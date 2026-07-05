# petekTools — build conventions

## What this is

A **standalone, pure-leaf** Rust library of numerics & geostatistics kernels —
the scattered-data gridding layer Rust lacks, plus a curated front-door over
mature numeric crates. Consumed by petekio and petekSim; depends on neither.
PyO3 bindings are planned. Read `SPEC.md` (design constitution) and `API.md`
(the locked contract) before changing anything. Follows the shared **petek house
style** (canonical: `petekSuite/dev-docs/petek-house-style.md`) — the rules below
are this library's slice of it.

## Mantra: SPLIT UP THE ELEPHANT 🐘

One module per concept, one concept per file. Split before a file owns two jobs
or grows past a few hundred lines. Keep the layers (`foundation → gridding →
[stats] → [sampling] → [py]`) one-directional.

## Hard rules (from SPEC.md)

1. **Pure leaf.** Never depend on petekio or petekSim. Only general-purpose
   numeric crates (`ndarray`, `thiserror`, and later `faer`/`statrs`/`kiddo`/
   `rstar`/`rand_distr`).
2. **Don't reinvent.** If a mature crate already does it well, curate it; only
   build what Rust is missing (the geostatistics/gridding kernels).
3. **Type-agnostic kernels.** `Lattice` + `[[f64; 3]]` in, `ndarray` out. No
   consumer domain types, no I/O.
4. **Parity with consolidated prior art.** Lifting a kernel from petekio (the
   author's own code) means matching its algorithm/defaults/tolerances and
   citing it. The GATE-0 kernels came from petekio 0.2.0; geometry parity is
   pinned by `tests/lattice_parity.rs`.
5. **PyO3-ready.** Keep public signatures binding-friendly (owned types, no
   public lifetimes).

## Tooling

- `cargo test` after any behaviour change; `cargo clippy` is **warnings = errors**;
  `cargo fmt`. `criterion` for benches when kernels land.
- GATE-0 is complete (the geometry `Lattice`, the `grid()` dispatcher, and the
  three ported kernels). Since then, shipped to HEAD (unreleased, heading for
  0.2.0): warm-start / `ConvergentGridder` gridding, the `Gridder` trait +
  `OrdinaryKriging`, the curated `stats` / `sampling` front-doors, and the
  `units` / `container` modules. Only the PyO3 wheel remains from the old
  roadmap — see `dev-docs/designs/roadmap.md`.

## Planning graph — the cross-library source of truth

The petekSuite **planning graph** (`petekSuite/research/graph/research.kgl`,
`contract` MCP) is the single source of truth for the inter-library contracts, architecture
decisions, and open questions. Reach for it on anything cross-cutting — read it
before changing a shared seam; record blocking issues and choices there, not only
in local docs. Contribute **without cluttering**: runtime types only
(`Question` / `Decision` / `Artifact` / `Task` — never managed research nodes;
raise a `Question` if one is wrong); **MERGE on id, never CREATE**; one node per
concept; `write_scope` to those types; stamp `git_sha` + `modified_by='petektools'`.
No direct access → route via the **inbox** to petekSuite (the coordinator). Full
protocol: petek house style §8.

## Working folders

- `inbox/` — cross-project coordination channel (see `inbox/README.md`).
- `dev-docs/` — plans, designs, todos (see `dev-docs/README.md`).

## Commits

`type: short description` (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`).
Update `CHANGELOG.md` `[Unreleased]` for surface changes. Pushing needs explicit
approval.
