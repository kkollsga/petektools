//! `store::writer` — [`StoreWriter`]: create a store and fill it, slab-by-slab
//! (streaming append) or in place via a mutable typed view, then `finalize` to
//! write the seal.

use crate::foundation::{AlgoError, Result};
use crate::store::layout::{Layout, MAGIC};
use crate::store::schema::{Dtype, LaneKind, StoreSchema};
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::path::Path;

/// A store being written. Created from a [`StoreSchema`] (which fixes the whole
/// layout up front); the backing file is preallocated to its full size and
/// memory-mapped, so slab writes are plain memory stores. Call [`finalize`] to
/// write the end-of-store seal — without it the file reads back as
/// *not finalized* (the partial-write guard).
///
/// ## Flush-behind (opt-in RSS ceiling for streaming builds)
///
/// A streaming build writes every slab through the mmap; the written pages stay
/// resident in the page cache, so total RSS grows `O(store)` even though only one
/// slab is live at a time. That is *soft* (the OS reclaims under pressure) but it
/// inflates measured RSS and weakens a hard streaming-RSS ceiling. Enable
/// [`with_flush_behind`](StoreWriter::with_flush_behind) and each completed
/// `write_slab_*` is `msync`'d then page-evicted (`madvise(MADV_DONTNEED)` on
/// unix) right after the copy, so resident pages do not accumulate across the
/// stream. Bytes are unchanged (flush-behind only controls page residency, never
/// content) — the store stays byte-deterministic. The in-place `slab_mut_*` fill
/// path evicts explicitly via [`flush_behind_slab`](StoreWriter::flush_behind_slab)
/// once a slab is done.
///
/// **Platform note.** On Linux `MADV_DONTNEED` drops the resident pages of a
/// clean (already-`msync`'d) `MAP_SHARED` range immediately; a later read
/// re-faults the identical on-disk bytes. On macOS/Darwin `MADV_DONTNEED` is a
/// softer hint (the pages become first-in-line for reclaim rather than dropped
/// synchronously), so the RSS win is smaller but correctness is identical. On
/// non-unix targets flush-behind degrades to the `msync` alone (no evict).
///
/// [`finalize`]: StoreWriter::finalize
#[derive(Debug)]
pub struct StoreWriter {
    schema: StoreSchema,
    layout: Layout,
    mmap: MmapMut,
    /// When true, each completed slab write is `msync`'d + page-evicted so a
    /// streaming build's resident set stays slab-bounded rather than `O(store)`.
    flush_behind: bool,
}

impl StoreWriter {
    /// Create a store at `path` from `schema`, preallocating and mapping the
    /// full file. Overwrites any existing file at `path`.
    pub fn create(path: &Path, schema: StoreSchema) -> Result<Self> {
        schema.validate()?;
        let header = serde_json::to_vec(&schema).map_err(|e| AlgoError::Parse(e.to_string()))?;
        let layout = Layout::compute(&schema, header.len() as u64);

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)?;
        file.set_len(layout.total_len)?;

        // SAFETY: `file` is a freshly created, exclusively-owned regular file of
        // the length we just set; this writer is the single writer (the store's
        // documented single-writer contract) so the mapping is not aliased or
        // resized underneath us.
        #[allow(unsafe_code)]
        let mut mmap = unsafe { MmapMut::map_mut(&file)? };

        mmap[0..4].copy_from_slice(&MAGIC);
        mmap[4..8].copy_from_slice(&(header.len() as u32).to_le_bytes());
        mmap[8..8 + header.len()].copy_from_slice(&header);
        // The remainder (pad, lane regions, seal) is zero from `set_len`.

