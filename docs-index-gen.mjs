#!/usr/bin/env node
/**
 * docs-index-gen.mjs —— 《<DSH_ROOT>\docs 文档总索引》生成器（只读扫描 + 幂等写入）
 *
 * 干什么：
 *   扫描 `docs\**\*.md`（含子目录），按「目录 / 更新日期 / 首行标题」重新生成索引的
 *   **自动段**；索引顶部的人工段（维护口径 + 最常用的 15 份）原样保留，不会被覆盖。
 *
 * 用法：
 *   node docs-index-gen.mjs              # dry-run（默认，只打印统计，不写文件）
 *   node docs-index-gen.mjs --apply      # 落盘写入索引
 *   node docs-index-gen.mjs --verify     # 只校验当前索引是否最新（exit 0 一致 / 3 有差异）
 *   node docs-index-gen.mjs --json       # 机器可读摘要（stdout 只有 JSON）
 *   可注入（测试隔离用）：--docs <扫描根> --index <索引文件> --overrides <覆盖表> --date <YYYY-MM-DD>
 *
 * 幂等保证：
 *   ① 自动段正文与上一版逐字节比较，一致则**连扫描日期行一起原样保留**（跨日重跑也不变）；
 *   ② 输出文件自身被排除在扫描之外（否则自引用会破坏幂等）；
 *   ③ 全文无变化时不写文件。
 *
 * 写入范围：仅 `docs\文档总索引.md`（可用 --index 改）；**从不修改任何源文档**。
 * 退出码：0 成功/无变化 ｜ 2 用法错/环境错 ｜ 3 --verify 发现差异
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 唯一权威源（方案 §2.5 冲突裁决表）：家族表 / 匹配模式 → 正则 的转换口径**一律以它为准**，本文件不得自写正则
import { GENERATED_DOC_FAMILIES, familyMatchToRe, normalizePath, firstH1Index, insertAtFor, stampDocMark } from "./lib/generated-docs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOCS = path.join(HERE, "..", "docs");
const DEFAULT_INDEX = path.join(DEFAULT_DOCS, "文档总索引.md");
const DEFAULT_OVERRIDES = path.join(HERE, "docs-index-overrides.json");
const DEFAULT_ARCHIVE_ROOT = path.join(HERE, "..", "_archive");

const AUTO_BEGIN = "<!-- docs-index-gen:auto:begin -->";
const AUTO_END = "<!-- docs-index-gen:auto:end -->";
const INDEX_TITLE = "# docs 文档总索引";

/** 由 tick / 常驻 job 自动生成、只在索引里占一行汇总的目录（不列明细）；`dir: ""` = docs 根按文件名模式。
 *  ⚠️ **本表已迁出**（2026-10-08 · 方案 §2.5 冲突裁决表）：唯一权威源 = `tools\lib\generated-docs.mjs` 的
 *  `GENERATED_DOC_FAMILIES`。以前在本文件**独立维护的 4 条规则**（含 `裸跑期观测-` 模式）已删除 ⇒ 现为**派生视图**：
 *    · `dir`   = 权威源族 `dir` 去掉 `docs\` 前缀（`docs\管家报告` ⇒ `管家报告`；`docs` ⇒ `""`）
 *    · `match` = 权威源族 `match` 模式经 `familyMatchToRe()` 转**锚定正则**（`*` / `<host>` / `<日期>` / `<月>` / `<设备>`）
 *    · 同目录多族（`管家报告` 11 族 / docs 根 3 族）**逐条试、首个命中为准**
 *    · 🔴 **模式收窄（§3.2 反向锚点①）**：旧正则 `/^(watch-|external-|周报-|裸跑期观测-|\d{4}-\d{2}-\d{2})/`
 *      把 2 份**人工档**（`裸跑期观测-*.md` = 卡 281050e4 的收尾判定产物）当自动档 ⇒ 已在权威源层面消失：
 *      它们不属任何家族 ⇒ **回到「明细」节**（正是期望行为）
 *  `note` 取权威源的 `driftMode`（漂移强度），不再手写 "append-only" 等**过期措辞**
 *  （§3.1-C7 订正：`变更流水` **不是** append-only —— 段内按首个 HH:MM 稳定正序插入 + RMW 锁 + 原子写 + 整档重渲染）。 */
