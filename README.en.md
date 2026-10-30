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
   The three delivery-gate tools (`dsh-ref-scan` / `dsh-sim-scan` / `dsh-self-audit`), plus
   `dsh-docs-consistency-scan` and `docs-gen-doc-audit`, implement `--help` (rc=0, nothing executed) and
   **reject unknown flags** (rc=2, nothing executed).
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
├── dsh-ref-scan.mjs                  # reference-surface scan: keywords ⇒ 4 carriers ⇒ 4-way disposition table
├── dsh-sim-scan.mjs                  # similarity scan: same-name / byte-identical / ≥90% / 50-90% / <50% / ≥50% share
├── dsh-self-audit.mjs                # pre-delivery self-audit: six mechanical checks
├── config/                           # calibre + word tables (shipped; changing the calibre = changing these)
│   ├── sim-scan.json                 # similarity calibre: 6 extensions + 8 skip dirs + production side + buckets
│   ├── ref-scan.json                 # reference-scan carriers: docs / skills / persona / tools
│   ├── deny-words.txt                # literal layer: must-remove literals (7 categories, ≥1 each)
│   ├── deny-patterns.txt             # literal layer: must-remove regexes (7 categories, counted together)
│   ├── deny-allow.txt                # allow rules: structural false positives only, one reason per line
│   └── baseline-sim-v3o.json         # **example** similarity baseline (shows `--baseline` attribution)
├── lib/
│   ├── dsh-home.mjs                  # DSH home / workspace / report dir resolution
│   ├── generated-docs.mjs            # single source of truth for "auto-generated docs" (pure)
│   ├── rulecheck-rules.mjs           # rule texts and check families
│   ├── cli-args.mjs                  # shared CLI args (--help / unknown flag ⇒ fail closed)
│   ├── deny-literal.mjs              # literal layer: 7 categories + hit judgement + allow rules + tree scan
│   ├── negctl.mjs                    # negative control, four ordered steps
│   ├── ref-scan-core.mjs             # reference scan core (scan-surface evidence / disposition table)
│   ├── sim-scan-core.mjs             # similarity core (multiset subtraction / buckets / baseline attribution)
│   └── self-audit-core.mjs           # the six checks (incl. the three-layer internal-identifier check)
├── _test/                            # 118 assertions, pure fixtures, zero production writes
│   ├── test-ref-scan.mjs
│   ├── test-sim-scan.mjs
│   ├── test-self-audit.mjs
│   ├── test-deny-literal.mjs
│   └── test-negctl.mjs
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

## 3. Root tools (9)

| File | What it does | Real arguments |
|---|---|---|
| `rulecheck.mjs` | Read-only engineering-rule checker: DoD ten items, DoR, defect grading, five-part postmortem, practice comparison | `rulecheck <subcommand> [--file <path>]... [--card <id\|title>]... [--section] [--json] [--fail-on-bad] [--self-test]`; subcommands = `baseline` / `debt` / `all` / `dod` / `dor` / `defect` / `postmortem` / `practice` |
| `check-decoupling.mjs` | Checks whether plugins statically depend on DSH internals, and whether host-adapter copies match their single source (R1–R5) | `node check-decoupling.mjs [--root <dir>] [--json <path>]`; root defaults to `DSH_DECOUPLING_ROOT` or cwd |
| `docs-index-gen.mjs` | Scans `docs\**\*.md` and regenerates the automatic section of a docs index (idempotent; only writes the index file) | `node docs-index-gen.mjs [--apply] [--verify] [--json] [--docs <dir>] [--index <p>] [--overrides <p>] [--date <YYYY-MM-DD>]`; no flags = dry-run |
| `docs-consistency-scan.mjs` | Single-document consistency scan: numbering, citations/headings, list counts, terminology | `node docs-consistency-scan.mjs <doc.md> [--json] [--quiet] [--defs 4.4,5,8] [--lists 5,8,12] [--ignore-own-headings] [--allow-doc-prefix <N>]` |
| `dsh-vocab-guard.mjs` | Session event-vocabulary drift guard: diffs two `known-event-types` sources and scans plugins for bare literals | `node dsh-vocab-guard.mjs [--old <path>] [--new <path>] [--scan-root <dir>] [--no-scan] [--no-out] [--out <file>] [--json <file>] [--quiet] [--save-baseline <p>] [--baseline <p>]` |
| `sync-host-adapter.mjs` | Idempotent sync of host-adapter “single source → per-package derived copies”; `check-decoupling` reuses it for R5 sha comparison | `node sync-host-adapter.mjs [--verify] [--dry-run] [--all] [--json <p>] [--self-test]`; no flags = sync (skips identical content) |
| [`dsh-ref-scan.mjs`](dsh-ref-scan.mjs) | Reference-surface scan: keywords ⇒ four carriers ⇒ four-way disposition table (A fix in place / B add a header pointer / C keep + reason / D needs owner). **The disposition column is left blank for a human** | `node dsh-ref-scan.mjs <keyword...> [--root <dir>] [--config <file>] [--out <file>] [--json] [--case-sensitive] [--snippet <N>]`; `0 hits ⇒ yellow (rc=3)` |
| [`dsh-sim-scan.mjs`](dsh-sim-scan.mjs) | Similarity scan for one repo or a whole repo root: same-name files / byte-identical / ≥90% / 50–90% / <50% / **≥50% line-share** | `node dsh-sim-scan.mjs (--repo <dir> \| --all <dir>) [--prod-root <dir>] [--config <file>] [--baseline <file\|none>] [--detail <repo>] [--out <file>] [--json]` |
| [`dsh-self-audit.mjs`](dsh-self-audit.mjs) | Pre-delivery self-audit: six mechanical checks (DoD block / verbatim command / pending-decision section / internal identifiers in three layers / report exists / cited files exist) | `node dsh-self-audit.mjs <report.md> [--root <dir>] [--machine-report <file>] [--negctl --dir <dir>] [--out <file>] [--json]`; `0 green / 3 yellow / 4 red` |

