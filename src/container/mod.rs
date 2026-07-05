//! `container` — a **domain-agnostic** single-file section container.
//!
//! One file = `magic(4) + data_version(u32 LE) + header_len(u32 LE) + header
//! (JSON) + section blobs`. Each section is a `kind` + `name` + `tags` +
//! `version` + an opaque `payload`, stored `zstd`-compressed. The container
//! knows **nothing** about the caller's domain (surfaces / wells / models) — it
//! round-trips tagged, versioned, kinded byte blobs and supports partial reads +
//! `filter_to` / `merge_to` that copy compressed blobs **byte-for-byte** (never
//! re-encoding a payload).
//!
//! Lifted verbatim from petekio's `.pproj` framing (the on-disk format is
//! unchanged): only the error type was swapped to this crate's [`AlgoError`].
//! petekio layers its GeoData element DTOs on top; petekSim stores an opaque
//! `model/*` sidecar the container never parses.
//!
//! Two-tier versioning: the 4th magic byte is the **hard** format version (a
//! mismatch is refused); `data_version` tracks the *caller's* DTO schema; the
//! JSON header evolves via serde defaults (soft). Per-section `version` lets an
//! opaque sidecar evolve independently.

mod format;

pub use format::{filter_to, merge_to, open, write, Entry, Reader, Section};
