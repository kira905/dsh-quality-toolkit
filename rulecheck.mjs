#!/usr/bin/env node
// ============================================================================
//  rulecheck.mjs —— 「工程规则机制化」只读校验器（R-017 机制层 · 第一批）
//  --------------------------------------------------------------------------
//  它是干什么的：把**已经立好的规矩**（三份口径档）里那些**确定性的**判据，变成
//    **每天/随时能跑一遍的机器检查**。它**不判语义**（「这条需求真的落地了吗」永远归人）、
//    **不改任何文件**、**不拦任何动作**、**不发任何通知**。
//
//  方案真源：`docs\方案-V3.0.0工程规则机制化-R017R032-20261015.md`（§3.1 / §3.2 / §3.3 / §5）
//  规矩真源（**本工具不改规矩，只做它的机器判据**）：
//    · `docs\口径-需求粒度与验收粒度对齐-20261014.md`
//    · `docs\口径-验收两轨制与DoD十条-20261014.md`
//    · `docs\口径-工程链条规则总纲-20261014.md`
//
//  档位：**observe**（缺省）—— 只出结论、**rc 恒 0**（除用法错 / 判定不可用 / 显式 --fail-on-bad）。
//    ⚠️ 为什么「有不合规」默认不非 0：将来挂 tickd 巡检 job 时，非 0 会被记成 job 失败 +
//       日报刷红 = 告警疲劳（同族先例 `rule-drift-check.mjs` / `overnight-guard-check.mjs`）。
//    ⚠️ **升到 report / notify / 拦 三档一律要主人一句话**（方案 §2.2）—— 本工具**不含任何开关**。
//
//  用法：
//    node rulecheck.mjs baseline [--file <档>]... [--scan-all] [--json] [--section] [--fail-on-bad]
//    node rulecheck.mjs debt     [--file <档>]... [--baseline <旧副本>] [--json] [--section] [--fail-on-bad]
//    node rulecheck.mjs all      [同上]
//    node rulecheck.mjs dod      [--file <报告>]... [--card <id|标题>]...
//    node rulecheck.mjs dor      [--card <id|标题>]... [--file <档>]... [--since <YYYY-MM-DD>] [--all]
//    node rulecheck.mjs defect   [--file <报告>]... [--card <id|标题>]...      # 第三批 S1–S3
//    node rulecheck.mjs postmortem [--file <复盘档>]... [--p0 <触发源档>]...   # 第三批 P1–P3
//    node rulecheck.mjs practice [--file <方案档>]... [--since <YYYY-MM-DD>] [--all]  # 第三批 I1–I2
//    node rulecheck.mjs --self-test          # 内存夹具单测（不碰真机）
//    node rulecheck.mjs --help
//
//  退出码：0 = 跑通（**含"发现不合规"这个正常结论**）· 2 = 用法 · 3 = 判定不可用（结构不认识）
//          · 4 = 有 🔴 **且显式** `--fail-on-bad`
//  【只读承诺】不写任何文件、不改被检档、不 import 任何写入型 API、不联网、不调 LLM。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDshWorkspace, resolveDshHome } from './lib/dsh-home.mjs';
import {
  checkBaseline, checkDebt, checkTechLeak, signoffDraft, debtStatusLine, summarizeLevels,
  findTables, pickColumn, RULECHECK_RULES_VERSION,
  checkDod, checkDor, checklistLine, DOD_ITEMS, DOR_ITEMS,
  checkDefect, checkPostmortem, checkPostmortemCoverage, checkPractice,
  P0_QUESTIONS, POSTMORTEM_SECTIONS, DEFECT_LEVELS,
} from './lib/rulecheck-rules.mjs';

export const RULECHECK_VERSION = '0.3.0';
/**
 * 勾选块格式的**生效日**（= 两份口径档追加 §10 / §9 的那天）。
 * 用途 = 发现面：DoR 默认只检生效日之后建的卡，之前的卡**不追溯**（否则 257 张存量卡一次全红
 * = 告警疲劳）；工具会把"存量 N 张未追溯"如实打印出来，**不静默跳过**。
 */
export const BLOCK_FORMAT_SINCE = '2026-10-15';
/**
 * 第三批（缺陷段 / 复盘档 / 惯例对照小节）的**载体形态生效日** —— 与块格式同日（口径档
 * `口径-工程链条规则总纲-20261014.md` §10 追加的那天）。
 * 用途同 `BLOCK_FORMAT_SINCE`：**发现面**只检生效日之后**新增 / 改动**的档，之前的**不追溯**
 * （否则第三批一上，存量 26 份方案档 + 全库报告一次全黄 = 告警疲劳）。
 */
export const BATCH3_SINCE = '2026-10-15';
export const EXIT = { OK: 0, USAGE: 2, UNAVAILABLE: 3, BAD: 4 };

let jsonMode = false;
const log = (m) => {
  // `--json` 时人类提示一律走 stderr（三条通用纪律 ②）
  if (jsonMode) process.stderr.write(m + '\n');
  else process.stdout.write(m + '\n');
};
const warn = (m) => process.stderr.write(m + '\n');

