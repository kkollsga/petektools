//! `store::layout` — the binary framing: magic, deterministic lane offsets, and
//! the end-of-store seal (finalize marker + partial-write detection).
//!
//! ```text
//! [0]              magic(4)            = b"PTS\x01"   (4th byte = hard format version)
//! [4]              header_len(u32 LE)
//! [8]              header (JSON, header_len bytes)    = the StoreSchema
//! [·]              zero pad → 64-align
//! [data_base]      lane 0 region · lane 1 region · …  (lane-major; each lane
//!                  64-aligned; within a lane the slabs are contiguous, slab 0
//!                  first — so a k-window read is one contiguous slice)
//! [data_end]       zero pad → 8-align
//! [seal_offset]    seal: magic(4)=b"PTSZ" + nslabs(u64 LE) + data_end(u64 LE)
//! ```
//!
//! Offsets are a pure function of `(header_len, schema)` — never stored — so
//! writer and reader derive them identically and the layout is deterministic.

use crate::foundation::{AlgoError, Result};
use crate::store::schema::StoreSchema;

/// Magic + hard format-version byte. Bytes 0..3 identify the family; byte 3 is
/// the format version (a newer one is refused on open).
pub(crate) const MAGIC: [u8; 4] = *b"PTS\x01";
/// End-of-store seal marker written by `finalize`.
pub(crate) const SEAL: [u8; 4] = *b"PTSZ";
/// Lane data alignment: one cache line, and ≥ the alignment of any lane dtype
/// (so zero-copy typed views are always well-aligned).
pub(crate) const ALIGN: u64 = 64;
/// Seal length: marker(4) + nslabs(8) + data_end(8).
pub(crate) const SEAL_LEN: u64 = 4 + 8 + 8;

/// Round `x` up to the next multiple of `a` (a power of two ≥ 1).
fn align_up(x: u64, a: u64) -> u64 {
    x.div_ceil(a) * a
}

/// The byte extent of one lane in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LaneLayout {
    /// Absolute byte offset of the lane's first element.
    pub offset: u64,
    /// Byte length of the lane's data region.
    pub byte_len: u64,
}

/// The full computed byte map of a store.
#[derive(Debug, Clone)]
pub(crate) struct Layout {
    /// One entry per schema lane (parallel to `schema.lanes`).
    pub lanes: Vec<LaneLayout>,
    /// End of the last lane's data.
    pub data_end: u64,
    /// Offset of the seal (8-aligned `data_end`).
    pub seal_offset: u64,
    /// Total file length (seal end).
    pub total_len: u64,
}

impl Layout {
    /// Derive the byte map from the schema and the serialized header length.
    /// Pure and deterministic — the reader recomputes the same map.
    pub fn compute(schema: &StoreSchema, header_len: u64) -> Layout {
        let data_base = align_up(MAGIC.len() as u64 + 4 + header_len, ALIGN);
        let mut off = data_base;
        let mut lanes = Vec::with_capacity(schema.lanes.len());
        for lane in &schema.lanes {
            off = align_up(off, ALIGN);
            let byte_len = lane.byte_len(schema.nslabs);
            lanes.push(LaneLayout {
                offset: off,
                byte_len,
            });
            off += byte_len;
        }
        let data_end = off;
        let seal_offset = align_up(data_end, 8);
        Layout {
            lanes,
            data_end,
            seal_offset,
            total_len: seal_offset + SEAL_LEN,
        }
    }

    /// Write the finalize seal into a mapped buffer.
    pub fn write_seal(&self, buf: &mut [u8], nslabs: u64) {
        let s = self.seal_offset as usize;
        buf[s..s + 4].copy_from_slice(&SEAL);
        buf[s + 4..s + 12].copy_from_slice(&nslabs.to_le_bytes());
        buf[s + 12..s + 20].copy_from_slice(&self.data_end.to_le_bytes());
    }

    /// Verify the finalize seal — the partial-write / not-finalized detector.
    /// A store that was never `finalize`d (or was truncated) fails loudly here.
    pub fn verify_seal(&self, buf: &[u8], nslabs: u64) -> Result<()> {
        if (buf.len() as u64) < self.total_len {
            return Err(AlgoError::Parse(
                "store not finalized or partially written (file shorter than its schema)".into(),
            ));
        }
        let s = self.seal_offset as usize;
        if buf[s..s + 4] != SEAL {
            return Err(AlgoError::Parse(
                "store not finalized (missing end-of-store seal)".into(),
            ));
        }
        let seal_nslabs = u64::from_le_bytes(buf[s + 4..s + 12].try_into().unwrap());
        let seal_end = u64::from_le_bytes(buf[s + 12..s + 20].try_into().unwrap());
        if seal_nslabs != nslabs || seal_end != self.data_end {
            return Err(AlgoError::Parse(
                "store seal disagrees with its header (corrupt or truncated)".into(),
            ));
        }
        Ok(())
    }
}
