# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.3.0] - 2026-11-06

> 本版**只加一件工具**：`write-action-check`（写动作登记校验器）。它是本仓第一个判断
> **「谁在写这个文件 / 这张表，登记得对不对」** 的件 —— 先写一份登记表说明谁写，再用静态扫描核对：
> 在写却没登记 ⇒ 🔴 未登记；登记了却不写了 ⇒ 🟡 登记过期。只读、零依赖、22 条自带用例（含阴性对照）。

### Added

- **`write-action-check.mjs`** — 写动作登记校验器（只读：只读盘、不写任何生产状态、不接线）。
  - **载体唯一键 = `实例|规范化绝对路径`**（表再加 `#表名`）。多机各一份登记表时，同一个相对路径在 A 机 / B 机
    上是**两个键** —— 这是「三份同名 state.json 不许混味」的机械判据；对端载体写 `peer://<实例>/<路径>`，
    前缀实例名与条目 `instance` 不符即结构红。
  - **写者枚举解析写调用的目标表达式**，不是「文件里出现载体名」（后者会把提到该名字的 60+ 个模块全算成写者）。
    目标藏在常量 / 标识符里也能回查（最多 3 层）；`openSync(p,'a')` + `writeSync` 这类追加写、以及
    `updateJson()` 这类**读-改-写**委派入口都算写，`readJson()` / `loadJson()` 绝不算（有阴性对照盯着）。
  - **表级载体**（`carrierKey` 带 `#表` + `writerScope:'table'`）走三条信号：T1 直接 SQL 写 / T2 注入词
    （`--<载体>-db`、`<X>_DB` 形态）+ 模块内有写动作 / T3 薄壳 CLI import 了写入口函数（写其实在 lib 里）。
    SQL 判据要求**语句形**：`UPDATE <表> … SET` 才算，`crypto.update(` / `update:` 不算。
  - **地板 + 持续契约**：`meta.baseline` 记现值、`meta.floor` 记下限（`--floor-total` 可覆盖总条数）。
    只判「baseline ≥ 地板」+「baseline 与实际计数一致」，不把持续契约钉成一次性快照。
  - **覆盖边界必须自己声明**（`meta.outOfScope`：不覆盖什么 / 为什么 / 谁监督），且必须机械覆盖三类
    （内核写会话日志 / 跨机写对端盘 / 运行时动态拼路径）；**判不了有硬上限**（`meta.unjudgeable` ≤ 8，
    每条要 owner），**超限整体判红** —— 防「把说明填满就变绿」。
  - `--selftest` 22 条；`--json` / `--dump-actual` 只读；`--help` rc=0、未知参数 rc=2。
- **`_test/写动作登记示例.json`** — 登记表结构与字段示例：`carrierPath` / `writers` **全是占位符**
  （`<DSH_HOME>/...`、`tools/example-*.mjs`），照它的形状写自己的表，再用 `--registry` 指过去。
- bin 名 **`write-action-check`**（`--help` 打全量参数）。

### Changed（去私有化 · 与本仓 0.2.1 的「注释面中性化」同口径）

提炼自一件内部工具，进仓前做了四类去私有化，**判据一条没放宽**（等价性证据见下）：

- **内部命名 → 入参**：实例名 / 认领人不再写死在代码里，走 `--instance` / `--owner`（env `DSH_INSTANCE` /
  `DSH_OWNER`，缺省中性值 `local` / `unassigned`）；自建插件白名单从 20 个硬编码包名改为
  `--self-plugins a,b,c` / `DSH_SELF_PLUGINS`，**缺省为空 ⇒ 该扫描根不启用**（每台机器装的插件都不同，
  硬编码名单对别人只会把真写者全漏掉）。
- **盘符路径 → 参数 / env**：登记表 `--registry`（缺省 cwd 下 `写动作登记.json`，或 `DSH_REGISTRY`）；
  扫描根 `--root`（可多值）/ `DSH_HOME`；注释与用法示例里不再出现任何盘符。
- **台账耦合 → 中性夹具**：对端载体样例从真实实例名 + 真实状态文件路径，改成 `peer://remote-node/agent/state.json`。
- **注释面中性化**：内部方案 §编号、内部任务卡号、复核编号、内部真源文档名一律不再出现在注释里。
- `meta.floor` / `--floor-total`：把「地板」从写死的常量变成可覆盖（缺省值不变），别的项目不必凑够 51 条才能绿。

### Notes

- **行为等价性**：同一份内部登记表、同一批扫描根下，提炼件与生产件的 **8 条红逐条文本一致**；
  扫描面 2457 件 + 111 件（profile 子树）= 2568 件，与生产件读数一致。差异只有一处口径：生产件把
  「tools 根」钉在一个盘、「profile 根」钉在 `~/.dsh`（两个家），本仓统一走 `DSH_HOME` + `--root`。
- **它判不了什么**：运行时动态拼出来的路径、别的进程 / 别的机器写的、以及 `--root` 之外的目录 —— 这些必须写进
  `meta.outOfScope` 明说，而不是假装全覆盖（README §5.7「已知限制」同上）。

## [0.2.1] - 2026-10-31

> 本版**已发布到 npm**（`latest = 0.2.1`）。它是 0.2.0 的修复重发：registry 上那份 0.2.0 的
> `dsh-vocab-guard` 一启动就崩（见 Fixed 第一条），而下面 Added 的条目在 0.2.0 落仓时就已写好、
> 随本版首次真正到达用户（含允许规则的第 4 列「值锚」与注释面中性化）。

### Fixed

- **`dsh-vocab-guard.mjs` 一启动就崩（0.2.0 的致命回归，也是本版唯一的动因）** —
  `DEFAULT_OUT` 用了 `os.tmpdir()`，文件头却只 import 了 `fs` / `path` / `url`，缺 `import os from 'node:os'`
  ⇒ 任何调用（包括 `--help`）当场 `ReferenceError: os is not defined`。旧发布件就是这个状态：
  装得上、跑不起来。已补 import；`node --check` rc=0、`node dsh-vocab-guard.mjs --help` rc=0。
  **发布判据因此加两条**：发前必须在本地真跑一次坏件；发后必须从 registry 把 tarball 拉下来再真跑一次
  —— `npm publish` 的成功回执不代表包能跑。

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
