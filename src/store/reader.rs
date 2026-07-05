//! `store::reader` — [`Store`]: open a finalized store read-only and pull typed,
//! zero-copy slab / window / whole-lane views straight out of the mapping.

use crate::foundation::{AlgoError, Result};
use crate::store::layout::{Layout, MAGIC};
use crate::store::schema::{Dtype, LaneKind, LaneSpec, StoreSchema};
use memmap2::Mmap;
use ndarray::{ArrayView1, ArrayView2};
use std::fs::File;
use std::path::Path;

/// A finalized store opened read-only. Reads are zero-copy slices into the
/// memory map — a slab, a k-window `[start, end)`, or a whole lane. Because a
/// lane's slabs are contiguous on disk, a window is one contiguous slice.
#[derive(Debug)]
pub struct Store {
    schema: StoreSchema,
    layout: Layout,
    mmap: Mmap,
}

/// Open a finalized store at `path`. Validates the magic, format version, header
/// and the finalize seal; an unfinalized or truncated file fails loudly with
/// [`Parse`](AlgoError::Parse).
pub fn open(path: &Path) -> Result<Store> {
    let file = File::open(path)?;
    // SAFETY: the store is opened read-only under the single-writer contract
    // (no concurrent writer resizes/mutates the file); the mapping is only read.
    #[allow(unsafe_code)]
    let mmap = unsafe { Mmap::map(&file)? };

    if mmap.len() < 8 {
        return Err(AlgoError::Parse(
            "not a petekTools store (truncated header)".into(),
        ));
    }
    if mmap[..3] != MAGIC[..3] {
        return Err(AlgoError::Parse(
            "not a petekTools store (bad magic)".into(),
        ));
    }
    if mmap[3] > MAGIC[3] {
        return Err(AlgoError::Parse(format!(
            "unsupported store format version {} (this build reads ≤ {}) — re-write with a newer writer",
            mmap[3], MAGIC[3]
        )));
    }
    let header_len = u32::from_le_bytes(mmap[4..8].try_into().unwrap()) as usize;
    if mmap.len() < 8 + header_len {
        return Err(AlgoError::Parse("store header truncated".into()));
    }
    let schema: StoreSchema = serde_json::from_slice(&mmap[8..8 + header_len])
        .map_err(|e| AlgoError::Parse(e.to_string()))?;
    let layout = Layout::compute(&schema, header_len as u64);
    layout.verify_seal(&mmap, schema.nslabs)?;
    Ok(Store {
        schema,
        layout,
        mmap,
    })
}

impl Store {
    /// Open a finalized store (see the free [`open`] function).
    pub fn open(path: &Path) -> Result<Store> {
        open(path)
    }

    /// The store's slab count.
    pub fn nslabs(&self) -> u64 {
        self.schema.nslabs
    }

    /// The lanes, in on-disk order.
    pub fn lanes(&self) -> &[LaneSpec] {
        &self.schema.lanes
    }

    /// Look up a lane by name.
    pub fn lane(&self, name: &str) -> Option<&LaneSpec> {
        self.schema.lanes.iter().find(|l| l.name == name)
    }

    /// The opaque caller metadata stored at create time.
    pub fn app(&self) -> &serde_json::Value {
        &self.schema.app
    }

    /// Bytes of one k-slab of a slab lane (dtype-checked, bounds-checked).
    fn slab_bytes(&self, name: &str, slab: u64, dtype: Dtype) -> Result<&[u8]> {
        self.window_bytes(name, slab, slab + 1, dtype)
    }

    /// Bytes of a k-window `[start, end)` of a slab lane — one contiguous slice.
    fn window_bytes(&self, name: &str, start: u64, end: u64, dtype: Dtype) -> Result<&[u8]> {
        let idx = self.schema.lane_index(name)?;
        let lane = &self.schema.lanes[idx];
        self.check_dtype(lane, dtype)?;
        let elems_per_slab = match lane.kind {
            LaneKind::Slab { elems_per_slab } => elems_per_slab,
            LaneKind::Flat { .. } => {
                return Err(AlgoError::InvalidArgument(format!(
                    "lane '{name}' is flat — use flat_*"
                )))
            }
        };
        if start > end || end > self.schema.nslabs {
            return Err(AlgoError::InvalidArgument(format!(
                "slab window [{start}, {end}) out of range (nslabs = {})",
                self.schema.nslabs
            )));
        }
        let size = dtype.size() as u64;
        let base = self.layout.lanes[idx].offset + start * elems_per_slab * size;
        let len = (end - start) * elems_per_slab * size;
        Ok(&self.mmap[base as usize..(base + len) as usize])
    }

