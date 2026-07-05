//! `foundation` — the type-agnostic vocabulary every kernel speaks: the error
//! type, the `Result` alias, and the rotatable [`Lattice`] (with its `BBox`).
//!
//! Deliberately tiny and dependency-free beyond `thiserror`: this is the bedrock
//! the higher layers (`gridding`, and later `stats` / `sampling`) build on.

pub mod error;
pub mod lattice;

pub use error::{AlgoError, Result};
pub use lattice::{BBox, Lattice};