        Ok(StoreWriter {
            schema,
            layout,
            mmap,
            flush_behind: false,
        })
    }

    /// Enable (or disable) **flush-behind**: after each completed `write_slab_*`,
    /// `msync` that slab's byte range then page-evict it (`madvise(MADV_DONTNEED)`
    /// on unix) so a streaming build's resident set stays slab-bounded instead of
    /// growing `O(store)`. Off by default (plain mmap writes). Chainable after
    /// [`create`](StoreWriter::create); the on-disk bytes are identical either way
    /// (see the type docs for the full rationale + platform behaviour).
    pub fn with_flush_behind(mut self, on: bool) -> Self {
        self.flush_behind = on;
        self
    }

    /// Whether flush-behind is enabled (see [`with_flush_behind`]).
    ///
    /// [`with_flush_behind`]: StoreWriter::with_flush_behind
    pub fn flush_behind_enabled(&self) -> bool {
        self.flush_behind
    }

    /// The schema this store was created with.
    pub fn schema(&self) -> &StoreSchema {
        &self.schema
    }

    /// The `(offset, len)` byte extent of one k-slab of a slab lane, using the
    /// lane's declared dtype (bounds-/kind-checked). The shared range primitive
    /// for the write, in-place-view and flush-behind paths.
    fn slab_byte_range(&self, idx: usize, slab: u64) -> Result<(usize, usize)> {
        let lane = &self.schema.lanes[idx];
        let elems_per_slab = match lane.kind {
            LaneKind::Slab { elems_per_slab } => elems_per_slab,
            LaneKind::Flat { .. } => {
                return Err(AlgoError::InvalidArgument(format!(
                    "lane '{}' is flat — use write_flat_*/flat_mut_*",
                    lane.name
                )))
            }
        };
        if slab >= self.schema.nslabs {
            return Err(AlgoError::InvalidArgument(format!(
                "slab {slab} out of range (nslabs = {})",
                self.schema.nslabs
            )));
        }
        let size = lane.dtype.size() as u64;
        let start = self.layout.lanes[idx].offset + slab * elems_per_slab * size;
        let len = elems_per_slab * size;
        Ok((start as usize, len as usize))
    }

    /// Mutable bytes of one k-slab of a slab lane (dtype-checked, bounds-checked).
    fn slab_region_mut(&mut self, name: &str, slab: u64, dtype: Dtype) -> Result<&mut [u8]> {
        let idx = self.schema.lane_index(name)?;
        if self.schema.lanes[idx].dtype != dtype {
            return Err(AlgoError::InvalidArgument(format!(
                "lane '{name}' is {}, not {}",
                self.schema.lanes[idx].dtype.as_str(),
                dtype.as_str()
            )));
        }
        let (start, len) = self.slab_byte_range(idx, slab)?;
        Ok(&mut self.mmap[start..start + len])
    }

    /// `msync` + page-evict one already-written, finalized-shape slab of a slab
    /// lane — the **explicit flush-behind hook** for the in-place `slab_mut_*`
    /// fill path (call it once a slab's view is fully written and dropped). The
    /// `write_slab_*` path evicts automatically when flush-behind is enabled; this
    /// gives the streaming in-place path the same RSS ceiling. A no-op-ish reclaim
    /// hint on platforms without an effective `MADV_DONTNEED`; bytes are unchanged.
    pub fn flush_behind_slab(&mut self, name: &str, slab: u64) -> Result<()> {
        let idx = self.schema.lane_index(name)?;
        let (off, len) = self.slab_byte_range(idx, slab)?;
        self.evict_range(off, len)
    }

    /// `msync` the byte range `[offset, offset+len)` (persist the just-written
    /// pages) then advise the OS to drop them from the resident set. Correctness
    /// is unaffected on every platform; only page residency changes.
    fn evict_range(&mut self, offset: usize, len: usize) -> Result<()> {
        if len == 0 {
            return Ok(());
        }
        // Persist first: the range must be clean before we hint it away, so a
        // later re-fault reads the identical on-disk bytes (no data loss).
        self.mmap.flush_range(offset, len)?;
        #[cfg(unix)]
        {
            // SAFETY: the range was just `msync`'d, so its pages are clean; the
            // store is a `MAP_SHARED` file-backed mapping, so `MADV_DONTNEED` only
            // drops resident pages (a subsequent read re-faults identical on-disk
            // bytes). We hold no outstanding borrow into this range across the
            // advise, and the streaming write path never revisits a finished slab.
            #[allow(unsafe_code)]
            unsafe {
                self.mmap.unchecked_advise_range(
                    memmap2::UncheckedAdvice::DontNeed,
                    offset,
                    len,
                )?;
            }
        }
        Ok(())
    }

    /// Mutable bytes of a flat lane (dtype-checked).
    fn flat_region_mut(&mut self, name: &str, dtype: Dtype) -> Result<&mut [u8]> {
        let idx = self.schema.lane_index(name)?;
        let lane = &self.schema.lanes[idx];
        if lane.dtype != dtype {
            return Err(AlgoError::InvalidArgument(format!(
                "lane '{name}' is {}, not {}",
                lane.dtype.as_str(),
                dtype.as_str()
            )));
        }
        if !matches!(lane.kind, LaneKind::Flat { .. }) {
            return Err(AlgoError::InvalidArgument(format!(
                "lane '{name}' is a slab lane — use write_slab_*/slab_mut_*"
            )));
        }
        let ext = self.layout.lanes[idx];
        Ok(&mut self.mmap[ext.offset as usize..(ext.offset + ext.byte_len) as usize])
    }

    /// Flush dirty pages to disk (`msync`). Does **not** write the seal.
    pub fn flush(&mut self) -> Result<()> {
        self.mmap.flush()?;
        Ok(())
    }

    /// Write the end-of-store seal and flush. After this the store reads back as
    /// finalized; consuming `self` prevents further writes.
    pub fn finalize(mut self) -> Result<()> {
        let nslabs = self.schema.nslabs;
        self.layout.write_seal(&mut self.mmap, nslabs);
        self.mmap.flush()?;
        Ok(())
    }
}

