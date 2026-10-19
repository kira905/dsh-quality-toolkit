#!/usr/bin/env node
// check-cites-exist.mjs —— 引用处清单机械判据（清单内「文件 + 行号 + 引文」与实况对账）
//
// 用法：
//   node check-cites-exist.mjs --list <清单档> [--section 11.3.1] [--root <DSH_ROOT>] [--dump]
//   node check-cites-exist.mjs --list <清单档> --json [--log <日志档>] [--min-token-hit 0.8]
//   node check-cites-exist.mjs --self-test
//
// 判据（写死）：
//   ① 文件存在：清单条目里的每个文件路径，在 --root 下必须存在（缺失 ⇒ FAIL file-missing）；
//   ② 行号在范围内：每个声明行号 ≤ 该档实际行数（越界 ⇒ FAIL line-out-of-range）；
//   ③ 内容相符（**段覆盖** · 双口径）：
//      强 = 引文段归一后作为**子串**命中目标行（归一：NFKC 折全角→半角 / 去 markdown 标记 / 引号 / 空白 /
//           单引号 / 表格竖线——清单引文常把整张表格行摘成"若干片段 + ="的形式，省掉了 `|`）；
//      弱 = 引文段切 token 后的**命中率 ≥ --min-token-hit**（默认 0.8；清单第 4 列是**摘要**而非逐字引文，
//           纯子串口径会大面积假红）；
//      条目 PASS = **每个引文段都落在某个目标行上**（强或弱）；一处都不落 ⇒ 漂移探测：
//      别处找到 ⇒ FAIL line-drift（报实况行号），全档找不到 ⇒ FAIL content-mismatch；
//   ④ 无引文可抽 ⇒ SKIP(no-keyword)（无对照物，只核文件存在性）；无行号 ⇒ SKIP(no-line-num)；
//      路径含 `…` 省略号且解析不出唯一文件 ⇒ SKIP(unresolved-path)。
//   ⑤ 已知弱面（如实登记，不隐藏）：段覆盖**不校验**"第 k 段必须落在第 k 个行号"（清单常把 N 处引用写成一行）；
//      引文过短/过泛（如只有「事实」「元信息」两字）时弱判据会轻易满足；相邻表格行之间可能因 token 高度重叠而互相判达标。
//   ⑥ 漂移候选的**可见性**（2026-09-25 加 · **判定未变**）：候选行按【正文行 → 行首 `>` 引述行 → 含订正注词面的行】
//      排序并逐条标注；候选 ≥2 处时**全部列出（top-N = DRIFT_TOP_N）**，不再只报可能报错的那一处。
//      动因：订正注行逐字引述原句时会与正文行同时命中，只报"第一处"会把订正注行误报成"实况"。
//      标注只是**形态提示**（两类都会在正文行上命中，需人工确认），见 annotKind() 的注释。
//   ⑦ SKIP 条目的**行号越界可见性**（2026-09-25 加 · **判定未变**）：无引文/无行号 ⇒ 仍记 SKIP；但判定层已算出的
//      `out-of-range` 状态改为**可见**：counts.skippedOutOfRange + 报告「SKIP 行号越界可见性」节 + --json 的
//      skippedOutOfRangeDetail。⚠️「越界是否该计 FAIL」属**口径变更**，本工具**未采纳**，只出数据供主人拍板。
//   ⑧ 「自动生成档」豁免（2026-10-08 加 · 方案 §4.2 / §4.3 / §4.4 · 依 `规划-自动生成档判据清单-20260925.md` v3c）：
//      判定落点 = **`:359` 之前**（原 `out-of-range ⇒ FAIL` 分支上），粒度 = **target 级 ∧ 资格维**：
//        target.status === 'out-of-range'
//        **且**（档头前 N 行带档级标记 `<!-- dsh-generated-doc:auto` **或** 命中例外白名单 —— 后者本轮恒 false）
//        **且** 该档家族 `exemptEligible === true`（M-1）
//        ⇒ 该 target 标 `generated-exempt`，**从 `:359` 的判定集里剔除**。
//      条目级（§4.2-2「仅因」算法）：**先剔除豁免 target、再按原判据复算** —— 仅当"原始集合会触发 `:359`"且
//        "剔除后不触发任何 FAIL 分支" ⇒ 整条转 `SKIP` + `reason = 'generated-doc-exempt'`；否则按剔除后的原判据落判。
//      **不放宽其它 reason**：`file-missing` / `line-drift` / `content-mismatch` 一律照红（自动档真写错内容 ⇒ 照样红）。
//      🔴 逃生舱（§4.3 · M-5）：env `DSH_CITES_EXEMPT=off`（或权威源 `EXEMPT_ENABLED = false`）⇒ **跳过豁免判定**，
//        报告节显示「开关关闭 · 未生效」、`counts.generatedExempt = 0`，结果与"豁免上线前"规范化一致。
//      权威源 = `tools\lib\generated-docs.mjs`（§2.5 唯一权威源：标记字面 / N / 插入点 / 家族表 / 豁免资格）。
//   ⑨ 「判定语」不进引文核对面（2026-10-08 加 · 主人当场口头令拍板 **S5 = A（改工具）**）：
//      真源 = 清单自己的体例说明（`docs\服务面隐私包-方案-20260917.md` §11.3.1 · B/C 两处 ⚠️ 块）——
//        「B 表『性质』列 / C 表『为什么是假命中』列 = 清单作者的人工摘要与判定语，**不是被引档的逐字原文** ⇒
//          该列**不参与机械核**；机械判据只认『文件 + 行号 + 命中处列引文』三件」。
//      判定语识别（**两条窄条件，命中其一即算判定语条**）：
//        ① 列级 · 表头驱动：该条目所属表格的**描述列表头名**（trim 后**全等**）∈ JUDGEMENT_DESC_COLUMNS；
//        ② 行级 · 句首标记：描述列 trim 后**以** `[体例·非引文]` **开头**（清单体例说明写明的升级接口）。
//      作用域 = **只降级"引文核对面"的两种 FAIL**（`line-drift` / `content-mismatch`）⇒ 整条转
//        `SKIP` + `reason = 'judgement-desc-exempt'`（原判 + 失配明细仍逐条可见于 targets）。
//      ⛔ **不放宽其它判定**：`file-missing` / `line-out-of-range` 一律照红；**非 FAIL 的条目一字不改**
//        （PASS / SKIP 原样 —— 判定语列"恰好对上"时仍按原判据记 PASS，口径只做降级、不做作废）。
//      ⚠️ 与 ⑧ 的关系：两者互不影响（⑧ 只管行号越界、⑨ 只管引文漂移/不符），可叠加，判定互不遮蔽。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  EXIT, argParse, helpBlock, isMain, meta, norm, sha256,
  newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp,
} from './lib/common.mjs';
import {
  SCHEMA_VERSION as GD_SCHEMA_VERSION, DOC_MARK_SCAN_LINES, isDocMarkLine, readFamilyId,
  isGeneratedDocText, isExemptEligible, findFamily, isListedExempt, isExemptEnabled,
  familySamples as GD_FAMILY_SAMPLES,
} from '../lib/generated-docs.mjs';

const EXIT_LIST_UNREADABLE = 4;
const DEFAULT_SECTION = '11.3.1';
const DEFAULT_ROOT = process.env.DSH_ROOT || process.cwd();
const DEFAULT_MIN_TOKEN_HIT = 0.8;
const SELF = fileURLToPath(import.meta.url);
// 权威源 / 白名单的**实体路径**（算 sha 用；本文件在 tools\docs-discipline\，二者在 tools\lib\）
const GD_SELF = fileURLToPath(new URL('../lib/generated-docs.mjs', import.meta.url));
const DEFAULT_WHITELIST = fileURLToPath(new URL('../lib/generated-docs-whitelist.json', import.meta.url));

// ---------------------------------------------------------------- 解析层

/** 段定位：标题行（含 token 的 2–6 级标题）→ 下一个 1–2 级标题之前。返回 1-based 闭区间 */
export function locateSection(lines, token) {
  const head = lines.findIndex((l) => /^#{2,6}\s/.test(l) && l.includes(token));
  if (head < 0) return null;
  let end = lines.length; // 1-based 段末行（含）
  for (let i = head + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  }
  return { titleLine: head + 1, startLine: head + 1, endLine: end };
}

/** 文字归一（引文比较用）：NFKC 折全角标点/字母/数字 → 半角，再去 markdown 标记 / 引号 / 空白 /
 *  单引号 / 间隔号 / 表格竖线（清单引文常把表格行摘成一串、省掉 `|` 分隔符） */
export function normC(s) {
  return norm(String(s ?? '').normalize('NFKC'))
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[\u00b7\u30fb|]/g, '');
}