    /// Bytes of a whole flat lane (dtype-checked).
    fn flat_bytes(&self, name: &str, dtype: Dtype) -> Result<&[u8]> {
        let idx = self.schema.lane_index(name)?;
        let lane = &self.schema.lanes[idx];
        self.check_dtype(lane, dtype)?;
        if !matches!(lane.kind, LaneKind::Flat { .. }) {
            return Err(AlgoError::InvalidArgument(format!(
                "lane '{name}' is a slab lane — use slab_*/window_*/lane_*"
            )));
        }
        let ext = self.layout.lanes[idx];
        Ok(&self.mmap[ext.offset as usize..(ext.offset + ext.byte_len) as usize])
    }

    fn check_dtype(&self, lane: &LaneSpec, dtype: Dtype) -> Result<()> {
        if lane.dtype != dtype {
            return Err(AlgoError::InvalidArgument(format!(
                "lane '{}' is {}, not {}",
                lane.name,
                lane.dtype.as_str(),
                dtype.as_str()
            )));
        }
        Ok(())
    }

    /// `elems_per_slab` of a slab lane, for shaping window views.
    fn elems_per_slab(&self, name: &str) -> Result<u64> {
        let idx = self.schema.lane_index(name)?;
        match self.schema.lanes[idx].kind {
            LaneKind::Slab { elems_per_slab } => Ok(elems_per_slab),
            LaneKind::Flat { .. } => Err(AlgoError::InvalidArgument(format!(
                "lane '{name}' is flat (no slabs)"
            ))),
        }
    }
}

/// Generate the typed read views (slice + ndarray) for one dtype.
macro_rules! typed_readers {
    ($ty:ty, $variant:expr,
     $slab:ident, $window:ident, $lane:ident, $flat:ident,
     $slab_view:ident, $window_view:ident) => {
        impl Store {
            #[doc = concat!("Zero-copy `", stringify!($ty), "` slice of one k-slab.")]
            pub fn $slab(&self, name: &str, slab: u64) -> Result<&[$ty]> {
                cast(self.slab_bytes(name, slab, $variant)?, name)
            }

            #[doc = concat!("Zero-copy `", stringify!($ty), "` slice of a k-window `[start, end)` (contiguous).")]
            pub fn $window(&self, name: &str, start: u64, end: u64) -> Result<&[$ty]> {
                cast(self.window_bytes(name, start, end, $variant)?, name)
            }

            #[doc = concat!("Zero-copy `", stringify!($ty), "` slice of a whole slab lane (all slabs).")]
            pub fn $lane(&self, name: &str) -> Result<&[$ty]> {
                cast(self.window_bytes(name, 0, self.schema.nslabs, $variant)?, name)
            }

            #[doc = concat!("Zero-copy `", stringify!($ty), "` slice of a whole flat lane.")]
            pub fn $flat(&self, name: &str) -> Result<&[$ty]> {
                cast(self.flat_bytes(name, $variant)?, name)
            }

            #[doc = concat!("One k-slab as a 1-D `", stringify!($ty), "` [`ArrayView1`] (zero-copy).")]
            pub fn $slab_view(&self, name: &str, slab: u64) -> Result<ArrayView1<'_, $ty>> {
                Ok(ArrayView1::from(self.$slab(name, slab)?))
            }

            #[doc = concat!("A k-window `[start, end)` as a 2-D `", stringify!($ty), "` [`ArrayView2`] shaped `[nwin, elems_per_slab]` (zero-copy).")]
            pub fn $window_view(&self, name: &str, start: u64, end: u64) -> Result<ArrayView2<'_, $ty>> {
                let eps = self.elems_per_slab(name)? as usize;
                let slice = self.$window(name, start, end)?;
                let nwin = if eps == 0 { 0 } else { slice.len() / eps };
                ArrayView2::from_shape((nwin, eps), slice)
                    .map_err(|e| AlgoError::InvalidArgument(format!("lane '{name}' view: {e}")))
            }
        }
    };
}

/// Cast mmap bytes to a typed slice; alignment is guaranteed by the 64-byte lane
/// alignment, so this only fails on a genuine layout bug (reported loudly).
fn cast<'a, T: bytemuck::Pod>(bytes: &'a [u8], name: &str) -> Result<&'a [T]> {
    bytemuck::try_cast_slice(bytes)
        .map_err(|e| AlgoError::InvalidArgument(format!("lane '{name}': {e}")))
}

typed_readers!(
    f32,
    Dtype::F32,
    slab_f32,
    window_f32,
    lane_f32,
    flat_f32,
    slab_view_f32,
    window_view_f32
);
typed_readers!(
    f64,
    Dtype::F64,
    slab_f64,
    window_f64,
    lane_f64,
    flat_f64,
    slab_view_f64,
    window_view_f64
);
typed_readers!(
    u32,
    Dtype::U32,
    slab_u32,
    window_u32,
    lane_u32,
    flat_u32,
    slab_view_u32,
    window_view_u32
);
typed_readers!(
    u16,
    Dtype::U16,
    slab_u16,
    window_u16,
    lane_u16,
    flat_u16,
    slab_view_u16,
    window_view_u16
);
