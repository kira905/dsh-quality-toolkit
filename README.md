# dsh-quality-toolkit · DSH 质检与规则工具包

> DeepSeek Harness（DSH）生态里「**写方案 → 审核 → 回修 → 出证 → 封版**」这条链上真正在用的
> 一组只读校验器：**工程规则校验**（DoD / DoR / 缺陷分级 / 复盘 / 惯例对照）、**文档纪律判据**、
> **文档总索引生成**、**词表漂移守卫**、**解耦检查**，外加一个 **L3 实时坑库提醒插件**。
>
> 全部 **Node.js ≥ 20**、**零第三方运行时依赖**（只用 `node:` 内置模块）。Windows 优先，路径与编码口径按 Windows 写。

---

## ⚠️ 先读这段（比任何用法都重要）

1. **本仓没有统一的「帮助命令」可以拿来探路。** 一部分脚本确实实现了帮助输出，但**另一部分脚本没有**：
   未知参数会被**静默忽略**，然后**直接执行真动作**。
   已实测过的翻车形态：对某个导出脚本敲 `--help`，它没认出这个参数，于是照常把整份快照导了出来。
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
├── lib/
│   ├── dsh-home.mjs                  # DSH home / workspace / 报告目录解析
│   ├── generated-docs.mjs            # 「自动生成档」判据唯一权威源（纯常量 + 纯函数）
│   └── rulecheck-rules.mjs           # 规则文本与判据族定义
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

## 3. 逐件表 · 根目录（6 个）

| 文件 | 一句话用途 | 真实参数 |
|---|---|---|
| `rulecheck.mjs` | 工程规则只读校验器：对报告/卡片/方案档跑 DoD 十条、DoR、缺陷分级、复盘五段、惯例对照 | `rulecheck <子命令> [--file <档>]... [--card <id\|标题>]... [--section] [--json] [--fail-on-bad] [--self-test]`；子命令 = `baseline` / `debt` / `all` / `dod` / `dor` / `defect` / `postmortem` / `practice` |
| `check-decoupling.mjs` | 检查自研插件有没有静态依赖 DSH 内核 / 宿主适配层副本是否与唯一源一致（R1–R5） | `node check-decoupling.mjs [--root <dir>] [--json <path>]`；根缺省 = `DSH_DECOUPLING_ROOT` 或当前目录 |
| `docs-index-gen.mjs` | 扫描 `docs\**\*.md` 生成「文档总索引」的自动段（幂等；只写索引文件） | `node docs-index-gen.mjs [--apply] [--verify] [--json] [--docs <dir>] [--index <p>] [--overrides <p>] [--date <YYYY-MM-DD>]`；无参 = dry-run |
| `docs-consistency-scan.mjs` | 单份文档的一致性四扫：编号序列、引用/标题、列表计数、术语 | `node docs-consistency-scan.mjs <doc.md> [--json] [--quiet] [--defs 4.4,5,8] [--lists 5,8,12] [--ignore-own-headings] [--allow-doc-prefix <N>]` |
| `dsh-vocab-guard.mjs` | 会话事件词表漂移守卫：比对两份 `known-event-types` 源码，并扫自研包里的裸字面量 | `node dsh-vocab-guard.mjs [--old <path>] [--new <path>] [--scan-root <dir>] [--no-scan] [--no-out] [--out <file>] [--json <file>] [--quiet] [--save-baseline <p>] [--baseline <p>]` |
| `sync-host-adapter.mjs` | 宿主适配层的「唯一源 → 各包派生副本」幂等同步器；`check-decoupling` 的 R5 复用它做 sha 比对 | `node sync-host-adapter.mjs [--verify] [--dry-run] [--all] [--json <p>] [--self-test]`；无参 = 同步（内容相同即跳过） |

> `sync-host-adapter.mjs` 是 `check-decoupling.mjs` 的**依赖件**（`verifySummary()` + `SOURCE_LABEL`）。
> 它只做**结构判定**（sha/头部比对），不读凭据、不碰密钥；默认目标表指向相对路径，
> 在缺少该生态的机器上跑只会报 `source-missing`，不会写任何文件。

## 4. 共享依赖件 · `lib/`（3 个）

| 文件 | 一句话用途 |
|---|---|
| `lib/dsh-home.mjs` | 解析 DSH home / web profile / workspace / 报告目录（`BUTLER_DSH_HOME > DSH_HOME > ~/.dsh`） |
| `lib/generated-docs.mjs` | 「自动生成档」判据的**唯一权威源**：15 个文档家族、匹配模式、豁免资格、插入点、档级标记（纯常量 + 纯函数，零副作用） |
| `lib/rulecheck-rules.mjs` | `rulecheck` 的判据族定义与规则文本（B/D/T/R/S/P/I 各族） |

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
  `docs-discipline/*`、`sync-host-adapter`。
- **依赖 DSH 生态约定**（读 `docs\` / `profiles\web\`）：`check-decoupling`（扫插件源码树）、`sync-host-adapter`（同步 profile 副本）。
- **是 DSH 插件**：只有 `dsh-l3-pitfall-reminder`（装在 `profiles\web\node_modules\` 下，随 dsh 启动加载）。

## 8. 已知限制

- 全部按 **Windows 路径口径**写（`\` 分隔、盘符、`\r\n`）；在 Linux/macOS 上跑，路径类判据会退化。
- `docs-discipline/_test/*` 与 `dsh-l3-pitfall-reminder/_test/test-core.mjs` 的部分用例会**读生产文档 / 生产坑库做对照**
  （只读）。在干净机器上这些用例会走 `skip` 分支或按数据漂移 FAIL —— 属预期。
- `rulecheck` 的规则文本（`lib/rulecheck-rules.mjs`）来自某个具体工程流程，字段名与判据族是**约定俗成**的，换团队要改规则表。

## 9. 许可

**AGPL-3.0-only + 商业授权（双许可）**：

- 开源使用：遵循 [`LICENSE`](LICENSE)（GNU Affero General Public License v3.0）。
- 商业使用：不愿承担 AGPL 的源码开放义务 ⇒ 可另行购买商业授权（联系仓库 owner）。
- 本仓库中**没有**从其他项目 fork 来的代码；`docs-discipline/lib/normalize.mjs` 是口径移植件、独立实现。

## 10. 来源说明

这些脚本来自一个长期运行的 DSH 私有工作树，2026-10 拆仓发布。发布时做了：
**只读复制**（源件未改）· **依赖闭包补齐**（`lib/` 3 件 + `sync-host-adapter.mjs`）· **脱敏**（盘符路径 → `DSH_ROOT` / 占位符，
机器名/用户名 → 通用占位）· 骨架补齐。行为与源件一致，仅路径解析与默认值改为环境变量驱动。