/** 引文段 → 关键词 token（归一后按结构标点切，长度 < 2 丢弃）：弱判据的比较单位 */
export function tokens(segs) {
  const out = [];
  for (const s of segs) {
    for (const t of normC(s).split(/[=+\/、，,：:；;()<>《》【】\[\]{}·—–…~!！?？。"'’‘*⇒→←↑↓]/)) {
      if (t.length >= 2) out.push(t);
    }
  }
  return out;
}

/** token 命中率：引文 token 在目标行里命中多少 */
export function tokenStats(text, segs) {
  const tk = tokens(segs);
  if (!tk.length) return { total: 0, hit: 0, rate: 0, missing: [] };
  const nt = normC(text);
  const missing = tk.filter((t) => !nt.includes(t));
  return { total: tk.length, hit: tk.length - missing.length, rate: (tk.length - missing.length) / tk.length, missing };
}

/** 漂移候选输出上限（**只影响可读输出，不影响判定**：候选多时列前 N 处 + 标出总处数） */
export const DRIFT_TOP_N = 5;

/** 疑似「引述 / 订正注行」判据 —— **只用于漂移候选的降权排序与标注，不参与任何判定、不过滤**。
 *  · 'correction'（强）：行内含**本仓订正注的专有词面**：订正注 / 订正说明 / 送审件 / 上一版
 *    —— 是 lib/common.mjs 的 RESIDUE_EXEMPT_RE 的**收窄子集**：刻意去掉「快照 / 旧值 / STAMP / 历史 / 实测 / 原文」，
 *    因为这些词在**正文行**里也常见（实测误标：六包施工方案 L62 正文「+ `VACUUM INTO` 快照」被标成订正注行）；
 *  · 'quote'（弱）：行首 `>`（markdown 引述块）—— **正文表格行被整体引述时也会命中，不必然是错行**（实测：愿景总纲
 *    L292 `> | **PM0 定位** | …` 就是清单声明的真实命中处），故只算"引用形态"；
 *  · null = 正文行（排序最优先）。两类标注都只是**形态提示**，需人工确认，不作判定依据。 */
export function annotKind(line) {
  const s = String(line ?? '');
  if (/订正注|订正说明|送审件|上一版/.test(s)) return 'correction';
  if (/^\s*>/.test(s)) return 'quote';
  return null;
}

/** 标注标签（人读输出用） */
export function annotTag(kind) {
  if (kind === 'correction') return '（订正注词面）';
  if (kind === 'quote') return '（行首 > 引述行）';
  return '';
}

const annotRank = (k) => (k === 'correction' ? 2 : k === 'quote' ? 1 : 0);

const SEP_RE = /^:?-{2,}:?$/;

/** 「判定语」列名白名单（**表头 trim 后精确全等** —— 刻意不用 includes，防「性质说明」之类被误纳入）。
 *  来源 = 清单体例：B 表第 3 列「性质」· C 表第 3 列「为什么是假命中」（见档头 §⑨ · 真源 §11.3.1）。 */
export const JUDGEMENT_DESC_COLUMNS = ['性质', '为什么是假命中'];

/** 「判定语」行级标记（**必须落在描述列句首**）—— 清单体例说明写明的升级接口（§11.3.1 L808 / L827）：
 *  「检查器若升级：请按本条跳过带本标记的条目（标记 = 性质列的固定串 `[体例·非引文]`）」。 */
export const DESC_JUDGEMENT_MARK = '[体例·非引文]';

/** 描述列是否带「判定语」行级标记（**句首**固定串 · 不是任意位置包含） */
export function hasJudgementMark(desc) {
  return String(desc ?? '').trim().startsWith(DESC_JUDGEMENT_MARK);
}

/** 表头行判据：第 1 格是 `#` 或 `文件`（原实现内联在 parseEntries 里 · 抽出供表头跟踪复用） */
export function isHeaderRow(cells) {
  return cells[0] === '#' || cells[0] === '文件';
}

/** 描述列在表里的下标：A 表 5 列 ⇒ 3（`# | 文件 | 命中处 | 该处原来写的是什么 | 处置`）；
 *  B/C 表 3 列 ⇒ 2（`文件 | 命中处 | 性质·为什么是假命中`） */
function descColumnIndex(colCount) {
  return colCount >= 5 ? 3 : 2;
}

/** 解析段内的 A/B/C 三张表 → 条目数组（含继承 `〃` 的文件列） */
export function parseEntries(lines, sec) {
  const groups = [];
  let cur = null;
  let headerCells = null; // 当前表的表头行（每遇表头行刷新 · 换组时重置）—— §⑨ 列级判定要用
  for (let i = sec.startLine - 1; i < sec.endLine; i++) {
    const l = lines[i];
    const gm = l.match(/^\*\*([A-Z])\.\s/);
    if (gm) { cur = { key: gm[1], headingLine: i + 1, rows: [] }; groups.push(cur); headerCells = null; continue; }
    if (!/^\|/.test(l) || !cur) continue;
    const cells = l.split('|').slice(1, -1).map((s) => s.trim());
    if (!cells.length || cells.every((c) => c === '' || SEP_RE.test(c))) continue;
    if (isHeaderRow(cells)) { headerCells = cells; cur.headerCells = cells; continue; } // 表头行
    cur.rows.push({ srcLine: i + 1, cells, headerCells });
  }
  const entries = [];
  for (const g of groups) {
    let prevFile = null;
    for (const row of g.rows) {
      const e = toEntry(g.key, row, prevFile);
      if (e.fileCell && e.files.length) prevFile = e.files[e.files.length - 1];
      entries.push(e);
    }
  }
  return { groups, entries };
}

function toEntry(groupKey, row, prevFile) {
  const c = row.cells;
  let id = null; let fileCell; let lineCell; let descCell;
  if (c.length >= 5) { [id, fileCell, lineCell, descCell] = c; } else if (c.length === 3) { [fileCell, lineCell, descCell] = c; } else {
    return { group: groupKey, srcLine: row.srcLine, id: null, fileCell: null, files: [], lines: [], keywords: [], judgementDesc: null, bad: 'unparsed-row', raw: c.join(' | ') };
  }
  const files = parseFiles(fileCell, prevFile);
  const lineNums = [...String(lineCell).matchAll(/:(\d{1,5})/g)].map((m) => Number(m[1]));
  return {
    group: groupKey,
    srcLine: row.srcLine,
    id: id && /^[A-Z]?\d+$/.test(id) ? id : null,
    fileCell,
    files,
    lines: [...new Set(lineNums)],
    keywords: parseKeywords(descCell), // ⚠️ 解析面**不动**：判定语只做"判定降级"（档头 §⑨）
    judgementDesc: detectJudgementDesc(row.headerCells, c.length, descCell),
    desc: descCell,
    lineCell,
    bad: null,
  };
}

/** 「判定语」识别（档头 §⑨ · 两条**窄条件**，命中其一即算）⇒ 返回 `{ byColumn, byMark, column }`；否则 null。
 *  ① 列级（表头驱动）：描述列表头名 trim 后**全等** ∈ JUDGEMENT_DESC_COLUMNS；
 *     表头与数据行**列数不等**时不判（保守：宁可漏判判定语，不可错判引文列）；
 *  ② 行级（句首标记）：描述列 trim 后以 `[体例·非引文]` 开头。 */
export function detectJudgementDesc(headerCells, colCount, descCell) {
  const byMark = hasJudgementMark(descCell);
  const column = Array.isArray(headerCells) && headerCells.length === colCount
    ? String(headerCells[descColumnIndex(colCount)] ?? '').trim()
    : null;
  const byColumn = column !== null && JUDGEMENT_DESC_COLUMNS.includes(column);
  if (!byColumn && !byMark) return null;
  return { byColumn, byMark, column: byColumn ? column : null };
}

/** 文件列 → 路径数组；`〃` 继承上一条；`…-xxx.md` 走省略号解析 */
function parseFiles(cell, prevFile) {
  const ticked = [...String(cell).matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())
    .filter((s) => /\.md$|\.json$/i.test(s) || /[\\/]/.test(s));
  const raw = ticked.length ? ticked : [String(cell).replace(/\*\*/g, '').trim()];
  const out = [];
  for (const r of raw) {
    if (r === '〃' || r === '同上') { if (prevFile) out.push(prevFile); continue; }
    out.push(r);
  }
  return [...new Set(out)];
}

/** 描述列 → 引文关键词段（引文按 `…` 切段，段长 < 2 丢弃；无引文则退回加粗片段）
 *  引文正则：内容类**允许内层 `『』`**（清单里常见「…『…』…」嵌套，早先按内容类排除 `』` 会把引文截断） */
export function parseKeywords(desc) {
  const s = String(desc ?? '');
  let raws = [...s.matchAll(/[「『“"\u201c\u201d]([^」”"\u201c\u201d]{2,200})[」』”"\u201c\u201d]/g)].map((m) => m[1]);
  if (!raws.length) raws = [...s.matchAll(/\*\*([^*]{2,80})\*\*/g)].map((m) => m[1]);
  const segs = [];
  for (const q of raws) {
    for (const part of String(q).split(/\u2026|\.\.\./)) {
      const t = part.trim();
      if (normC(t).length >= 2) segs.push(t);
    }
  }
  return [...new Set(segs)];
}

// ---------------------------------------------------------------- 判定层

/** 白名单载体信息（§4.2-6 / §4.3-2）：sha256 + 条数（**只读**；文件缺失 ⇒ exists:false，不炸） */
function whitelistInfo(p) {
  try {
    const buf = fs.readFileSync(p);
    let entries = 0;
    try { entries = (JSON.parse(buf.toString('utf8')).entries ?? []).length; } catch { /* 结构坏了也不炸：只报 sha */ }
    return { path: p, exists: true, sha256: sha256(buf), bytes: buf.length, entries };
  } catch {
    return { path: p, exists: false, sha256: null, bytes: 0, entries: 0 };
  }
}

/** 权威源模块 sha16（§6.2 口径②：报告里打印"当时按哪版判"） */
function gdSha16() {
  try { return sha256(fs.readFileSync(GD_SELF)).slice(0, 16); } catch { return null; }
}

function relToAbs(rel, root) {
  if (path.isAbsolute(rel)) return rel;
  return path.resolve(root, rel);
}

/** 省略号路径解析：同目录下唯一候选才接受 */
function resolveEllipsis(rel, prev, root) {
  if (!rel.includes('\u2026')) return { ok: true, file: rel };
  const rest = rel.split('\u2026').pop().replace(/^[-\\/]+/, '');
  const dir = path.dirname(prev ?? '');
  const guess = dir === '.' ? rest : path.join(dir, rest);
  if (fs.existsSync(relToAbs(guess, root))) return { ok: true, file: guess };
  const absDir = relToAbs(dir, root);
  if (fs.existsSync(absDir)) {
    const cands = fs.readdirSync(absDir).filter((f) => f.endsWith(rest) || f.includes(rest.replace(/\.md$/i, '')));
    if (cands.length === 1) return { ok: true, file: dir === '.' ? cands[0] : path.join(dir, cands[0]) };
  }
  return { ok: false, file: rel, cands: [] };
}

export function runCheck({
  listPath, sectionToken = DEFAULT_SECTION, root = DEFAULT_ROOT, minTokenHit = DEFAULT_MIN_TOKEN_HIT,
  exemptEnabled = isExemptEnabled(process.env), whitelistPath = DEFAULT_WHITELIST,
} = {}) {
  if (!listPath || !fs.existsSync(listPath)) {
    const err = new Error(`读不到清单档：${listPath}`);
    err.code = 'LIST_UNREADABLE';
    throw err;
  }
  const list = meta(listPath);
  const sec = locateSection(list.lines, sectionToken);
  if (!sec) {
    const err = new Error(`清单档里找不到段「${sectionToken}」`);
    err.code = 'LIST_UNREADABLE';
    throw err;
  }
  const { groups, entries } = parseEntries(list.lines, sec);

  const cache = new Map();
  const info = (abs) => {
    if (!cache.has(abs)) cache.set(abs, meta(abs));
    return cache.get(abs);
  };

  // 省略号路径二次解析（依赖同一格/上一条已解析的文件名）
  const flat = [];
  let prevResolved = null;
  for (const e of entries) {
    const files = [];
    let unresolved = null;
    for (const f of e.files) {
      const r = resolveEllipsis(f, prevResolved, root);
      if (r.ok) { files.push(r.file); prevResolved = r.file; } else unresolved = f;
    }
    flat.push({ ...e, files, unresolved });
  }

  // 豁免判定上下文（§4.2-1）：开关（§4.3 逃生舱）+ 档级标记缓存（每档只读一次档头前 N 行）
  const genCache = new Map();
  const exempt = {
    enabled: exemptEnabled === true,
    isAutoDoc: (rel, m) => {
      let v = genCache.get(rel);
      if (v === undefined) { v = isGeneratedDocText(m.text); genCache.set(rel, v); } // §2.4：只读前 N 行，不做全文件扫描
      return v;
    },
  };
  const rows = flat.map((e) => judge(e, root, info, minTokenHit, exempt));
  // 「自动生成档 · 已豁免」节素材（§4.2-6）：条目 id · 档名 · family · 命中行号 · 是否整条被豁免
  const exemptDetail = rows
    .filter((r) => r.targets.some((t) => t.status === 'generated-exempt'))
    .map((r) => ({
      group: r.group,
      id: r.id,
      listLine: r.srcLine,
      articleExempted: r.reason === 'generated-doc-exempt',
      targets: r.targets.filter((t) => t.status === 'generated-exempt')
        .map((t) => ({ file: t.file, line: t.line, family: t.family ?? null, exemptBy: t.exemptBy ?? null })),
    }));
  // SKIP 条目里"已经算出、但原实现不消费"的行号越界（2026-09-25 加 · 只加可见性，判定与退出码不变）
  const skippedOor = rows.filter((r) => r.status === 'SKIP' && r.targets.some((t) => t.status === 'out-of-range'));
  const oorDetail = skippedOor.map((r) => ({
    group: r.group,
    id: r.id,
    listLine: r.srcLine,
    status: r.status,
    reason: r.reason,
    files: r.files,
    lines: r.lines,
    outOfRange: r.targets.filter((t) => t.status === 'out-of-range').map((t) => ({ file: t.file, line: t.line, fileLines: t.fileLines })),
  }));
  // 「判定语」降级明细（档头 §⑨）：被降级的条目 + 识别依据 + 被降的原 reason + 失配明细（**只加可见性**）
  const judgementDescDetail = rows
    .filter((r) => r.reason === 'judgement-desc-exempt')
    .map((r) => ({
      group: r.group,
      id: r.id,
      listLine: r.srcLine,
      files: r.files,
      formerReason: r.formerReason ?? null,
      byColumn: r.judgementDesc?.byColumn ?? false,
      byMark: r.judgementDesc?.byMark ?? false,
      column: r.judgementDesc?.column ?? null,
      miss: (r.targets ?? []).filter((t) => t.status === 'miss').map((t) => ({ file: t.file, line: t.line })),
    }));
  const counts = {
    entries: rows.length,
    pass: rows.filter((r) => r.status === 'PASS').length,
    fail: rows.filter((r) => r.status === 'FAIL').length,
    skip: rows.filter((r) => r.status === 'SKIP').length,
    weakPass: rows.filter((r) => r.status === 'PASS' && r.match === 'weak').length,
    partial: rows.filter((r) => r.status === 'PASS' && r.partialTargets).length,
    byGroup: Object.fromEntries(groups.map((g) => [g.key, rows.filter((r) => r.group === g.key).length])),
    skippedOutOfRange: skippedOor.length,
    // §4.2-3 计数口径（写死）：generatedExempt = **"整条被豁免的条目数"（条目级，不是 target 级）**
    //  —— 部分豁免（含豁免 target 但整条仍 FAIL）**不计入**（其 target 仍在报告节里逐条可见）
    generatedExempt: rows.filter((r) => r.reason === 'generated-doc-exempt').length,
  };
  // 假设口径（**未采纳**，仅供报告出"若按判据②原意把越界计 FAIL"的差异表）
  const ifOorFail = { fail: counts.fail + counts.skippedOutOfRange, skip: counts.skip - counts.skippedOutOfRange };
  return {
    list,
    sec,
    groups,
    rows,
    counts,
    skippedOutOfRangeDetail: oorDetail,
    judgementDescDetail,
    ifOutOfRangeCountedAsFail: {
      ...ifOorFail,
      note: '假设口径（未采纳 · 待主人拍板）：把 SKIP 条目里已越界的行号也计为 FAIL —— 现口径下越界在 SKIP 条目上完全不可见',
    },
    root,
    sectionToken,
    minTokenHit,
    // 「自动生成档」豁免（§4.2 / §4.3）：开关现值 + 白名单指纹 + 权威源版本 + 豁免明细
    exemptEnabled: exemptEnabled === true,
    whitelist: whitelistInfo(whitelistPath),
    generatedDocs: { path: GD_SELF, schemaVersion: GD_SCHEMA_VERSION, sha16: gdSha16(), scanLines: DOC_MARK_SCAN_LINES },
    generatedExemptDetail: exemptDetail,
  };
}

function judge(e, root, info, minTokenHit, exempt = null) {
  const targets = [];
  if (e.bad) return mk(e, 'SKIP', 'unparsed-row', targets, '行格式无法解析（列数不是 3 / 5）');
  if (e.unresolved) return mk(e, 'SKIP', 'unresolved-path', targets, `省略号路径解析不出唯一文件：${e.unresolved}`);
  if (!e.files.length) return mk(e, 'SKIP', 'no-file-cell', targets, '文件列解析为空');

  for (const rel of e.files) {
    const abs = relToAbs(rel, root);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      targets.push({ file: rel, line: null, status: 'file-missing' });
      continue;
    }
    const m = info(abs);
    if (!e.lines.length) {
      targets.push({ file: rel, line: null, status: 'no-line-num', fileLines: m.gc, head: '' });
      continue;
    }
    for (const n of e.lines) {
      if (n < 1 || n > m.lines.length) {
        // 先一律记 out-of-range（= "**未豁免时**的落判"底座）；豁免标记在判定段按 §4.2-1 统一打
        targets.push({ file: rel, line: n, status: 'out-of-range', fileLines: m.gc, head: '（越界）' });
        continue;
      }
      const text = m.lines[n - 1];
      const head = text.trim().slice(0, 60) || '（空行）';
      if (!e.keywords.length) { targets.push({ file: rel, line: n, status: 'no-keyword', fileLines: m.gc, head }); continue; }
      const nt = normC(text);
      const segs = e.keywords.map((k) => {
        const strong = nt.includes(normC(k));
        const ts = tokenStats(text, [k]);
        return { strong, rate: ts.total ? ts.rate : (strong ? 1 : 0), total: ts.total, hit: ts.hit, missing: ts.missing };
      });
      const okSegs = segs.filter((s) => s.strong || s.rate >= minTokenHit).length;
      let st;
      if (segs.every((s) => s.strong)) st = 'hit';
      else if (okSegs === segs.length) st = 'hit-weak';
      else if (okSegs > 0) st = 'partial';
      else st = 'miss';
      targets.push({
        file: rel, line: n, status: st, fileLines: m.gc, head, segs,
        segHits: segs.filter((s) => s.strong).length, segTotal: segs.length,
        rate: Number(Math.max(0, ...segs.map((s) => s.rate)).toFixed(3)),
        worstRate: Number(Math.min(...segs.map((s) => s.rate)).toFixed(3)),
        tokensTotal: segs.reduce((a, s) => a + s.total, 0), tokensHit: segs.reduce((a, s) => a + s.hit, 0),
        missing: [...new Set(segs.flatMap((s) => s.missing ?? []))].slice(0, 8),
      });
    }
  }

  // ---- 「自动生成档」豁免（§4.2-1 target 级 ∧ 资格维 ⇒ §4.2-2 条目级「仅因」算法）----
  // ① 先按原判据算 base = **"未豁免时的落判"**（此时越界一律记 out-of-range）
  const base = decide(e, targets, root, info, minTokenHit);
  // ② 再把"越界 ∧ 资格"的 target 标成 generated-exempt（§4.2-1：粒度 = target 级 ∧ 资格维 M-1）
  const exempted = [];
  if (exempt && exempt.enabled === true) {
    for (const t of targets) {
      if (t.status !== 'out-of-range') continue;              // 只放宽"行号越界"这一支
      const ex = exemptFor(t.file, exempt, info, root);       // 档级标记 ∨ 白名单 ∧ 家族 exemptEligible
      if (!ex) continue;
      t.status = 'generated-exempt';
      t.family = ex.familyId;
      t.exemptBy = ex.by;
      t.head = '（越界 · 自动生成档已豁免）';
      exempted.push(t);
    }
  }
  if (!exempted.length) return downGradeJudgementDesc(e, base, targets);
  // ③ T' = T ∖ T_ex ⇒ 按原判据复算 —— T' = 空集 ⇒ 判定集为空 ⇒ **不触发任何 FAIL 分支**
  //    （写死：否则 `:357` 的 `every()` 在空数组上恒 true ⇒ 会误得 file-missing；
  //      这是 §4.2-2 字面没覆盖到的边界，实施期按"空集不 FAIL"补齐）
  const rest = targets.filter((t) => t.status !== 'generated-exempt');
  const after = rest.length
    ? decide(e, rest, root, info, minTokenHit)
    : { status: 'SKIP', reason: 'no-targets-left', note: '剔除豁免 target 后判定集为空' };
  const exList = exempted.map((t) => ({ file: t.file, line: t.line, family: t.family ?? null, exemptBy: t.exemptBy ?? null }));
  // 「仅因」判据（写死）：**T 原本会触发 `:359`** 且 **T' 不触发任何 FAIL 分支** ⇒ 整条转 SKIP + reason
  if (base.status === 'FAIL' && base.reason === 'line-out-of-range' && after.status !== 'FAIL') {
    const row = mk(e, 'SKIP', 'generated-doc-exempt', targets,
      `条目**仅因**自动生成档的行号越界才落 FAIL（:359）⇒ 已豁免 ${exempted.length} 处越界 target、整条转 SKIP；`
      + `被剔除的 target 仍逐条可见：${[...new Set(exList.map((t) => `${t.file}:L${t.line}[family=${t.family ?? '—'}]`))].join(' · ')}`);
    row.exemptedTargets = exList;
    return row;
  }
  // 否则按 T' 的原判据结果落判（该 FAIL 就 FAIL）；被剔除的 target 仍挂在 row.targets 上（§4.2-2 末句）
  const row = after;
  row.targets = targets;
  row.exemptedTargets = exList;
  if (row.status === 'FAIL') {
    row.note = `${row.note}；⚠️ 本条目另有 ${exempted.length} 处越界 target 属**自动生成档 · 已豁免**（已从判定集剔除，但整条**仍因其它原因 FAIL**）`;
  }
  return downGradeJudgementDesc(e, row, targets);
}

/** 「判定语」降级（档头 §⑨ · 2026-10-08 加 · 主人拍板 S5 = A）——
 *  判定语条（列级 ∨ 行级标记）**只**把「引文核对面」的两种 FAIL 降为 `SKIP`（reason = `judgement-desc-exempt`）：
 *    · `line-drift`（引文在别处）/ `content-mismatch`（引文全档不存在）⇒ 降级；
 *    · `file-missing` / `line-out-of-range` ⇒ **一律照红**（**不放宽其它判定**）；
 *    · 非 FAIL（PASS / SKIP / generated-doc-exempt）⇒ **一字不改**（判定语列"恰好对上"时仍记 PASS）。
 *  ⚠️ 原判 + 失配明细**不吞**：`targets` 原样保留、`formerReason` 记下被降的原 reason、报告另设专节。 */
function downGradeJudgementDesc(e, row, targets) {
  if (!e.judgementDesc) return row;
  if (row.status !== 'FAIL') return row;
  if (row.reason !== 'line-drift' && row.reason !== 'content-mismatch') return row;
  const src = e.judgementDesc.byColumn
    ? `描述列表头「${e.judgementDesc.column}」= 判定语列`
    : `描述列句首体例标记 ${DESC_JUDGEMENT_MARK}`;
  const out = mk(e, 'SKIP', 'judgement-desc-exempt', targets,
    `「判定语」不进引文核对面（识别依据：${src}）⇒ 原判 **${row.reason} 不计 FAIL**、整条转 SKIP；`
    + '声明的文件/行号与失配明细仍逐条可见（见 targets）。口径：只降引文面两种 FAIL，文件缺失 / 行号越界一律照红。');
  out.judgementDesc = e.judgementDesc;
  out.formerReason = row.reason;
  return out;
}

/** §4.2-1 资格维：该档的**越界 target** 是否可豁免 —— （档级标记 ∨ 例外白名单）**∧** 家族 exemptEligible。
 *  开关关 / 未命中 / 无资格 ⇒ 返回 null（**不豁免**，target 仍记 out-of-range）。
 *  ⚠️ M-1 的实测后果：`watch` / `external` 现值各 22 档，若只判"有标记"就会被一并豁免 ⇒ 与 §3.1 ⛔ 直接冲突。 */
function exemptFor(rel, exempt, info, root) {
  if (!exempt || exempt.enabled !== true) return null;      // §4.3 逃生舱：开关关 ⇒ 跳过豁免判定
  let m;
  try { m = info(relToAbs(rel, root)); } catch { return null; }
  const generated = exempt.isAutoDoc(rel, m);               // §2.4：只读档头前 N 行（不做全文件扫描）
  const listed = isListedExempt(rel);                       // §4.3-2 白名单支路（**本轮占位恒 false** · §6.1-8）
  if (!generated && !listed) return null;                   // 判据字面：`(isGeneratedDoc(file) || isListedExempt(file))`
  if (!isExemptEligible(rel)) return null;                  // M-1 资格维：watch / external ⇒ 不豁免
  const fam = findFamily(rel);
  return { familyId: fam?.id ?? null, by: generated ? 'doc-mark' : 'whitelist' };
}

/** 原判据分支（`:349 → :359 → :361 → :372`，**分支逻辑一字不改**）——抽成独立函数，
 *  供 §4.2-2 的「仅因」算法复算（先剔除豁免 target、再把 T' 走一遍同样的分支）。 */
function decide(e, targets, root, info, minTokenHit) {
  // 条目判定 = **段覆盖**：描述里的每个引文段都须在某个目标行上「强命中或弱达标」
  // （清单常把「同一处引用的 N 行」写成一行，两段引文分居两行；逐行要求"全段命中"会把这种正常条目判死）
  const segCovered = e.keywords.map((_, i) => targets.some((t) => t.segs?.[i] && (t.segs[i].strong || t.segs[i].rate >= minTokenHit)));
  const segStrong = e.keywords.map((_, i) => targets.some((t) => t.segs?.[i]?.strong));
  const hits = targets.filter((t) => t.status === 'hit' || t.status === 'hit-weak');
  if (e.keywords.length && segCovered.every(Boolean)) {
    const strongAll = segStrong.every(Boolean);
    const best = targets.reduce((a, b) => (b.rate > a.rate ? b : a), targets[0]);
    const note = `${strongAll ? 'match=strong' : `match=weak ${Math.round(best.rate * 100)}%`} · 段覆盖 ${segCovered.filter(Boolean).length}/${e.keywords.length}${hits.length < targets.length ? ` · 行级全段达标 ${hits.length}/${targets.length}` : ''}`;
    return mk(e, 'PASS', hits.length < targets.length ? 'partial-targets' : 'ok', targets, note, strongAll ? 'strong' : 'weak');
  }
  if (!e.keywords.length) {
    const missing = targets.some((t) => t.status === 'file-missing');
    const oor = targets.filter((t) => t.status === 'out-of-range');
    if (missing) return mk(e, 'FAIL', 'file-missing', targets, '文件缺失');
    return mk(e, 'SKIP', 'no-keyword', targets,
      '条目无引文可抽 ⇒ 只核了文件存在性（无内容对照物）'
      + (oor.length ? `；⚠️ 另 ${oor.length} 处声明行号**已越界**（该档行数不足）—— 判定**仍为 SKIP**（口径未变），越界情况另见报告「SKIP 行号越界可见性」节` : ''));
  }
  if (targets.every((t) => t.status === 'file-missing')) return mk(e, 'FAIL', 'file-missing', targets, '声明的文件全部不存在');
  if (targets.some((t) => t.status === 'file-missing')) return mk(e, 'FAIL', 'file-missing', targets, '部分声明文件不存在');
  if (targets.some((t) => t.status === 'out-of-range')) return mk(e, 'FAIL', 'line-out-of-range', targets, '声明行号超出该档实际行数');
  // 漂移探测：同串（或同 token 集）在别处出现
  const drift = driftProbe(e, root, info, minTokenHit);
  if (drift.length) {
    const shown = drift.slice(0, DRIFT_TOP_N);
    const row = mk(e, 'FAIL', 'line-drift', targets,
      `行号漂移：声明的 ${e.lines.map((n) => 'L' + n).join('/')} 处不符，同串实况候选 ${drift.length} 处（按【正文 → 引述 → 订正注】排序，列前 ${shown.length} 处）：${driftLabel(shown)}`
      + `${drift.length > shown.length ? ` …（共 ${drift.length} 处，余下从略）` : ''}`
      + `${drift.some((d) => d.annot) ? '；⚠️ 带标注的候选 = **引述/订正注形态**（只是提示、不必然是错行，需人工确认）—— 订正注行常逐字引述原句而与正文行同时达标' : ''}`);
    row.drifts = drift; // 只加可见性字段（JSON + 报告明细用），判定不变
    return row;
  }
  const bestRate = Math.max(0, ...targets.map((t) => t.worstRate ?? 0));
  return mk(e, 'FAIL', 'content-mismatch', targets,
    `声明行号处未达标（最好那行的**各段最低**命中率仅 ${Math.round(bestRate * 100)}%，阈值 ${Math.round(minTokenHit * 100)}%），且全档无一处让**全部引文段**达标（引文：${e.keywords.join(' | ').slice(0, 60)}）`);
}

/** 漂移探测：声明行全不达标时，找「同串（或同 token 集）在别处出现」的候选行。
 *  **候选 = 全部引文段都达标**的行（任一段达标就报"实况在 L<n>"会自相矛盾）；声明行本身不算"别处"。
 *  ① 收集**全部**候选（不再在首处 break）⇒ 输出层才能"候选 ≥2 全部列出"；
 *  ② 每处标 `annot`（正文行 null / 行首 `>` 引述行 / 订正注词面行），按【正文 → 引述 → 订正注】排序（同类按行号升序）
 *     ⇒ **只排序 + 只标注，绝不过滤**（过滤会改变判定结果，本卡红线）；
 *  ③ `rate` = 该处**最弱那段**的 token 命中率（原实现硬编码 1，导致弱命中也打印"token 100%"，属可见性失真）。 */
function driftProbe(e, root, info, minTokenHit) {
  const out = [];
  for (const rel of e.files) {
    const abs = relToAbs(rel, root);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const m = info(abs);
    const declared = new Set(e.lines);
    const cands = [];
    for (let i = 0; i < m.lines.length; i++) {
      if (declared.has(i + 1)) continue; // 声明行本身不算"别处"（否则会输出"实况在 L<声明行>"这种自相矛盾的话）
      const nt = normC(m.lines[i]);
      const segs = e.keywords.map((k) => {
        const strong = nt.includes(normC(k));
        const ts = tokenStats(m.lines[i], [k]);
        return { strong, rate: ts.total ? ts.rate : (strong ? 1 : 0) };
      });
      if (segs.every((s) => s.strong || s.rate >= minTokenHit)) {
        cands.push({
          file: rel,
          line: i + 1,
          rate: Number(Math.min(...segs.map((s) => s.rate)).toFixed(3)),
          strong: segs.every((s) => s.strong),
          annot: annotKind(m.lines[i]),
        });
      }
      // 只认「全部引文段都达标」的行：任一段达标就报"实况在 L<声明行>"会出现自相矛盾的输出
    }
    cands.sort((a, b) => (annotRank(a.annot) - annotRank(b.annot)) || (a.line - b.line));
    out.push(...cands);
  }
  return out;
}

/** 漂移候选 → 人读串（含"疑似引述/订正注行"标注；只影响可读输出） */
function driftLabel(list) {
  return list.map((d) => `${d.file}:L${d.line}`
    + `${d.strong ? '' : `（token ${Math.round(d.rate * 100)}%）`}`
    + `${d.annot ? `${annotTag(d.annot)}` : ''}`).join(' · ');
}


function mk(e, status, reason, targets, note, match = null) {
  return {
    group: e.group, id: e.id, srcLine: e.srcLine, files: e.files, lines: e.lines,
    keywords: e.keywords, desc: e.desc, status, reason, targets, note, match,
    partialTargets: targets.length > 1 && targets.some((t) => ['hit', 'hit-weak'].includes(t.status)) && targets.some((t) => !['hit', 'hit-weak'].includes(t.status)),
  };
}

// ---------------------------------------------------------------- 输出层

export function render(r, { dump = false } = {}) {
  const L = [];
  L.push(`清单档：${r.list.path}  ·  ${r.list.gc} 行 · sha16 ${r.list.sha16}`);
  L.push(`判据权威源：${r.generatedDocs.path} · SCHEMA_VERSION ${r.generatedDocs.schemaVersion} · sha16 ${r.generatedDocs.sha16} · 扫描窗口 N=${r.generatedDocs.scanLines}`
    + ` · 豁免开关：${r.exemptEnabled ? '开' : '**关（跳过豁免判定 · §4.3 逃生舱）**'}`
    + ` · 白名单 sha16 ${r.whitelist.sha256 ? r.whitelist.sha256.slice(0, 16) : '（文件缺失）'}（${r.whitelist.entries} 条）`);
  L.push(`判定面 as-of：${new Date().toISOString()}（§6.2：生成器并发写档 ⇒ 同一清单两次跑的"实况"可不同，行号差异属预期）`);
  L.push(`段：§${r.sectionToken} · 标题 L${r.sec.titleLine} → 段末 L${r.sec.endLine}`);
  L.push(`根目录（--root）：${r.root}  ·  弱判据阈值（--min-token-hit）：${r.minTokenHit}`);
  L.push(`条目：${r.counts.entries} 条（${Object.entries(r.counts.byGroup).map(([k, v]) => `${k} 表 ${v}`).join(' · ')}）`);
  L.push('');
  L.push('| 组-# | 条目行 | 文件 | 行号 | 引文（截断） | 目标行 | 判定 | 说明 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) {
    const hitN = x.targets.filter((t) => ['hit', 'hit-weak'].includes(t.status)).length;
    const tg = x.targets.length ? `命中 ${hitN}/${x.targets.length}` : '—';
    L.push(`| ${x.group}${x.id ?? '-'} | L${x.srcLine} | ${x.files.join(' · ') || '—'} | ${x.lines.map((n) => ':' + n).join(' ') || '—'} | ${(x.keywords.join(' / ') || '—').slice(0, 40)} | ${tg} | ${x.status}${x.reason !== 'ok' ? `(${x.reason})` : ''} | ${x.note.slice(0, 90)} |`);
  }
  L.push('');
  const c = r.counts;
  L.push(`[汇总] 条目 ${c.entries} · PASS ${c.pass}（弱命中 ${c.weakPass} · 部分命中 ${c.partial}）· **FAIL ${c.fail}** · SKIP ${c.skip}${c.skippedOutOfRange ? `（其中 ${c.skippedOutOfRange} 条含**行号越界**，判定仍为 SKIP）` : ''} · 自动生成档豁免 **${c.generatedExempt}** 条 ⇒ ${c.fail === 0 ? 'PASS（清单与实况一致）' : `FAIL（${c.fail} 条与实况不符）`}`);
  const fails = r.rows.filter((x) => x.status === 'FAIL');
  if (fails.length) {
    L.push('');
    L.push(`FAIL 明细（${fails.length} 条）——**本工具只报不改，清单订正属另一件事**：`);
    for (const f of fails) {
      L.push(`  ${f.group}${f.id ?? '-'}（清单 L${f.srcLine}） ${f.files.join(' · ')} ${f.lines.map((n) => ':' + n).join(' ')} ⇒ ${f.reason}：${f.note}`);
      for (const t of f.targets) {
        const ex = t.tokensTotal ? ` token ${t.tokensHit}/${t.tokensTotal}` : '';
        const mi = t.missing && t.missing.length ? ` 缺[${t.missing.slice(0, 5).join(' ')}]` : '';
        L.push(`      - ${t.file}${t.line ? ':L' + t.line : ''} [${t.status}${ex}]${mi} ${t.head ? '实况：' + t.head : ''}`);
      }
      // 漂移候选逐条列出（只报一处会漏掉"疑似订正注行 vs 正文行"的区别 —— 2026-09-25 加，判定未变）
      if (f.drifts && f.drifts.length) {
        const shown = f.drifts.slice(0, DRIFT_TOP_N);
        L.push(`      ↳ 同串实况候选 ${f.drifts.length} 处（按【正文行 → 行首 > 引述行 → 订正注词面行】排序，列前 ${shown.length} 处；⚠️ 形态标注只是提示、不必然是错行）：`);
        for (const d of shown) {
          L.push(`          ${d.file}:L${d.line} ${d.strong ? '[强命中]' : `[弱命中 token ${Math.round(d.rate * 100)}%]`}${d.annot ? ` ${annotTag(d.annot)}` : ''}${d.annot ? ' ← 引述/订正注形态，需人工确认' : ''}`);
        }
        if (f.drifts.length > shown.length) L.push(`          …（余 ${f.drifts.length - shown.length} 处从略）`);
      }
    }
  }
  const skips = r.rows.filter((x) => x.status === 'SKIP');
  if (skips.length) {
    L.push('');
    L.push(`SKIP 明细（${skips.length} 条 · 不计入退出码）：`);
    for (const s of skips) L.push(`  ${s.group}${s.id ?? '-'}（清单 L${s.srcLine}） ${s.files.join(' · ') || '—'} ⇒ ${s.reason}：${s.note}`);
  }
  // SKIP 条目里已算出的行号越界（2026-09-25 加 · 只加可见性，判定与退出码不变）
  if (c.skippedOutOfRange) {
    L.push('');
    L.push(`SKIP 行号越界可见性（${c.skippedOutOfRange} 条 · **判定仍为 SKIP**、不计入退出码；「越界是否该计 FAIL」属口径变更，**未采纳 · 待主人拍板**）：`);
    for (const x of r.skippedOutOfRangeDetail) {
      L.push(`  ${x.group}${x.id ?? '-'}（清单 L${x.listLine}） ${x.files.join(' · ') || '—'} ⇒ ${x.outOfRange.map((t) => `${t.file}:L${t.line}（该档实际 ${t.fileLines} 行）`).join(' · ')}`);
    }
    L.push('  ↑ 原口径：SKIP 分支只核文件存在性就返回，**不消费**判定层已算出的 out-of-range 状态 ⇒ 越界在 SKIP 条目上完全不可见（本工具只补可见性，判定口径未动）。');
    L.push(`  ↑ 若按「行号越界 ⇒ FAIL」的口径（**未采纳**）：本档 FAIL ${c.fail} → ${r.ifOutOfRangeCountedAsFail.fail} · SKIP ${c.skip} → ${r.ifOutOfRangeCountedAsFail.skip}（退出码不变：仍有 FAIL ⇒ ${EXIT.FAIL}）。`);
  }
  // 「自动生成档 · 已豁免」节（§4.2-6 / §4.2-7）：**空态与开关关闭都必须显式出现**
  //    —— 便于判读"没生效"还是"无命中"（隐藏该节会让两种情形不可区分）
  L.push('');
  if (!r.exemptEnabled) {
    L.push('「自动生成档 · 已豁免」（**开关关闭 · 未生效** · env `DSH_CITES_EXEMPT=off` ⇒ **跳过豁免判定**，`counts.generatedExempt = 0`，判定结果与"豁免上线前"规范化后一致）：本节不参与任何判定。');
  } else if (!r.generatedExemptDetail.length) {
    L.push(`「自动生成档 · 已豁免」（**0 条：本次无自动生成档条目**）· 开关：开 · 白名单 ${r.whitelist.entries} 条`
      + `（sha16 ${r.whitelist.sha256 ? r.whitelist.sha256.slice(0, 16) : '（文件缺失）'}）`);
    L.push('  ↑ 空态 ≠ 未生效：本工具已接线（判定落点 `:359` 之前 · target 级 ∧ 资格维），只是本次清单里没有"档头带档级标记且家族有豁免资格"的越界 target。');
  } else {
    L.push(`「自动生成档 · 已豁免」（含豁免 target 的条目 **${r.generatedExemptDetail.length}** 条 · 其中**整条被豁免 ${c.generatedExempt}** 条 · 计数口径 = 条目级 §4.2-3）：`);
    for (const x of r.generatedExemptDetail) {
      L.push(`  ${x.group}${x.id ?? '-'}（清单 L${x.listLine}）${x.articleExempted
        ? '**整条已豁免** ⇒ SKIP / generated-doc-exempt（越界 target 已从判定集剔除）'
        : '整条**未**豁免（其豁免 target 已剔除，其余 target 仍按原判据落判 —— 该 FAIL 就 FAIL）'}`);
      for (const t of x.targets) {
        L.push(`      - ${t.file}:L${t.line} [generated-exempt · family=${t.family ?? '—'} · 依据=${t.exemptBy ?? '—'}]`);
      }
    }
    L.push('  ↑ 只放宽"行号越界"这一支：`file-missing` / `line-drift` / `content-mismatch` **一律不受豁免影响**（自动生成档真写错内容并被引用时照样红）。');
  }
  // 「判定语 · 不进引文核对面」节（档头 §⑨ · 2026-10-08 加）：**空态与有命中都显式出现**
  //    —— 隐藏该节会让"没生效"与"无命中"不可区分（同 ⑧ 的可见性纪律）
  L.push('');
  if (!r.judgementDescDetail.length) {
    L.push('「判定语 · 不进引文核对面」（**0 条：本次清单无判定语条目**）· 识别 = ①描述列表头 ∈ {`性质` / `为什么是假命中`}（全等）②描述列句首 `[体例·非引文]`；'
      + '作用 = 只降 `line-drift` / `content-mismatch` 两种 FAIL ⇒ SKIP(judgement-desc-exempt)（`file-missing` / `line-out-of-range` 一律照红）。');
  } else {
    L.push(`「判定语 · 不进引文核对面」（**${r.judgementDescDetail.length}** 条被降级 · 原判 line-drift / content-mismatch **不再计 FAIL**）：`);
    for (const x of r.judgementDescDetail) {
      const why = x.byColumn ? `列级：描述列表头「${x.column}」` : '行级：描述列句首 `[体例·非引文]`';
      const mi = x.miss.length ? ` · 失配明细 ${x.miss.map((m) => `${m.file}:L${m.line}`).join(' ')}` : '';
      L.push(`  ${x.group}${x.id ?? '-'}（清单 L${x.listLine}） ${x.files.join(' · ') || '—'} ⇒ 原判 **${x.formerReason}**（识别依据 ${why}）${mi}`);
    }
    L.push('  ↑ 口径（档头 §⑨）：判定语列/标记是**清单里人写给人看的判定语**（`docs\服务面隐私包-方案-20260917.md` §11.3.1 体例说明声明"该列不参与机械核"）'
      + '⇒ 不足以定 FAIL；但**不作废**：该列恰好与声明行对上时仍按原判据记 PASS（非 FAIL 的条目一字不改），`file-missing` / `line-out-of-range` 也一律照红。');
  }
  if (dump) {
    L.push('');
    L.push('解析明细（--dump）：');
    for (const x of r.rows) L.push(`  ${x.group}${x.id ?? '-'} L${x.srcLine} files=[${x.files.join(', ')}] lines=[${x.lines.join(',')}] kw=[${x.keywords.join(' | ')}]`);
  }
  return L;
}

function logPathDefault() {
  const dir = path.join(os.tmpdir(), 'docs-discipline-cites');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `check-cites-exist-${ts}.log`);
}

function jsonOut(r, { exitCode, error = null, logFile }) {
  return {
    tool: 'check-cites-exist',
    ok: exitCode === EXIT.OK && !error,
    exitCode,
    error,
    root: r?.root ?? null,
    minTokenHit: r?.minTokenHit ?? null,
    list: r ? { path: r.list.path, gc: r.list.gc, sha16: r.list.sha16 } : null,
    section: r ? { token: r.sectionToken, titleLine: r.sec.titleLine, endLine: r.sec.endLine } : null,
    counts: r?.counts ?? null,
    skippedOutOfRangeDetail: r?.skippedOutOfRangeDetail ?? [],
    judgementDescDetail: r?.judgementDescDetail ?? [],
    ifOutOfRangeCountedAsFail: r?.ifOutOfRangeCountedAsFail ?? null,
    // 「自动生成档」豁免（§4.2-6：顶层 whitelistSha + 开关现值 + 权威源版本；§6.2 口径②）
    exemptEnabled: r?.exemptEnabled ?? null,
    whitelistSha: r?.whitelist?.sha256 ?? null,
    whitelist: r?.whitelist ?? null,
    generatedDocs: r?.generatedDocs ?? null,
    generatedExemptDetail: r?.generatedExemptDetail ?? [],
    entries: r ? r.rows.map((x) => ({
      group: x.group, id: x.id, listLine: x.srcLine, files: x.files, lines: x.lines,
      keywords: x.keywords, status: x.status, reason: x.reason, match: x.match, note: x.note,
      // 条目级豁免原因（整条被豁免 ⇒ 'generated-doc-exempt'；否则 null —— 其豁免 target 仍逐条可见）
      exemptReason: x.reason === 'generated-doc-exempt' ? 'generated-doc-exempt' : null,
      // 「判定语」降级（档头 §⑨）：识别依据 + 被降的原 reason（非判定语条恒 null ⇒ 其余条目的既有字段语义不变）
      judgementDesc: x.judgementDesc ?? null,
      formerReason: x.formerReason ?? null,
      exemptedTargets: (x.exemptedTargets ?? []).map((t) => ({ file: t.file, line: t.line, family: t.family ?? null, exemptBy: t.exemptBy ?? null })),
      drifts: (x.drifts ?? []).map((d) => ({ file: d.file, line: d.line, rate: d.rate, strong: d.strong, annot: d.annot ?? null })),
      targets: x.targets.map((t) => ({ file: t.file, line: t.line, status: t.status, fileLines: t.fileLines ?? null, family: t.family ?? null, exemptBy: t.exemptBy ?? null, rate: t.rate ?? null, tokensHit: t.tokensHit ?? null, tokensTotal: t.tokensTotal ?? null, missing: t.missing ?? [], head: t.head ?? '' })),
    })) : [],
    logFile: logFile ?? null,
  };
}

// ---------------------------------------------------------------- CLI

function main() {
  const a = argParse(process.argv.slice(2), { values: ['list', 'section', 'root', 'log', 'min-token-hit'], flags: ['dump'] });
  const jsonMode = !!a.json;
  const logs = [];
  const emit = (lines) => { for (const l of lines) logs.push(l); };
  const printLogs = () => { if (!jsonMode) for (const l of logs) console.log(l); };

  const finish = (exitCode, payload, { writeLog = true } = {}) => {
    let logFile = a.log ?? null;
    if (writeLog) {
      logFile = logFile ?? logPathDefault();
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, logs.join('\n') + '\n', 'utf8');
      } catch { logFile = null; }
    }
    if (jsonMode) console.log(JSON.stringify({ ...payload, logFile }, null, 2));
    else if (logFile) console.log(`[日志] ${logFile}`);
    process.exitCode = exitCode;
  };

  if (a.error || a.help) {
    emit(renderHelp());
    printLogs();
    finish(a.error ? EXIT.USAGE : EXIT.OK, jsonOut(null, { exitCode: a.error ? EXIT.USAGE : EXIT.OK, error: a.error ?? null, logFile: null }), { writeLog: false });
    return;
  }
  if (a.selfTest) { selfTest(); return; }

  let minTokenHit = DEFAULT_MIN_TOKEN_HIT;
  if (a['min-token-hit'] !== undefined) {
    const v = Number(a['min-token-hit']);
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      emit([`✗ --min-token-hit 须为 (0,1] 之间的数，收到：${a['min-token-hit']}`]);
      printLogs();
      finish(EXIT.USAGE, jsonOut(null, { exitCode: EXIT.USAGE, error: 'bad --min-token-hit', logFile: null }), { writeLog: false });
      return;
    }
    minTokenHit = v;
  }
  if (!a.list) {
    emit(['✗ 缺 --list <清单档>（--help 看用法）']);
    printLogs();
    finish(EXIT.USAGE, jsonOut(null, { exitCode: EXIT.USAGE, error: 'missing --list', logFile: null }), { writeLog: false });
    return;
  }

  let r;
  try {
    r = runCheck({ listPath: a.list, sectionToken: a.section ?? DEFAULT_SECTION, root: a.root ?? DEFAULT_ROOT, minTokenHit });
  } catch (e) {
    const code = e.code === 'LIST_UNREADABLE' ? EXIT_LIST_UNREADABLE : EXIT.INTERNAL;
    emit([`✗ ${e.message}`]);
    printLogs();
    finish(code, jsonOut(null, { exitCode: code, error: e.message, logFile: a.log ?? null }));
    return;
  }
  const lines = render(r, { dump: !!a.dump });
  emit(lines);
  const exitCode = r.counts.fail === 0 ? EXIT.OK : EXIT.FAIL;
  printLogs();
  finish(exitCode, jsonOut(r, { exitCode, logFile: a.log ?? null }));
}