/// Generate the typed slab/flat writers + in-place views for one dtype.
macro_rules! typed_writers {
    ($ty:ty, $variant:expr,
     $write_slab:ident, $slab_mut:ident, $write_flat:ident, $flat_mut:ident) => {
        impl StoreWriter {
            #[doc = concat!("Write one k-slab of a `", stringify!($ty), "` lane. `data.len()` must equal the lane's `elems_per_slab`.")]
            pub fn $write_slab(&mut self, name: &str, slab: u64, data: &[$ty]) -> Result<()> {
                let bytes: &[u8] = bytemuck::cast_slice(data);
                let region = self.slab_region_mut(name, slab, $variant)?;
                if bytes.len() != region.len() {
                    return Err(AlgoError::InvalidArgument(format!(
                        "lane '{name}' slab expects {} elements, got {}",
                        region.len() / std::mem::size_of::<$ty>(),
                        data.len()
                    )));
                }
                region.copy_from_slice(bytes);
                // Flush-behind: persist + page-evict this slab so a streaming
                // build's resident set stays slab-bounded (opt-in; bytes unchanged).
                if self.flush_behind {
                    self.flush_behind_slab(name, slab)?;
                }
                Ok(())
            }

            #[doc = concat!("A mutable, zero-copy `", stringify!($ty), "` view of one k-slab (fill it in place — the streaming write path).")]
            pub fn $slab_mut(&mut self, name: &str, slab: u64) -> Result<&mut [$ty]> {
                let region = self.slab_region_mut(name, slab, $variant)?;
                bytemuck::try_cast_slice_mut(region)
                    .map_err(|e| AlgoError::InvalidArgument(format!("lane '{name}': {e}")))
            }

            #[doc = concat!("Write a whole flat `", stringify!($ty), "` lane. `data.len()` must equal the lane's `len`.")]
            pub fn $write_flat(&mut self, name: &str, data: &[$ty]) -> Result<()> {
                let bytes: &[u8] = bytemuck::cast_slice(data);
                let region = self.flat_region_mut(name, $variant)?;
                if bytes.len() != region.len() {
                    return Err(AlgoError::InvalidArgument(format!(
                        "flat lane '{name}' expects {} elements, got {}",
                        region.len() / std::mem::size_of::<$ty>(),
                        data.len()
                    )));
                }
                region.copy_from_slice(bytes);
                Ok(())
            }

            #[doc = concat!("A mutable, zero-copy `", stringify!($ty), "` view of a whole flat lane.")]
            pub fn $flat_mut(&mut self, name: &str) -> Result<&mut [$ty]> {
                let region = self.flat_region_mut(name, $variant)?;
                bytemuck::try_cast_slice_mut(region)
                    .map_err(|e| AlgoError::InvalidArgument(format!("lane '{name}': {e}")))
            }
        }
    };
}

typed_writers!(
    f32,
    Dtype::F32,
    write_slab_f32,
    slab_mut_f32,
    write_flat_f32,
    flat_mut_f32
);
typed_writers!(
    f64,
    Dtype::F64,
    write_slab_f64,
    slab_mut_f64,
    write_flat_f64,
    flat_mut_f64
);
typed_writers!(
    u32,
    Dtype::U32,
    write_slab_u32,
    slab_mut_u32,
    write_flat_u32,
    flat_mut_u32
);
typed_writers!(
    u16,
    Dtype::U16,
    write_slab_u16,
    slab_mut_u16,
    write_flat_u16,
    flat_mut_u16
);
