# dsh-quality-toolkit · DSH 质检与规则工具包

> 本仓**主包**是命令行工具（**24 个命令**，`npm i -g @kira905/dsh-quality-toolkit` 即可），但**它还带一个默认关的插件子包** `dsh-l3-pitfall-reminder`（`private: true`，随主包 tarball 一起到，不是独立包）—— 要用它得在 profile 的 `cordis.patch.yml` 里手工 `insert` 一行，见下文；`npm i -g` 装完**不会**自动带走这一步。

## 装完自检（三条只读验法）

`<profile>` 换成你实际用的 profile（默认 `web`），`<数据根>` 换成你的 DSH 数据根（默认 `~/.dsh`）。

```powershell
# ① 组合树里有没有它（只读、约 0.6 秒、不启服务）
dsh --profile <profile> --dump-config | Select-String "dsh-quality-toolkit"
# 期望：bundle 层出现一行 "# == <登记名>"、insert 层出现 "- id: <entry>"（问的都是「它挂上没」）；
#       本仓包名 @kira905/dsh-quality-toolkit —— 带 scope 装的写带 scope 名、老工装 / 手写的可能是裸名，两种都搜一遍
#       ⚠️ 若该包会 insert 一行，还要数一遍"同一个 id 出现了几次"，必须 == 1

# ② 组合列表里有没有它（只读）
Get-Content <数据根>/profiles/<profile>/package.json | Select-String "@kira905/dsh-quality-toolkit"
# 期望：dependencies 与 dsh.profile.bundles 两处都有（CLI 类只需要 dependencies；bundles 里也可能写裸名 dsh-quality-toolkit）

# ③ 命令在不在 —— 【只查存在，不执行】
Test-Path <数据根>/profiles/<profile>/node_modules/.bin/rulecheck.CMD   # 装进 profile 的
Test-Path "$env:APPDATA\npm\rulecheck.CMD"                           # npm i -g 装的
# 期望：True。两条路径按你实际用的装法挑一条
```

> 探针只做存在性检查（只看命令文件在不在，不执行任何命令）。
> 要不要用 `--help` 验，见本仓当前说明与该命令的参数表。

---

> DeepSeek Harness（DSH）生态里「**写方案 → 审核 → 回修 → 出证 → 封版**」这条链上真正在用的
> 一组只读校验器：**工程规则校验**（DoD / DoR / 缺陷分级 / 复盘 / 惯例对照）、**文档纪律判据**、
> **文档总索引生成**、**词表漂移守卫**、**解耦检查**，外加一个 **L3 实时坑库提醒插件**。
>
> 全部 **Node.js ≥ 20**、**零第三方运行时依赖**（只用 `node:` 内置模块）。Windows 优先，路径与编码口径按 Windows 写。

---

## 设计依据

本仓的判据不是凭空定的：每组判据对应一篇方法稿，脚本只负责把它变成可复跑的命令，不另立一套口径。

| 能力 | 设计依据 |
|---|---|
| 方案过审闸（见 5.6） | 《设计稿审核规程》（文档集第 04 篇）：审核轮次、过审凭据、回修闭环怎么组织 |
| 交付闸三件（见 5.5） | 《文档体系口径一致性审核》（文档集第 08 篇）：引用面与一致性审核的判据面 |

> 设计稿来自同一套长期运行的工程流程；随本仓开源时只保留方法，不含任何环境细节。

---

## ⚠️ 先读这段（比任何用法都重要）

1. **帮助命令只覆盖一部分脚本。** 2026-10-30 起 `dsh-docs-consistency-scan`、`docs-gen-doc-audit`、**交付闸三件**
   （`dsh-ref-scan` / `dsh-sim-scan` / `dsh-self-audit`）以及**方案过审闸** `dsh-plan-gate` 支持 `--help`（打印用法、退出码 0）与**未知参数拒收**（退出码 2，绝不继续执行）；
   `rulecheck` / `check-decoupling` 本来就有帮助输出。其余历史脚本仍可能**静默忽略**未知参数、
   然后**直接执行真动作**。
   ⇒ **不确定就先读该脚本头部的注释块**（本仓每个脚本头 10~40 行都写了用法、口径与退出码），
   或者先翻本文件的逐件表。
2. **写动作一律默认 dry-run。** `docs-index-gen`、`archive-rounds`、`install.mjs` 不加 `--apply` 只打印计划；
   `l3-reminder` 改开关也要 `--apply`。**别把「跑一下看看」当成只读**。
3. **检查器是只读的**（`rulecheck` / `check-*` / `scan-four` / `docs-consistency-scan` / `docs-discipline` 全套）
   —— 它们只读文件、只打印/落报告，不改被检查的文档。
4. 本仓工具**不做任何网络请求、不读凭据文件**。

---

## 1. 环境与安装

```powershell
# Node 20+；无需 npm install（零依赖）
node --version

# 直接用（推荐先跑自测/只读模式）
node rulecheck.mjs dod --file <报告.md>
node docs-consistency-scan.mjs <doc.md> --json

# 或者装到全局用 bin 名
npm i -g @kira905/dsh-quality-toolkit
rulecheck dod --file <报告.md>
```