function renderHelp() {
  return helpBlock({
    title: '引用处清单机械判据（G29 · 清单 ↔ 实况对账，只读）',
    usage: 'node check-cites-exist.mjs --list <清单档> [--section 11.3.1] [--root <DSH_ROOT>] [--min-token-hit 0.8] [--dump] [--json] [--log <日志档>]',
    form: ['清单档 · 行数 · sha16 · 段起止行号 · 根目录 · 弱判据阈值 · 条目数（A/B/C 分组）',
      '逐条表：组-# | 清单行 | 文件 | 行号 | 引文 | 目标行命中数 | 判定（PASS/FAIL/SKIP + 原因）| 说明（match=strong/weak n%）',
      '[汇总] 条目 N · PASS x（弱命中 y · 部分命中 z）· FAIL w · SKIP v（其中 k 条含行号越界）⇒ PASS/FAIL',
      'FAIL 明细：逐目标行回显实况行首 60 字 + token 命中比（便于人工判漂移还是解析问题）',
      'FAIL 明细 · line-drift 条目：另列「同串实况候选」全部候选行（top-N = DRIFT_TOP_N），并标注引述/订正注形态（只是提示、需人工确认）',
      'SKIP 明细：逐条回显原因；另设「SKIP 行号越界可见性」节列出 SKIP 条目里已越界的行号（判定仍为 SKIP）',
      '`--json` ⇒ stdout 只有一份 JSON（含 counts.skippedOutOfRange / skippedOutOfRangeDetail / ifOutOfRangeCountedAsFail / judgementDescDetail / 每条 drifts · 豁免面：顶层 exemptEnabled + whitelistSha + generatedDocs(schemaVersion/sha16) + 每条 exemptReason/exemptedTargets + generatedExemptDetail），人类日志只落 --log 文件',
      '「自动生成档 · 已豁免」节（§4.2-6 / §4.2-7）：开关关闭 ⇒ 「开关关闭 · 未生效」；无命中 ⇒ 「0 条：本次无自动生成档条目」（**该节恒出现，不隐藏** —— 便于判读"没生效"还是"无命中"）',
      '「判定语 · 不进引文核对面」节（2026-10-08 加）：逐条列出被降级的条目（识别依据 = 列级/行级 · 原判 reason · 失配明细）；无命中 ⇒ 「0 条：本次清单无判定语条目」（**该节恒出现，不隐藏**）'],
    caliber: ['清单结构：段内 `**A. ...**` / `**B. ...**` / `**C. ...**` 三个加粗段各带一张表；',
      'A 表 5 列（# | 文件 | 命中处行号 | 该处原来写的是什么 | 处置），B/C 表 3 列（文件 | 命中处 | 性质/假命中理由）；',
      '文件列取反引号内的 `.md/.json` 路径（`〃` 继承上一条；`…-xxx.md` 走同目录唯一候选解析，不唯一 ⇒ SKIP）；',
      '行号列取所有 `:N`（含 `:90`–`:91` 区间端点、括注里的第二行号）；',
      '引文 = 描述列的 `「…」`/`"…"` 内容（允许内层 `『』` 嵌套；无引文退回 `**加粗**`），按 `…` 切段后逐段核；',
      '归一 `normC`：NFKC 折全角→半角，再去 markdown 标记 / 引号 / 空白 / 单引号 / 表格竖线 `|`；',
      '内容相符双口径：**强** = 全段子串命中；**弱** = token 命中率 ≥ --min-token-hit（默认 0.8）——清单第 4 列是摘要不是逐字引文，纯子串口径会大面积假红；',
      '条目判定（**段覆盖**）：描述里的每个引文段都须落在某个目标行上（强命中或 token 弱达标）⇒ PASS；无引文可抽 ⇒ SKIP(no-keyword)；文件缺/行号越界/某段一处不落 ⇒ FAIL；',
      '已知弱面：段覆盖不校验"第 k 段必须落在第 k 个行号"；引文过短（如「事实」「元信息」）时弱判据轻易满足；相邻表格行 token 高度重叠可能互判达标；',
      '漂移候选（2026-09-25 加 · 判定未变）：候选 = **全部引文段都达标**的行（声明行不算"别处"）；**全部收集后排序**，排序键 = 正文行(0) < 行首 `>` 引述行(1) < 含「订正注/订正说明/送审件/上一版」词面的行(2)，同类按行号升序；**只排序+标注、绝不过滤**，输出列 top-N（DRIFT_TOP_N）；',
      '为什么排序：订正注行逐字引述原句时会与正文命中处同时达标，原实现"首处即 break"会把订正注行当成实况报出去（判定仍是 line-drift，只是"实况在 L<n>"指错行）；',
      '标注口径（只是形态提示、非错行判定）：`correction` 词面刻意收窄为「订正注/订正说明/送审件/上一版」——不收「快照/旧值/STAMP/历史/实测/原文」（实测会误标正文行）；`quote` = 行首 `>` 引述块，**正文表格行被引述时同样命中**（实测就是清单里的真实命中处）⇒ 带标注的候选需人工确认，不能直接当"实况"照抄；',
      'SKIP 行号越界可见性（2026-09-25 加 · 判定未变）：无引文/无行号 ⇒ 仍记 SKIP，但判定层已算出的 out-of-range 改为可见（counts.skippedOutOfRange + 报告专节 + JSON 明细）；',
      '⚠️「行号越界是否该计 FAIL」是**口径变更**，本工具**未采纳**：--json 里 ifOutOfRangeCountedAsFail 给出的只是**假设值**，供主人拍板（现口径 = 越界在 SKIP 条目上不影响退出码）；',
      '「自动生成档」豁免（2026-10-08 加 · 方案 §4.2 / §4.3）：判定落点 = **:359 之前**，粒度 = **target 级 ∧ 资格维** —— target 越界 **且**（档头前 5 行行首带档级标记 `<!-- dsh-generated-doc:auto` **或** 命中例外白名单，后者本轮恒 false）**且** 家族 `exemptEligible === true` ⇒ 该 target 标 `generated-exempt` 并从判定集剔除；',
      '条目级「仅因」算法（§4.2-2 写死）：**先剔除豁免 target、再按原判据复算** ⇒ 仅当"原始集合会触发 :359"且"剔除后不触发任何 FAIL 分支"时，整条转 `SKIP` + `reason = generated-doc-exempt`；否则按剔除后的原判据落判（该 FAIL 就 FAIL）；',
      '豁免**只放宽"行号越界"这一支**：`file-missing` / `line-drift` / `content-mismatch` 一律不受影响（自动生成档真写错内容并被引用 ⇒ 照样红）；`counts.generatedExempt` = **整条被豁免的条目数**（条目级，部分豁免不计入）；',
      '🔴 逃生舱（§4.3 · M-5）：env `DSH_CITES_EXEMPT=off`（或权威源 `EXEMPT_ENABLED = false`）⇒ **跳过豁免判定**（报告节显示「开关关闭 · 未生效」、`counts.generatedExempt = 0`、结果与"豁免上线前"规范化一致）—— 改开关不需要改代码、不需要重启；',
      '权威源 = `tools\\lib\\generated-docs.mjs`（§2.5 唯一权威源：标记字面 / 扫描窗口 N=5 / 插入点 insertAtFor / 15 族登记表 / exemptEligible；改它须同步 SCHEMA_VERSION）；本条含豁免的判定**不读档头的 `family=<id>` 值**（只认前缀，新增家族不改判据）；',
      '「判定语 · 不进引文核对面」（2026-10-08 加 · 主人当场口头令拍板 S5 = A）：真源 = 清单自己的体例说明（B 表「性质」列 / C 表「为什么是假命中」列 = 人工摘要与判定语，声明"不参与机械核"）；识别 = ①描述列表头 **trim 后全等** ∈ {`性质` / `为什么是假命中`} ②描述列**句首**以 `[体例·非引文]` 开头；作用 = **只降**引文面两种 FAIL（`line-drift` / `content-mismatch`）⇒ 整条 `SKIP` + `reason = judgement-desc-exempt`；',
      '⚠️ 判定语降级**不放宽其它判定**：`file-missing` / `line-out-of-range` 一律照红；**非 FAIL 的条目一字不改**（判定语列恰好对上声明行时仍按原判据记 PASS —— 只做降级、不做作废）；原判 reason 记在 `formerReason`、失配明细仍在 `targets`、报告设专节 + JSON `judgementDescDetail` 逐条列出；',
      '本工具只核「文件存在 + 行号处内容相符」，**不核**处置列（订正注是否已写）；除判红外不做任何动作、不写生产路径'],
    scope: { docs: '带「引用处清单」段的方案/盘点档（当前 = 服务面隐私包方案 §11.3.1）', stage: '真源口径改动后 / 定期巡检', who: '文档纪律线（收尾或巡检会话）' },
    exits: ['0 = 全部条目 PASS/SKIP（无 FAIL）', '3 = 有 FAIL（清单与实况不符）', '2 = 用法错', '4 = 读不到清单档 / 段不存在'],
    selfTest: 'node check-cites-exist.mjs --self-test',
  });
}

