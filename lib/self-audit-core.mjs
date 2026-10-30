// self-audit-core.mjs —— 交付前自批：六条机械判据
//
// ① DoD 块在不在           ② 有没有带当次命令原文        ③ 有没有「待拍板」段（有未决项时）
// ④ 报告里有没有内部标识    ⑤ 报告路径真实存在            ⑥ 正文引用的文件真实存在
//
// 第 ④ 条**不许只调扫描器的 rc**：调用方不看退出码，只看"扫描器有没有说它不完整"。
// 不注入 P0 词表时扫描器照样 hits=0 —— "干净但不完整"是最外层失效而无人告警。
// 所以这里走三层：机器层（词表是否注入）+ 证伪层（阴性对照是否活的）+ 字面量层（仓内 7 类表）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditTables, scanText, CATEGORIES } from './deny-literal.mjs';

export const MACHINE_INCOMPLETE = ['P0 段未启用', '本次扫描不完整'];

/**
 * 解析权威扫描器的报告/输出。两种写法都认（英文 key=value 与中文「命中：N（放行 A / 待复核 R）」），
 * 因为不同版本的扫描器报告措辞不一样 —— 认不出来的读数一律当"证据不足"，不许当 0。
 */
export function parseMachineReport(text) {
  const t = String(text ?? '');
  const incomplete = MACHINE_INCOMPLETE.filter((p) => t.includes(p));
  const p0Line = t.match(/P0[^\n]*/) ?? [''];
  const p0Count = (t.match(/P0[^\n]*?[：:]\s*(\d+)\s*条/) ?? [])[1] ?? null;
  const p0Injected = Boolean(p0Count) || (/注入的私有标识词表/.test(t) && !/未提供/.test(t));
  const hits = (t.match(/hits\s*[=:]\s*(\d+)/i)?.[1] ?? t.match(/命中[：:]\s*(\d+)/)?.[1]) ?? null;
  const allow = (t.match(/allow\s*[=:]\s*(\d+)/i)?.[1] ?? t.match(/放行\s*(\d+)/)?.[1]) ?? null;
  const review = (t.match(/review\s*[=:]\s*(\d+)/i)?.[1] ?? t.match(/待复核\s*(\d+)/)?.[1]) ?? null;
  return {
    incomplete,
    p0Injected,
    p0Count: p0Count === null ? null : Number(p0Count),
    p0Line: String(p0Line[0] ?? '').trim(),
    hits: hits === null ? null : Number(hits),
    allow: allow === null ? null : Number(allow),
    review: review === null ? null : Number(review),
  };
}

const PATH_EXT = 'md|markdown|mjs|cjs|js|json|yml|yaml|txt|ps1|cmd|png|jpg|jpeg|pdf|docx|xlsx';

const RE_INLINE_PATH = new RegExp('`([^`\\n]{3,200}?\\.(?:' + PATH_EXT + '))`', 'g');
const RE_BARE_PATH = new RegExp('(?<![`\\w.\\-])((?:[A-Za-z]:[\\\\/]|~[\\\\/]|[\\w.-]+[\\\\/])[^\\s`|*<>"\'（），。；：]{2,180}?\\.(?:' + PATH_EXT + '))', 'g');

export function sectionOf(lines, matcher) {
  const idx = lines.findIndex((l) => matcher.test(l));
  return idx;
}

/** 从一段文本里找出 DoD 块：要求出现「DoD」，且块内 ≥10 个勾选/编号项（允许表格形式）。 */
export function findDodBlock(lines) {
  const head = lines.findIndex((l) => /DoD/i.test(l));
  if (head < 0) return { ok: false, reason: '全文没有出现 DoD' };
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i]) && !/DoD/i.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(head, Math.min(end, head + 80));
  const item = block.filter((l) => /^\s*(?:[-*+]\s*\[[ xX✓☐☑]?\]|\d{1,2}[.、)]\s|[-*+]\s*[☐☑✓✅]|\|.*\|\s*(?:✅|✓|☑|是|已|否))/u.test(l));
  return { ok: item.length >= 10, reason: item.length >= 10 ? `${item.length} 个条目` : `只数到 ${item.length} 个条目（要 ≥10）`, count: item.length };
}