const AUTO_DIR_RULES = buildAutoDirRules();

/** 家族表 → 索引侧目录规则（**派生**；要改模式请改权威源族表，别在这里加正则） */
function buildAutoDirRules() {
  const out = [];
  const seen = new Set();
  for (const fam of GENERATED_DOC_FAMILIES) {
    const dir = normalizePath(fam.dir).replace(/^docs\\?/, "");
    const key = `${dir}::${fam.match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      dir,
      match: familyMatchToRe(fam.match),
      label: fam.label,
      rawMatch: fam.match,
      generator: fam.generator,
      note: fam.driftMode,
      familyId: fam.id,
      exemptEligible: fam.exemptEligible === true,
    });
  }
  // 目录级标签 + 族数（渲染「一行/目录」汇总用）：同目录多族 ⇒ 合并成 `docs\<目录>\（模式 1 / 模式 2 / …）`
  const byDir = new Map();
  for (const r of out) {
    if (!byDir.has(r.dir)) byDir.set(r.dir, []);
    byDir.get(r.dir).push(r);
  }
  for (const [dir, list] of byDir) {
    const prefix = dir === "" ? "docs\\" : `docs\\${dir}\\`;
    const pats = [...new Set(list.map((r) => r.rawMatch))];
    const label = list.length === 1 ? list[0].label : `${prefix}（${pats.join(" / ")}）`;
    for (const r of list) { r.dirLabel = label; r.dirFamilyCount = list.length; }
  }
  return out;
}

/** 头部强信号 → 自动判「已过期」（否则默认「现行」）。命中后可用覆盖表人工修正。 */
const EXPIRE_SIGNALS = [
  "已被取代",
  "已过期",
  "已作废",
  "已放弃",
  "历史文档",
  "DEPRECATED",
  "deprecated",
];

const HEAD_SCAN_LINES = 25;

const DEFAULT_MANUAL = `${INDEX_TITLE}

> 全库入口：**先看「最常用的 15 份」，再按目录查全量清单**。本索引覆盖 \`docs\` 下**全部 \`.md\`**（含子目录）。
> 自动段由脚本生成、人工段手工维护；两者边界见下表。**新增/删除/搬移/归档文档后，跑一次生成器即可。**

## 维护口径（谁维护 · 何时更新 · 标签含义）

| 项 | 口径 |
|---|---|
| **谁维护** | 主人 + 本鱼（任何会话）。**自动段**由 \`tools\\docs-index-gen.mjs\` 生成；**人工段**（本节 + 「最常用的 15 份」）手工维护 |
| **何时更新** | ① 新增 / 删除 / 改名 / 搬移 \`docs\\\` 下 \`.md\` 后；② **文档归档 / 从归档恢复后立刻跑一次**（移入或移出 \`_archive\\docs-retired-*\\\` 的文档会同步刷新文末「已归档」节；归档侧＝L5 卡 \`restore-docs-retired.cmd --apply\`）；③ 文档大扫除收尾、每月体检（1/15）复核一次 |
| **怎么更新** | \`node docs-index-gen.mjs\`（默认 dry-run 只打印统计）→ \`--apply\` 落盘 → \`--verify\` 校验（exit 3 = 索引落后于磁盘）。**幂等**：重复跑内容不变 |
| **状态标签** | **现行** = 继续生效的规范 / 总纲 / 入口；**已归档** = 文档本体已移出 \`docs\\\`（在 \`_archive\\docs-retired-*\\\`，只在文末「已归档」节出现）；**已过期** = 仍在 \`docs\\\` 但前提消失 / 被取代（只作历史取证，别当现行口径引用） |
| **状态怎么来** | 默认「现行」；文档**头部 25 行**内出现强信号（已被取代 / 已过期 / 已作废 / 已放弃 / 历史文档 / DEPRECATED）→ 自动标「已过期」；人工修正写在 \`tools/docs-index-overrides.json\`（键 = \`docs/\` 开头的相对路径，正反斜杠皆可） |
| **自动维护目录** | \`坑库\\\`、\`变更流水\\\`、\`管家报告\\\` 等目录下**由脚本/常驻 job 生成的档**（判据 = \`tools\\lib\\generated-docs.mjs\` 的**家族表**，共 15 族；本文件只**派生**、不自写正则）→ 索引只在「自动维护目录」节**每目录列一行汇总**（同目录多族合并），不列明细；**同目录里的人工档仍列明细**；明细去目录里看 |
| **取代关系** | 本文件取代 2026-09-14 的一份审计草案（已过期；依据见项目内部笔记） |

## 一、最常用的 15 份（主人 & 新会话高频入口）

| # | 文档 | 用途 |
|---|---|---|
| 1 | \`docs\\主人使用手册.md\` | 主人使用手册 / 本鱼备忘录 |
| 2 | \`docs\\DSH目录规范.md\` | 生产地图 + 放置规矩 + 备份体系（动文件前先看） |
| 3 | \`docs\\开发顺序统筹-20260914.md\` | 当前 run / 验收顺序依据 |
| 4 | \`docs\\大管家-主人视角-一页纸-20260913.md\` | 大管家唯一给主人看的说明书 |
| 5 | \`docs\\大管家-开关矩阵与放行判据-20260913.md\` | 动作真相表 + 放行判据唯一真相源 |
| 6 | \`docs\\插件升级决策表.md\` | 禁升区 / 可升区速查（升级前必查） |
| 7 | \`docs\\插件魔改维护清单.md\` | 全部插件魔改总账 + 补丁序列 |
| 8 | \`docs\\升级方案-2026-09-10.md\` | 主包受控升级 B0–B5 唯一蓝图 |
| 9 | \`docs\\自愈与回滚-验收缺口与整改方案-20260911.md\` | 演练制权威源 + 整改台账（出事看这里） |
| 10 | \`docs\\gitee备份使用说明.md\` | 三仓备份 / clone + unlock 流程 |
| 11 | \`docs\\换机必补清单.md\` | 仓外本机层重建清单（换机必看） |
| 12 | \`docs\\重启通知与标题状态-20260911.md\` | 重启通知目标 + 会话标题三态 |
| 13 | \`docs\\被打断会话判定-修正-20260911.md\` | 被打断会话双判据（看板验收用） |
| 14 | \`docs\\权限默认-部署override-20260910.md\` | 新会话权限默认机制与恢复 |
| 15 | \`docs\\API资产与定价.md\` | API 资产 / 价格速查（换 API 前先看） |

> 这 15 份是**人工挑的入口**，不随自动段变化；要增减直接改这一节（生成器不会覆盖）。
`;

function parseArgs(argv) {
  const o = {
    apply: false,
    verify: false,
    json: false,
    help: false,
    docs: DEFAULT_DOCS,
    index: null,
    overrides: DEFAULT_OVERRIDES,
    archiveRoot: DEFAULT_ARCHIVE_ROOT,
    date: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--dry-run") o.apply = false;
    else if (a === "--verify") o.verify = true;
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--docs") o.docs = argv[++i];
    else if (a === "--index") o.index = argv[++i];
    else if (a === "--overrides") o.overrides = argv[++i];
    else if (a === "--archive-root") o.archiveRoot = argv[++i];
    else if (a === "--date") o.date = argv[++i];
    else throw new Error(`未知参数：${a}`);
  }
  if (!o.index) o.index = path.join(o.docs, "文档总索引.md");
  return o;
}

function norm(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cell(s, max = 70) {
  let t = String(s ?? "").replace(/\r?\n/g, " ").trim();
  t = t.replace(/\|/g, "\\|").replace(/\*/g, "").replace(/`/g, "");
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t || "—";
}

function walkMd(rootDir) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(rootDir, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(childRel);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }));
}

function headInfo(abs, lines = HEAD_SCAN_LINES) {
  let text = "";
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return { title: null, signal: null };
  }
  const all = text.split(/\r?\n/);
  const head = all.slice(0, lines);
  let title = null;
  for (const l of all.slice(0, 40)) {
    const m = l.match(/^#\s+(.+?)\s*$/);
    if (m) {
      title = m[1];
      break;
    }
  }
  let signal = null;
  for (const l of head) {
    const hit = EXPIRE_SIGNALS.find((s) => l.includes(s));
    if (hit) {
      signal = hit;
      break;
    }
  }
  return { title, signal };
}

function loadOverrides(p) {
  if (!fs.existsSync(p)) return { status: {}, note: {}, path: p, exists: false };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      status: j.status ?? {},
      note: j.note ?? {},
      path: p,
      exists: true,
    };
  } catch (e) {
    throw new Error(`覆盖表解析失败：${p} → ${e.message}`);
  }
}

function overrideFor(overrides, relPosix) {
  const keys = Object.keys(overrides.status);
  for (const k of keys) {
    const kk = k.replace(/^docs\//i, "").replace(/\\/g, "/");
    if (kk.toLowerCase() === relPosix.toLowerCase()) return overrides.status[k];
  }
  return null;
}

function autoRuleFor(relPosix) {
  const slash = relPosix.indexOf("/");
  const dir = slash === -1 ? "" : relPosix.slice(0, slash);
  const file = slash === -1 ? relPosix : relPosix.slice(slash + 1);
  for (const r of AUTO_DIR_RULES) {
    if (r.dir !== dir) continue;
    // 🔴 同目录多族（`管家报告` 11 族 / docs 根 3 族）⇒ 不命中要**继续试下一条**：
    //    旧实现此处 `return null` —— 某族的 match 不中时，同目录后面的族永远轮不到（迁出后必现的缺陷）
    if (r.match && !r.match.test(file)) continue;
    return r;
  }
  return null;
}

function readArchived(archiveRoot) {
  const rows = [];
  if (!fs.existsSync(archiveRoot)) return rows;
  for (const name of fs.readdirSync(archiveRoot)) {
    if (!name.startsWith("docs-retired-")) continue;
    const mf = path.join(archiveRoot, name, "manifest.json");
    if (!fs.existsSync(mf)) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(mf, "utf8"));
    } catch {
      continue;
    }
    const when = j.movedAt || j.createdAt;
    const date = when ? fmtDate(new Date(when)) : "—";
    for (const it of j.items ?? []) {
      rows.push({
        orig: it.orig,
        dir: name,
        date,
        why: it.why ?? "",
      });
    }
  }
  rows.sort((a, b) => a.orig.localeCompare(b.orig, "zh-Hans-CN", { numeric: true }));
  return rows;
}

/** 计算所有行（明细 + 自动目录汇总 + 归档），返回 { body, stats } */
export function buildIndexContent(opts) {
  const docsRoot = path.resolve(opts.docs);
  const indexAbs = path.resolve(opts.index);
  const overrides = opts.overrides ?? { status: {}, note: {} };
  const dateStr = opts.date ?? fmtDate(new Date());

  const indexKey = norm(indexAbs);
  const rels = walkMd(docsRoot).filter((r) => norm(path.join(docsRoot, r)) !== indexKey);

  const detailByDir = new Map();
  const autoByRule = new Map();
  const statusCounts = { 现行: 0, 已过期: 0 };
  let overridden = 0;

  for (const relPosix of rels) {
    const abs = path.join(docsRoot, relPosix);
    const rule = autoRuleFor(relPosix);
    const relWin = relPosix.replace(/\//g, "\\");
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    const date = fmtDate(new Date(st.mtimeMs));
    if (rule) {
      if (!autoByRule.has(rule.dir)) autoByRule.set(rule.dir, { rule, files: [] });
      autoByRule.get(rule.dir).files.push({ relPosix, date, bytes: st.size });
      continue;
    }
    const { title, signal } = headInfo(abs);
    const ov = overrideFor(overrides, relPosix);
    let status;
    if (ov) {
      status = ov;
      overridden++;
    } else if (signal) {
      status = "已过期";
    } else {
      status = "现行";
    }
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const dir = relPosix.includes("/") ? relPosix.slice(0, relPosix.indexOf("/")) : "";
    if (!detailByDir.has(dir)) detailByDir.set(dir, []);
    detailByDir.get(dir).push({
      relWin,
      title: title ?? path.basename(relPosix, ".md"),
      date,
      status,
      signal,
    });
  }

  const autoGroups = [];
  let autoCount = 0;
  const seenAutoDir = new Set();
  for (const r of AUTO_DIR_RULES) {
    // 同目录多族（`管家报告` 11 族 / docs 根 3 族）⇒ 目录级**只汇总一行**（聚合桶按 dir 建）
    if (seenAutoDir.has(r.dir)) continue;
    seenAutoDir.add(r.dir);
    const g = autoByRule.get(r.dir);
    const files = g?.files ?? [];
    autoCount += files.length;
    const latest = files.map((f) => f.date).sort().pop() ?? "—";
    autoGroups.push({ rule: r, count: files.length, latest });
  }
  // 兜底：扫描到但未命中任何已知规则目录的自动文件（防漏）
  const knownDirs = new Set(AUTO_DIR_RULES.map((r) => r.dir));
  for (const [dir, g] of autoByRule) {
    if (knownDirs.has(dir)) continue;
    autoCount += g.files.length;
    autoGroups.push({
      rule: { dir, generator: "（见目录内说明）", note: "自动维护目录" },
      count: g.files.length,
      latest: g.files.map((f) => f.date).sort().pop() ?? "—",
    });
  }

  const detailCount = [...detailByDir.values()].reduce((n, a) => n + a.length, 0);
  const archived = readArchived(opts.archiveRoot ?? DEFAULT_ARCHIVE_ROOT);

  const L = [];
  L.push(
    `> **本段自动生成**（\`docs-index-gen.mjs\` 扫描 \`docs\\**\\*.md\`）｜扫描日期：${dateStr}｜共 **${detailCount + autoCount}** 份 = 明细 **${detailCount}** + 自动维护目录 **${autoCount}**`,
  );
  L.push("> 手工改本段会在下次生成时被覆盖；要改内容请改源文档或 \`tools\\docs-index-overrides.json\`（状态）。");
  L.push("");
  L.push("## 二、全量清单（按目录）");
  L.push("");

  const dirOrder = [...detailByDir.keys()].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b, "zh-Hans-CN", { numeric: true });
  });
  let sec = 0;
  for (const dir of dirOrder) {
    const items = detailByDir.get(dir);
    sec++;
    const label = dir === "" ? "根目录" : `\`${dir}\\\``;
    L.push(`### 2.${sec} ${label}（${items.length} 份）`);
    L.push("");
    L.push("| # | 文档 | 标题 | 更新 | 状态 |");
    L.push("|---|---|---|---|---|");
    let i = 0;
    for (const it of items) {
      i++;
      L.push(`| ${i} | \`docs\\${it.relWin}\` | ${cell(it.title)} | ${it.date} | ${it.status} |`);
    }
    L.push("");
  }

  L.push("## 三、自动维护区（tick / 常驻 job 自动生成 → 不列明细）");
  L.push("");
  L.push("| 位置 | 份数 | 生成者 | 最新 | 说明 |");
  L.push("|---|---|---|---|---|");
  for (const g of autoGroups) {
    const label = g.rule.dirLabel ?? g.rule.label ?? `docs\\${g.rule.dir}\\`;
    L.push(`| \`${label}\` | ${g.count} | ${g.rule.generator} | ${g.latest} | ${cell(g.rule.note, 90)} |`);
  }
  L.push(`| **小计** | **${autoCount}** | — | — | 这些不进明细；明细在各自目录内（如 \`docs\\坑库\\*-<host>.md\`） |`);
  L.push("");

  L.push("## 四、已归档（已移出 `docs\\`，只作历史取证）");
  L.push("");
  if (!archived.length) {
    L.push("> 未发现 \`_archive\\docs-retired-*\\\` 归档批次。");
  } else {
    const batches = [...new Set(archived.map((a) => a.dir))].sort();
    L.push(`> 共 **${archived.length}** 份，分 ${batches.length} 批：${batches.map((b) => `\`_archive\\${b}\\\``).join(" · ")}`);
    L.push("> 恢复：桌面 \`DSH鲸落地\\restore-docs-retired.cmd --apply\`（可 \`--only\` 单项）。");
    L.push("");
    L.push("| # | 原位置（`docs` 根内相对路径） | 归档位置 | 归档日期 | 原因 |");
    L.push("|---|---|---|---|---|");
    let i = 0;
    for (const a of archived) {
      i++;
      // ⚠️ 本列**绝不输出 `docs\` 前缀**（口径见本节表头：只写 docs 根内的相对路径）：
      //    这里的 orig 是「归档前在 docs 里的位置」，文件已移出 docs ⇒ 一旦拼成 `docs\xxx.md`，
      //    就会被死链扫描器的 REF_RE（`/docs[\\/]([^\s\`"'<>|*?()[\]{}，。；：、）】」』]+?\.md)/g`，
      //    见 `_archive\doc-audit-20260921\doc-health-scan.mjs` L64）判成死链，
      //    **每跑一次索引就自己长回 24 条**（2026-09-21 文档·5 卡）。
      //    防御：orig 万一自带 `docs/` 前缀先剥掉，避免拼出 `docs\docs\…`。
      const origRel =
        String(a.orig ?? "")
          .replace(/^docs[\\/]/i, "")
          .replace(/\//g, "\\") || "—";
      L.push(
        `| ${i} | \`${origRel}\` | \`_archive\\${a.dir}\\\` | ${a.date} | ${cell(a.why, 80)} |`,
      );
    }
  }
  L.push("");

  return {
    body: L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(),
    stats: {
      docsRoot,
      index: indexAbs,
      total: detailCount + autoCount,
      detailCount,
      autoCount,
      dirs: dirOrder.map((d) => ({ dir: d || "(根目录)", count: detailByDir.get(d).length })),
      auto: autoGroups.map((g) => ({ dir: g.rule.dir, count: g.count, latest: g.latest })),
      archived: archived.length,
      archivedBatches: [...new Set(archived.map((a) => a.dir))],
      statusCounts,
      overridden,
      date: dateStr,
    },
  };
}

function splitIndex(text) {
  const i = text.indexOf(AUTO_BEGIN);
  if (i === -1) return { manual: text.trimEnd() + "\n\n", auto: null };
  const j = text.indexOf(AUTO_END, i);
  return {
    manual: text.slice(0, i),
    auto: j === -1 ? text.slice(i) : text.slice(i, j + AUTO_END.length),
  };
}

function stripDateLine(s) {
  return s.replace(/^> \*\*本段自动生成\*\*.*$/m, "");
}

export function buildIndexFile(opts) {
  const { body, stats } = buildIndexContent(opts);
  const indexAbs = path.resolve(opts.index);
  let oldRaw = null;
  try {
    oldRaw = fs.readFileSync(indexAbs, "utf8");
  } catch {
    oldRaw = null;
  }
  const split = oldRaw === null ? { manual: DEFAULT_MANUAL.replace(/\s*$/, "") + "\n\n", auto: null } : splitIndex(oldRaw);
  let auto;
  let changed;
  if (split.auto && stripDateLine(split.auto) === stripDateLine(`${AUTO_BEGIN}\n${body}\n${AUTO_END}`)) {
    auto = split.auto; // 正文一致 → 原样保留（含旧扫描日期），保证跨日重跑幂等
    changed = false;
  } else {
    auto = `${AUTO_BEGIN}\n${body}\n${AUTO_END}`;
    changed = true;
  }
  const manual = split.manual.replace(/\s*$/, "") + "\n\n";
  // §2.2 档级标记（`index` 族）：插在 manual 段头（AUTO_BEGIN 段之前）⇒ 不受段级重写影响；
  //   插入点由权威源 `insertAtFor()` 按文档真实 H1 定（实测 H1 索引 0 ⇒ 落 L2）
  const raw = `${manual}${auto}\n`;
  const full = stampDocMark(raw, "index", insertAtFor(firstH1Index(raw)));
  const existed = oldRaw !== null;
  const sameAsFile = existed && oldRaw === full;
  return { full, body, stats, changed: changed || !existed, sameAsFile, existed };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n用法见 --help\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    process.stdout.write(
      [
        "docs-index-gen.mjs —— docs 文档总索引生成器（只读扫描 docs\\**\\*.md）",
        "",
        "  （无参数）    dry-run：只打印统计，不写文件",
        "  --apply       写入索引文件",
        "  --verify      只校验索引是否最新（0 一致 / 3 有差异）",
        "  --json        机器可读摘要（stdout 只有 JSON）",
        "  --docs <dir>  扫描根（默认 <DSH_ROOT>/docs）",
        "  --index <p>   索引文件（默认 <docs>\\文档总索引.md）",
        "  --overrides <p> 状态覆盖表（默认 tools\\docs-index-overrides.json）",
        "  --date <YYYY-MM-DD> 固定扫描日期（测试用）",
        "",
      ].join("\n"),
    );
    return;
  }
  if (!fs.existsSync(opts.docs)) {
    process.stderr.write(`扫描根不存在：${opts.docs}\n`);
    process.exitCode = 2;
    return;
  }

  let overrides;
  try {
    overrides = loadOverrides(opts.overrides);
    opts = { ...opts, overrides };
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
    return;
  }

  let r;
  try {
    r = buildIndexFile(opts);
  } catch (e) {
    process.stderr.write(`生成失败：${e.message}\n`);
    process.exitCode = 2;
    return;
  }

  const s = r.stats;
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          mode: opts.verify ? "verify" : opts.apply ? "apply" : "dry-run",
          index: s.index,
          docsRoot: s.docsRoot,
          total: s.total,
          detailCount: s.detailCount,
          autoCount: s.autoCount,
          dirs: s.dirs,
          auto: s.auto,
          archived: s.archived,
          archivedBatches: s.archivedBatches,
          statusCounts: s.statusCounts,
          overridden: s.overridden,
          overridesFile: overrides.path,
          overridesExists: overrides.exists,
          date: s.date,
          existed: r.existed,
          changed: r.changed,
          sameAsFile: r.sameAsFile,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const mode = opts.verify ? "verify" : opts.apply ? "apply" : "dry-run（不改文件）";
    const lines = [
      `[docs-index-gen] ${mode}`,
      `  扫描根：${s.docsRoot}`,
      `  索引：  ${s.index}${r.existed ? "" : "（不存在，将新建）"}`,
      `  文档：${s.total} 份 = 明细 ${s.detailCount} + 自动维护目录 ${s.autoCount}`,
      `  明细分组：${s.dirs.map((d) => `${d.dir} ${d.count}`).join(" · ")}`,
      `  自动目录：${s.auto.map((a) => `${a.dir || "(根目录·按文件名模式)"} ${a.count}（最新 ${a.latest}）`).join(" · ")}`,
      `  状态：现行 ${s.statusCounts["现行"] ?? 0} · 已过期 ${s.statusCounts["已过期"] ?? 0}（覆盖表修正 ${s.overridden} 条${
        overrides.exists ? "" : "，覆盖表不存在"
      }）`,
      `  已归档：${s.archived} 份${s.archivedBatches.length ? `（${s.archivedBatches.join(" · ")}）` : ""}`,
      `  覆盖表：${overrides.path}${overrides.exists ? "" : "（缺失，用内置口径）"}`,
    ];
    if (opts.verify) {
      lines.push(r.sameAsFile ? "  结果：✅ 索引与磁盘一致" : "  结果：⚠️ 索引落后于磁盘（跑 --apply 刷新）");
    } else if (opts.apply) {
      lines.push(r.sameAsFile ? "  结果：无变化（幂等，未写入）" : r.changed ? "  结果：已写入" : "  结果：无变化（幂等，未写入）");
    } else {
      lines.push(r.sameAsFile ? "  结果：预览 = 当前文件（无变化）" : "  结果：预览与当前文件不同（--apply 才会写）");
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  if (opts.verify) {
    process.exitCode = r.sameAsFile ? 0 : 3;
    return;
  }
  if (opts.apply) {
    if (!r.sameAsFile) {
      fs.mkdirSync(path.dirname(path.resolve(opts.index)), { recursive: true });
      fs.writeFileSync(path.resolve(opts.index), r.full, "utf8");
    }
  }
}

function isMain() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
