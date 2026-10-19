#!/usr/bin/env node
// check-selfclaim.mjs —— 自述核对（报告里"人写的声明"逐条回 diff 实证）
//
// 用法：
//   node check-selfclaim.mjs --report <回修报告> --diff <本轮 diff>
//   node check-selfclaim.mjs --report <档> --diff <diff> --section "第 10 轮回修" [--json]
//   node check-selfclaim.mjs --self-test
//
// 判据（写死）：
//   ① 自述行 = 含「已改 / 已重写 / 已补 / 已加 / 已闭合 / 已落 / 已删 / 已登记 / 逐字一致 / 未变 / 无改动」之一的行；
//   ② 每条自述抽出**可核 token**（sha16 / N 行 / N B / N 条 / N 次）⇒ 必须能在 diff 里找到**实证**（+/- 行）；
//   ③ 「未变 / 无改动 / 一字未碰」型自述 ⇒ diff 里**不得出现**该文件的头（出现 ⇒ 相抵 ❌）；
//   ④ 自述行里找不到任何可核 token ⇒ ⚠️ 无对照物（只报，不判红）。
import fs from 'node:fs';
import { EXIT, argParse, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp } from './lib/common.mjs';

const CLAIM_RE = /已改|已重写|已补|已加|已闭合|已落|已删|已登记|逐字一致|逐条一致|未变|无改动|一字未碰/;
const UNCHANGED_RE = /未变|无改动|一字未碰|未碰/;
const TOKEN_RE = /[0-9A-Fa-f]{16}|\d[\d\s]{0,6}?\s*(?:行|B|条|次)/g;
const FILE_RE = /[\u4e00-\u9fa50-9A-Za-z][\u4e00-\u9fa50-9A-Za-z._/-]*\.md/g;

export function parseDiff(text) {
  const files = new Set();
  const body = [];
  for (const line of text.split(/\r?\n/)) {
    // git 对非 ASCII 路径会加引号：`--- "a/<DSH_ROOT>\\...\\档.md"` ⇒ 两种形态都要认（否则文件名面全空 ⇒ 反向核形同虚设）
    const h = /^(?:\+\+\+|---)\s+(?:"[ab][\\/](.+)"|[ab][\\/](.+?))\s*$/.exec(line);
    if (h) {
      const p = (h[1] ?? h[2]).replace(/\\\\/g, '\\').trim();
      files.add(p);
      files.add(p.split(/[\\/]/).pop());
      continue;
    }
    if (/^[+-]/.test(line) && !/^[-+]{3}/.test(line)) body.push(line);
  }
  return { files, body, text };
}

