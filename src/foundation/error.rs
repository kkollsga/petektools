//! The crate error type and `Result` alias.

use thiserror::Error;

/// `Result<T>` specialised to [`AlgoError`].
pub type Result<T> = std::result::Result<T, AlgoError>;

/// Errors raised by petekTools.
///
/// The numeric-kernel surface is narrow (bad inputs, degenerate geometry) and
/// `&'static str`-payloaded. The `container` module adds a small I/O-shaped
/// surface (I/O failures, corrupt/parse errors, missing sections) since it
/// round-trips section blobs to disk. The `stats` / `sampling` front-doors add
/// [`InvalidArgument`](AlgoError::InvalidArgument) for bad parameters / ranges.
///
/// The enum is `#[non_exhaustive]`: match with a wildcard arm so a future
/// variant is never a breaking change.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum AlgoError {
    /// A kernel was handed no data to work with.
    #[error("empty input: {0}")]
    EmptyInput(&'static str),

    /// The target lattice is degenerate (e.g. zero node spacing).
    #[error("invalid geometry: {0}")]
    InvalidGeometry(&'static str),

    /// A parameter or range argument was invalid — e.g. a percentile outside
    /// `[0, 100]`, a non-positive standard deviation, or a `values`/`weights`
    /// length mismatch. Raised by the `stats` / `sampling` front-doors.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    /// Underlying I/O failure (file open/read/write) — raised by `container`.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// A byte stream could not be parsed / was corrupt — raised by `container`.
    #[error("parse error: {0}")]
    Parse(String),

    /// A named item (e.g. a container section) was not found.
    #[error("not found: {0}")]
    NotFound(String),
}