// ---------------------------------------------------------------- 自测（夹具全部落 os.tmpdir，禁写生产路径）

function fixtureList() {
  return [
    '# 夹具清单',
    '',
    '#### 11.3.1 「引用处清单」（夹具）',
    '',
    '**A. 假活文档引用处**',
    '',
    '| # | 文件 | 命中处（行号） | 该处原来写的是什么 | 处置 |',
    '|---|---|---|---|---|',
    '| A1 | `tgt\\a.md` | `:5` | 「口径真源：只标注不抹原文」 | **回写** → 订正注 `:7` |',
    '| A2 | `tgt\\missing.md` | `:3` | 「这句话在缺失档里」 | **回写** |',
    '| A3 | `tgt\\a.md` | `:9` | 「口径真源：只标注不抹原文」 | **回写** |',
    '| A4 | `tgt\\b.md` | `:3` | 「根本不存在的一句话」 | **回写** |',
    '| A5 | `tgt\\a.md` | `:5` | 没有引文的条目 | **回写** |',
    '| A6 | `tgt\\a.md` | `:99` | 「口径真源：只标注不抹原文」 | **回写** |',
    '| A7 | `tgt\\tbl.md` | `:2` | 「家人模型档 ✅ **先挂免费档**（智谱 `glm-4.7-flash`）」 | **回写** |',
    '| A8 | `tgt\\tbl.md` | `:3` | 「默认档 = 智谱 `glm-4.7-flash`（免费）」 | **回写** |',
    '| A9 | `tgt\\tbl.md` | `:2` | 「默认档 = 智谱 `glm-4.7-flash`（免费）」 | **回写**（引文实际在 L3 ⇒ 应判漂移） |',
    '| A10 | `tgt\\tbl2.md` | `:2` `:3` | 「第甲段标记」「第二段标记」 | **回写**（两段分居两行 ⇒ 段覆盖口径应 PASS） |',
    '',
    '**B. 假历史报告**',
    '',
    '| 文件 | 命中处 | 性质 |',
    '|---|---|---|',
    '| `tgt\\hist.md` | `:2` | 时点记录（含"假别名副本"的结论） |',
    '',
    '**C. 假命中**',
    '',
    '| 文件 | 命中处 | 为什么是假命中 |',
    '|---|---|---|',
    '| `tgt\\c.md` | `:4` | "11.3%" = 观测比例 |',
    '',
    '**D. 变更程序**',
    '',
    '1. 无表。',
    '',
    '## 下一节',
    '',
    '（段外内容不该被解析）',
    '| A9 | `tgt\\a.md` | `:5` | 「段外的行」 | 不该出现 |',
    '',
  ].join('\n');
}