export function check({ reportPath, diffPath, section }) {
  const rep = meta(reportPath);
  const diff = parseDiff(fs.readFileSync(diffPath, 'utf8'));
  let from = 1;
  if (section) {
    // 同 check-cites：优先匹配标题行，避免正文提前提到本章节名把抽查面起点拉错
    let i = rep.lines.findIndex((l) => /^#{1,3}\s/.test(l) && l.includes(section));
    if (i < 0) i = rep.lines.findIndex((l) => l.includes(section));
    from = i >= 0 ? i + 1 : rep.lines.length + 1;
  }
  const rows = [];
  for (let i = from - 1; i < rep.lines.length; i++) {
    const line = rep.lines[i];
    if (!CLAIM_RE.test(line)) continue;
    const tokens = [...new Set([...line.matchAll(TOKEN_RE)].map((m) => m[0].replace(/\s+/g, ' ').trim()))];
    const filesInLine = [...new Set([...line.matchAll(FILE_RE)].map((m) => m[0]))];
    let verdict;
    let evidence = [];
    if (UNCHANGED_RE.test(line) && filesInLine.length) {
      const touched = filesInLine.filter((f) => diff.files.has(f));
      if (touched.length) { verdict = '❌ 相抵（自述"未变"但 diff 动了该文件）'; evidence = touched; }
      else { verdict = '✅ 与 diff 一致（diff 未动该文件）'; evidence = filesInLine; }
    } else if (tokens.length) {
      evidence = tokens.filter((t) => diff.text.includes(t));
      verdict = evidence.length ? '✅ 有 diff 实证' : '❌ 自述无实证（diff 里找不到该 token）';
    } else {
      verdict = '⚠️ 无对照物（自述行无可核 token / 文件名）';
    }
    rows.push({ line: i + 1, text: line.trim().slice(0, 90), tokens, files: filesInLine, evidence, verdict });
  }
  const bad = rows.filter((r) => r.verdict.startsWith('❌'));
  return { ok: true, rep, diff, rows, bad, from, section: section ?? null };
}

export function report(r) {
  console.log(`报告：${r.rep.path}  ·  ${r.rep.gc} 行 · sha16 ${r.rep.sha16}`);
  console.log(`diff：${r.diff.files.size} 个文件头 · ${r.diff.body.length} 条 +/- 行 · 抽查面 = ${r.section ? `「${r.section}」起（L${r.from} → 末）` : '全档'}`);
  console.log('');
  console.log('| 报告行 | 自述（截 90） | 可核 token | 文件名 | diff 实证 | 结论 |');
  console.log('|---|---|---|---|---|---|');
  for (const x of r.rows) {
    console.log(`| L${x.line} | ${x.text} | ${x.tokens.slice(0, 3).join(' ') || '—'} | ${x.files.join(' ') || '—'} | ${x.evidence.slice(0, 3).join(' ') || '—'} | ${x.verdict} |`);
  }
  console.log('');
  console.log(`[汇总] 自述行 ${r.rows.length} · 有实证 ${r.rows.filter((x) => x.verdict.startsWith('✅')).length} · **相抵 / 无实证 ${r.bad.length}** · 无对照物 ${r.rows.filter((x) => x.verdict.startsWith('⚠️')).length} ⇒ ${r.bad.length === 0 ? 'PASS' : 'FAIL'}`);
  return r.bad.length === 0 ? EXIT.OK : EXIT.FAIL;
}

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-selfclaim-');
  const diff = writeTmp(dir, 'd.txt', [
    '--- a/docs/甲.md',
    '+++ b/docs/甲.md',
    '@@ -1 +1 @@',
    '-旧行 v10 = 257 行 / 39 532 B',
    '+新行 v11 = 300 行 / 45 000 B',
    '--- a/docs/乙.md',
    '+++ b/docs/乙.md',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n'));
  const rep = writeTmp(dir, 'r.md', [
    '# 第 1 轮回修',
    '',
    '① 甲.md 已改：257 行 ⇒ 300 行（逐条落 39 532 B 那一处）。',
    '② 乙.md 自述「已补 9 999 B」但 diff 里没有这个数。',
    '③ 丙.md 未变、一字未碰。',
    '④ 甲.md 未变 —— 但 diff 动了它（相抵）。',
  ].join('\n'));
  const r = check({ reportPath: rep, diffPath: diff, section: '第 1 轮回修' });
  assertEq(r.rows.length, 4, '抽到 4 条自述行', res);
  assertEq(r.rows[0].verdict, '✅ 有 diff 实证', '自述数字能在 diff 找到 ⇒ PASS', res);
  assertEq(r.rows[1].verdict, '❌ 自述无实证（diff 里找不到该 token）', '自述数字 diff 无 ⇒ 判红', res);
  assertEq(r.rows[2].verdict, '✅ 与 diff 一致（diff 未动该文件）', '未变 + diff 未动 ⇒ PASS', res);
  assertEq(r.rows[3].verdict, '❌ 相抵（自述"未变"但 diff 动了该文件）', '未变 + diff 动了 ⇒ 相抵判红', res);
  const r2 = check({ reportPath: rep, diffPath: diff, section: '不存在的章节' });
  assertEq(r2.rows.length, 0, '--section 指不到 ⇒ 抽查面为空（全档不扫）', res);
  rmrf(dir);
  finishSelfTest('check-selfclaim', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['report', 'diff', 'section'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '自述核对（第 7 条④⑤ · 人写的声明必须回原始证据）',
      usage: 'node check-selfclaim.mjs --report <回修报告> --diff <本轮 diff> [--section <本轮章节标题子串>] [--json]',
      form: ['报告行 | 自述（截 90） | 可核 token | 文件名 | diff 实证 | 结论', '[汇总] 自述行 N · 有实证 x · 相抵/无实证 y · 无对照物 z'],
      caliber: ['自述行靠触发词匹配（已改/已补/已闭合/未变/无改动…），token 靠正则抽（sha16 / N 行 / N B / N 条 / N 次），脚本内无硬编码串',
        '「未变」型自述反向核：diff 头里出现该文件 ⇒ 相抵（这是"报告说改了/没改、正文不一致"族的正解）',
        'diff 头认两种形态：`--- a/path` 与 git 对非 ASCII 路径加引号的 `--- "a/<盘符>:\\…\\档.md"`',
        '--section 优先匹配标题行；其之外的章节不扫（历史章节的自述由当时那轮的产物负责）'],
      scope: { docs: '回修报告（自述面）+ 本轮 diff（证据面）', stage: '回修交付阶段', who: '回修方' },
      exits: ['0 = 自述与 diff 一致', '3 = 有相抵 / 无实证', '2 = 用法错 / 报告或 diff 不可读'],
      selfTest: 'node check-selfclaim.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    selfTest();
  } else if (!a.report || !a.diff) {
    console.log('✗ 缺 --report / --diff（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else {
    process.exitCode = report(check({ reportPath: a.report, diffPath: a.diff, section: a.section }));
  }
}
