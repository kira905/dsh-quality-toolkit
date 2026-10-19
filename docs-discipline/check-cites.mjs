#!/usr/bin/env node
// check-cites.mjs —— 落点自核（标签 ↔ 行号双向核）
//
// 用法：
//   node check-cites.mjs --doc <方案档> --report <回修报告>
//   node check-cites.mjs --doc <档> --report <档> --section "第 10 轮回修"
//   node check-cites.mjs --self-test
//
// 判据（写死）：
//   ① 正向（标签 → 行号）：报告里写 `L<num>「引文」` ⇒ 目标档第 num 行**必须真的含该引文**（忽略 markdown 粗体 / 反引号 / 列宽空格）；
//   ② 反向（行号 → 标签）：把该引文在目标档里**全文搜一遍**，命中行号必须与声明行号一致（不一致 ⇒ 错配，打回）。
//   ③ 无引文只有行号的引用 ⇒ **无对照物**，只展示"该行前 60 字"，不判红。
//   ④ 射程 = 报告里**本轮新增章节**（--section 指定）内的引用为**可判红面**；
//      历史章节的引用因方案档已换代必然错位 ⇒ **只报不判**（第 7 条细则①：行号订正走订正注）。
import fs from 'node:fs';
import { EXIT, argParse, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp, norm } from './lib/common.mjs';

const CITE_QUOTE_FIRST = /L(\d+)\s*[「『“"]([^」』”"]{2,60})[」』”"]/g;
const CITE_QUOTE_LAST = /[「『“"]([^」』”"]{2,60})[」』”"]\s*(?:在|位于|见)?\s*L(\d+)/g;
const CITE_BARE = /(?:^|[^A-Za-z0-9])L(\d+)(?![0-9])/g;

/** 抽出报告里的全部引用。返回 {reportLine, kind:'quote'|'quoteLast'|'bare', num, quote, target:'doc'|'report'} */
export function extractCites(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const seen = new Set();
    for (const m of line.matchAll(CITE_QUOTE_FIRST)) {
      const at = m.index;
      seen.add(at);
      out.push({ reportLine: i + 1, kind: 'quote', num: Number(m[1]), quote: m[2], target: targetOf(line, at) });
    }
    for (const m of line.matchAll(CITE_QUOTE_LAST)) {
      const at = m.index;
      if (seen.has(at)) continue;
      seen.add(at);
      out.push({ reportLine: i + 1, kind: 'quoteLast', num: Number(m[2]), quote: m[1], target: targetOf(line, at) });
    }
    for (const m of line.matchAll(CITE_BARE)) {
      const at = m.index + m[0].indexOf('L');
      let inside = false;
      for (const s of seen) if (at >= s && at <= s + 60) inside = true;
      if (inside) continue;
      out.push({ reportLine: i + 1, kind: 'bare', num: Number(m[1]), quote: null, target: targetOf(line, at) });
    }
  }
  return out;
}

/** 目标档归属：引用点前 30 字里出现「报告 / 本报告」⇒ 目标是回修报告，否则默认方案档 */
function targetOf(line, at) {
  const ctx = line.slice(Math.max(0, at - 30), at);
  return /报告/.test(ctx) ? 'report' : 'doc';
}