function parseArgs(argv) {
  const a = { cmd: null, files: [], cards: [], p0s: [], baseline: null, exempt: null, since: null, allCards: false, scanAll: false, changed: false, json: false, section: false, failOnBad: false, selfTest: false, help: false };
  const args = [...argv];
  if (args.length && !args[0].startsWith('-')) a.cmd = args.shift();
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--file' || t === '-f') { const v = args[++i]; if (!v) return { err: '--file 需要路径' }; a.files.push(path.resolve(v)); }
    else if (t === '--card') { const v = args[++i]; if (!v) return { err: '--card 需要卡 id 前缀或标题子串' }; a.cards.push(v); }
    else if (t === '--p0') { const v = args[++i]; if (!v) return { err: '--p0 需要路径（P0 的触发源档：交付报告 / 卡）' }; a.p0s.push(path.resolve(v)); }
    else if (t === '--since') { const v = args[++i]; if (!v) return { err: '--since 需要日期（YYYY-MM-DD）' }; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { err: `--since 日期形态不对：${v}（要 YYYY-MM-DD）` }; a.since = v; }
    else if (t === '--all') a.allCards = true;
    else if (t === '--changed') a.changed = true;
    else if (t === '--baseline') { const v = args[++i]; if (!v) return { err: '--baseline 需要路径' }; a.baseline = path.resolve(v); }
    else if (t === '--exempt') { const v = args[++i]; if (!v) return { err: '--exempt 需要路径' }; a.exempt = path.resolve(v); }
    else if (t === '--scan-all') a.scanAll = true;
    else if (t === '--json') a.json = true;
    else if (t === '--section') a.section = true;
    else if (t === '--fail-on-bad') a.failOnBad = true;
    else if (t === '--self-test') a.selfTest = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else return { err: `未知参数：${t}` };
  }
  return a;
}

const USAGE = `rulecheck —— 工程规则只读校验器（R-017 / R-032 机制层 · observe 档）

用法：
  node rulecheck.mjs baseline [--file <档>]... [--scan-all] [--json] [--section] [--fail-on-bad]
  node rulecheck.mjs debt     [--file <档>]... [--baseline <旧副本>] [--json] [--section] [--fail-on-bad]
  node rulecheck.mjs all      [同上（= baseline + debt，**第一批契约不变**）]
  node rulecheck.mjs dod      [--file <报告>]... [--card <id|标题>]... [--json] [--section] [--fail-on-bad]
  node rulecheck.mjs dor      [--card <id|标题>]... [--file <档>]... [--since <YYYY-MM-DD>] [--all] [--json] [--section] [--fail-on-bad]
  node rulecheck.mjs defect   [--file <报告>]... [--card <id|标题>]... [--json] [--section] [--fail-on-bad]
  node rulecheck.mjs postmortem [--file <复盘档>]... [--p0 <触发源档>]... [--card <id|标题>]... [--json] [--section] [--fail-on-bad]
  node rulecheck.mjs practice [--file <方案档>]... [--since <YYYY-MM-DD>] [--all] [--json] [--section] [--fail-on-bad]
  node rulecheck.mjs --self-test     内存夹具单测（不碰真机）

判据族（载体形态真源 = docs\\口径-工程链条规则总纲-20261014.md 的 §9 / §10）：
  baseline B1–B8（需求基线）· debt D1–D8（技术债账本）· dod T1–T4 · dor R1–R3
  defect S1–S3（缺陷分级 P0–P3 + 判 P0 三句 + 指复盘）· postmortem P1–P3（复盘五段 · 缺落点即未复盘）
  practice I1–I2（方案档里的惯例对照小节 · **存量不追溯**）

缺省自动发现（不给 --file 时）：
  · 需求基线：<workspace>\\docs\\需求清单-*.md
  · 技术债台账：<workspace>\\docs\\技术债台账-*.md
  · DoR：**看板账本**（只读 projection）里 createdAt ≥ ${BLOCK_FORMAT_SINCE}（块格式生效日）的卡 —— 存量**不追溯**，跑一次会如实打印存量张数
  · DoD / defect：**不自动扫全库**（报告太多）—— 必须给 --file 或 --card，否则空态明说并 rc 0
  · postmortem：<workspace>\\docs\\复盘-*.md（没有就空态明说）
  · practice：<workspace>\\docs\\方案-*.md 里**生效日之后新增**的档（--changed 时连"今天改过"的一并判）—— 存量**不追溯**，跑一次会如实打印存量份数
可选：
  --card <id|标题>      卡 id 前缀 或 标题子串（可多次；命中即检，不受 --since 限制）
  --p0 <档>             postmortem 专用：P0 的**触发源档**（交付报告；可多次）—— 用来判 P1（有 P0 却没对上复盘档）
  --since <YYYY-MM-DD>  DoR / practice 发现面起点（缺省 = 生效日 ${BLOCK_FORMAT_SINCE}）
  --all                 DoR / practice 连存量一起检（会把生效日之前的档也判，慎用）
  --changed             practice 专用：把"生效日之后**改过**的旧方案档"也纳入判定（缺省不判 —— 防"加一行订正注就报黄"）
  --baseline <旧副本>   台账专用：比对「未结只减不增」（**按 basename 匹配同名档**；不匹配则跳过并明说）
  --exempt <清单.json>  豁免清单（**人来维护、本工具只读**；条目 { file, id, reason, at }；file 支持 * 与 basename）
退出码：0 跑通（含发现不合规）· 2 用法 · 3 判定不可用（档读不到 / 账本读不到）· 4 有 🔴 且显式 --fail-on-bad（--self-test 失败亦 4）
档位：observe（只报告 · 零副作用 · 无开关 · 不碰卡状态）`;