### 环境变量（都可选）

| 变量 | 含义 | 缺省 |
|---|---|---|
| `DSH_ROOT` | DSH 工作区根（放 `docs\`、`tools\`、`_archive\` 的那棵树） | `~/DSH` |
| `DSH_HOME` / `BUTLER_DSH_HOME` | DSH home（`profiles\web` 所在处；L3 插件开关也在这里） | `~/.dsh` |
| `DSH_DECOUPLING_ROOT` | `check-decoupling` 的扫描根 | 当前工作目录 |
| `DSH_L3_PITFALL_DOCS` | L3 插件的坑库目录 | `<DSH_ROOT>/docs/坑库` |
| `DSH_OLD_PKG` / `DSH_NEW_PKG` | `dsh-vocab-guard` 词表探测的两侧包路径 | 自动探测 npm 全局目录 |
| `AUTODOC_PROD_ROOT` | `docs-discipline/_test` 的对照数据根 | 当前工作目录 |

> 这些工具原本长在一棵私有工作树里，**发布版把所有本机绝对路径改成了 `DSH_ROOT` / `os.homedir()` / 环境变量 + 相对路径**。
> 第一次在自己机器上用，先设 `DSH_ROOT`，否则默认会按 `~/DSH` 找 `docs\`。

---

## 2. 仓库结构（全量文件）

```
dsh-quality-toolkit/
├── rulecheck.mjs                     # 工程规则只读校验（DoD/DoR/缺陷/复盘/惯例）
├── check-decoupling.mjs              # 插件↔内核解耦检查（R1–R5）
├── docs-index-gen.mjs                # docs 总索引生成器（只读扫描 + 幂等写入）
├── docs-consistency-scan.mjs         # 文档一致性四扫（编号/引用/列表）
├── dsh-vocab-guard.mjs               # 事件词表漂移守卫
├── sync-host-adapter.mjs             # 宿主适配层「唯一源 → 派生副本」同步/校验（依赖件）
├── dsh-ref-scan.mjs                  # 引用面扫描：关键词 ⇒ 四类载体 ⇒ 四类处置表（A/B/C/D 留空给人填）
├── dsh-sim-scan.mjs                  # 同源度扫描：同名件 / 逐字节同 / ≥90% / 50–90% / <50% / ≥50% 行同占比
├── dsh-self-audit.mjs                # 交付前自批：六条机械判据（DoD / 命令原文 / 待拍板 / 内部标识 / 路径）
├── dsh-plan-gate.mjs                 # 方案过审闸：正文字节 sha ⇒ 四态（pass/stale/missing/fail）+ 幂等锚点
├── config/                           # 四件器具的口径与词表（随仓发布；改口径 = 改这里）
│   ├── sim-scan.json                 # 同源度口径：6 类扩展名 + 8 个 skip 目录 + 生产面 + 分档阈值
│   ├── ref-scan.json                 # 引用面载体：文档 / 技能 / 人设 / 工具 + 各自排除目录
│   ├── plan-gate.json                # 过审闸口径：锚点落位 / ## 约定 / 谁能签 / 缺省是否要求独立
│   ├── deny-words.txt                # 脱敏第三层：必删字面量（7 类，每类至少 1 条）
│   ├── deny-patterns.txt             # 脱敏第三层：必删模式（正则；7 类合并计）
│   ├── deny-allow.txt                # 允许规则：只放行结构性误报（夹具里的合成盘符等），逐行写理由
│   └── baseline-sim-v3o.json         # 同源度基线表**示例**：演示 --baseline 的逐行差异归因
├── lib/
│   ├── dsh-home.mjs                  # DSH home / workspace / 报告目录解析
│   ├── generated-docs.mjs            # 「自动生成档」判据唯一权威源（纯常量 + 纯函数）
│   ├── rulecheck-rules.mjs           # 规则文本与判据族定义
│   ├── cli-args.mjs                  # 用户 CLI 公共参数件（--help / 未知参数 fail-closed）
│   ├── deny-literal.mjs              # 字面量层：7 类表 + 命中判定 + allow 规则 + 目录扫描
│   ├── negctl.mjs                    # 阴性对照四步时序（注入 → 复制 → 扫+断言 → 清理）
│   ├── ref-scan-core.mjs             # 引用面扫描内核（扫描面证据 / 四类处置表）
│   ├── sim-scan-core.mjs             # 同源度内核（多重集扣减 / 分桶 / 基线差异归因）
│   ├── self-audit-core.mjs           # 六条判据实现（含内部标识三层）
│   └── plan-gate-core.mjs            # 过审闸内核（正文归一 / 四态 / 锚点读写 / 幂等 / 并发三态）
├── _test/                            # 四件器具的单测（227 条断言，纯夹具、零生产写入）
│   ├── test-ref-scan.mjs
│   ├── test-sim-scan.mjs
│   ├── test-self-audit.mjs
│   ├── test-plan-gate.mjs            # 含三条变异测试（关独立校验 / 幂等改追加 / 关写后回读）
│   ├── test-deny-literal.mjs
│   └── test-negctl.mjs
├── docs-discipline/                  # 文档纪律判据集（13 个检查器 + 2 个共享件 + 2 个单测）
│   ├── README.md                     # 该组判据的完整口径（产物形态 / 取值 / 射程 / 退出码）
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
│   │   ├── common.mjs                # 参数解析 / 帮助块 / 自测骨架 / 临时目录
│   │   └── dispatch.mjs              # 子命令分发
│   └── _test/
│       ├── test-generated-docs.mjs   # 家族表 / 归一化 / 插入点的单测
│       └── test-stamp-doc-mark.mjs   # 档级标记盖印单测
└── dsh-l3-pitfall-reminder/          # DSH 插件：L3 实时坑库提醒（默认关）
    ├── package.json                  # 插件声明（无第三方依赖）
    ├── README.md                     # 挂载/卸载与开关说明
    ├── install.mjs                   # 装/卸到某个 DSH profile（默认 dry-run）
    ├── bin/
    │   └── l3-reminder.mjs           # 命令行：状态 / 开关 / 试匹配 / 看尾巴
    ├── lib/
    │   ├── index.js                  # 插件入口（apply + tools/post-execute 挂点）
    │   ├── core.mjs                  # 签名归一化 / 匹配 / 提醒正文
    │   ├── normalize.mjs             # 错误文本归一化（口径移植件）
    │   └── store.mjs                 # 坑库读取 / 开关 / 日志
    └── _test/
        └── test-core.mjs             # 纯单测（含端到端内存夹具）