export function check({ docPath, reportPath, section }) {
  const doc = meta(docPath);
  const rep = meta(reportPath);
  const cites = extractCites(rep.lines);
  let winFrom = 1;
  if (section) {
    // 先找**标题行**里的 section（避免正文里提前提到它就把窗口起点拉错）；找不到再退化为首处包含
    let idx = rep.lines.findIndex((l) => /^#{1,3}\s/.test(l) && l.includes(section));
    if (idx < 0) idx = rep.lines.findIndex((l) => l.includes(section));
    winFrom = idx >= 0 ? idx + 1 : rep.lines.length + 1;
  }
  const rows = [];
  for (const c of cites) {
    const tgt = c.target === 'doc' ? doc : rep;
    const inWindow = c.reportLine >= winFrom;
    const hitLine = c.num >= 1 && c.num <= tgt.lines.length ? tgt.lines[c.num - 1] : null;
    const head = hitLine === null ? '（越界：目标档无此行）' : hitLine.trim().slice(0, 60) || '（空行）';
    let verdict = '—';
    let actualLine = null;
    if (c.quote) {
      const q = norm(c.quote);
      if (hitLine !== null && norm(hitLine).includes(q)) {
        verdict = '✅ 强核通过';
      } else {
        const who = tgt.lines.findIndex((l) => norm(l).includes(q));
        actualLine = who >= 0 ? who + 1 : null;
        verdict = inWindow ? '❌ 错配' : '⚠️ 历史引用错位（只报）';
      }
    } else {
      verdict = hitLine === null ? (inWindow ? '❌ 引空行' : '⚠️ 历史引用引空行') : '⚠️ 无对照物（只有行号）';
    }
    rows.push({ ...c, targetName: c.target === 'doc' ? '方案档' : '报告', head, verdict, actualLine, inWindow });
  }
  const hard = rows.filter((r) => r.verdict === '❌ 错配' || r.verdict === '❌ 引空行');
  const soft = rows.filter((r) => r.verdict.startsWith('⚠️'));
  const ok = rows.filter((r) => r.verdict.startsWith('✅'));
  return { ok: true, doc, rep, rows, hard, soft, okRows: ok, winFrom, section: section ?? null };
}

export function report(r, { onlyWindow = false } = {}) {
  const rows = onlyWindow ? r.rows.filter((x) => x.inWindow) : r.rows;
  console.log(`方案档：${r.doc.path}  ·  ${r.doc.gc} 行 · sha16 ${r.doc.sha16}`);
  console.log(`报告档：${r.rep.path}  ·  ${r.rep.gc} 行 · sha16 ${r.rep.sha16}`);
  console.log(`可判红面：${r.section ? `「${r.section}」起（报告 L${r.winFrom} → 末）` : '全档（未指定 --section）'}${onlyWindow ? ` · **--only-window：只打印该面内的 ${rows.length} 处**` : ` · 全部 ${rows.length} 处`}`);
  console.log('');
  console.log('| 报告行 | 目标 | 引用 | 该行前 60 字 | 反向：引文实际所在 | 判定 |');
  console.log('|---|---|---|---|---|---|');
  for (const x of rows) {
    console.log(`| L${x.reportLine} | ${x.targetName} | L${x.num}${x.quote ? `「${x.quote.slice(0, 24)}」` : '（无引文）'} | ${x.head} | ${x.actualLine ? 'L' + x.actualLine : '—'} | ${x.verdict} |`);
  }
  console.log('');
  console.log(`[汇总] 引用 ${r.rows.length} 处 · 强核通过 ${r.okRows.length} · **错配（可判红）${r.hard.length}** · 只报 ${r.soft.length} ⇒ ${r.hard.length === 0 ? 'PASS' : 'FAIL'}`);
  if (r.hard.length) {
    console.log('  错配明细（标签 ↔ 行号不符，须按第 7 条细则①走订正注订正）：');
    for (const h of r.hard) console.log(`    L${h.reportLine} 声明 L${h.num}「${h.quote}」 ⇒ 实际 ${h.actualLine ? 'L' + h.actualLine : '全档无此串'}`);
  }
  return r.hard.length === 0 ? EXIT.OK : EXIT.FAIL;
}

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-cites-');
  const doc = writeTmp(dir, 'doc.md', [
    '# 假方案档',
    '',
    '第一行正文',
    'L9 检查项（一句话，可直接抄进方案的审核章节或卡面）',   // 第 4 行
    '',
    '登记位置：写进方案文档的审核章节',                        // 第 6 行
    '',
    '尾巴',
  ].join('\n'));
  const rep = writeTmp(dir, 'report.md', [
    '# 第 1 轮回修',
    '',
    '规程 L6「登记位置：写进方案文档的审核章节」已命中。',      // 正确引用
    '规程 L4「登记位置：写进方案文档的审核章节」已命中。',      // 错配（引文在 L6）
    '另见 L999。',                                            // 越界
  ].join('\n'));
  const r = check({ docPath: doc, reportPath: rep });
  assertEq(r.rows.length, 3, '抽到 3 处引用（2 带引文 + 1 裸行号）', res);
  assertEq(r.okRows.length, 1, '强核通过 1 处', res);
  assertEq(r.hard.length, 2, '错配 1 + 越界 1 ⇒ 判红 2 处', res);
  const bad = r.hard.find((h) => h.quote && h.actualLine === 6);
  assertTrue(bad, '反向核指出引文真实所在行（L6）', res, JSON.stringify(r.rows.map((x) => x.verdict)));
  const r2 = check({ docPath: doc, reportPath: rep, section: '不存在的章节' });
  assertEq(r2.hard.length, 0, '--section 指不到 ⇒ 可判红面为空（历史面只报）', res);
  rmrf(dir);
  finishSelfTest('check-cites', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'report', 'section'], flags: ['only-window'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '落点自核（第 7 条 · 标签 ↔ 行号双向核）',
      usage: 'node check-cites.mjs --doc <方案档> --report <回修报告> [--section <本轮章节标题子串>] [--only-window] [--json]',
      form: ['报告行 | 目标 | 引用 | 该行前 60 字 | 反向：引文实际所在 | 判定',
        '[汇总] 引用 N · 强核通过 x · 错配（可判红）y · 只报 z',
        '错配明细：报告行 · 声明行号 · 引文 · 实际所在行',
        '`--only-window` ⇒ 只打印可判红面（--section 之后）的行，便于把产物直接贴进报告（历史面 600+ 行不刷屏）'],
      caliber: ['引用靠正则抽（`L<num>「引文」` / `「引文」L<num>` / 裸 `L<num>`），脚本内无硬编码行号、无硬编码引文串',
        '正向 = 标签 → 行号：目标档第 num 行须含引文（归一：去 `**` / 反引号 / 引号 / 空白）',
        '反向 = 行号 → 标签：引文在目标档全文搜到的行号须等于声明行号',
        '无引文的引用 = 无对照物（⚠️ 只报）；--section 之外的历史引用 = 只报不判（行号随换代必然错位，走订正注）',
        '--section 优先匹配**标题行**（避免正文提前提到本章节名就把窗口起点拉错）'],
      scope: { docs: '方案档 + 回修报告（一核一对）', stage: '回修交付阶段（交付前）', who: '回修方' },
      exits: ['0 = 无错配', '3 = 有错配 / 引空行', '2 = 用法错'],
      selfTest: 'node check-cites.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    selfTest();
  } else if (!a.doc || !a.report) {
    console.log('✗ 缺 --doc / --report（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else {
    process.exitCode = report(check({ docPath: a.doc, reportPath: a.report, section: a.section }), { onlyWindow: !!a['only-window'] });
  }
}