/** 可见性夹具（2026-09-25 加）：专测 ①订正注/引述行降权 + 候选全列 top-N ②SKIP 条目行号越界可见性 */
function fixtureList2() {
  return [
    '# 夹具清单 v2（可见性）',
    '',
    '#### 11.3.1 「引用处清单」（夹具 v2）',
    '',
    '**A. 可见性夹具**',
    '',
    '| # | 文件 | 命中处（行号） | 该处原来写的是什么 | 处置 |',
    '|---|---|---|---|---|',
    '| A1 | `tgt\\ann.md` | `:9` | 「口径真源：只标注不抹原文」 | **回写**（L3 订正注行 / L5 引述行 / L7 正文行三处同时达标） |',
    '| A2 | `tgt\\many.md` | `:9` | 「口径真源：只标注不抹原文」 | **回写**（7 处候选 ⇒ 测 top-N 截断） |',
    '| A3 | `tgt\\short.md` | `:9` | 没有引文的条目 | **回写**（该档仅 3 行 ⇒ 越界 + 无引文） |',
    '| A4 | `tgt\\short.md` | `:9` | 没有引文的条目（第二条越界） | **回写** |',
    '',
    '## 完',
    '',
  ].join('\n');
}

/** 可见性夹具的文档实体（全部落 os.tmpdir） */
function writeVisibilityDocs(dir) {
  writeTmp(dir, 'tgt/ann.md', [
    '# ann',
    '',
    '> ⚠️ **订正注（2026-09-25）**：原句「口径真源：只标注不抹原文」已过期', // L3 = correction（含订正注词面）
    '',
    '> 引述块里的正文行「口径真源：只标注不抹原文」', // L5 = quote（行首 >）
    '',
    '口径真源：只标注不抹原文，不改正文', // L7 = 正文行（应排序最优先）
    '',
    '尾巴',
  ].join('\n'));
  writeTmp(dir, 'tgt/many.md', [
    '# many',
    ...Array.from({ length: 7 }, (_, i) => `口径真源：只标注不抹原文 ${'ABCDEFG'[i]}`), // L2..L8 = 7 处候选
    '尾巴',
  ].join('\n'));
  writeTmp(dir, 'tgt/short.md', ['# short', '行二', '行三'].join('\n')); // 仅 3 行 ⇒ :9 必越界
}