```

---

## 3. 逐件表 · 根目录（10 个）

| 文件 | 一句话用途 | 真实参数 |
|---|---|---|
| `rulecheck.mjs` | 工程规则只读校验器：对报告/卡片/方案档跑 DoD 十条、DoR、缺陷分级、复盘五段、惯例对照 | `rulecheck <子命令> [--file <档>]... [--card <id\|标题>]... [--section] [--json] [--fail-on-bad] [--self-test]`；子命令 = `baseline` / `debt` / `all` / `dod` / `dor` / `defect` / `postmortem` / `practice` |
| `check-decoupling.mjs` | 检查自研插件有没有静态依赖 DSH 内核 / 宿主适配层副本是否与唯一源一致（R1–R5） | `node check-decoupling.mjs [--root <dir>] [--json <path>]`；根缺省 = `DSH_DECOUPLING_ROOT` 或当前目录 |
| `docs-index-gen.mjs` | 扫描 `docs\**\*.md` 生成「文档总索引」的自动段（幂等；只写索引文件） | `node docs-index-gen.mjs [--apply] [--verify] [--json] [--docs <dir>] [--index <p>] [--overrides <p>] [--date <YYYY-MM-DD>]`；无参 = dry-run |
| `docs-consistency-scan.mjs` | 单份文档的一致性四扫：编号序列、引用/标题、列表计数、术语 | `node docs-consistency-scan.mjs <doc.md> [--json] [--quiet] [--defs 4.4,5,8] [--lists 5,8,12] [--ignore-own-headings] [--allow-doc-prefix <N>]` |
| `dsh-vocab-guard.mjs` | 会话事件词表漂移守卫：比对两份 `known-event-types` 源码，并扫自研包里的裸字面量 | `node dsh-vocab-guard.mjs [--old <path>] [--new <path>] [--scan-root <dir>] [--no-scan] [--no-out] [--out <file>] [--json <file>] [--quiet] [--save-baseline <p>] [--baseline <p>]` |
| `sync-host-adapter.mjs` | 宿主适配层的「唯一源 → 各包派生副本」幂等同步器；`check-decoupling` 的 R5 复用它做 sha 比对 | `node sync-host-adapter.mjs [--verify] [--dry-run] [--all] [--json <p>] [--self-test]`；无参 = 同步（内容相同即跳过） |
| [`dsh-ref-scan.mjs`](dsh-ref-scan.mjs) | 引用面扫描：给关键词 ⇒ 扫四类载体 ⇒ 四类处置表（A 就地订正 / B 加头指针 / C 判定不改+理由 / D 待主人）。**判定列留空给人填** | `node dsh-ref-scan.mjs <关键词...> [--root <dir>] [--config <file>] [--out <file>] [--json] [--case-sensitive] [--snippet <N>]`；`0 命中 ⇒ 判黄（rc=3）` |
| [`dsh-sim-scan.mjs`](dsh-sim-scan.mjs) | 同源度扫描：一个仓或一整个仓根，对同名可比件算「同名件 / 逐字节同 / ≥90% / 50–90% / <50% / **≥50% 行同占比**」 | `node dsh-sim-scan.mjs (--repo <dir> \| --all <dir>) [--prod-root <dir>] [--config <file>] [--baseline <file\|none>] [--detail <repo>] [--out <file>] [--json]` |
| [`dsh-self-audit.mjs`](dsh-self-audit.mjs) | 交付前自批：六条机械判据（DoD 块 / 当次命令原文 / 待拍板段 / 内部标识三层 / 报告存在 / 引用文件存在） | `node dsh-self-audit.mjs <report.md> [--root <dir>] [--machine-report <file>] [--negctl --dir <dir>] [--out <file>] [--json]`；`0 绿 / 3 黄 / 4 红` |
| [`dsh-plan-gate.mjs`](dsh-plan-gate.mjs) | 方案过审闸：给方案档算正文字节 sha，判四态（pass / stale / missing / fail），可写一条幂等锚点（`actor` / `independent` 两个字段支撑"职责分离"） | `node dsh-plan-gate.mjs (--check \| --pass \| --fail) --file <方案档> [--require-independent] [--round N] [--actor <who>] [--independent yes\|no] [--apply] [--expect-sha <hex>] [--config <file>] [--json]`；`check：0/1/3/4`、`写：0/1/3/4`、用法错一律 2 |

> `sync-host-adapter.mjs` 是 `check-decoupling.mjs` 的**依赖件**（`verifySummary()` + `SOURCE_LABEL`）。
> 它只做**结构判定**（sha/头部比对），不读凭据、不碰密钥；默认目标表指向相对路径，
> 在缺少该生态的机器上跑只会报 `source-missing`，不会写任何文件。

## 4. 共享依赖件 · `lib/`（10 个）

| 文件 | 一句话用途 |
|---|---|
| `lib/dsh-home.mjs` | 解析 DSH home / web profile / workspace / 报告目录（`BUTLER_DSH_HOME > DSH_HOME > ~/.dsh`） |
| `lib/generated-docs.mjs` | 「自动生成档」判据的**唯一权威源**：15 个文档家族、匹配模式、豁免资格、插入点、档级标记（纯常量 + 纯函数，零副作用） |
| `lib/rulecheck-rules.mjs` | `rulecheck` 的判据族定义与规则文本（B/D/T/R/S/P/I 各族） |
| `lib/cli-args.mjs` | 用户 CLI 公共参数件：`--help` ⇒ 打印用法 rc=0 且**绝不执行动作**；未知参数 ⇒ rc=2 且**绝不继续** |
| `lib/deny-literal.mjs` | 脱敏第三层：7 类字面量表解析与校验（缺类即红）、命中判定、allow 规则、目录扫描 |
| `lib/negctl.mjs` | 阴性对照四步时序：仓外生成样本 → 复制进被扫目录 → 扫并断言命中 → finally 清理 |
| `lib/ref-scan-core.mjs` | 引用面扫描内核：扫描面证据行、四类处置表渲染、被排除目录命中单独计数 |
| `lib/sim-scan-core.mjs` | 同源度内核：多重集扣减、三档分桶、主结论列、与基线的逐行差异归因 |
| `lib/self-audit-core.mjs` | 六条判据实现（含「内部标识」三层：机器层 + 证伪层 + 字面量层） |
| `lib/plan-gate-core.mjs` | 过审闸内核：正文归一（去锚点 / 去 BOM / CRLF→LF）、四态判定、锚点读写、幂等、并发三态（CAS + 写后回读） |

## 5. `docs-discipline/` · 13 个文档纪律判据

完整口径（产物形态 / 取值口径 / 射程 / 退出码）见 **[`docs-discipline/README.md`](docs-discipline/README.md)**。

| 文件 | 一句话用途 | 真实参数 |
|---|---|---|
| `archive-rounds.mjs` | 把审核档的历史轮次切到归档目录（默认 dry-run） | `--doc <审核档> --keep-lines <N> [--apply --archive <归档目录>] [--json] [--self-test]` |
| `check-caliber.mjs` | 检查方案档里的口径数字在改动行中是否前后一致 | `--scope --doc <方案档>` ｜ `--doc <方案档> --changed <行号集合> [--old <旧值.json>] [--json] [--self-test]` |
| `check-cites.mjs` | 引文核：回修报告声称改过的引文是否真在方案档里 | `--doc <方案档> --report <回修报告> [--section <标题子串>] [--only-window] [--json] [--self-test]` |
| `check-cites-exist.mjs` | 引用处清单 ↔ 实况对账（文件/行号/内容三级） | `--list <清单档> [--section <x>] [--root <dir>] [--min-token-hit 0.8] [--dump] [--json] [--log <档>] [--self-test]` |
| `check-promises.mjs` | 方案档里承诺的改动点 ↔ 回应表逐条对账 | `--doc <方案档> --claims <回应表.json\|.md> [--json] [--self-test]` |
| `check-residue.mjs` | 回修后旧值残留扫描（配合回修前快照目录） | `--doc <方案档> --report <回修报告> --snapshot <快照目录> [--values <补充清单.json>] [--json] [--self-test]` |
| `check-rootcause.mjs` | 根因表 ↔ 夹具目录对账（每族根因必须能在夹具里复现） | `--doc <方案档> --families <族表.json> --fixture <夹具目录> [--json] [--self-test]` |
| `check-rounds.mjs` | 审核轮次结构检查（轮号连续、每轮有四段） | `--doc <审核档\|回修报告> [--ledger <台账.json>] [--json] [--self-test]` |
| `check-selfclaim.mjs` | 回修报告的自述改动 ↔ `git diff` 逐条对账 | `--report <回修报告> --diff <本轮 diff> [--section <标题子串>] [--json] [--self-test]` |
| `check-volume.mjs` | 文档体量检查（某轮 / 最新一轮的行数、节数） | `--doc <审核档\|回修报告> --round <N\|last> [--json] [--self-test]` |
| `gen-doc-audit.mjs` | 自动生成档清单 ↔ 实况对账（漏项 / 误归族 / 缺标记） | `[--docs <dir>] [--root <dir>] [--json] [--log <档>] [--self-test]` |
| `scan-four.mjs` | 薄封装 `docs-consistency-scan.mjs` 的四扫入口（**恒 0 退出**，只报不拦） | `--doc <档> [--defs 4.4,5,8] [--lists 5,8,12] [--ignore-own-headings] [--allow-doc-prefix <N>] [--json] [--self-test]` |
| `selfcheck-rerun.mjs` | 自检链复跑：记录一次全量自检产物，之后可重放出证 | `--record --doc <送审件> --manifest <清单.json> --out <产物目录>` ｜ `--replay --doc <送审件> --manifest <清单.json> --artifacts <产物目录> [--stage1 <改动行集合>] [--self-test]` |

| 支撑件 | 一句话用途 |
|---|---|
| `docs-discipline/lib/common.mjs` | 参数解析、帮助块、自测骨架、临时目录/断言工具 |
| `docs-discipline/lib/dispatch.mjs` | 子命令分发 |
| `docs-discipline/_test/test-generated-docs.mjs` | 家族表 / 归一化 / 插入点单测（**会读生产档做对照**，先设 `AUTODOC_PROD_ROOT`） |
| `docs-discipline/_test/test-stamp-doc-mark.mjs` | 档级标记盖印单测（同上，读生产档对照） |

## 5.5 交付闸三件（`dsh-ref-scan` / `dsh-sim-scan` / `dsh-self-audit`）

这三件治的是同一种病：**"口径改了就得扫全库""交付前机械自批一遍"这种活，别靠人记**。

三件都是 **只读 + 可选落报告** —— 默认只打印，唯一写点是 `--out <file>`；报告请落在被扫目录之外。
三件都接 `lib/cli-args.mjs`：`--help` ⇒ rc=0 且**不执行动作**；未知参数 ⇒ rc=2 且**零副作用**。

### 5.5.1 `dsh-ref-scan` · 引用面扫描

给一个关键词（可多个）⇒ 扫四类载体 ⇒ 输出一张四类处置表。

- **四类载体**（`config/ref-scan.json` 可改）：文档 `docs/` · 技能 `~/.dsh/skills/` · 人设 `~/.dsh/.agent-presets/` · 工具 `tools/`。
- **四类处置**：`A 就地订正` · `B 加头指针` · `C 判定不改 + 理由` · `D 待主人`。**机器只做机械事** —— 表里那一列默认留空，由人填。
- **空态写死三条**（这是最容易退化成形式主义的地方）：
  1. **0 命中 ⇒ 判黄**（rc=3），不是 pass、也不是红，并要求人工确认扫描面；
  2. **每次扫描都打印"扫描面证据"**：载体清单 + 每类扫了多少文件 + 命中数 —— **空表也要有这行**；
  3. 配**阴性对照**（见 5.5.4）证明扫描器不是死的。
- **被排除目录里的命中单独声明**（如历史快照 / 别线产物）：既不进处置表、也不进主计数，但证据行会写清楚"另有 N 处"，
  否则"漏网 0"只在一个未声明的面内成立。

### 5.5.2 `dsh-sim-scan` · 同源度扫描

一个仓（`--repo`）或一整个仓根（`--all`）⇒ 对**同名可比件**算同源度。

**口径写死在 `config/sim-scan.json`，脚本不许另立一套默认值**（改口径 = 改这个文件，并把口径指纹一起记下来）：

- **6 类扩展名**：`.mjs` · `.js` · `.cjs` · `.ps1` · `.yml` · `.yaml`
- **8 个 skip 目录**：`node_modules` · `.git` · `_archive` · `_tmp` · `generated` · `logs` · `backups` · `snapshots`
- **生产面** = `<proot>/tools` 递归 + `<proot>` 根目录下的文件（**不递归**）；`<proot>` = `--prod-root` / `$DSH_ROOT` / `~/DSH`
- **仓面** = 每个仓递归（同样 6 类扩展名 + 8 个 skip 目录）；仓根下只收 `dsh-*` 目录（`_backup` / `_publish` 这类不是仓，不进分母）
- **逐字节同** = sha256 相等；其余算**行同度**：仓内非空行（去首尾空白）拿去生产同名件里做**多重集扣减**
  （同一行出现次数也扣 —— 集合包含会把"出现 5 次 vs 1 次"当全中），同名有多个候选时**取行同度最高者**
- **三档**：≥90% / 50–90% / <50%；**主结论列** = (逐字节同 + ≥90% + 50–90%) ÷ 同名件 = **「≥50% 行同占比」**
- **判定**：≥90% 近源副本 · ≥50% 部分重写 · <50% 重写为主；**同名件为 0 ⇒ 判不了**（不白给"重写为主"）

表头一定打印：**口径指纹 + 生产面 + 扫描时点 + 扫描时各仓脏项数**（拿读数当"干净时的读数"是最常见的误读）。

**与 `--baseline` 对比时不要求"逐格一致"** —— 仓是活体，取数时点不同、仓已变版都是正常的。
本工具给的是：**差异行数** + 每行**可复现的原因**，原因只许三种：
`取数时点不同`（无新提交但工作树脏 / 文件比基线时点新）· `该仓已变版`（附 `git log --since` 的一行）· `口径差异`（附口径指纹）。
归不上这三种的，明确打 **无法归因** 并 rc=3 —— 不许拿"时点不同"糊过去。

### 5.5.3 `dsh-self-audit` · 交付前自批（六条机械判据）

| # | 判据 | 判法 |
|---|---|---|
| ① | DoD 块在不在 | 出现 `DoD` 且块内 ≥10 个勾选/编号项（**不是"有标题就算"**） |
| ② | 有没有带当次命令原文 | **围栏代码块内**至少一条命令行（"跑过了"不算，要能把命令抄出来重跑） |
| ③ | 有没有「待拍板」段 | 有未决项标记（`待拍板` / `待确认` / `未决`…）却没有该段 ⇒ 红；"无待拍板"这种否定式不算未决项 |
| ④ | 报告里有没有内部标识 | **三层**：机器层 + 证伪层 + 字面量层（见 5.5.4），任一层不过即红 |
| ⑤ | 报告路径真实存在 | 不存在 ⇒ 只出这一条并判红 |
| ⑥ | 正文引用的文件真实存在 | 逐条解析行内反引号 / 裸路径；占位符（`<…>`）与 URL 不算；缺任一 ⇒ 红并点名。**围栏代码块里的命令不算引用**（那是第 ② 条的事）；**仓内相对路径**（首段不是扫描根下的目录，如 `lib/xxx.mjs`）记「跳过」—— 工具不知道它属于哪个仓，不冒充"缺文件" |

退出码：`0 绿` · `3 黄（证据不足，需补）` · `4 红（停止发布）` · `2 用法错误`。
⚠️ **「证据不足」不是通过**：机器层没注入词表、证伪层没跑阴性对照，都只能判黄。

### 5.5.4 脱敏三层 + 阴性对照四步（第 ④ 条的真身）

**① 机器层**：权威扫描器 rc=0 且 `review=0`，**且必须已注入 P0 词表**（`--deny-file`）。
机器层报告里出现「P0 段未启用 / 本次扫描不完整」字样 ⇒ **判机器层不过 —— 不看 rc**
（不注词表时扫描器照样 `hits=0`，"干净但不完整"就是最外层失效而无人告警）。

**② 证伪层**：**阴性对照四步时序**（`dsh-self-audit --negctl --dir <仓>`）。为什么必须四步：
样本放仓外 + 扫描器排除该路径 ⇒「扫描器必须判红」**永远不可能被验证**（它根本读不到样本）。

1. **注入**：把 7 类各 1 条的样本写到**仓外固定路径** `%TEMP%/oss-negative-control/<仓名>.txt`；
2. **复制**：把样本复制进**被扫目录**，用唯一哨兵名 `.negctl-<runId>.txt`；
3. **扫 + 断言**：扫被扫目录（这一步刻意**不排除**哨兵），断言 **7 类全中**，其中三类核心（设备标签 / 盘符主机名 / 棒号卡号）必须命中；
4. **清理**：`finally` 删掉哨兵与样本，再扫一次断言命中归零，并核对 `git status` 没被污染。

"排除 `%TEMP%` 路径"只约束**正常扫描**，不约束第 3 步 —— 这两件事不冲突。

**③ 字面量层**：**表必须落在仓内、随仓发布**（`config/deny-words.txt` + `config/deny-patterns.txt`），最小 **7 类**：
设备标签前缀 / `第 ?N ?棒` 式棒号 / `卡 <数字>` 卡号 / `主线「…」` 主线名 / 内部交付报告名模式 / 主机名与主机别名 / 盘符与私有端口。
**判据 = 每类至少 1 条，缺任一类别即判红**（"非空"不算过 —— 3 个词的合法空表就是漏洞）。

命中不是一律判红：落在**围栏代码块内 / 行内反引号里 / 引用块里**的记为 allow（命令原文 / 被引用证据 / 原文摘录）；
`config/deny-allow.txt` 里还有**逐行写理由**的结构性允许规则（例如夹具里的合成盘符 `X:`），
**能放行的只有结构性误报，真实私有标识一律不许加允许**。你自己的私有词另建
`config/deny-words.local.txt`（`.gitignore` 已挡，不随仓发布），扫描器会自动并进表里。

---

## 5.6 方案过审闸（`dsh-plan-gate`）

治的病：**「方案没过审就建卡」只能靠人自觉**。本命令把「这份方案审过了、而且审完之后正文没被改过」变成一次
可复跑的读数，而不是一句承诺。

### 四态

| 状态 | 什么情况 | `--check` 退出码 |
|---|---|---|
| `pass` | 有 `pass` 锚点，且锚点里的正文 sha 与当前正文一致 | 0 |
| `stale` | 有 `pass` 锚点，但正文变了（锚点里没 sha 也算） | 1 |
| `missing` | 档读不到 / 没有锚点 /（要求独立签署时）签署方不独立 | 3 |
| `fail` | 有 `fail` 锚点（审核没过 ⇒ 同样不能建卡） | 4 |

判定优先级写死：**正文变了永远先报 `stale`** —— 「锚点还在、内容已经换了」是最容易被人当成"过了审"的那种假绿。

### 锚点是什么

一行 HTML 注释，落在档头（首个 `##` 之前）：

