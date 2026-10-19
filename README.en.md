# dsh-quality-toolkit · quality & rules tooling for DeepSeek Harness (DSH)

> The read-only checkers actually used along the DSH **plan → review → rework → evidence → release** chain:
> **engineering-rule checks** (DoD / DoR / defect grading / postmortems / practice comparison),
> **documentation-discipline judges**, a **docs index generator**, a **vocabulary drift guard**,
> a **decoupling checker**, plus an **L3 realtime pitfall-reminder plugin**.
>
> Node.js **≥ 20**, **zero third-party runtime dependencies** (only `node:` built-ins). Windows-first
> (paths and encoding follow Windows conventions).

---

## ⚠️ Read this first

1. **There is no single “help command” you can use to explore this repo.** Some scripts do implement a help
   output; **others silently ignore unknown flags and then execute their real action**. We have hit exactly
   that: running a snapshot export script with an unknown flag exported a full snapshot instead of printing help.
   ⇒ **Read the header comment block of the script you are about to run** (every script documents usage,
   semantics and exit codes in its first 10–40 lines), or use the per-file table below.
2. **Every write action is dry-run by default.** `docs-index-gen`, `archive-rounds` and `install.mjs` only print a
   plan unless you pass `--apply`; the `l3-reminder` switch also needs `--apply`.
   **Do not treat “just run it to see” as read-only.**
3. **The checkers are read-only** (`rulecheck` / `check-*` / `scan-four` / `docs-consistency-scan` / the whole
   `docs-discipline` set): they read files and print/report, never modify the documents they inspect.
4. No tool here performs network requests or reads credential files.

---

## 1. Environment & install

```powershell
# Node 20+; no npm install needed (zero dependencies)
node --version

# Run in place (prefer self-test / read-only modes first)
node rulecheck.mjs dod --file <report.md>
node docs-consistency-scan.mjs <doc.md> --json

# Or install globally and use the bin names
npm i -g @kira905/dsh-quality-toolkit
rulecheck dod --file <report.md>
```

### Environment variables (all optional)