> `sync-host-adapter.mjs` is a **dependency** of `check-decoupling.mjs` (`verifySummary()` + `SOURCE_LABEL`).
> It performs **structural checks only** (sha/header comparison), never touches credentials or keys. Its default
> target table points at relative paths, so on a machine without that ecosystem it reports `source-missing`
> and writes nothing.

## 4. Shared dependencies · `lib/` (9)

| File | What it does |
|---|---|
| `lib/dsh-home.mjs` | Resolves DSH home / web profile / workspace / report dir (`BUTLER_DSH_HOME > DSH_HOME > ~/.dsh`) |
| `lib/generated-docs.mjs` | Single source of truth for auto-generated docs: 15 families, match patterns, exemption eligibility, insertion point, doc-mark stamping (pure constants + pure functions) |
| `lib/rulecheck-rules.mjs` | Rule families and rule texts used by `rulecheck` |
| `lib/cli-args.mjs` | Shared CLI args: `--help` prints usage with rc=0 and **executes nothing**; an unknown flag exits rc=2 and **never continues** |
| `lib/deny-literal.mjs` | Literal layer: parses and validates the 7 categories (a missing category is red), judges hits, applies allow rules, walks trees |
| `lib/negctl.mjs` | Negative control in four ordered steps: generate outside the repo → copy into the scanned dir → scan and assert hits → clean up in `finally` |
| `lib/ref-scan-core.mjs` | Reference-scan core: scan-surface evidence line, disposition table rendering, excluded-dir hit accounting |
| `lib/sim-scan-core.mjs` | Similarity core: multiset subtraction, three buckets, headline column, baseline diff attribution |
| `lib/self-audit-core.mjs` | The six checks, including the three-layer internal-identifier check |

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

## 5.5 Delivery gate · three tools

All three are **read-only with an optional report**: they print by default, `--out <file>` is the only write point,
and reports belong outside the directory being scanned.

### 5.5.1 `dsh-ref-scan` · reference-surface scan

Given one or more keywords, it scans four carriers (docs / skills / persona / tools — configurable in
`config/ref-scan.json`) and prints a four-way disposition table (`A` fix in place · `B` add a header pointer ·
`C` keep + reason · `D` needs owner). **The machine only lists what to look at** — the disposition column stays
blank for a human.

Three hard rules on the empty state:

1. **0 hits ⇒ yellow** (rc=3): not pass, not red, and it asks a human to confirm the scan surface;
2. **every scan prints a scan-surface evidence line**: carrier list + files scanned per carrier + hit counts —
   **an empty table still prints it**;
3. pair it with a **negative control** (§5.5.4) proving the scanner is not dead.

Hits inside excluded directories (historical snapshots, other workstreams) are **counted and declared separately**:
they never enter the disposition table nor the headline count, but the evidence line says "N more over there" —
otherwise "zero missed" only holds inside an undeclared surface.