```text
<!-- PLAN-REVIEW:pass round=2 actor=reviewer-a independent=yes sha=1af1bde732c1 at=2026-10-30T08:51:10Z runId=… -->
```

- `sha` = **正文** sha256 的前 12 位。正文 = 去掉所有锚点行 → 去 BOM → CRLF 归一成 LF，其余逐字节参与哈希。
  ⇒ 改行尾、加 BOM **不算**改正文；改一个字立刻 `stale`；重写锚点不会把自己判过期。
- `actor` = 谁签的（人名或角色名）；`independent` = 签署方是否独立于作者（值域写死 `yes` / `no`）。
- 锚点**永远只有一行**：写入时先摘旧锚点再插新行；`kind` / `round` / `actor` / `independent` / 正文 sha 全一致时
  **连写都不写**（文件字节前后一致）。

### 职责分离：`--require-independent`

```bash
dsh-plan-gate --check --file plan.md --require-independent
```

要求「签署方独立于作者」：有 pass 锚点但 `independent` 不是 `yes` ⇒ 判 **`missing`（rc 3）**，不是 `pass`。

> ⚠️ **缺省不校验立场。** 不带 `--require-independent` 时，作者自己签的锚点照样判 `pass` —— 那时 `pass` 只说明
> **「有人签过」**，不说明「签署方独立于作者」。真把过审当回事的流水线必须显式带上这个标志；不写清这一点，
> 用的人会以为 `pass` = 过了审。

