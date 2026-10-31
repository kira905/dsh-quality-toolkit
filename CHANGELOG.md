# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

### Added

- **`config/deny-allow.txt` 支持可选第 4 列「值锚」** — an allow rule may now anchor on the **matched text**:
  `drive-port <TAB> ** <TAB> <reason> <TAB> 127.0.0.1:3080` allows exactly that one literal and nothing else.
  Why: some false positives are **value-level** (a loopback address + a component's public default port, a
  synthetic drive letter), and a path glob can only express "allow this whole file / directory" — which is the
  real loosening. Anchored rules keep the gate tight: another port or another host still lands in `review`.
  Backward compatible: 3-column rules behave exactly as before, and a rule that carries an anchor never fires
  when the matched text is not supplied (conservative). `configuredAllow()` gained the optional `matchedText`
  argument, and every hit now carries `matched` alongside `masked`. Unit tests: `_test/test-deny-literal.mjs` E1–E7.
- **`config/deny-allow.txt` 值锚定条目** — loopback + the public default ports of our own components
  (DSH web / isolated instance / canary / local encode bridge / local ComfyUI / local proxy core), the synthetic
  `X:` drive, and the files that must contain the device-tag **format** because they audit it. Each line states
  its reason; no real machine name, account or report name is being allowed.
- **注释面中性化**（K-6）：仓内注释不再出现内部任务号 / 批次号 / 内部交付报告名 / 内部主线名 /
  设备标字面量；只动注释与文档，参数名、缺省值、退出码、输出结构一字节未动（8 个单测文件读数与改前一致）。

- **`dsh-plan-gate.mjs`** — plan-review gate. Given a plan document it prints the sha256 of the **body**
  (anchor lines dropped, BOM stripped, CRLF→LF) and judges four states: `pass` / `stale` / `missing` / `fail`
  (`--check` rc 0 / 1 / 3 / 4). Writes are **dry-run by default**: `--pass` / `--fail` land an anchor line only with
  `--apply`, and there is **ever only one anchor line** (same `kind` / `round` / `actor` / `independent` / body sha
  ⇒ byte-identical file, not even written).
  The anchor carries `actor=` (who signed) and `independent=` (whether the signer is independent of the author; value
  domain `yes` / `no`); `--check --require-independent` reports **`missing` (rc 3)** when a pass anchor exists but the
  signer is not independent. ⚠️ **The default does not check the stance**: without that flag an author-signed anchor is
  still `pass`, which means only "somebody signed" — stated explicitly in `--help` and the README.
  Concurrency: external-snapshot CAS (`--expect-sha`), a re-read right before the write, and a read-back right after
  it (anchor line + body sha). A read-only file, a failed write, or two sessions writing at once all yield `stale`
  **without overwriting**, with the errno / reason code printed as is.
- **`lib/plan-gate-core.mjs`** — core behind the gate: body normalization, four-state judgement, anchor parse / place /
  write, idempotence, race handling. `node:` built-ins only.
- **`config/plan-gate.json`** — gate calibre: where the anchor goes (before the first `##`), what counts as a `##`
  heading, who may sign (`any` / `list` + allow-list), and whether independence is required by default (`false`).
- **`_test/test-plan-gate.mjs`** — 109 assertions: the four states, body normalization (CRLF ⇄ LF and BOM are *not*
  changes, one character is), idempotence (three writes ⇒ still one anchor line, byte-identical file), separation of
  duties (both directions, plus "the default does not check the stance" as an executable assertion), the three race
  cases, anchor placement (including CRLF and BOM preservation), calibre overrides, and the CLI exit-code matrix
  (including `--help` / dry-run writing nothing). It also runs **three mutation tests** — disable the independence
  check, turn idempotence into appending, disable the read-back — and each mutant must turn a named assertion red.
- **`dsh-ref-scan.mjs`** — reference-surface scan. Given keywords, scans four carriers (docs / skills / persona /
  tools, configurable in `config/ref-scan.json`) and prints a four-way disposition table
  (`A` fix in place · `B` add a header pointer · `C` keep + reason · `D` needs owner). The disposition column is
  **left blank for a human**; the machine only lists what to look at. **0 hits ⇒ yellow (rc=3)**, every scan prints
  a scan-surface evidence line (also for empty tables), and hits inside excluded directories are counted and
  declared separately.
- **`dsh-sim-scan.mjs`** — similarity scan for one repo (`--repo`) or a whole repo root (`--all`): same-name files /
  byte-identical / ≥90% / 50–90% / <50% / **≥50% line share** (headline column). Calibre pinned in
  `config/sim-scan.json` (6 extensions, 8 skipped dirs, production side, buckets); line similarity uses
  **multiset subtraction** and takes the best-matching namesake. Header always prints per-repo dirty counts.
  `--baseline` reports **the number of differing rows with a reproducible reason per row**, limited to
  `time point differs` / `repo changed` / `calibre differs`; anything else is **unattributed** with rc=3.
- **`dsh-self-audit.mjs`** — pre-delivery self-audit with six mechanical checks (DoD block, verbatim command,
  pending-decision section, internal identifiers, report exists, cited files exist). The identifier check runs in
  **three layers**: machine layer (the word table must actually be injected; "P0 not enabled" fails regardless of
  rc), falsification layer (negative control), literal layer (7-category tables shipped in `config/`).
- **`config/`** — calibre and word tables shipped with the package: `sim-scan.json`, `ref-scan.json`,
  `deny-words.txt`, `deny-patterns.txt`, `deny-allow.txt`, `baseline-sim-v3o.json`.
- **`lib/deny-literal.mjs`, `lib/negctl.mjs`, `lib/ref-scan-core.mjs`, `lib/sim-scan-core.mjs`,
  `lib/self-audit-core.mjs`** — the shared cores behind the three tools.
- **`_test/`** — 118 assertions across five fixtures (`test-ref-scan` 23 · `test-sim-scan` 27 ·
  `test-self-audit` 29 · `test-deny-literal` 23 · `test-negctl` 16); pure fixtures in the OS temp dir, zero
  production writes.

### Changed

- `package.json` bumped to **0.2.0** (version only — **not published** with this change) and `dsh-plan-gate` added to
  `bin`. README (zh + en) gained a "Design basis" section at the top and a `5.6` section for the gate.
- Comments only: four leftover internal markers removed from `docs-index-gen.mjs`, `check-decoupling.mjs`,
  `dsh-l3-pitfall-reminder/install.mjs` and `dsh-l3-pitfall-reminder/README.md` (no behaviour change; the
  literal-layer scanner found them — earlier published snapshots carried them).

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