### 5.5.2 `dsh-sim-scan` · similarity scan

**The calibre is pinned in `config/sim-scan.json`**; the script carries no second set of defaults.

- **6 extensions**: `.mjs` `.js` `.cjs` `.ps1` `.yml` `.yaml`
- **8 skipped directories**: `node_modules` `.git` `_archive` `_tmp` `generated` `logs` `backups` `snapshots`
- **Production side** = `<proot>/tools` recursively + files directly under `<proot>` (not recursive);
  `<proot>` = `--prod-root` / `$DSH_ROOT` / `~/DSH`
- **Repo side** = each repo recursively (same 6 extensions and 8 skip dirs); only `dsh-*` directories count as repos
- Byte-identical = equal sha256; everything else gets a **line similarity**: non-empty repo lines are subtracted
  from the production namesake as a **multiset** (repetition counts), taking the **best-matching namesake**
- Buckets ≥90% / 50–90% / <50%; headline column = (identical + ≥90% + 50–90%) ÷ same-name = **≥50% line share**
- Verdict: ≥90% near-source copy · ≥50% partial rewrite · <50% rewrite-first · **0 same-name files ⇒ not judgeable**

The header always prints the calibre fingerprint, production side, scan time and **per-repo dirty counts at scan
time** (reading these numbers as "clean-tree numbers" is the classic misread).

With `--baseline` it does **not** demand cell-by-cell equality (repos are alive). It reports the **number of
differing rows** plus a **reproducible reason per row**, limited to three: `time point differs` (no new commit but
dirty tree / newer files), `repo changed` (with a `git log --since` line) and `calibre differs` (with the
fingerprint). Anything else is printed as **unattributed** with rc=3 — no hand-waving.

### 5.5.3 `dsh-self-audit` · pre-delivery self-audit

Six mechanical checks: ① DoD block present (≥10 items, not just a heading) · ② at least one **verbatim command
line inside a fenced block** ("I ran it" does not count) · ③ a pending-decision section whenever unresolved
markers exist · ④ **no internal identifiers (three layers)** · ⑤ the report path exists · ⑥ every file cited in
the body exists (commands inside fenced blocks are not citations — check ② owns those; repo-relative paths whose
first segment is not a directory under the scan root are reported as **skipped**, because the tool cannot know
which repo they belong to).

Exit codes: `0 green` · `3 yellow (insufficient evidence)` · `4 red (do not ship)` · `2 usage`.
⚠️ **"Insufficient evidence" is not a pass**: no injected word table and no negative control both mean yellow.

### 5.5.4 Desensitization in three layers + the four-step negative control

1. **Machine layer** — the authoritative scanner returns rc=0 with `review=0` **and the P0 word table was actually
   injected** (`--deny-file`). If its report says "P0 not enabled / this scan is incomplete", the layer **fails —
   regardless of rc** (without the table the scanner still reports `hits=0`).
2. **Falsification layer** — the negative control, four ordered steps (`dsh-self-audit --negctl --dir <repo>`):
   (a) generate a sample with one line per category at a **fixed path outside the repo**
   (`%TEMP%/oss-negative-control/<repo>.txt`); (b) copy it **into the scanned directory** under a unique sentinel
   name `.negctl-<runId>.txt`; (c) scan that directory **without** excluding the sentinel and assert that all
   seven categories hit (the three core ones — device tag, drive/host, batch/card — are mandatory);
   (d) delete sentinel and sample in `finally`, rescan to assert zero hits, and check `git status` is untouched.
   Because the sample lives outside and the scanner excludes that path, "the scanner must go red" is otherwise
   **impossible to verify** — it would never read the sample.
3. **Literal layer** — the tables ship **inside the repo** (`config/deny-words.txt` + `config/deny-patterns.txt`),
   with at least seven categories: device-tag prefix / `第 ?N ?棒` batch numbers / `卡 <digits>` card ids /
   quoted mainline names / internal report-name pattern / host names and aliases / drive letters and private ports.
   **Every category needs at least one entry; a missing category is red** ("non-empty" is not enough).

A hit is not automatically red: hits inside fenced blocks, inline backticks or block quotes are recorded as
allowed (verbatim command / cited evidence / quoted excerpt). `config/deny-allow.txt` holds **structural** allow
rules with a written reason per line (e.g. synthetic drive letters in fixtures) — never for real private
identifiers. Put your own private words in `config/deny-words.local.txt` (gitignored); the scanner merges it.

---

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