### 并发与权限

写锚点要过三道门：外部快照 CAS（`--expect-sha`）→ 写前重读比对 → 写后回读比对（锚点行 + 正文 sha）。
写失败、文件只读、两个会话同时写 ⇒ 一律判 `stale`（rc 1）**且不覆盖**，把 errno / 原因码原样打出来。
写完还会自检一次：`--pass` 之后 `--check` 必须判 pass（「写完自己判 stale」= 锚点旁边多加了空行）。

### 5.6.1 可选消费点（**本文只给接口，不接线**）

本仓不替你的流水线做决定，只把凭证做成可读的；下面两处是它最自然的两个消费点，接不接由你用不用：

| 消费点 | 怎么用 | 不接的后果 |
|---|---|---|
| **建卡器必填** | 建卡前跑 `--check`，非 `pass` 就拒绝建卡（要求独立签署就再加 `--require-independent`） | 卡和方案之间没有任何机器可查的关系 |
| **复核器 R4** | 复核时把 `--check` 的四态当一条判据写进复核表；`stale` **单独一档**（不是"缺证据"，是"证据过期"） | 复核表里"方案已过审"仍然只是一句自述 |

⭐ 把 `stale` 和 `missing` 分成两档是有意的：前者「证据过期、必须重新过审」，后者「从来没留下证据」。