/** 豁免夹具清单（2026-10-08 加 · 方案 §4.5 五类夹具）
 *  ① 混合条目（人工档 + 自动档都越界）② 生成档（= §4.4-7「真豁免」正向门的承载者）
 *  ③ 自举负样例（档头无标记、正文引用标记）④ 资格维负样例（`watch` / `external` 带标记但不豁免）
 *  ⑤ 家族匹配构造性断言（在 selfTest 里对权威源家族表逐族跑，见 G 段）
 *  ⚠️ 另设 A8 / A9 = 「豁免面没被放宽」反向夹具（line-drift / content-mismatch 在自动档上**仍红**） */
function fixtureList3() {
  return [
    '# 夹具清单 v3（自动生成档 · 豁免）',
    '',
    '#### 11.3.1 「引用处清单」（夹具 v3）',
    '',
    '**A. 豁免夹具**',
    '',
    '| # | 文件 | 命中处（行号） | 该处原来写的是什么 | 处置 |',
    '|---|---|---|---|---|',
    '| A1 | `docs\\管家报告\\2026-10-08-HostA.md` | `:999` | 「口径真源：只标注不抹原文」 | ② 自动档越界 ⇒ 开开关转 SKIP（正向门） |',
    '| A2 | `docs\\夹具人工档.md` | `:999` | 「口径真源：只标注不抹原文」 | ① 人工档越界 ⇒ **仍 FAIL** |',
    '| A3 | `docs\\管家报告\\2026-10-08-HostA.md` `docs\\夹具人工档.md` | `:999` | 「口径真源：只标注不抹原文」 | ① 混合条目（两边都越界）⇒ 整条**仍 FAIL** |',
    '| A4 | `docs\\夹具自举档.md` | `:999` | 「口径真源：只标注不抹原文」 | ③ 档头无标记（正文引用）⇒ **仍 FAIL** |',
    '| A5 | `docs\\管家报告\\watch-2026-10-08-hosta.md` | `:999` | 「口径真源：只标注不抹原文」 | ④ watch 带标记但无资格 ⇒ **仍 FAIL** |',
    '| A6 | `docs\\管家报告\\external-2026-10-08-HostA.md` | `:999` | 「口径真源：只标注不抹原文」 | ④ external ⇒ **仍 FAIL** |',
    '| A7 | `docs\\管家报告\\2026-10-08-HostA.md` | `:4` | 「口径真源：只标注不抹原文」 | 行号准 ⇒ **仍 PASS**（豁免只管越界） |',
    '| A8 | `docs\\管家报告\\2026-10-08-HostA.md` | `:3` | 「漂移声明句：仅此一处」 | 自动档 line-drift ⇒ **仍 FAIL**（不放宽） |',
    '| A9 | `docs\\管家报告\\2026-10-08-HostA.md` | `:4` | 「全档都不存在的一句话」 | 自动档 content-mismatch ⇒ **仍 FAIL**（不放宽） |',
    '',
    '## 完',
    '',
  ].join('\n');
}

/** 豁免夹具的文档实体（全部落 os.tmpdir · **禁写生产路径**）
 *  自动档 = daily 族（有资格）· watch/external 档 = 无资格族（带标记但不豁免） */
function writeExemptDocs(dir) {
  writeTmp(dir, 'docs/管家报告/2026-10-08-HostA.md', [
    '# 2026-10-08 日报（夹具 · 自动生成档）',
    '<!-- dsh-generated-doc:auto family=daily -->',
    '> 生成于 09:00（夹具，刻意与大管家日报同构）',
    '口径真源：只标注不抹原文，不改正文',   // L4：A7 的命中行
    '尾巴',
    '漂移声明句：仅此一处',                 // L6：A8 的"实况在别处"
    '',
  ].join('\n'));
  writeTmp(dir, 'docs/夹具人工档.md', [
    '# 夹具人工档（无档级标记）',
    '口径真源：只标注不抹原文，不改正文',
    '尾巴',
    '',
  ].join('\n'));
  writeTmp(dir, 'docs/夹具自举档.md', [
    '# 夹具自举档（人工档 · 正文第 20+ 行逐字引用标记）',
    ...Array.from({ length: 20 }, (_, i) => `正文第 ${i + 2} 行`),
    '逐字引用 `<!-- dsh-generated-doc:auto family=daily -->` 的行（自举负样例）',
    '',
  ].join('\n'));
  writeTmp(dir, 'docs/管家报告/watch-2026-10-08-hosta.md', [
    '# watch 夹具（登记但**不豁免**族 · 带标记）',
    '<!-- dsh-generated-doc:auto family=watch -->',
    '> 由 `…watch-notify.mjs` 每 5 分钟自动追加（仅在有事件时写）',
    '',
  ].join('\n'));
  writeTmp(dir, 'docs/管家报告/external-2026-10-08-HostA.md', [
    '# external 夹具（登记但**不豁免**族 · 带标记）',
    '<!-- dsh-generated-doc:auto family=external -->',
    '> 由 `…butler-external.mjs` 按源节流追加',
    '',
  ].join('\n'));
}

/** 判定语夹具清单（2026-10-08 加 · 主人拍板 S5 = A：「判定语」不进引文核对面）
 *  **每条都是可失败的**（改错就红）：
 *    · 反向门（**不放宽**）：A1 非判定语 / A3 标记不在句首 / B3 行号越界 / B4 文件缺失 / D1 表头非白名单 ⇒ 一律**仍 FAIL**；
 *    · 正向门（**真降级**）：A2 行级标记 · B1/B5/C1 列级表头（B5 覆盖 line-drift、B1 覆盖 content-mismatch）；
 *    · 不误伤门：B2 判定语列**恰好命中** ⇒ 仍按原判据 PASS（只降级、不作废）。 */
function fixtureList4() {
  return [
    '# 夹具清单 v4（判定语 · 不进引文核对面）',
    '',
    '#### 11.3.1 「引用处清单」（夹具 v4）',
    '',
    '**A. 引文列（行级标记）**',
    '',
    '| # | 文件 | 命中处（行号） | 该处原来写的是什么 | 处置 |',
    '|---|---|---|---|---|',
    '| A1 | `jg\\a.md` | `:9` | 「全档都不存在的一句话」 | 非判定语（对照）⇒ **仍 FAIL** |',
    '| A2 | `jg\\a.md` | `:9` | [体例·非引文] 判定语说明「全档都不存在的一句话」 | 句首标记 ⇒ 降级 SKIP |',
    '| A3 | `jg\\a.md` | `:9` | 判定语标记不在句首 [体例·非引文]「全档都不存在的一句话」 | 标记非句首 ⇒ **仍 FAIL** |',
    '',
    '**B. 性质列（列级 · 表头全等）**',
    '',
    '| 文件 | 命中处 | 性质 |',
    '|---|---|---|',
    '| `jg\\a.md` | `:9` | 「全档都不存在的一句话」 |',
    '| `jg\\a.md` | `:3` | 「口径真源：只标注不抹原文」 |',
    '| `jg\\a.md` | `:99` | 「越界也照红」 |',
    '| `jg\\missing.md` | `:3` | 「文件缺也照红」 |',
    '| `jg\\a.md` | `:9` | 「口径真源：只标注不抹原文」 |',
    '',
    '**C. 为什么是假命中（列级 · 表头全等）**',
    '',
    '| 文件 | 命中处 | 为什么是假命中 |',
    '|---|---|---|',
    '| `jg\\a.md` | `:9` | 「全档都不存在的一句话」 |',
    '',
    '**D. 表头非白名单（对照 · 证明用全等、不用 includes）**',
    '',
    '| 文件 | 命中处 | 性质说明 |',
    '|---|---|---|',
    '| `jg\\a.md` | `:9` | 「全档都不存在的一句话」 |',
    '',
    '## 完',
    '',
  ].join('\n');
}

/** 判定语夹具的文档实体（全部落 os.tmpdir · **禁写生产路径**）
 *  L3/L5 含「口径真源：只标注不抹原文」（⇒ 声明 :3 命中 = PASS / 声明 :9 时在别处 = line-drift）；
 *  L9 是声明行本身（不含该句 ⇒ content-mismatch）；共 11 行（⇒ `:99` 必越界）。 */