| Variable | Meaning | Default |
|---|---|---|
| `DSH_ROOT` | DSH workspace root (the tree holding `docs\`, `tools\`, `_archive\`) | `~/DSH` |
| `DSH_HOME` / `BUTLER_DSH_HOME` | DSH home (`profiles\web` lives here; the L3 switch file too) | `~/.dsh` |
| `DSH_DECOUPLING_ROOT` | Scan root for `check-decoupling` | current working directory |
| `DSH_L3_PITFALL_DOCS` | Pitfall library directory for the L3 plugin | `<DSH_ROOT>/docs/坑库` |
| `DSH_OLD_PKG` / `DSH_NEW_PKG` | Two package paths for `dsh-vocab-guard` vocabulary probing | auto-detected npm global dir |
| `AUTODOC_PROD_ROOT` | Reference data root for `docs-discipline/_test` | current working directory |

> These tools grew inside a private work tree. The published build replaced every machine-absolute path with
> `DSH_ROOT` / `os.homedir()` / environment variables plus relative paths. Set `DSH_ROOT` first, otherwise the
> defaults look for `docs\` under `~/DSH`.

---

## 2. Repository layout (all files)

```
dsh-quality-toolkit/
├── rulecheck.mjs                     # engineering-rule checker (DoD/DoR/defect/postmortem/practice)
├── check-decoupling.mjs              # plugin ↔ core decoupling checks (R1–R5)
├── docs-index-gen.mjs                # docs index generator (read-only scan + idempotent write)
├── docs-consistency-scan.mjs         # single-document consistency scan
├── dsh-vocab-guard.mjs               # session event-vocabulary drift guard
├── sync-host-adapter.mjs             # host-adapter source → derived copies sync/verify (dependency)
├── lib/
│   ├── dsh-home.mjs                  # DSH home / workspace / report dir resolution
│   ├── generated-docs.mjs            # single source of truth for "auto-generated docs" (pure)
│   └── rulecheck-rules.mjs           # rule texts and check families
├── docs-discipline/                  # 13 document-discipline checkers + 2 shared libs + 2 unit tests
│   ├── README.md                     # full semantics for this set (output shape / values / scope / exit codes)
│   ├── archive-rounds.mjs
│   ├── check-caliber.mjs
│   ├── check-cites.mjs
│   ├── check-cites-exist.mjs
│   ├── check-promises.mjs
│   ├── check-residue.mjs
│   ├── check-rootcause.mjs
│   ├── check-rounds.mjs
│   ├── check-selfclaim.mjs
│   ├── check-volume.mjs
│   ├── gen-doc-audit.mjs
│   ├── scan-four.mjs
│   ├── selfcheck-rerun.mjs
│   ├── lib/
│   │   ├── common.mjs                # arg parsing / help block / self-test scaffold / tmp dirs
│   │   └── dispatch.mjs              # subcommand dispatch
│   └── _test/
│       ├── test-generated-docs.mjs
│       └── test-stamp-doc-mark.mjs
└── dsh-l3-pitfall-reminder/          # DSH plugin: L3 realtime pitfall reminder (off by default)
    ├── package.json
    ├── README.md
    ├── install.mjs                   # install/uninstall into a DSH profile (dry-run by default)
    ├── bin/
    │   └── l3-reminder.mjs           # CLI: status / switch / match / tail
    ├── lib/
    │   ├── index.js                  # plugin entry (apply + tools/post-execute hook)
    │   ├── core.mjs                  # signature normalization / matching / reminder text
    │   ├── normalize.mjs             # error-text normalization (ported semantics, no upstream import)
    │   └── store.mjs                 # pitfall store index / switch / log
    └── _test/
        └── test-core.mjs             # pure unit tests (30 cases, in-memory end-to-end fixtures)
```

---

## 3. Root tools (6)

| File | What it does | Real arguments |
|---|---|---|
| `rulecheck.mjs` | Read-only engineering-rule checker: DoD ten items, DoR, defect grading, five-part postmortem, practice comparison | `rulecheck <subcommand> [--file <path>]... [--card <id\|title>]... [--section] [--json] [--fail-on-bad] [--self-test]`; subcommands = `baseline` / `debt` / `all` / `dod` / `dor` / `defect` / `postmortem` / `practice` |
| `check-decoupling.mjs` | Checks whether plugins statically depend on DSH internals, and whether host-adapter copies match their single source (R1–R5) | `node check-decoupling.mjs [--root <dir>] [--json <path>]`; root defaults to `DSH_DECOUPLING_ROOT` or cwd |
| `docs-index-gen.mjs` | Scans `docs\**\*.md` and regenerates the automatic section of a docs index (idempotent; only writes the index file) | `node docs-index-gen.mjs [--apply] [--verify] [--json] [--docs <dir>] [--index <p>] [--overrides <p>] [--date <YYYY-MM-DD>]`; no flags = dry-run |
| `docs-consistency-scan.mjs` | Single-document consistency scan: numbering, citations/headings, list counts, terminology | `node docs-consistency-scan.mjs <doc.md> [--json] [--quiet] [--defs 4.4,5,8] [--lists 5,8,12] [--ignore-own-headings] [--allow-doc-prefix <N>]` |
| `dsh-vocab-guard.mjs` | Session event-vocabulary drift guard: diffs two `known-event-types` sources and scans plugins for bare literals | `node dsh-vocab-guard.mjs [--old <path>] [--new <path>] [--scan-root <dir>] [--no-scan] [--no-out] [--out <file>] [--json <file>] [--quiet] [--save-baseline <p>] [--baseline <p>]` |
| `sync-host-adapter.mjs` | Idempotent sync of host-adapter “single source → per-package derived copies”; `check-decoupling` reuses it for R5 sha comparison | `node sync-host-adapter.mjs [--verify] [--dry-run] [--all] [--json <p>] [--self-test]`; no flags = sync (skips identical content) |

> `sync-host-adapter.mjs` is a **dependency** of `check-decoupling.mjs` (`verifySummary()` + `SOURCE_LABEL`).
> It performs **structural checks only** (sha/header comparison), never touches credentials or keys. Its default
> target table points at relative paths, so on a machine without that ecosystem it reports `source-missing`
> and writes nothing.

## 4. Shared dependencies · `lib/` (3)

| File | What it does |
|---|---|
| `lib/dsh-home.mjs` | Resolves DSH home / web profile / workspace / report dir (`BUTLER_DSH_HOME > DSH_HOME > ~/.dsh`) |
| `lib/generated-docs.mjs` | Single source of truth for auto-generated docs: 15 families, match patterns, exemption eligibility, insertion point, doc-mark stamping (pure constants + pure functions) |
| `lib/rulecheck-rules.mjs` | Rule families and rule texts used by `rulecheck` |

## 5. `docs-discipline/` · 13 document-discipline judges

Full semantics (output shape / value scope / exit codes) live in **[`docs-discipline/README.md`](docs-discipline/README.md)** (Chinese).

| File | What it does | Real arguments |
|---|---|---|
| `archive-rounds.mjs` | Moves historical review rounds out of a document into an archive dir (dry-run default) | `--doc <doc> --keep-lines <N> [--apply --archive <dir>] [--json] [--self-test]` |
| `check-caliber.mjs` | Checks that numeric “calibre” values stay consistent across changed lines | `--scope --doc <plan>` ｜ `--doc <plan> --changed <line set> [--old <values.json>] [--json] [--self-test]` |
| `check-cites.mjs` | Verifies that citations claimed as fixed in a rework report really exist in the plan | `--doc <plan> --report <rework report> [--section <heading substring>] [--only-window] [--json] [--self-test]` |
| `check-cites-exist.mjs` | Reconciles a citation list against reality (file / line / content) | `--list <list file> [--section <x>] [--root <dir>] [--min-token-hit 0.8] [--dump] [--json] [--log <file>] [--self-test]` |
| `check-promises.mjs` | Reconciles promised changes in a plan against a claims table | `--doc <plan> --claims <claims.json\|.md> [--json] [--self-test]` |
| `check-residue.mjs` | Scans for stale old values after a rework (using a pre-rework snapshot) | `--doc <plan> --report <rework report> --snapshot <dir> [--values <extra.json>] [--json] [--self-test]` |
| `check-rootcause.mjs` | Reconciles a root-cause family table against a fixture directory | `--doc <plan> --families <families.json> --fixture <dir> [--json] [--self-test]` |
| `check-rounds.mjs` | Checks review-round structure (continuous numbering, each round has four parts) | `--doc <review doc\|rework report> [--ledger <ledger.json>] [--json] [--self-test]` |
| `check-selfclaim.mjs` | Reconciles a rework report's claimed changes against `git diff` | `--report <rework report> --diff <diff> [--section <heading substring>] [--json] [--self-test]` |
| `check-volume.mjs` | Reports document volume (lines / sections) for a round or the latest round | `--doc <review doc\|rework report> --round <N\|last> [--json] [--self-test]` |
| `gen-doc-audit.mjs` | Reconciles the auto-generated-docs family table against reality | `[--docs <dir>] [--root <dir>] [--json] [--log <file>] [--self-test]` |
| `scan-four.mjs` | Thin wrapper around `docs-consistency-scan.mjs` (**always exits 0**, report-only) | `--doc <doc> [--defs 4.4,5,8] [--lists 5,8,12] [--ignore-own-headings] [--allow-doc-prefix <N>] [--json] [--self-test]` |
| `selfcheck-rerun.mjs` | Records one full self-check run and replays it later as evidence | `--record --doc <doc> --manifest <manifest.json> --out <dir>` ｜ `--replay --doc <doc> --manifest <manifest.json> --artifacts <dir> [--stage1 <line set>] [--self-test]` |

| Support file | What it does |
|---|---|
| `docs-discipline/lib/common.mjs` | Arg parsing, help block, self-test scaffold, temp dirs, assertions |
| `docs-discipline/lib/dispatch.mjs` | Subcommand dispatch |
| `docs-discipline/_test/test-generated-docs.mjs` | Family table / normalization / insertion-point tests (**reads production docs**; set `AUTODOC_PROD_ROOT`) |
| `docs-discipline/_test/test-stamp-doc-mark.mjs` | Doc-mark stamping tests (also reads production docs) |

## 6. `dsh-l3-pitfall-reminder/` · L3 realtime pitfall-reminder plugin

When a tool call fails and its normalized error signature matches an archived pitfall, the plugin injects one
advisory context message into the **current session** (off by default).

| File | What it does |
|---|---|
| `dsh-l3-pitfall-reminder/package.json` | Plugin manifest (`type: module`, zero third-party deps) |
| `dsh-l3-pitfall-reminder/README.md` | Install/uninstall, switch, CLI usage (Chinese) |
| `dsh-l3-pitfall-reminder/install.mjs` | Installs/uninstalls into a DSH profile: `[--apply] [--rollback] [--home <dir>] [--profile web] [--mode copy\|link]` (**dry-run default**; a restart is needed to load it) |
| `dsh-l3-pitfall-reminder/bin/l3-reminder.mjs` | CLI: `--status` / `--on --apply` / `--off --apply` / `--dry-run on --apply` / `--tail <N>` / `--match <text> [--name --code --tool]` / `--docs-root <dir>` / `--home <dir>` |
| `dsh-l3-pitfall-reminder/lib/index.js` | Plugin entry: `apply(ctx)` registers `tools/post-execute`; internal errors never escape into the waterfall |
| `dsh-l3-pitfall-reminder/lib/core.mjs` | Signature normalization, pitfall matching, reminder rendering |
| `dsh-l3-pitfall-reminder/lib/normalize.mjs` | Error-text normalization (ported semantics, no upstream import ⇒ zero external deps) |
| `dsh-l3-pitfall-reminder/lib/store.mjs` | Pitfall store index, switch file, JSONL log |
| `dsh-l3-pitfall-reminder/_test/test-core.mjs` | Pure unit tests (30 cases, in-memory end-to-end fixtures) |

> The plugin hooks a **public DSH plugin API** (`ctx.on('tools/post-execute')`) and imports no private internals.
> Its switch is `<DSH_HOME>/butler-l3-reminder.json`, read on every call (no restart needed), **off by default**.

---

## 7. Relationship to DSH

- **Plain CLI (run without DSH)**: `rulecheck`, `docs-consistency-scan`, `docs-index-gen`, `dsh-vocab-guard`,
  `docs-discipline/*`, `sync-host-adapter`.
- **Rely on DSH conventions** (read `docs\` / `profiles\web\`): `check-decoupling`, `sync-host-adapter`.
- **A DSH plugin**: only `dsh-l3-pitfall-reminder`.

## 8. Known limitations

- Windows-first paths (`\`, drive letters, `\r\n`); path-oriented checks degrade on Linux/macOS.
- Some `_test` cases read production docs / the production pitfall store (read-only) for comparison; on a clean
  machine they take the `skip` branch or fail on data drift — expected.
- `rulecheck`'s rule texts (`lib/rulecheck-rules.mjs`) encode one team's workflow; swap the rule table for yours.

## 9. License

**AGPL-3.0-only + commercial license (dual licensing)**:

- Open source: follow [`LICENSE`](LICENSE) (GNU Affero General Public License v3.0).
- Commercial: if AGPL's source-disclosure obligations do not fit, a commercial license is available
  (contact the repository owner).
- No code here is forked from another project; `docs-discipline/lib/normalize.mjs` is a semantics port with an
  independent implementation.

## 10. Provenance

These scripts come from a long-running private DSH work tree and were split out into this repository in 2026-10.
The publication pass did: **read-only copy** (sources untouched) · **dependency closure** (`lib/` 3 files +
`sync-host-adapter.mjs`) · **sanitization** (drive-letter paths → `DSH_ROOT` / placeholders; host and user names →
generic placeholders) · skeleton completion. Behaviour matches the sources; only path resolution and defaults
were made environment-driven.