### 5.6.2 「机器锁二」：改生产可免审，但必须补默认等价判据

**机器锁一** = 本文的过审闸：动方案要走审。
**机器锁二** = 例外通道：允许「改生产」跳过审（热修、回滚、只改一行），但**必须同时留下一条可复跑的等价判据**，
否则免审就变成了「没人知道这处改动凭什么安全」。

| | 锁一 | 锁二 |
|---|---|---|
| 管什么 | 方案变更 | 生产变更（代码 / 配置 / 脚本） |
| 凭据 | 锚点（正文 sha + actor + independent） | 一条**当场能跑**的判据：改前改后各跑一次的那个命令 + 两次读数 |
| 谁签 | 独立于作者的人 | 同样得独立于作者（**免审 ≠ 免签**） |
| 过期判据 | 正文 sha 变了 ⇒ `stale` | 判据的输入变了（文件 sha / 版本号 / 配置值）⇒ 同样算过期 |

两条锁治的是同一件事：**「我说它没问题」不算凭证，「换个人现在能跑一遍」才算**。

---

## 6. `dsh-l3-pitfall-reminder/` · L3 实时坑库提醒插件

干活过程中工具调用失败、且错误签名命中已归档坑库时，向**当前会话**注入一条提醒（默认**关**）。

| 文件 | 一句话用途 |
|---|---|
| `dsh-l3-pitfall-reminder/package.json` | 插件声明（`type: module`，零第三方依赖） |
| `dsh-l3-pitfall-reminder/README.md` | 挂载/卸载、开关、命令行用法 |
| `dsh-l3-pitfall-reminder/install.mjs` | 装/卸到指定 DSH profile：`[--apply] [--rollback] [--home <dir>] [--profile web] [--mode copy\|link]`（**默认 dry-run**；落盘后需重启 dsh 才加载） |
| `dsh-l3-pitfall-reminder/bin/l3-reminder.mjs` | 命令行：`--status` / `--on --apply` / `--off --apply` / `--dry-run on --apply` / `--tail <N>` / `--match <文本> [--name --code --tool]` / `--docs-root <dir>` / `--home <dir>` |
| `dsh-l3-pitfall-reminder/lib/index.js` | 插件入口：`apply(ctx)` 注册 `tools/post-execute`，任何内部异常都不抛回 waterfall |
| `dsh-l3-pitfall-reminder/lib/core.mjs` | 签名归一化、坑匹配、提醒正文渲染 |
| `dsh-l3-pitfall-reminder/lib/normalize.mjs` | 错误文本归一化（口径移植件，**不 import 上游**，保证零外部依赖） |
| `dsh-l3-pitfall-reminder/lib/store.mjs` | 坑库读取索引、开关文件、JSONL 日志 |
| `dsh-l3-pitfall-reminder/_test/test-core.mjs` | 纯单测（30 条，含端到端内存夹具） |