/** 围栏代码块里的命令行（当次命令原文的载体）。 */
export function findCommands(lines) {
  const cmds = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) continue;
    const t = line.trim().replace(/^[$>]\s*/, '');
    if (/^(?:node|npm|npx|git|pwsh|powershell|cmd|\.\/|python|python3|deno|yarn|pnpm)\b/i.test(t)) cmds.push(t);
    else if (/^(?:Get-|Set-|Test-Path|New-Item|Copy-Item|Remove-Item|Select-String)\b/.test(t)) cmds.push(t);
  }
  return cmds;
}

/** 未决项标记（排除"无待拍板"这种否定式）。 */
export function findPendingLines(lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (!/待拍板|待主人|未决|待确认|待批/.test(l)) return;
    if (/(无|没有|不存在|零)\s*待拍板/.test(l)) return;
    out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

export function hasPendingSection(lines) {
  return lines.some((l) => /^#{1,6}\s*.*待拍板|^\*\*待拍板|^待拍板[:：]/.test(l.trim()));
}

function isPlaceholder(p) {
  return /[<>*…]|\$\{|^\.\.\./.test(p);
}

/** 正文里引用的文件路径（行内反引号优先，其次裸路径）。**跳过围栏代码块** —— 那是命令，由第 ② 条管。 */
export function extractCitedPaths(text, { skipFences = true } = {}) {
  const found = new Map();
  const push = (raw) => {
    const p = raw.trim().replace(/^[`'"]+|[`'"）)，。；：]+$/g, '');
    if (!p || isPlaceholder(p)) return;
    if (/^https?:/i.test(p)) return;
    if (/[;|&$(){}"']/.test(p)) return;
    if (/\s/.test(p)) return;
    if (!found.has(p)) found.set(p, true);
  };
  let inFence = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (skipFences && inFence) continue;
    for (const m of line.matchAll(RE_INLINE_PATH)) push(m[1]);
    for (const m of line.matchAll(RE_BARE_PATH)) push(m[1]);
  }
  return [...found.keys()].map((raw) => ({ raw }));
}

export function resolveCited(raw, { root, reportDir }) {
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  if (path.isAbsolute(raw)) return raw;
  const bases = [root, reportDir, path.join(root, 'docs')];
  for (const b of bases) {
    if (!b) continue;
    const p = path.resolve(b, raw);
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(root ?? reportDir ?? '.', raw);
}

/** 默认根：报告在 <X>/docs/ 下 ⇒ 根 = <X>；否则当前工作目录。 */
export function guessRoot(reportFile) {
  let dir = path.dirname(path.resolve(reportFile));
  for (let i = 0; i < 6; i += 1) {
    if (path.basename(dir).toLowerCase() === 'docs') return path.dirname(dir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

/**
 * 六条判据。返回 { checks: [{id, title, state, evidence:[...]}], tally }
 * state: pass / warn / fail —— warn 是"证据不足/需人确认"，不是通过。
 */
export function auditReport({ file, root, tables, machineReport = null, negctl = null, card = null, item = null }) {
  const absFile = path.resolve(file);
  const exists = fs.existsSync(absFile) && fs.statSync(absFile).isFile();
  if (!exists) {
    return {
      checks: [{ id: 5, title: '报告路径真实存在', state: 'fail', evidence: [`不存在或不是文件：${absFile}`] }],
      tally: { pass: 0, warn: 0, fail: 1 },
    };
  }
  const text = fs.readFileSync(absFile, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const stat = fs.statSync(absFile);
  const reportDir = path.dirname(absFile);
  const rootDir = root ?? guessRoot(absFile);
  const checks = [];

  const dod = findDodBlock(lines);
  checks.push({
    id: 1,
    title: 'DoD 块在不在',
    state: dod.ok ? 'pass' : 'fail',
    evidence: [dod.ok ? `DoD 块：${dod.reason}` : `DoD 块缺失或不成形：${dod.reason}`],
  });

  const cmds = findCommands(lines);
  checks.push({
    id: 2,
    title: '有没有带当次命令原文',
    state: cmds.length ? 'pass' : 'fail',
    evidence: cmds.length
      ? cmds.slice(0, 3).map((c) => `命令原文：${c.length > 120 ? `${c.slice(0, 120)}…` : c}`)
      : ['围栏代码块里没有任何命令行 —— "跑过了"不算，要能把命令抄出来重跑'],
  });

  const pending = findPendingLines(lines);
  const pendingSection = hasPendingSection(lines);
  const state3 = pending.length === 0 ? 'pass' : pendingSection ? 'pass' : 'fail';
  checks.push({
    id: 3,
    title: '有没有「待拍板」段（有未决项时）',
    state: state3,
    evidence: pending.length === 0
      ? ['正文没有未决项标记，不需要「待拍板」段']
      : [
        `未决项标记 ${pending.length} 处（首条 L${pending[0].line}）`,
        pendingSection ? '存在「待拍板」段 ✓' : '🔴 有未决项但没有「待拍板」段',
      ],
  });

  // ④ 内部标识：三层
  const tableAudit = auditTables(tables);
  const hits = scanText(text, tables, { file: absFile });
  const review = hits.filter((h) => !h.allow);
  const allowed = hits.filter((h) => h.allow);
  const ev4 = [];
  let state4 = 'pass';
  ev4.push(
    `字面量层：${CATEGORIES.length} 类，缺 ${tableAudit.missing.length} 类` +
    (tableAudit.missing.length ? `（缺 ${tableAudit.missing.join(',')}）` : '（每类 ≥1 条 ✓）') +
    `；解析错误 ${tableAudit.parseErrors.length} 条`,
  );
  if (!tableAudit.ok) state4 = 'fail';
  ev4.push(`字面量层命中：待复核 ${review.length} 条 · 允许 ${allowed.length} 条（命令原文/引用证据/引用块）`);
  if (review.length) {
    state4 = 'fail';
    for (const h of review.slice(0, 5)) ev4.push(`  🔴 L${h.line} ${h.category}：${h.masked}`);
  }
  if (allowed.length) {
    const byReason = {};
    for (const h of allowed) byReason[h.allowReason] = (byReason[h.allowReason] ?? 0) + 1;
    ev4.push(`  允许明细：${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  // 机器层
  const saysIncomplete = MACHINE_INCOMPLETE.filter((p) => text.includes(p));
  if (saysIncomplete.length) {
    state4 = 'fail';
    ev4.push(`🔴 报告自身出现「${saysIncomplete.join('」「')}」⇒ 机器层不过（不看 rc：不注词表时照样 hits=0）`);
  }
  if (machineReport) {
    let mText = '';
    try { mText = fs.readFileSync(machineReport, 'utf8'); } catch { mText = ''; }
    const m = parseMachineReport(mText);
    let mState = 'pass';
    if (!mText) {
      mState = 'warn';
      ev4.push(`机器层：给了 ${machineReport} 但读不到内容 ⇒ 判"证据不足"`);
    } else {
      if (m.incomplete.length) {
        mState = 'fail';
        ev4.push(`🔴 机器层报告出现「${m.incomplete.join('」「')}」⇒ 词表没注入，本次扫描不完整（**不看 rc**）`);
      } else if (!m.p0Injected) {
        mState = 'warn';
        ev4.push('机器层报告里看不到「P0 词表已注入 N 条」的证据 ⇒ 判"证据不足"（干净但不完整不算过）');
      } else {
        ev4.push(`机器层：P0 词表已注入 ${m.p0Count ?? '?'} 条`);
      }
      if (m.hits !== null) {
        ev4.push(`机器层读数：命中 ${m.hits} · 放行 ${m.allow ?? '?'} · 待复核 ${m.review ?? '?'}`);
        if ((m.review ?? 0) > 0) { mState = 'fail'; ev4.push('🔴 机器层 待复核 > 0（review 必须为 0）'); }
      } else if (!m.incomplete.length) {
        mState = mState === 'fail' ? 'fail' : 'warn';
        ev4.push('机器层报告里没读到命中/放行/待复核读数 ⇒ 判"证据不足"');
      }
    }
    if (mState === 'fail') state4 = 'fail';
    else if (mState === 'warn' && state4 === 'pass') state4 = 'warn';
  } else {
    if (state4 === 'pass') state4 = 'warn';
    ev4.push('机器层：没给 --machine-report ⇒ 判"证据不足"（不许当通过；权威扫描器需注入 P0 词表再跑一次）');
  }
  // 证伪层
  if (negctl) {
    ev4.push(`证伪层：阴性对照 ${negctl.ok ? '四步全过 ✓（样本必然判红）' : '🔴 失效'}`);
    if (!negctl.ok) state4 = 'fail';
  } else {
    if (state4 === 'pass') state4 = 'warn';
    ev4.push('证伪层：本次没跑 --negctl ⇒ 判"证据不足"（"它会红"本身才是验收物）');
  }
  checks.push({ id: 4, title: '报告里有没有内部标识（三层）', state: state4, evidence: ev4 });

  checks.push({
    id: 5,
    title: '报告路径真实存在',
    state: 'pass',
    evidence: [`${absFile} · ${stat.size} B · 修改时间 ${new Date(stat.mtimeMs).toISOString()}`],
  });

  const cited = extractCitedPaths(text);
  const missing = [];
  const ok = [];
  const skipped = [];
  for (const c of cited) {
    const p = resolveCited(c.raw, { root: rootDir, reportDir });
    if (fs.existsSync(p)) { ok.push(c.raw); continue; }
    // 只有"落点明确"的才判缺：绝对路径，或首段就是扫描根下的真实目录。
    // 仓内相对路径（如 `lib/cli-args.mjs`）基准不在扫描根里 ⇒ 记"跳过"，不冒充缺文件。
    const firstSeg = c.raw.split(/[\\/]/)[0];
    const anchored = path.isAbsolute(c.raw) || /^~/.test(c.raw) || fs.existsSync(path.join(rootDir, firstSeg));
    if (anchored) missing.push(c.raw); else skipped.push(c.raw);
  }
  checks.push({
    id: 6,
    title: '正文引用的文件真实存在',
    state: missing.length ? 'fail' : 'pass',
    evidence: [
      `引用路径 ${cited.length} 条：存在 ${ok.length} · 缺 ${missing.length}` +
      (skipped.length ? ` · 跳过 ${skipped.length}（相对路径，基准不在扫描根内：${skipped.slice(0, 3).join(' · ')}${skipped.length > 3 ? ' …' : ''}）` : ''),
      ...missing.slice(0, 8).map((m) => `  🔴 找不到：${m}`),
    ],
  });

  const tally = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) tally[c.state] += 1;
  return { checks, tally, meta: { file: absFile, root: rootDir, card, item, size: stat.size } };
}

export function verdictOf(tally) {
  if (tally.fail > 0) return { id: 'red', zh: '红（不放行）', rc: 4 };
  if (tally.warn > 0) return { id: 'yellow', zh: '黄（证据不足，需补）', rc: 3 };
  return { id: 'green', zh: '绿（六条全过）', rc: 0 };
}

export function renderChecks(result) {
  const L = [];
  const mark = { pass: '✓', warn: '△', fail: '✗' };
  for (const c of result.checks) {
    L.push(`${mark[c.state]} ${c.id}. ${c.title} —— ${c.state}`);
    for (const e of c.evidence) L.push(`    ${e}`);
  }
  const v = verdictOf(result.tally);
  L.push(`\n合计：通过 ${result.tally.pass} · 证据不足 ${result.tally.warn} · 不通过 ${result.tally.fail} ⇒ 判定 ${v.zh}`);
  return L.join('\n');
}