// ---------------------------------------------------------------------------
//  文件发现（纯只读）
// ---------------------------------------------------------------------------
function discover(dir, prefix) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.toLowerCase().endsWith('.md'))
      .map((n) => path.join(dir, n))
      .sort();
  } catch { return []; }
}

function readText(file) {
  const buf = fs.readFileSync(file);
  return { text: buf.toString('utf8'), sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

/**
 * 豁免清单（**人来维护、校验器只读** —— 不给校验器任何自写状态的机会）。
 * 形态（照同族 `butler-rule-drift-exempt.json` 的思路，但**不自动读 home**，必须显式 `--exempt`）：
 *   `{ "exempt": [ { "file": "需求清单-*.md 的 basename 或 *", "id": "B5", "reason": "…", "at": "2026-10-15" } ] }`
 * 为什么需要它（2026-10-15 审核 I-3）：合规但"天然红"的项（如按"只加订正注不改原文"制度保留的旧汇总数）
 *   需要一条**合法消除路径**，否则要么长期报红（告警疲劳）、要么本鱼偷偷改口径 —— 两条都坏。
 */
function loadExempt(file) {
  if (!file) return [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(j) ? j : (Array.isArray(j.exempt) ? j.exempt : []);
    const ok = list.filter((x) => x && typeof x === 'object' && x.id);
    if (list.length && !ok.length) warn('⚠️ 豁免清单里没有可用条目（每条至少要 { file, id }）');
    return ok;
  } catch (e) {
    warn(`⚠️ 豁免清单读不到 / 不合法：${e.message}（按"无豁免"继续，不拦）`);
    return [];
  }
}

function applyExempt(rec, exempt) {
  if (!exempt.length || !Array.isArray(rec.issues) || !rec.issues.length) return rec;
  const base = path.basename(rec.file);
  const kept = []; const used = [];
  for (const i of rec.issues) {
    const hit = exempt.find((x) => x.id === i.id && (x.file === '*' || x.file === base || x.file === rec.file));
    if (hit) used.push({ ...i, exemptReason: hit.reason || '(未写理由)' });
    else kept.push(i);
  }
  rec.issues = kept;
  if (used.length) rec.exempted = used;
  return rec;
}

// ---------------------------------------------------------------------------
//  跑一族判据
// ---------------------------------------------------------------------------
function runBaseline(files, opts) {
  const out = [];
  for (const file of files) {
    let rec;
    try {
      const { text, sha256, bytes } = readText(file);
      const r = checkBaseline(text, opts);
      rec = { file, sha256, bytes, kind: 'baseline', ...r };
      if (opts.scanAll) rec.scanAllHits = checkTechLeak(text);
    } catch (e) {
      rec = { file, kind: 'baseline', unavailable: true, reason: `读不到：${e.message}`, issues: [], counts: { total: 0, byStatus: {} }, entries: [] };
    }
    out.push(rec);
  }
  return out;
}

function runDebt(files, opts) {
  // 基线（显式传入的上一版副本；**校验器不自己落基线**）—— 用同一个 checkDebt 解析基线档，
  //   取「行 id 集合 + 未结条数」（口径修正见 lib 的 D6 注释：行数不是真判据，未结数才是）
  let baseline = null; let baselineLabel = null;
  if (opts.baseline) {
    try {
      const { text } = readText(opts.baseline);
      const b = checkDebt(text);
      if (b.unavailable) { warn(`⚠️ 基线档没解析出台账表：${opts.baseline}`); }
      else {
        baseline = { rows: b.counts.total, open: b.counts.byStatus['未结'] ?? 0, ids: b.entries.map((e) => e.id) };
        baselineLabel = `${opts.baseline}（${b.counts.total} 条 / 未结 ${baseline.open}）`;
      }
    } catch (e) { warn(`⚠️ 基线档读不到：${e.message}`); }
  }
  const out = [];
  for (const file of files) {
    let rec;
    // S-3（审核轮三）：`--baseline` 是**单值**，多份台账时**按 basename 匹配**该档；不匹配 ⇒ 明说跳过
    const useBase = baseline && path.basename(file) === path.basename(opts.baseline) ? baseline : null;
    if (baseline && !useBase) warn(`⚠️ 基线档「${path.basename(opts.baseline)}」与目标档「${path.basename(file)}」不同名 ⇒ 该档跳过 D6（不许张冠李戴）`);
    try {
      const { text, sha256, bytes } = readText(file);
      const r = checkDebt(text, { baseline: useBase, baselineLabel: useBase ? baselineLabel : null });
      rec = { file, sha256, bytes, kind: 'debt', ...r };
    } catch (e) {
      rec = { file, kind: 'debt', unavailable: true, reason: `读不到：${e.message}`, issues: [], counts: { total: 0, byStatus: {} }, entries: [] };
    }
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  看板账本（**只读投影** —— 绝不写账本、绝不碰卡状态；R-032-① 的只读数据源）
// ---------------------------------------------------------------------------
function loadLedger() {
  const file = path.join(resolveDshHome(), 'task-board', 'ledger-v2.json');
  try {
    const buf = fs.readFileSync(file);
    const j = JSON.parse(buf.toString('utf8'));
    const tasks = Array.isArray(j.tasks) ? j.tasks : [];
    return { file, tasks, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, revision: j.revision ?? null };
  } catch (e) {
    return { file, tasks: null, error: e.message };
  }
}

/** 卡的人话称谓（报账口径：只给 GUI 能对应的名字，id 只作末尾脚注）。 */
const cardLabel = (c) => `卡：${c.seq ? `${c.seq} · ` : ''}${String(c.title || '(无标题)').slice(0, 70)}`;

/** 卡的内容指纹（等价于文档的 sha256 —— 卡没有文件，用 description 的 hash 当"跑前跑后"判据）。 */
const textSha = (t) => crypto.createHash('sha256').update(String(t ?? ''), 'utf8').digest('hex');

/**
 * 选卡（发现面）：显式 `--card` > 生效日之后 > `--all` 全量。
 * 为什么要有发现面：存量 257 张卡里 **0 张**有勾选块（2026-10-15 实测）⇒ 不加发现面，
 *   块格式一上线就是"全库报红"= 告警疲劳（与方案 §3.8 I1「存量不追溯」同口径）。
 */
function pickCards(ledger, a) {
  const all = ledger.tasks || [];
  if (a.cards.length) {
    return {
      picked: all.filter((c) => a.cards.some((q) => String(c.id).startsWith(q) || String(c.title || '').includes(q))),
      skipped: 0, since: null, total: all.length, explicit: true,
    };
  }
  if (a.allCards) return { picked: all, skipped: 0, since: null, total: all.length, all: true };
  const since = a.since || BLOCK_FORMAT_SINCE;
  const sinceMs = Date.parse(`${since}T00:00:00+08:00`);
  const after = all.filter((c) => typeof c.createdAt === 'number' && c.createdAt >= sinceMs);
  return { picked: after, skipped: all.length - after.length, since, total: all.length };
}

function runDod(a) {
  const recs = [];
  for (const file of a.files) {
    try {
      const { text, sha256, bytes } = readText(file);
      recs.push({ file, sha256, bytes, kind: 'dod', ...checkDod(text) });
    } catch (e) {
      recs.push({ file, kind: 'dod', unavailable: true, reason: `读不到：${e.message}`, issues: [], items: [], counts: { total: 0, checked: 0, unchecked: 0 }, meta: { blockFound: false } });
    }
  }
  if (a.cards.length) {
    const led = loadLedger();
    if (!led.tasks) {
      recs.push({ file: `看板账本（${led.file}）`, kind: 'dod', unavailable: true, reason: `账本读不到：${led.error}`, issues: [], items: [], counts: {}, meta: {} });
    } else {
      for (const c of pickCards(led, a).picked) {
        const text = String(c.description || '');
        recs.push({ file: `${cardLabel(c)} · DoD 块`, cardId: c.id, sha256: textSha(text), bytes: Buffer.byteLength(text), kind: 'dod', ...checkDod(text) });
      }
    }
  }
  return recs;
}

function runDor(a) {
  const recs = [];
  for (const file of a.files) {
    try {
      const { text, sha256, bytes } = readText(file);
      recs.push({ file, sha256, bytes, kind: 'dor', ...checkDor(text) });
    } catch (e) {
      recs.push({ file, kind: 'dor', unavailable: true, reason: `读不到：${e.message}`, issues: [], items: [], counts: { total: 0, checked: 0, unchecked: 0 }, meta: { blockFound: false } });
    }
  }
  if (!a.files.length || a.cards.length) {
    const led = loadLedger();
    if (!led.tasks) {
      recs.push({
        file: `看板账本（${led.file}）`, kind: 'dor', unavailable: true,
        reason: `账本读不到：${led.error}`, issues: [], items: [], counts: {}, meta: {},
      });
    } else {
      const sel = pickCards(led, a);
      const disc = {
        ledger: led.file, ledgerSha256: led.sha256, ledgerBytes: led.bytes, revision: led.revision,
        total: sel.total, checked: sel.picked.length, skipped: sel.skipped, since: sel.since, explicit: !!sel.explicit, all: !!sel.all,
      };
      for (const c of sel.picked) {
        const text = String(c.description || '');
        recs.push({
          file: `${cardLabel(c)} · DoR 块`, cardId: c.id, cardStatus: c.status, cardLine: c.line || '',
          createdAt: typeof c.createdAt === 'number' ? new Date(c.createdAt).toISOString() : null,
          sha256: textSha(text), bytes: Buffer.byteLength(text), kind: 'dor', discovery: disc, ...checkDor(text),
        });
      }
      if (!sel.picked.length) {
        recs.push({
          file: `看板账本（${led.file}）`, kind: 'dor', unavailable: false, issues: [], items: [], counts: {},
          meta: { blockFound: false }, discovery: disc, emptyDiscovery: true,
        });
      }
    }
  }
  return recs;
}

// ---------------------------------------------------------------------------
//  第三批：缺陷段（S1–S3）/ 复盘档（P1–P3）/ 惯例对照（I1–I2）
//  载体形态真源 = `docs\口径-工程链条规则总纲-20261014.md` §10；规矩层 = 同档 §3 / §4 / §5
//  ⚠️ 一律 **observe**：不拦档、不发通知、不挂 job、不写任何文件、不碰卡状态（方案 §6.3 划界）
// ---------------------------------------------------------------------------
const defectSummary = (r) => {
  if (!r.meta || !r.meta.sectionFound) return '没有缺陷段（= 无缺陷要报）';
  const by = Object.entries(r.counts.byLevel || {}).map(([k, v]) => `${k} ${v}`).join(' / ');
  return `缺陷行 ${r.counts.total}（${by || '—'}）· 依据：${r.meta.by === 'anchor' ? 'Defect 锚点' : `小节标题「${r.meta.title}」`}`;
};
const pmSummary = (r) => `五段 ${r.counts.sections}/5 · 缺 ${r.counts.missing} 段 · 第 5 段落点：${r.counts.landing}`;
const practiceSummary = (r) => (r.meta && r.meta.sectionFound
  ? `惯例对照小节在位（L${r.meta.line}「${r.meta.title}」）· 判定 ${r.counts.verdicts} 处 · 理由 / 代价${r.counts.hasReason ? '有' : '缺'}`
  : '没有惯例对照小节');

function runDefect(a) {
  const recs = [];
  for (const file of a.files) {
    try {
      const { text, sha256, bytes } = readText(file);
      const r = checkDefect(text);
      recs.push({ file, sha256, bytes, kind: 'defect', ...r, summary: defectSummary(r) });
    } catch (e) {
      recs.push({ file, kind: 'defect', unavailable: true, reason: `读不到：${e.message}`, issues: [], entries: [], counts: { total: 0, byLevel: {} }, meta: { sectionFound: false } });
    }
  }
  if (a.cards.length) {
    const led = loadLedger();
    if (!led.tasks) {
      recs.push({ file: `看板账本（${led.file}）`, kind: 'defect', unavailable: true, reason: `账本读不到：${led.error}`, issues: [], entries: [], counts: {}, meta: {} });
    } else {
      for (const c of pickCards(led, a).picked) {
        const text = String(c.description || '');
        const r = checkDefect(text);
        recs.push({ file: `${cardLabel(c)} · 缺陷段`, cardId: c.id, sha256: textSha(text), bytes: Buffer.byteLength(text), kind: 'defect', ...r, summary: defectSummary(r) });
      }
    }
  }
  return recs;
}

/** 从触发源（`--p0` 档 / `--card` 卡）里抽出 P0 条目（**只读**）—— P1 覆盖度的输入。 */
function collectP0s(a) {
  const out = [];
  for (const file of a.p0s) {
    try {
      const { text } = readText(file);
      const r = checkDefect(text);
      const base = path.basename(file).replace(/\.md$/i, '');
      for (const e of r.entries.filter((x) => x.level === 'P0')) {
        out.push({ label: `${base} · ${e.text.slice(0, 40)}`, source: base, id: path.basename(file) });
      }
    } catch { warn(`⚠️ 触发源档读不到：${file}`); }
  }
  if (a.cards.length) {
    const led = loadLedger();
    if (led.tasks) {
      for (const c of pickCards(led, a).picked) {
        const r = checkDefect(String(c.description || ''));
        for (const e of r.entries.filter((x) => x.level === 'P0')) {
          out.push({ label: `${cardLabel(c)} · ${e.text.slice(0, 40)}`, cardId: c.id, source: String(c.title || '').slice(0, 40) });
        }
      }
    }
  }
  return out;
}

function runPostmortem(a) {
  const recs = [];
  const pmDocs = [];
  const files = a.files.length ? a.files : discover(path.join(resolveDshWorkspace(), 'docs'), '复盘-');
  for (const file of files) {
    try {
      const { text, sha256, bytes } = readText(file);
      const r = checkPostmortem(text);
      pmDocs.push({ file, text });
      recs.push({ file, sha256, bytes, kind: 'postmortem', ...r, summary: pmSummary(r) });
    } catch (e) {
      recs.push({ file, kind: 'postmortem', unavailable: true, reason: `读不到：${e.message}`, issues: [], sections: [], counts: {}, meta: {} });
    }
  }
  const p0s = collectP0s(a);
  if (p0s.length || a.p0s.length) {
    const cov = checkPostmortemCoverage(p0s, pmDocs);
    recs.push({
      file: `触发源 → 复盘档（${a.p0s.length} 份触发源档 + ${a.cards.length} 张卡 / ${pmDocs.length} 份复盘档）`,
      kind: 'postmortem', issues: cov.issues, sections: [], counts: { p0: cov.p0, covered: cov.covered, missing: cov.missing.length },
      meta: { coverage: true },
      summary: `触发源里 P0 ${cov.p0} 条 · 对上一份复盘 ${cov.covered} 条 · 没对上 ${cov.missing.length} 条`,
    });
  }
  return recs;
}

function runPractice(a) {
  const recs = [];
  const docs = path.join(resolveDshWorkspace(), 'docs');
  let files = a.files;
  let disc = null;
  if (!files.length) {
    const since = a.since || BATCH3_SINCE;
    const sinceMs = Date.parse(`${since}T00:00:00+08:00`);
    const found = discover(docs, '方案-');
    // 发现面（**低误报优先**）：新增档（birthtime ≥ 生效日）一律判；改动档（只加了订正注的旧方案）
    //   默认**不判** —— 否则"给旧方案补一行订正注"就会把它拉进来报黄 = 告警疲劳；
    //   要一并判给 `--changed`（显式加严）。两个数都如实打印，不静默跳过。
    const info = found.map((f) => {
      try { const st = fs.statSync(f); return { f, mtime: st.mtimeMs, birthtime: st.birthtimeMs }; }
      catch { return { f, mtime: 0, birthtime: 0 }; }
    });
    const fresh = info.filter((x) => x.birthtime >= sinceMs);
    const changed = info.filter((x) => x.birthtime < sinceMs && x.mtime >= sinceMs);
    const picked = a.allCards ? info : [...fresh, ...(a.changed ? changed : [])];
    files = picked.map((x) => x.f);
    disc = {
      dir: docs, total: found.length, checked: files.length, skipped: found.length - files.length,
      since, all: !!a.allCards, fresh: fresh.length, changed: changed.length, changedIncluded: !!a.changed,
    };
  }
  for (const file of files) {
    try {
      const { text, sha256, bytes } = readText(file);
      const r = checkPractice(text);
      recs.push({ file, sha256, bytes, kind: 'practice', ...r, ...(disc ? { discovery: disc } : {}), summary: practiceSummary(r) });
    } catch (e) {
      recs.push({ file, kind: 'practice', unavailable: true, reason: `读不到：${e.message}`, issues: [], counts: {}, meta: {} });
    }
  }
  return recs;
}

// ---------------------------------------------------------------------------
//  渲染
// ---------------------------------------------------------------------------
function renderHuman(recs, mode) {
  const L = [];
  const firstDisc = recs.findIndex((x) => x.discovery);
  for (let idx = 0; idx < recs.length; idx++) {
    const r = recs[idx];
    L.push('');
    L.push(`【${r.cardId ? '卡' : '档'}】${r.file}`);
    if (!r.emptyDiscovery) L.push(`  sha256 ${String(r.sha256 || '-').slice(0, 16)}… · ${r.bytes ?? '?'} B`);
    if (r.unavailable) { L.push(`  ⛔ 判定不可用：${r.reason}`); continue; }
    if (r.kind === 'baseline') {
      const c = r.counts;
      L.push(`  条目 ${c.total} · 已落地 ${c.byStatus['已落地']} / 部分 ${c.byStatus['部分']} / 未落地 ${c.byStatus['未落地']}`);
    } else if (r.kind === 'debt') {
      L.push(`  条目 ${r.counts.total} · 未结 ${r.counts.byStatus['未结'] ?? 0} / 已结 ${r.counts.byStatus['已结'] ?? 0} / 状态未知 ${r.counts.byStatus['未知'] ?? 0}`);
      L.push(`  ${debtStatusLine(r)}`);
      if (r.growth) L.push(`  只减不增（双判据）：行 ${r.growth.baselineRows} → ${r.growth.currentRows} · 未结 ${r.growth.baselineOpen} → ${r.growth.currentOpen}${r.growth.added.length ? ` · 新增 ${r.growth.added.join(',')}` : ''}${r.growth.removed.length ? ` · 消失 ${r.growth.removed.join(',')}` : ''}`);
    } else if (r.kind === 'dod' || r.kind === 'dor') {
      const items = r.kind === 'dod' ? DOD_ITEMS : DOR_ITEMS;
      if (!r.emptyDiscovery) L.push(`  ${checklistLine(r, items)}${r.cardStatus ? ` · 卡状态 ${r.cardStatus}` : ''}`);
      if (r.discovery && idx === firstDisc) {
        const d = r.discovery;
        const scope = d.explicit ? '按 --card 点名（不受生效日限制）'
          : d.all ? '--all（含存量卡）'
            : `createdAt ≥ ${d.since} 的 ${d.checked} 张（**存量 ${d.skipped} 张不追溯** —— 块格式 ${BLOCK_FORMAT_SINCE} 才立）`;
        L.push(`  ℹ️ 发现面：账本共 ${d.total} 张卡 · ${scope}`);
        L.push(`  ℹ️ 账本 ${path.basename(d.ledger)} · revision ${d.revision} · sha256 ${String(d.ledgerSha256 || '').slice(0, 16)}…（只读投影 · 不写账本 · 不碰卡状态）`);
      }
      if (r.emptyDiscovery) L.push('  ℹ️ 发现面内没有卡（空态不静默）—— 生效日之后还没建卡，或改用 --card 点名');
      if (r.meta && Array.isArray(r.meta.unsaid) && r.meta.unsaid.length) L.push(`  ℹ️ 未勾且卡面没写原因的第 ${r.meta.unsaid.join(' / ')} 条`);
    } else {
      // 第三批：缺陷段 / 复盘档 / 惯例对照（summary 由 runner 生成）
      if (r.summary) L.push(`  ${r.summary}`);
      if (r.discovery && idx === firstDisc) {
        const d = r.discovery;
        const scope = d.all ? `--all（含存量档，共 ${d.checked} 份）`
          : `新增 ${d.fresh} 份${d.changedIncluded ? ` + 改动 ${d.changed} 份（--changed）` : ''}（**存量 ${d.skipped} 份不追溯** —— 载体形态 ${BATCH3_SINCE} 才立）`;
        L.push(`  ℹ️ 发现面：${path.basename(d.dir)} 下「方案-*.md」共 ${d.total} 份 · ${scope}`);
        if (!d.all && !d.changedIncluded && d.changed) {
          L.push(`  ℹ️ 另有 ${d.changed} 份今天被改过（多为加订正注）**默认不判** —— 要一并判加 --changed`);
        }
      }
      if (r.meta && r.meta.coverage && !r.counts.p0) L.push('  ℹ️ 触发源里没有 P0（= 没有"必须出复盘"的触发源）');
      if (r.meta && r.meta.sectionFound) L.push(`  ℹ️ 判据依据：${r.kind === 'defect' ? (r.meta.by === 'anchor' ? 'Defect 锚点' : `小节标题「${r.meta.title}」`) : '载体形态真源 = 总纲 §10'}`);
    }
    for (const i of r.issues) L.push(`  ${i.level} ${i.id} ${i.msg}${i.evidence ? `  ← ${i.evidence}` : ''}`);
    if (r.scanAllHits && r.scanAllHits.length) {
      L.push(`  ℹ️ 全档扫描（--scan-all）命中 ${r.scanAllHits.length} 处：`);
      for (const h of r.scanAllHits.slice(0, 10)) L.push(`     L${h.line} [${h.label}] ${h.match}`);
    }
    const s = summarizeLevels(r.issues);
    L.push(`  小结：🔴 ${s['🔴']} · 🟡 ${s['🟡']} · ℹ️ ${s['ℹ️']}${r.exempted && r.exempted.length ? ` · 已豁免 ${r.exempted.length} 条（${r.exempted.map((x) => x.id).join(',')}）` : ''}`);
  }
  L.push('');
  L.push(`══ 合计：${recs.length} 份档 · 🔴 ${recs.reduce((n, r) => n + (r.issues || []).filter((i) => i.level === '🔴').length, 0)} · 🟡 ${recs.reduce((n, r) => n + (r.issues || []).filter((i) => i.level === '🟡').length, 0)}（模式：${mode} · 档位 observe · 零副作用）`);
  return L.join('\n');
}

function renderSection(recs, mode) {
  const L = [];
  L.push(`### rulecheck · ${mode}（observe 档 · 只报告不拦）`);
  L.push('');
  for (const r of recs) {
    const name = path.basename(r.file);
    if (r.unavailable) { L.push(`- **${name}**：⛔ 判定不可用 —— ${r.reason}`); continue; }
    if (r.kind === 'baseline') {
      const c = r.counts;
      L.push(`- **${name}**：${c.total} 条（已落地 ${c.byStatus['已落地']} / 部分 ${c.byStatus['部分']} / 未落地 ${c.byStatus['未落地']}）`);
    } else if (r.kind === 'debt') {
      L.push(`- **${name}**：${debtStatusLine(r)}`);
    } else if (r.kind === 'dod' || r.kind === 'dor') {
      if (!r.emptyDiscovery) {
        const items = r.kind === 'dod' ? DOD_ITEMS : DOR_ITEMS;
        L.push(`- **${name}**：${checklistLine(r, items)}`);
      }
    } else if (r.summary) {
      L.push(`- **${name}**：${r.summary}`);
    }
    for (const i of r.issues) L.push(`  - ${i.level} **${i.id}** ${i.msg}${i.evidence ? ` ← ${i.evidence}` : ''}`);
  }
  L.push('');
  if (mode === 'baseline' || mode === 'all') for (const r of recs.filter((x) => x.kind === 'baseline')) L.push(signoffDraft(r, humanName(r.file)));
  return L.join('\n');
}

/**
 * 文件名 → **人话名**（签字页草稿的标题用）。
 * 为什么必须有这一步（2026-10-15 夹具实测抓到）：草稿是**给人看的**，标题若直接写文件名
 *   （`需求清单-大管家V2.9-20261014.md`）就违反了两轨制的硬口径「**技术条目零次出现在
 *   给人看的清单里**」—— 带扩展名文件名本身就是技术细节（B4 模式集第 2 类）。
 */
function humanName(file) {
  const base = path.basename(file).replace(/\.md$/i, '');
  const s = base.replace(/^(需求清单|技术债台账)[-_]?/, '').replace(/[-_]\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return s.trim() || '（未命名）';
}

// ---------------------------------------------------------------------------
//  主流程
// ---------------------------------------------------------------------------
function main(argv) {
  const a = parseArgs(argv);
  if (a.err) { warn(`用法错误：${a.err}`); warn(USAGE); return EXIT.USAGE; }
  if (a.help) { process.stdout.write(USAGE + '\n'); return EXIT.OK; }
  if (a.selfTest) {
    // 夹具单测（内存，不碰真机）
    // 用动态 import 触发夹具模块顶层断言，再汇报
    const url = new URL('./lib/rulecheck-selftest.mjs', import.meta.url).href;
    return import(url).then((m) => {
      const r = m.runSelfTest();
      if (r.fail) {
        process.stdout.write(`❌ 夹具单测：通过 ${r.pass} · 失败 ${r.fail}\n`);
        for (const f of r.fails) process.stdout.write(`   ✗ ${f}\n`);
        process.exitCode = EXIT.BAD;
      } else {
        process.stdout.write(`✅ 夹具单测全绿：通过 ${r.pass} 项 · 失败 0\n`);
        process.exitCode = EXIT.OK;
      }
    }).catch((e) => { warn(`夹具单测加载失败：${e.message}`); process.exitCode = EXIT.UNAVAILABLE; });
  }

  const cmd = a.cmd || 'all';
  if (!['baseline', 'debt', 'all', 'dod', 'dor', 'defect', 'postmortem', 'practice'].includes(cmd)) { warn(`未知子命令：${cmd}`); warn(USAGE); return EXIT.USAGE; }
  jsonMode = a.json;

  const ws = resolveDshWorkspace();
  const docs = path.join(ws, 'docs');
  let all = [];
  if (['dod', 'dor', 'defect', 'postmortem', 'practice'].includes(cmd)) {
    // 第二 / 第三批判据：数据源 = 交付报告（--file）· 卡 description（--card）· docs 下的复盘 / 方案档
    all = cmd === 'dod' ? runDod(a)
      : cmd === 'dor' ? runDor(a)
        : cmd === 'defect' ? runDefect(a)
          : cmd === 'postmortem' ? runPostmortem(a) : runPractice(a);
    if (!all.length) {
      warn({
        dod: '⚠️ dod 没找到被检对象：**不自动扫全库报告**（量太大、存量必红）⇒ 请给 --file <报告> 或 --card <id|标题>',
        dor: `⚠️ dor 没找到任何卡（账本为空 / --card 没命中 / --since ${a.since || BLOCK_FORMAT_SINCE} 之后还没有卡）—— 空态不静默，如实报`,
        defect: '⚠️ defect 没找到被检对象：**不自动扫全库报告** ⇒ 请给 --file <报告> 或 --card <id|标题>',
        postmortem: '⚠️ postmortem 没找到任何复盘档（docs\\复盘-*.md 不存在 / --file 没给）—— 空态不静默，如实报（口径：P0 修完必须出复盘）',
        practice: `⚠️ practice 发现面内没有档（docs\\方案-*.md 里 mtime ≥ ${a.since || BATCH3_SINCE} 的 0 份 / --file 没给）—— 空态不静默；要看存量加 --all`,
      }[cmd]);
    }
  } else {
    const files = { baseline: [], debt: [] };
    if (a.files.length) {
      for (const f of a.files) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch (e) { warn(`⚠️ 读不到 ${f}：${e.message}`); }
        const isDebt = /技术债/.test(path.basename(f)) || findTables(text).some((t) => pickColumn(t.header, ['风险']) >= 0);
        files[isDebt ? 'debt' : 'baseline'].push(f);
      }
      if (cmd === 'baseline') files.debt = [];
      if (cmd === 'debt') files.baseline = [];
    } else {
      if (cmd === 'baseline' || cmd === 'all') files.baseline = discover(docs, '需求清单-');
      if (cmd === 'debt' || cmd === 'all') files.debt = discover(docs, '技术债台账-');
    }
    if (files.baseline.length) all.push(...runBaseline(files.baseline, a));
    if (files.debt.length) all.push(...runDebt(files.debt, a));
    if (!all.length) warn(`⚠️ 没找到任何目标档（workspace=${ws} · docs=${docs} · 模式=${cmd}）—— 空态不静默，如实报`);
  }

  // 豁免清单（可选 · 只读 · 人来维护）
  const exempt = loadExempt(a.exempt);
  if (a.exempt && exempt.length) log(`（豁免清单：${a.exempt} · ${exempt.length} 条规则）`);
  for (const r of all) applyExempt(r, exempt);

  const reds = all.reduce((n, r) => n + (r.issues || []).filter((i) => i.level === '🔴').length, 0);
  const unavail = all.filter((r) => r.unavailable).length;

  if (a.json) {
    const payload = {
      tool: 'rulecheck', version: RULECHECK_VERSION, rulesVersion: RULECHECK_RULES_VERSION,
      mode: cmd, tier: 'observe', generatedAt: new Date().toISOString(),
      workspace: ws, files: all, totals: { files: all.length, red: reds, unavailable: unavail },
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else if (a.section) {
    process.stdout.write(renderSection(all, cmd) + '\n');
  } else {
    process.stdout.write(renderHuman(all, cmd) + '\n');
  }

  if (unavail) return EXIT.UNAVAILABLE;
  if (a.failOnBad && reds) return EXIT.BAD;
  return EXIT.OK;
}

const isMain = (() => {
  try {
    const a = fs.realpathSync(process.argv[1] || '');
    const b = fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return a.toLowerCase() === b.toLowerCase();
  } catch { return false; }
})();

if (isMain) {
  const r = main(process.argv.slice(2));
  if (r && typeof r.then === 'function') r.then((code) => { if (typeof code === 'number') process.exitCode = code; });
  else if (typeof r === 'number') process.exitCode = r;
}

export { main };