> 这个插件挂的是 **DSH 插件公开 API**（`ctx.on('tools/post-execute')`），不 import 任何私有内核。
> 开关文件是 `<DSH_HOME>/butler-l3-reminder.json`，**热读**，改完不用重启；**默认关**，所以装完不重启也不改行为。

---

## 7. 与 DSH 的关系

- **纯 CLI（可脱离 DSH 单跑）**：`rulecheck`、`docs-consistency-scan`、`docs-index-gen`、`dsh-vocab-guard`、
  `dsh-plan-gate`、`docs-discipline/*`、`sync-host-adapter`。
- **依赖 DSH 生态约定**（读 `docs\` / `profiles\web\`）：`check-decoupling`（扫插件源码树）、`sync-host-adapter`（同步 profile 副本）。
- **是 DSH 插件**：只有 `dsh-l3-pitfall-reminder`（装在 `profiles\web\node_modules\` 下，随 dsh 启动加载）。

## 8. 已知限制

- 全部按 **Windows 路径口径**写（`\` 分隔、盘符、`\r\n`）；在 Linux/macOS 上跑，路径类判据会退化。
- `docs-discipline/_test/*` 与 `dsh-l3-pitfall-reminder/_test/test-core.mjs` 的部分用例会**读生产文档 / 生产坑库做对照**
  （只读）。在干净机器上这些用例会走 `skip` 分支或按数据漂移 FAIL —— 属预期。
- `rulecheck` 的规则文本（`lib/rulecheck-rules.mjs`）来自某个具体工程流程，字段名与判据族是**约定俗成**的，换团队要改规则表。
- `dsh-plan-gate` **不判断"谁有资格签"**：它只记 `actor` 与 `independent` 两个字段，是否真独立由流程与人负责。
  默认配置 `signer.mode=any`（谁都签得了）；要白名单就在 `config/plan-gate.json` 里改成 `list`。
  另外它的只读档判据依赖文件系统只读位（Windows 上 `chmod 0444` 会置只读属性），在容器里以 root 跑可能测不到这条。

## 9. 许可

**AGPL-3.0-only + 商业授权（双许可）**：

- 开源使用：遵循 [`LICENSE`](LICENSE)（GNU Affero General Public License v3.0）。
- 商业使用：不愿承担 AGPL 的源码开放义务 ⇒ 可另行购买商业授权（联系仓库 owner）。
- 本仓库中**没有**从其他项目 fork 来的代码；`docs-discipline/lib/normalize.mjs` 是口径移植件、独立实现。

## 10. 来源说明

这些脚本来自一个长期运行的 DSH 私有工作树，2026-10 拆仓发布。发布时做了：
**只读复制**（源件未改）· **依赖闭包补齐**（`lib/` 3 件 + `sync-host-adapter.mjs`）· **脱敏**（盘符路径 → `DSH_ROOT` / 占位符，
机器名/用户名 → 通用占位）· 骨架补齐。行为与源件一致，仅路径解析与默认值改为环境变量驱动。
