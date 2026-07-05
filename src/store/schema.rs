//! `store::schema` — the lane dtypes and the store schema declared at create time.
//!
//! A [`StoreSchema`] fixes the whole on-disk shape up front (the slab count plus
//! every lane's name / dtype / chunking), so `create` can preallocate the file
//! and offsets are a pure, deterministic function of the schema. See the module
//! docs for the byte layout.

use crate::foundation::{AlgoError, Result};
use serde::{Deserialize, Serialize};

/// Element type of a lane. Stored **little-endian**, fixed stride (no
/// compression — mmap wants fixed strides; out-of-core ruling R1).
///
/// `f32` is the spill-scale default and the bandwidth lever; `f64` is opt-in
/// per lane (ruling R4). `u16` / `u32` carry ids / indices (zone ids, active
/// masks) cheaply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dtype {
    /// 32-bit IEEE-754 float (the default storage lane).
    F32,
    /// 64-bit IEEE-754 float (opt-in per lane).
    F64,
    /// 16-bit unsigned integer (ids / small indices).
    U16,
    /// 32-bit unsigned integer (ids / indices).
    U32,
}

impl Dtype {
    /// Byte width of one element.
    pub fn size(self) -> usize {
        match self {
            Dtype::F32 | Dtype::U32 => 4,
            Dtype::F64 => 8,
            Dtype::U16 => 2,
        }
    }

    /// The lowercase tag used in the JSON header and in error messages.
    pub fn as_str(self) -> &'static str {
        match self {
            Dtype::F32 => "f32",
            Dtype::F64 => "f64",
            Dtype::U16 => "u16",
            Dtype::U32 => "u32",
        }
    }
}

/// How a lane is chunked along the store's slow (k) axis.
///
/// A `Slab` lane is chunked into `nslabs` equal blocks of `elems_per_slab`
/// elements — streamed slab-by-slab and windowed by k. A `Flat` lane is
/// k-invariant (e.g. corner-point pillars / `COORD`) and written whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum LaneKind {
    /// `elems_per_slab` typed elements per k-slab; total = `nslabs · elems_per_slab`.
    Slab {
        /// Elements in one k-slab of this lane (e.g. `8·ni·nj` for ZCORN, `ni·nj`
        /// for a cell-centred cube).
        elems_per_slab: u64,
    },
    /// A single fixed array of `len` typed elements, independent of the slab axis.
    Flat {
        /// Total elements in the lane.
        len: u64,
    },
}

/// One lane: a named, typed, chunked array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneSpec {
    /// Lane identity (unique within the store; the read/write key).
    pub name: String,
    /// Element type.
    pub dtype: Dtype,
    /// Chunking (slab or flat).
    #[serde(flatten)]
    pub kind: LaneKind,
}

impl LaneSpec {
    /// A k-slab-chunked lane of `elems_per_slab` elements per slab.
    pub fn slab(name: impl Into<String>, dtype: Dtype, elems_per_slab: u64) -> Self {
        LaneSpec {
            name: name.into(),
            dtype,
            kind: LaneKind::Slab { elems_per_slab },
        }
    }

    /// A k-invariant flat lane of `len` elements.
    pub fn flat(name: impl Into<String>, dtype: Dtype, len: u64) -> Self {
        LaneSpec {
            name: name.into(),
            dtype,
            kind: LaneKind::Flat { len },
        }
    }

    /// Total element count of the lane given the store's slab count.
    pub(crate) fn elem_count(&self, nslabs: u64) -> u64 {
        match self.kind {
            LaneKind::Slab { elems_per_slab } => nslabs * elems_per_slab,
            LaneKind::Flat { len } => len,
        }
    }

    /// Total byte length of the lane given the store's slab count.
    pub(crate) fn byte_len(&self, nslabs: u64) -> u64 {
        self.elem_count(nslabs) * self.dtype.size() as u64
    }
}

/// The full on-disk shape, declared once at [`create`](super::StoreWriter::create).
///
/// Offsets are **not** part of the schema — they are recomputed identically by
/// writer and reader from the schema plus the header length, which is what makes
/// the layout deterministic (same schema + same data → identical bytes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreSchema {
    /// Number of k-slabs — the shared slow-axis chunk count for every slab lane.
    pub nslabs: u64,
    /// The lanes, in a fixed order (the order fixes the on-disk layout).
    pub lanes: Vec<LaneSpec>,
    /// Opaque, caller-owned metadata (grid dims, units, provenance). The store
    /// never interprets it. Keep it empty or deterministic to preserve
    /// byte-determinism.
    #[serde(default)]
    pub app: serde_json::Value,
}

impl StoreSchema {
    /// A schema with the given slab count and lanes, no app metadata.
    pub fn new(nslabs: u64, lanes: Vec<LaneSpec>) -> Self {
        StoreSchema {
            nslabs,
            lanes,
            app: serde_json::Value::Null,
        }
    }

    /// Attach opaque caller metadata (chainable).
    pub fn with_app(mut self, app: serde_json::Value) -> Self {
        self.app = app;
        self
    }

    /// Validate the schema: positive slab count, unique non-empty lane names, and
    /// non-empty lanes. Called by `create`; a bad schema is a loud
    /// [`InvalidArgument`](AlgoError::InvalidArgument).
    pub(crate) fn validate(&self) -> Result<()> {
        if self.nslabs == 0 {
            return Err(AlgoError::InvalidArgument(
                "store nslabs must be > 0".into(),
            ));
        }
        for (i, lane) in self.lanes.iter().enumerate() {
            if lane.name.is_empty() {
                return Err(AlgoError::InvalidArgument(format!(
                    "store lane {i} has an empty name"
                )));
            }
            let elems = match lane.kind {
                LaneKind::Slab { elems_per_slab } => elems_per_slab,
                LaneKind::Flat { len } => len,
            };
            if elems == 0 {
                return Err(AlgoError::InvalidArgument(format!(
                    "store lane '{}' has zero elements",
                    lane.name
                )));
            }
            if self.lanes[..i].iter().any(|o| o.name == lane.name) {
                return Err(AlgoError::InvalidArgument(format!(
                    "store lane name '{}' is not unique",
                    lane.name
                )));
            }
        }
        Ok(())
    }

    /// Index of a lane by name.
    pub(crate) fn lane_index(&self, name: &str) -> Result<usize> {
        self.lanes
            .iter()
            .position(|l| l.name == name)
            .ok_or_else(|| AlgoError::NotFound(format!("store lane '{name}'")))
    }
}
