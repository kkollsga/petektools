//! `store` — a **domain-agnostic** chunked, memory-mapped lane store: the
//! spill-to-disk backing for larger-than-memory models (out-of-core ruling R1,
//! `petekSuite/dev-docs/designs/out-of-core-strategy.md`).
//!
//! A store is one file holding named **lanes** — typed arrays chunked along the
//! slow (**k-slab**) axis — so slab-sequential streaming writes and windowed
//! random reads are both natural. It is the same file family as the `.pproj`
//! [`container`](crate::container) and the v3 wire lanes: little-endian, an
//! explicitly versioned header, fixed strides, and a **deterministic** layout
//! (same schema + same data → identical bytes). There is **no compression**
//! (mmap wants fixed strides — a ruled non-goal); heavy formats (HDF5 / Arrow /
//! parquet) are excluded — a few hundred lines of layout code beats a
//! dependency.
//!
//! # On-disk format (v1)
//!
//! ```text
//! magic(4) = b"PTS\x01"   (bytes 0..3 = family; byte 3 = hard format version)
//! header_len(u32 LE)
//! header (JSON, header_len bytes)         = the StoreSchema
//! zero pad → 64-align
//! lane 0 region · lane 1 region · …       lane-major; each lane 64-aligned;
//!                                         within a lane the slabs are stored
//!                                         contiguously (slab 0 first) so a
//!                                         k-window is one contiguous slice
//! zero pad → 8-align
//! seal: b"PTSZ" + nslabs(u64 LE) + data_end(u64 LE)   written by finalize
//! ```
//!
//! Lane byte offsets are **not** stored — they are recomputed identically by
//! writer and reader from `(header_len, schema)`, which is what makes the layout
//! deterministic. Lanes are 64-byte aligned (one cache line, ≥ any dtype's
//! alignment), so typed views are always well-aligned and zero-copy.
//!
//! ## Lanes
//!
//! A [`LaneSpec`] is a `name` + [`Dtype`] (`f32` default, `f64` opt-in, `u16` /
//! `u32` for ids — ruling R4) + a [`LaneKind`]:
//! - **`Slab { elems_per_slab }`** — chunked into `nslabs` equal blocks; total
//!   `nslabs · elems_per_slab` elements. Written/read slab-by-slab or by
//!   k-window. Example: a cell-centred `PORO` cube (`elems_per_slab = ni·nj`),
//!   `ZCORN` (`elems_per_slab = 8·ni·nj`).
//! - **`Flat { len }`** — a single k-invariant array (e.g. corner-point pillars
//!   `COORD`). Written and read whole.
//!
//! # Lifecycle
//!
//! ```no_run
//! use petektools::store::{Dtype, LaneSpec, Store, StoreSchema, StoreWriter};
//! # fn main() -> petektools::Result<()> {
//! let (ni, nj, nk) = (200u64, 150, 40);
//! let schema = StoreSchema::new(
//!     nk,
//!     vec![
//!         LaneSpec::slab("PORO", Dtype::F32, ni * nj),
//!         LaneSpec::slab("ZCORN", Dtype::F32, 8 * ni * nj),
//!         LaneSpec::flat("COORD", Dtype::F32, (ni + 1) * (nj + 1) * 6),
//!     ],
//! );
//!
//! let mut w = StoreWriter::create(std::path::Path::new("model.pts"), schema)?;
//! for k in 0..nk {
//!     let poro = vec![0.2f32; (ni * nj) as usize];   // produced by the pipeline
//!     w.write_slab_f32("PORO", k, &poro)?;           // streaming append
//! }
//! w.write_flat_f32("COORD", &vec![0.0f32; ((ni + 1) * (nj + 1) * 6) as usize])?;
//! w.finalize()?;                                     // seal + sync
//!
//! let s = Store::open(std::path::Path::new("model.pts"))?;
//! let slab0 = s.slab_f32("PORO", 0)?;                // zero-copy view
//! let window = s.window_view_f32("PORO", 0, 8)?;     // ndarray [8, ni·nj]
//! # let _ = (slab0, window);
//! # Ok(())
//! # }
//! ```
//!
//! # Scope
//!
//! Rust-only in v1 (petekStatic is the consumer; Python exposure comes later if
//! needed). Single-writer: one [`StoreWriter`] owns a file until `finalize`; a
//! store is not concurrently written while mapped. This is the crate's second
//! deliberate I/O carve-out alongside [`container`](crate::container) — and the
//! one place the crate's `deny(unsafe_code)` is locally relaxed, for the two
//! `memmap2` map calls only (both documented with a `SAFETY` note).

mod layout;
mod reader;
mod schema;
mod writer;

pub use reader::{open, Store};
pub use schema::{Dtype, LaneKind, LaneSpec, StoreSchema};
pub use writer::StoreWriter;
