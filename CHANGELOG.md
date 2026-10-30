# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.1.1] - 2026-10-30

### Changed

- Comments and docs: internal markers, internal note references and internal batch numbering
  removed (no behaviour change; no code path touched).

## [0.1.0] - 2026-10-19

### Added

- **`rulecheck.mjs`** — read-only engineering-rule checker: `baseline` / `debt` / `all` / `dod` / `dor` /
  `defect` / `postmortem` / `practice` subcommands, plus an in-memory `--self-test`.
- **`check-decoupling.mjs`** — plugin ↔ DSH-internals decoupling checks (R1–R5), including host-adapter
  copy-vs-source verification.
- **`docs-index-gen.mjs`** — idempotent docs-index generator (dry-run by default; `--apply` / `--verify` / `--json`).
- **`docs-consistency-scan.mjs`** — single-document consistency scan (numbering / citations / list counts / terms).
- **`dsh-vocab-guard.mjs`** — session event-vocabulary drift guard with baseline save/compare.
- **`sync-host-adapter.mjs`** — host-adapter single-source → derived-copy sync/verify (dependency of
  `check-decoupling.mjs`; structural checks only).
- **`docs-discipline/`** — 13 document-discipline judges (`archive-rounds`, `check-caliber`, `check-cites`,
  `check-cites-exist`, `check-promises`, `check-residue`, `check-rootcause`, `check-rounds`, `check-selfclaim`,
  `check-volume`, `gen-doc-audit`, `scan-four`, `selfcheck-rerun`) + `lib/common.mjs` + `lib/dispatch.mjs`
  + 2 unit tests.
- **`dsh-l3-pitfall-reminder/`** — DSH plugin publishing an L3 realtime pitfall reminder into the current
  session when a failing tool call matches an archived pitfall (off by default; hot-read switch; zero deps),
  with `install.mjs`, `bin/l3-reminder.mjs` CLI, and 30 pure unit tests.
- Shared `lib/dsh-home.mjs`, `lib/generated-docs.mjs`, `lib/rulecheck-rules.mjs`.
- `package.json` with `bin` entries for every CLI, dual licensing (AGPL-3.0-only + commercial).

### Changed (relative to the private source tree)

- All machine-absolute paths replaced with `DSH_ROOT` / `os.homedir()` / environment variables / relative paths.
- `hostSlug()` generalized (no hard-coded host names): any host name is slugified to lowercase with `-` separators.
- `<host>` family-match placeholder generalized to `([a-z][a-z0-9-]*)` instead of a fixed two-host alternation.
- Host names, user names and session ids in comments and test fixtures replaced with generic placeholders.

### Notes

- No script here supports a uniform help flag across the board; **unknown flags may be ignored and the real
  action executed**. Read each script's header comment before running it.
- Write actions are dry-run by default (`--apply` required).