function writeJudgementDocs(dir) {
  writeTmp(dir, 'jg/a.md', [
    '# jg a',
    '',
    '口径真源：只标注不抹原文，不改正文',
    '',
    '口径真源：只标注不抹原文，也不改别的',
    '',
    '行七',
    '',
    '行九（声明行）',
    '',
    '尾巴',
  ].join('\n'));
}

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-cites-exist-');
  try {
    writeTmp(dir, 'tgt/a.md', ['# a', '', '行三', '', '口径真源：只标注不抹原文，不改正文', '', '订正注：按 D2 作废', '', '行九', ''].join('\n'));
    writeTmp(dir, 'tgt/b.md', ['# b', '', '这里是完全另一句话', ''].join('\n'));
    writeTmp(dir, 'tgt/hist.md', ['# hist', '审核报告（含假别名副本的时点结论）'].join('\n'));
    writeTmp(dir, 'tgt/c.md', ['# c', '', '行三', '观测比例 11.3% 上界'].join('\n'));
    writeTmp(dir, 'tgt/tbl.md', [
      '# tbl',
      '| 5 | **家人模型档** | ✅ **先挂免费档**（智谱 `glm-4.7-flash`） | 火山引擎缓议 |',
      '| **默认档** | 智谱 `glm-4.7-flash`（**免费**，官方基础版限 1 并发） |',
      '| 尾巴 |',
    ].join('\n'));
    writeTmp(dir, 'tgt/tbl2.md', [
      '# tbl2',
      '| 甲 | 第甲段标记 |',
      '| 乙 | 第二段标记 |',
    ].join('\n'));
    const list = writeTmp(dir, 'list.md', fixtureList());

    // —— 解析层
    const listMeta = meta(list);
    const sec = locateSection(listMeta.lines, '11.3.1');
    assertTrue(sec && sec.titleLine === 3, '段定位：标题在第 3 行', res, JSON.stringify(sec));
    assertTrue(sec && listMeta.lines[sec.endLine] === '## 下一节', '段末 = 下一个 1–2 级标题（含段末行号）', res, `endLine=${sec?.endLine}`);
    const { groups, entries } = parseEntries(listMeta.lines, sec);
    assertEq(groups.map((g) => g.key), ['A', 'B', 'C', 'D'], '四组齐（D 组无表）', res);
    assertEq(entries.length, 12, '共 12 条（A 10 + B 1 + C 1；段外那条不计）', res);
    assertEq(entries[0].keywords, ['口径真源：只标注不抹原文'], '引文抽取 + 归一', res);
    assertEq(entries[5].lines, [99], '行号抽取（A6 :99）', res);
    assertEq(parseKeywords('「第一段…第二段」'), ['第一段', '第二段'], '引文按 `…` 切段（省略号 = 中间省略 ⇒ 逐段都须命中）', res);
    assertEq(parseKeywords('§4.3-② 第 1 条「**出机口径 = 『永不明文出本机』**」'), ['**出机口径 = 『永不明文出本机』**'], '嵌套引号 `「…『…』…」` 不截断', res);
    assertEq(normC('智谱（免费）'), '智谱(免费)', 'normC：NFKC 折全角括号 → 半角', res);
    assertEq(normC('| A | B |'), 'AB', 'normC：去表格竖线（清单引文常省 `|`）', res);

    // —— 判定层：4 类分支全覆盖 + 双口径
    const r = runCheck({ listPath: list, root: dir });
    const by = (id) => r.rows.find((x) => x.id === id);
    assertEq(by('A1').status, 'PASS', '①全过分支：文件在 + 行号准 + 引文命中 ⇒ PASS', res);
    assertEq(by('A2').status, 'FAIL', '②文件缺失 ⇒ FAIL', res);
    assertEq(by('A2').reason, 'file-missing', '②原因 = file-missing', res);
    assertEq(by('A3').status, 'FAIL', '③行号漂移 ⇒ FAIL', res);
    assertEq(by('A3').reason, 'line-drift', '③原因 = line-drift', res);
    assertTrue(by('A3').note.includes('L5'), '③漂移探测指出实况行号 L5', res, by('A3').note);
    assertEq(by('A4').status, 'FAIL', '④内容不符 ⇒ FAIL', res);
    assertEq(by('A4').reason, 'content-mismatch', '④原因 = content-mismatch', res);
    assertEq(by('A5').status, 'SKIP', '⑤无引文 ⇒ SKIP', res);
    assertEq(by('A5').reason, 'no-keyword', '⑤原因 = no-keyword', res);
    assertEq(by('A6').status, 'FAIL', '⑥行号越界 ⇒ FAIL', res);
    assertEq(by('A6').reason, 'line-out-of-range', '⑥原因 = line-out-of-range', res);
    assertEq(by('A7').status, 'PASS', '⑦强口径：表格行省掉 `|` 也能子串命中 ⇒ PASS', res);
    assertEq(by('A7').match, 'strong', '⑦match = strong', res);
    assertEq(by('A8').status, 'PASS', '⑧弱口径：引文是摘要（`X = Y` vs 表格两格）⇒ PASS(weak)', res);
    assertEq(by('A8').match, 'weak', '⑧match = weak（引文摘要在 L3 全 token 命中）', res);
    assertEq(by('A9').status, 'FAIL', '⑨相邻行 token 部分重叠仍判漂移 ⇒ FAIL', res);
    assertEq(by('A9').reason, 'line-drift', '⑨原因 = line-drift（同串实况在 L3）', res);
    assertEq(by('A10').status, 'PASS', '⑩段覆盖：两段引文分居两行 ⇒ PASS（不要求"全段落在同一行"）', res);
    assertTrue(by('A10').note.includes('段覆盖 2/2'), '⑩note 记明段覆盖 2/2', res, by('A10').note);
    assertEq(r.rows.find((x) => x.group === 'B').status, 'PASS', 'B 表条目按同口径核（命中）', res);
    assertEq(r.rows.find((x) => x.group === 'C').status, 'PASS', 'C 表条目按同口径核（11.3% 命中）', res);
    assertEq(r.counts, { entries: 12, pass: 6, fail: 5, skip: 1, weakPass: 1, partial: 0, byGroup: { A: 10, B: 1, C: 1, D: 0 }, skippedOutOfRange: 0, generatedExempt: 0 }, '汇总计数（含 skippedOutOfRange / generatedExempt）', res);
    const r2 = runCheck({ listPath: list, root: dir, minTokenHit: 0.6 });
    assertEq(r2.rows.find((x) => x.id === 'A9').status, 'PASS', '阈值可注入：--min-token-hit 0.6 ⇒ A9 变弱命中 PASS（证明阈值真被使用）', res);
    assertEq(r2.counts.fail, 4, '阈值放宽后 FAIL 由 5 → 4', res);

    // —— CLI 层端到端：退出码 + --json 静默 + 日志落盘（全部走 temp）
    const log1 = path.join(dir, 'run1.log');
    const p1 = spawnSync(process.execPath, [SELF, '--list', list, '--root', dir, '--json', '--log', log1], { encoding: 'utf8' });
    assertEq(p1.status, EXIT.FAIL, 'CLI：有 FAIL ⇒ 退出码 3', res);
    let j1 = null;
    try { j1 = JSON.parse(p1.stdout); } catch { /* 下面断言会报 */ }
    assertTrue(j1 && j1.exitCode === EXIT.FAIL, 'CLI --json：stdout 是可解析 JSON 且带 exitCode', res, `stdout 头 120 字：${String(p1.stdout).slice(0, 120)}`);
    assertTrue(!String(p1.stdout).includes('清单档：'), 'CLI --json：stdout **不含**人类日志（红线：日志只落文件）', res, String(p1.stdout).slice(0, 120));
    assertTrue(fs.existsSync(log1) && fs.readFileSync(log1, 'utf8').includes('清单档：'), 'CLI --json：人类日志落在 --log 文件里', res);
    const p1b = spawnSync(process.execPath, [SELF, '--list', list, '--root', dir, '--min-token-hit', '0.7', '--json', '--log', path.join(dir, 'run1b.log')], { encoding: 'utf8' });
    assertEq(p1b.status, EXIT.FAIL, 'CLI：--min-token-hit 透传（仍有 FAIL ⇒ 3）', res);

    // —— CLI：全过夹具 ⇒ 退出码 0
    const dir2 = makeTmp('dd-cites-exist-ok-');
    try {
      writeTmp(dir2, 'tgt/a.md', ['# a', '', '口径真源：只标注不抹原文'].join('\n'));
      const list2 = writeTmp(dir2, 'list.md', [
        '# 夹具清单（全过）', '', '#### 11.3.1 清单', '', '**A. 活文档引用处**', '',
        '| # | 文件 | 命中处（行号） | 该处原来写的是什么 | 处置 |', '|---|---|---|---|---|',
        '| A1 | `tgt\\a.md` | `:3` | 「口径真源：只标注不抹原文」 | **回写** |', '',
        '## 完', '',
      ].join('\n'));
      const log2 = path.join(dir2, 'run2.log');
      const p2 = spawnSync(process.execPath, [SELF, '--list', list2, '--root', dir2, '--json', '--log', log2], { encoding: 'utf8' });
      assertEq(p2.status, EXIT.OK, 'CLI：全过 ⇒ 退出码 0', res);
      const p3 = spawnSync(process.execPath, [SELF, '--list', path.join(dir2, 'nope.md'), '--json', '--log', path.join(dir2, 'run3.log')], { encoding: 'utf8' });
      assertEq(p3.status, EXIT_LIST_UNREADABLE, 'CLI：读不到清单 ⇒ 退出码 4', res);
      const p4 = spawnSync(process.execPath, [SELF, '--json', '--log', path.join(dir2, 'run4.log')], { encoding: 'utf8' });
      assertEq(p4.status, EXIT.USAGE, 'CLI：缺 --list ⇒ 退出码 2', res);
      const p5 = spawnSync(process.execPath, [SELF, '--list', list2, '--min-token-hit', '9', '--json'], { encoding: 'utf8' });
      assertEq(p5.status, EXIT.USAGE, 'CLI：--min-token-hit 越界 ⇒ 退出码 2', res);
      const p6 = spawnSync(process.execPath, [SELF, '--list', path.join(dir2, 'nope.md')], { encoding: 'utf8' });
      assertEq(p6.status, EXIT_LIST_UNREADABLE, 'CLI：读不到清单（非 json）⇒ 退出码 4', res);
    } finally { rmrf(dir2); }

    // —— 可见性（2026-09-25 加）：① 漂移候选降权/标注 + 全列 top-N ② SKIP 条目行号越界可见性
    //     红线自证：新增能力**只加可见性**——① 的判定仍 FAIL(line-drift)，② 的判定仍 SKIP(no-keyword)、不进 FAIL
    const vdir = makeTmp('dd-cites-exist-vis-');
    try {
      writeVisibilityDocs(vdir);
      const list3 = writeTmp(vdir, 'list.md', fixtureList2());
      const r3 = runCheck({ listPath: list3, root: vdir });
      const by3 = (id) => r3.rows.find((x) => x.id === id);
      // ① 订正注/引述行降权 + 候选全列
      assertEq(by3('A1').status, 'FAIL', '可见性①：订正注行存在时判定仍为 FAIL（口径未变）', res);
      assertEq(by3('A1').reason, 'line-drift', '可见性①：原因仍为 line-drift', res);
      assertEq(by3('A1').drifts.length, 3, '可见性①：三处候选**全部**收集（原实现在首处 break ⇒ 会丢掉正文行）', res);
      assertEq(by3('A1').drifts.map((d) => d.line), [7, 5, 3], '可见性①：排序 = 正文行 L7 → 行首 > 引述行 L5 → 订正注行 L3', res);
      assertEq(by3('A1').drifts.map((d) => d.annot), [null, 'quote', 'correction'], '可见性①：逐条标注 annot（null/quote/correction）', res);
      assertTrue(by3('A1').note.includes('L7') && by3('A1').note.includes('订正注词面'), '可见性①：说明文字首选正文行并标出订正注词面行', res, by3('A1').note);
      assertTrue(by3('A1').note.includes('引述行') && by3('A1').note.includes('不必然是错行'), '可见性①：说明文字标出行首 > 引述行、并写明"只是提示"', res, by3('A1').note);
      // ①″ 词面判据收窄（防误标正文行）：正文里的「快照 / 原文 / 历史」不算订正注词面
      assertEq([annotKind('| ⑤-3 | … + `VACUUM INTO` 快照 |'), annotKind('正文行：原文见 §3'), annotKind('> ⚠️ **订正注（2026-09-25）**：原句已过期'), annotKind('> | **PM0 定位** | 已降级 |'), annotKind('普通正文行')], [null, null, 'correction', 'quote', null], '可见性①″：annotKind 词面收窄（快照/原文不标；订正注=correction；行首 >=quote）', res);
      // ①′ top-N 截断（7 处候选只列前 5，但全部进 drifts 供 JSON 用）
      assertEq(by3('A2').drifts.length, 7, '可见性①′：7 处候选全部进 drifts（不丢）', res);
      assertTrue(by3('A2').note.includes('共 7 处'), '可见性①′：说明文字给出候选总数', res, by3('A2').note);
      assertTrue(by3('A2').note.includes('many.md:L6') && !by3('A2').note.includes('many.md:L7'), '可见性①′：只列 top-5（L6 在列、L7 不在列）', res, by3('A2').note);
      // ② SKIP 条目行号越界可见性（判定不变）
      assertEq(by3('A3').status, 'SKIP', '可见性②：无引文 + 行号越界 ⇒ 判定**仍为 SKIP**（口径未变）', res);
      assertEq(by3('A3').reason, 'no-keyword', '可见性②：原因仍为 no-keyword', res);
      assertEq(by3('A3').targets.map((t) => t.status), ['out-of-range'], '可见性②：目标行状态 = out-of-range（判定层已算出）', res);
      assertTrue(by3('A3').note.includes('已越界'), '可见性②：说明文字提示越界', res, by3('A3').note);
      assertEq(r3.counts.skippedOutOfRange, 2, '可见性②：counts.skippedOutOfRange = 2', res);
      assertEq(r3.counts.skip, 2, '可见性②：SKIP 计数不受影响（仍 2 条）', res);
      assertEq(r3.counts.fail, 2, '可见性②：越界**不计**进 FAIL（fail 只 = 两条 line-drift）', res);
      assertEq(r3.skippedOutOfRangeDetail.map((x) => x.id), ['A3', 'A4'], '可见性②：明细逐条列出（JSON 用）', res);
      assertEq(r3.skippedOutOfRangeDetail[0].outOfRange, [{ file: 'tgt\\short.md', line: 9, fileLines: 3 }], '可见性②：明细带该档实际行数', res);
      assertEq(r3.ifOutOfRangeCountedAsFail, { fail: 4, skip: 0, note: r3.ifOutOfRangeCountedAsFail.note }, '可见性②：假设口径（未采纳）给出若越界计 FAIL 的差异值', res);
      // 人读报告：新增两节
      const vis = render(r3).join('\n');
      assertTrue(vis.includes('同串实况候选 3 处'), '可见性①：报告列出全部候选处数', res);
      assertTrue(vis.includes('引述/订正注形态，需人工确认'), '可见性①：报告标注引述/订正注形态（非错行判定）', res);
      assertTrue(vis.includes('SKIP 行号越界可见性'), '可见性②：报告新增「SKIP 行号越界可见性」节', res);
      assertTrue(vis.includes('该档实际 3 行'), '可见性②：节内回显该档实际行数', res);
      assertTrue(vis.includes('未采纳'), '可见性②：节内写明"越界计 FAIL"未采纳', res);
      // CLI/JSON 面
      const p7 = spawnSync(process.execPath, [SELF, '--list', list3, '--root', vdir, '--json', '--log', path.join(vdir, 'run7.log')], { encoding: 'utf8' });
      let j7 = null;
      try { j7 = JSON.parse(p7.stdout); } catch { /* 下面断言会报 */ }
      assertEq(p7.status, EXIT.FAIL, '可见性：CLI 退出码仍只由 FAIL 条数决定（2 条 ⇒ 3）', res);
      assertTrue(j7 && j7.counts.skippedOutOfRange === 2, '可见性：--json 暴露 counts.skippedOutOfRange', res, JSON.stringify(j7?.counts ?? null));
      assertTrue(j7 && Array.isArray(j7.skippedOutOfRangeDetail) && j7.skippedOutOfRangeDetail.length === 2, '可见性：--json 暴露 skippedOutOfRangeDetail', res);
      assertTrue(j7 && j7.ifOutOfRangeCountedAsFail && j7.ifOutOfRangeCountedAsFail.fail === 4, '可见性：--json 暴露假设口径 ifOutOfRangeCountedAsFail（未采纳）', res, JSON.stringify(j7?.ifOutOfRangeCountedAsFail ?? null));
      assertTrue(j7 && Array.isArray(j7.entries.find((e) => e.id === 'A1')?.drifts) && j7.entries.find((e) => e.id === 'A1').drifts.length === 3, '可见性：--json 每条带 drifts 候选数组（含 annot）', res);
    } finally { rmrf(vdir); }

    // —— 豁免夹具（2026-10-08 加 · §4.5 五类夹具 + §4.4-7 正向门）：**关 / 开 两轮同格比对**
    //     §4.4-7 残留-a 的夹具版等价判据 = 同一夹具格里"关轮 FAIL/line-out-of-range ⇒ 开轮 SKIP/generated-doc-exempt"
    //     夹具版"改前" = 同一次 --self-test 里"关开关"那一轮（两轮都打印落判，不许只报"已豁免 N 条"）
    const xdir = makeTmp('dd-cites-exempt-');
    try {
      writeExemptDocs(xdir);
      const xlist = writeTmp(xdir, 'list.md', fixtureList3());
      const rOff = runCheck({ listPath: xlist, root: xdir, exemptEnabled: false });
      const rOn = runCheck({ listPath: xlist, root: xdir, exemptEnabled: true });
      const rPlain = runCheck({ listPath: list, root: dir }); // 无自动档条目的基线（测 §4.2-7 空态节）
      const byOff = (id) => rOff.rows.find((x) => x.id === id);
      const byOn = (id) => rOn.rows.find((x) => x.id === id);
      const cats = { c1: { p: 0, t: 0 }, c2: { p: 0, t: 0 }, c3: { p: 0, t: 0 }, c4: { p: 0, t: 0 }, c5: { p: 0, t: 0 } };
      const C = (k) => (ok) => { cats[k].t++; if (ok) cats[k].p++; return ok; };
      const real = []; // §4.4-7「真豁免」断言组（**独立计数并打印通过数**：不许只报总数）
      const R = (ok) => { real.push(!!ok); return !!ok; };

      // ② 生成档 · 真豁免正向门（承载者 = A1；§4.4-7：开开关 ⇒ generatedExempt ≥ 1 且对应条目 reason = generated-doc-exempt）
      C('c2')(R(assertEq(byOff('A1').status, 'FAIL', '真豁免①关轮：A1 = FAIL（未豁免时的落判）', res)));
      C('c2')(R(assertEq(byOff('A1').reason, 'line-out-of-range', '真豁免②关轮：A1 reason = line-out-of-range', res)));
      C('c2')(R(assertEq(byOn('A1').status, 'SKIP', '真豁免③开轮：**同一条目 id** ⇒ SKIP', res)));
      C('c2')(R(assertEq(byOn('A1').reason, 'generated-doc-exempt', '真豁免④开轮：A1 reason = generated-doc-exempt', res)));
      const t1 = byOn('A1').targets.find((t) => t.status === 'generated-exempt');
      C('c2')(R(assertTrue(!!t1, '真豁免⑤：A1 越界 target 标 generated-exempt（不再记 out-of-range）', res, JSON.stringify(byOn('A1').targets))));
      C('c2')(R(assertEq(t1?.family, 'daily', '真豁免⑥：target 带 family=daily（报告节逐条列用）', res)));
      C('c2')(R(assertEq(t1?.exemptBy, 'doc-mark', '真豁免⑦：豁免依据 = doc-mark（主路径）', res)));
      C('c2')(R(assertEq(rOff.counts.generatedExempt, 0, '真豁免⑧：关开关轮 counts.generatedExempt = 0', res)));
      C('c2')(R(assertEq(rOn.counts.generatedExempt, 1, '真豁免⑨：开开关轮 counts.generatedExempt = 1（条目级）', res)));
      C('c2')(R(assertEq([rOn.counts.fail - rOff.counts.fail, rOn.counts.skip - rOff.counts.skip], [-1, 1], '真豁免⑩：关→开 差值 = fail −1 / skip +1（整条转 SKIP）', res)));
      C('c2')(R(assertTrue(render(rOn).join('\n').includes('整条已豁免'), '真豁免⑪：报告节列出"整条已豁免"', res, render(rOn).join('\n').slice(-500))));

      // ① 混合条目（人工档 + 自动档都越界）⇒ 整条仍 FAIL、人工档的越界不被吞（M-2 / R1）
      C('c1')(R(assertEq([byOff('A3').status, byOn('A3').status], ['FAIL', 'FAIL'], '①混合条目：关/开两轮整条都 FAIL', res)));
      C('c1')(R(assertEq([byOff('A3').reason, byOn('A3').reason], ['line-out-of-range', 'line-out-of-range'], '①混合条目：reason 恒 = line-out-of-range', res)));
      C('c1')(R(assertTrue(byOn('A3').targets.some((t) => t.file.includes('夹具人工档') && t.status === 'out-of-range'), '①混合条目：人工档越界 target 仍记 out-of-range', res, JSON.stringify(byOn('A3').targets.map((t) => [t.file, t.status])))));
      C('c1')(R(assertTrue(byOn('A3').targets.some((t) => t.status === 'generated-exempt'), '①混合条目：自动档越界 target 标 generated-exempt', res)));
      C('c1')(R(assertEq(byOff('A2').status, 'FAIL', '①人工档单列：越界 ⇒ 仍 FAIL', res)));

      // ③ 自举负样例（档头无标记 · 正文第 20+ 行逐字引用标记）⇒ 仍 FAIL
      C('c3')(R(assertEq([byOff('A4').status, byOn('A4').status], ['FAIL', 'FAIL'], '③自举负样例：关/开两轮都 FAIL', res)));
      C('c3')(R(assertTrue(byOn('A4').targets.every((t) => t.status !== 'generated-exempt'), '③自举负样例：任何 target 都不得标 generated-exempt', res)));

      // ④ 资格维负样例（M-1：watch / external 带标记但 exemptEligible = false）⇒ 仍 FAIL + counts 不增
      C('c4')(R(assertEq([byOff('A5').status, byOn('A5').status, byOff('A6').status, byOn('A6').status], ['FAIL', 'FAIL', 'FAIL', 'FAIL'], '④资格维：watch/external 两族两轮都 FAIL', res)));
      C('c4')(R(assertEq([byOn('A5').reason, byOn('A6').reason], ['line-out-of-range', 'line-out-of-range'], '④资格维：reason 恒 = line-out-of-range', res)));
      C('c4')(R(assertTrue([byOn('A5'), byOn('A6')].every((x) => x.targets.every((t) => t.status !== 'generated-exempt')), '④资格维：无资格族不得产生 generated-exempt target', res)));

      // 反向夹具：豁免面没被放宽（§4.4-4 —— 非越界不受影响 · 其它 reason 照红）
      C('c2')(R(assertEq([byOff('A7').status, byOn('A7').status], ['PASS', 'PASS'], '反向①：行号准的自动档条目 ⇒ 豁免前后都 PASS', res)));
      C('c2')(R(assertEq([byOn('A8').status, byOn('A8').reason], ['FAIL', 'line-drift'], '反向②：自动档 line-drift ⇒ 仍 FAIL（不放宽）', res)));
      C('c2')(R(assertEq([byOn('A9').status, byOn('A9').reason], ['FAIL', 'content-mismatch'], '反向③：自动档 content-mismatch ⇒ 仍 FAIL（不放宽）', res)));

      // §4.2-7 空态 / §4.3 开关关闭口径（报告节必须显式出现，不许隐藏）
      C('c2')(R(assertTrue(render(rPlain).join('\n').includes('0 条：本次无自动生成档条目'), '§4.2-7 空态：无自动档条目时该节仍出现并显示 0 条', res)));
      C('c2')(R(assertTrue(render(rOff).join('\n').includes('开关关闭 · 未生效'), '§4.3 逃生舱：关开关时报告节显示「开关关闭 · 未生效」', res)));

      // ⑤ 家族匹配构造性断言（§4.5-5 / §2.5-5：逐族样本 ⇒ 有资格 true / 无资格 false；可失败）
      C('c5')(R(assertEq([isDocMarkLine('<!-- dsh-generated-doc:auto family=daily -->'), readFamilyId('<!-- dsh-generated-doc:auto family=daily -->')], [true, 'daily'], '⑤权威源接线自证：isDocMarkLine / readFamilyId 可用', res)));
      {
        let okTrue = 0; let okFalse = 0; const bad = [];
        for (const s of GD_FAMILY_SAMPLES()) {
          for (const v of s.variants) {
            const fam = findFamily(v);
            const elig = isExemptEligible(v);
            if (fam && fam.id === s.id && elig === s.exemptEligible) { if (s.exemptEligible) okTrue++; else okFalse++; } else bad.push({ id: s.id, variant: v, got: fam?.id ?? null, elig });
          }
        }
        C('c5')(R(assertEq(bad, [], '⑤家族匹配构造性：全族 × 4 变体命中本族且资格 = 表值', res)));
        C('c5')(R(assertEq([okTrue, okFalse], [52, 8], '⑤家族匹配构造性计数：有资格 52 · 无资格 8', res)));
      }

      // --json 面（豁免字段）+ CLI 端到端（开关开 / 关 两跑）
      const p8 = spawnSync(process.execPath, [SELF, '--list', xlist, '--root', xdir, '--json', '--log', path.join(xdir, 'run8.log')], { encoding: 'utf8' });
      let j8 = null; try { j8 = JSON.parse(p8.stdout); } catch { /* 下面断言报 */ }
      C('c2')(R(assertTrue(j8 && j8.exemptEnabled === true, '--json：exemptEnabled = true', res, String(p8.stdout).slice(0, 160))));
      C('c2')(R(assertTrue(j8 && typeof j8.whitelistSha === 'string' && j8.whitelistSha.length === 64, '--json：顶层 whitelistSha（§4.2-6 S4）', res)));
      C('c2')(R(assertTrue(!!(j8 && j8.generatedDocs && j8.generatedDocs.schemaVersion === GD_SCHEMA_VERSION), '--json：generatedDocs.schemaVersion（§6.2②）', res)));
      C('c2')(R(assertEq(j8?.counts?.generatedExempt, 1, '--json：counts.generatedExempt = 1', res)));
      C('c2')(R(assertEq(j8?.entries?.find((e) => e.id === 'A1')?.exemptReason, 'generated-doc-exempt', '--json：A1 条目 exemptReason', res)));
      C('c2')(R(assertEq(j8?.entries?.find((e) => e.id === 'A5')?.exemptReason, null, '--json：A5（无资格族）exemptReason = null', res)));
      C('c2')(R(assertTrue(Array.isArray(j8?.generatedExemptDetail) && j8.generatedExemptDetail.length === 2, '--json：generatedExemptDetail 逐条列出（A1 整条豁免 + A3 含豁免 target ⇒ 2 条）', res)));
      C('c2')(R(assertEq(j8?.generatedExemptDetail?.filter((x) => x.articleExempted === true).map((x) => x.id), ['A1'], '--json：generatedExemptDetail 标出"整条被豁免"的条目（仅 A1）', res)));
      C('c2')(R(assertEq(p8.status, EXIT.FAIL, 'CLI：开开关轮仍有 FAIL（A2~A6 / A8 / A9）⇒ 退出码 3', res)));
      const p9 = spawnSync(process.execPath, [SELF, '--list', xlist, '--root', xdir, '--json', '--log', path.join(xdir, 'run9.log')], { encoding: 'utf8', env: { ...process.env, DSH_CITES_EXEMPT: 'off' } });
      let j9 = null; try { j9 = JSON.parse(p9.stdout); } catch { /* 下面断言报 */ }
      C('c2')(R(assertTrue(j9 && j9.exemptEnabled === false, '逃生舱 CLI：env=off ⇒ --json exemptEnabled = false', res, String(p9.stdout).slice(0, 160))));
      C('c2')(R(assertEq([j9?.counts?.generatedExempt, j9?.entries?.find((e) => e.id === 'A1')?.status], [0, 'FAIL'], '逃生舱 CLI：env=off ⇒ generatedExempt = 0 且 A1 回 FAIL（跳过豁免判定）', res)));

      const realPass = real.filter(Boolean).length;
      console.log(`[夹具分类 · 5 类] ①混合条目 ${cats.c1.p}/${cats.c1.t} · ②生成档(真豁免正向门) ${cats.c2.p}/${cats.c2.t} · ③自举负样例 ${cats.c3.p}/${cats.c3.t} · ④资格维负样例 ${cats.c4.p}/${cats.c4.t} · ⑤家族匹配构造性 ${cats.c5.p}/${cats.c5.t}`);
      console.log(`真豁免断言：${realPass}/${real.length} 通过`);
      assertTrue(realPass === real.length, `§4.4-7 正向门：真豁免断言 ${realPass}/${real.length} 全部通过`, res);
    } finally { rmrf(xdir); }

    // —— 判定语夹具（2026-10-08 加 · 主人拍板 S5 = A：「判定语」不进引文核对面）：**窄条件 + 反向门**，每条都可失败
    const jdir = makeTmp('dd-cites-judgement-');
    try {
      writeJudgementDocs(jdir);
      const jlist = writeTmp(jdir, 'list.md', fixtureList4());
      const rj = runCheck({ listPath: jlist, root: jdir });
      const byJ = (id) => rj.rows.find((x) => x.id === id);
      const g = (k) => rj.rows.filter((x) => x.group === k);
      // —— 识别函数直测（解析层）
      assertEq(detectJudgementDesc(['文件', '命中处', '性质'], 3, '随便'), { byColumn: true, byMark: false, column: '性质' }, '判定语识别①：表头「性质」全等命中 ⇒ 列级', res);
      assertEq(detectJudgementDesc(['文件', '命中处', '性质说明'], 3, '随便'), null, '判定语识别②：表头「性质说明」**不**命中（全等而非 includes）', res);
      assertEq(detectJudgementDesc(['文件', '命中处', '性质'], 4, '随便'), null, '判定语识别③：表头与数据行列数不等 ⇒ 不判（保守）', res);
      assertEq(detectJudgementDesc(null, 3, '随便'), null, '判定语识别④：无表头 ⇒ 只认行级标记', res);
      assertEq([hasJudgementMark('  [体例·非引文] 说明'), hasJudgementMark('句首之外 [体例·非引文] 说明'), hasJudgementMark('「体例·非引文」')],
        [true, false, false], '判定语识别⑤：行级标记只认**句首**固定串', res);
      // —— 正向门：真降级
      assertEq([byJ('A2').status, byJ('A2').reason], ['SKIP', 'judgement-desc-exempt'], '判定语正向①：句首标记 ⇒ SKIP/judgement-desc-exempt', res);
      assertEq(byJ('A2').formerReason, 'content-mismatch', '判定语正向①′：记下被降的原判 formerReason（不吞原判）', res);
      assertEq(byJ('A2').judgementDesc, { byColumn: false, byMark: true, column: null }, '判定语正向①″：识别依据 = 行级标记', res);
      assertEq([g('B')[0].status, g('B')[0].reason, g('B')[0].judgementDesc?.column], ['SKIP', 'judgement-desc-exempt', '性质'], '判定语正向②：B 表「性质」列级 ⇒ 降级', res);
      assertEq([g('B')[4].status, g('B')[4].formerReason], ['SKIP', 'line-drift'], '判定语正向③：line-drift 同样降级（引文面两种 FAIL 都降）', res);
      assertEq([g('C')[0].status, g('C')[0].reason, g('C')[0].judgementDesc],
        ['SKIP', 'judgement-desc-exempt', { byColumn: true, byMark: false, column: '为什么是假命中' }], '判定语正向④：C 表「为什么是假命中」列级独立成立（**无**行级标记也降）', res);
      // —— 不误伤门 + 反向门（**不放宽**）
      assertEq([g('B')[1].status, g('B')[1].reason], ['PASS', 'ok'], '判定语反向①：判定语列**恰好命中** ⇒ 仍 PASS（只降级、不作废）', res);
      assertEq([byJ('A1').status, byJ('A1').reason], ['FAIL', 'content-mismatch'], '判定语反向②：**非**判定语条 ⇒ 照红（没整体放宽）', res);
      assertEq([byJ('A3').status, byJ('A3').reason], ['FAIL', 'content-mismatch'], '判定语反向③：标记**不在句首** ⇒ 照红（标记判据已收窄）', res);
      assertEq([g('B')[2].status, g('B')[2].reason], ['FAIL', 'line-out-of-range'], '判定语反向④：判定语条**行号越界** ⇒ 照红（不放宽其它判定）', res);
      assertEq([g('B')[3].status, g('B')[3].reason], ['FAIL', 'file-missing'], '判定语反向⑤：判定语条**文件缺失** ⇒ 照红（不放宽其它判定）', res);
      assertEq([g('D')[0].status, g('D')[0].reason], ['FAIL', 'content-mismatch'], '判定语反向⑥：表头非白名单（性质说明）⇒ 照红（全等语义）', res);
      // —— 计数 + 报告 / JSON 面
      assertEq([rj.counts.fail, rj.counts.skip, rj.counts.pass], [5, 4, 1], '判定语计数：FAIL 5（反向门）· SKIP 4（正向门）· PASS 1（不误伤门）', res);
      assertEq(rj.judgementDescDetail.length, 4, '判定语明细：4 条降级逐条进 judgementDescDetail', res);
      const jtxt = render(rj).join('\n');
      assertTrue(jtxt.includes('判定语 · 不进引文核对面'), '判定语报告：新增专节', res);
      assertTrue(jtxt.includes('列级：描述列表头「性质」'), '判定语报告：列级识别依据可见', res);
      assertTrue(jtxt.includes('行级：描述列句首'), '判定语报告：行级识别依据可见', res);
      const p10 = spawnSync(process.execPath, [SELF, '--list', jlist, '--root', jdir, '--json', '--log', path.join(jdir, 'run10.log')], { encoding: 'utf8' });
      let j10 = null; try { j10 = JSON.parse(p10.stdout); } catch { /* 下面断言报 */ }
      assertEq(p10.status, EXIT.FAIL, '判定语 CLI：仍有反向门 FAIL ⇒ 退出码 3', res);
      assertEq(j10?.judgementDescDetail?.length, 4, '判定语 --json：judgementDescDetail 逐条列出', res);
      assertEq(j10?.entries?.find((e) => e.id === 'A2')?.formerReason, 'content-mismatch', '判定语 --json：条目带 formerReason', res);
      assertEq(j10?.entries?.find((e) => e.id === 'A1')?.formerReason, null, '判定语 --json：未降级条目的 formerReason = null（其余条目字段语义不变）', res);
    } finally { rmrf(jdir); }
  } finally {
    rmrf(dir);
  }
  finishSelfTest('check-cites-exist', res);
}

if (isMain(import.meta.url)) {
  main();
}
