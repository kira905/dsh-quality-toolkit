#!/usr/bin/env node
// check-promises.mjs —— 承诺自核（回应表里的承诺串，命中必须落在**声明的节或行区间**内）
//
// 用法：
//   node check-promises.mjs --doc <方案档> --claims <回应表>
//   node check-promises.mjs --doc <档> --claims x.json --json
//   node check-promises.mjs --self-test
//
// 回应表两种格式（任选）：
//   A) JSON：{"claims":[{"id":"R10-M2","anchor":"判据索引只留三列","expect":{"section":"§3","lines":[113,140]}}]}
//   B) 文本：每行 `- <编号> | <承诺串> | <§3 或 L113-L140>`
//
// 判据（写死）：命中集合 ∩ 声明区间 ≠ ∅ ⇒ ✅；命中集合非空但全在区间外 ⇒ ❌ 射程不符；全档 0 命中 ⇒ ❌ 承诺未落。
import fs from 'node:fs';
import { EXIT, argParse, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp, norm } from './lib/common.mjs';

export function parseClaims(p) {
  const raw = fs.readFileSync(p, 'utf8');
  if (p.toLowerCase().endsWith('.json')) {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : j.claims;
    return arr.map((c) => ({
      id: String(c.id ?? c.编号 ?? '?'),
      anchor: String(c.anchor ?? c.承诺串 ?? ''),
      section: c.expect?.section ?? c.section ?? null,
      lines: c.expect?.lines ?? c.lines ?? null,
    }));
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*(.+?)\s*[|｜]\s*(.+?)\s*[|｜]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const expect = m[3].trim();
    const lm = /L\s*(\d+)\s*[-–~]\s*L?\s*(\d+)/.exec(expect);
    out.push({
      id: m[1].trim(),
      anchor: m[2].trim(),
      section: lm ? null : (expect.match(/§[^\s|]*|第\s*\d+\s*节/)?.[0] ?? null),
      lines: lm ? [Number(lm[1]), Number(lm[2])] : null,
    });
  }
  return out;
}

/** 求某节标题覆盖的行区间（1-based，含端点）：标题行的 `#` 层数决定终止（下一个层数 ≤ 它的标题） */
export function sectionRange(lines, sectionToken) {
  const idx = lines.findIndex((l) => l.includes(sectionToken) && /^#{1,4}\s/.test(l));
  if (idx < 0) return null;
  const level = (lines[idx].match(/^#+/) ?? ['#'])[0].length;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return [idx + 1, end];
}

export function check({ doc, claims }) {
  const m = meta(doc);
  const rows = [];
  for (const c of claims) {
    const a = norm(c.anchor);
    const hits = [];
    if (a) {
      for (let i = 0; i < m.lines.length; i++) if (norm(m.lines[i]).includes(a)) hits.push(i + 1);
    }
    let range = null;
    if (c.lines && c.lines.length === 2) range = [Number(c.lines[0]), Number(c.lines[1])];
    else if (c.section) range = sectionRange(m.lines, String(c.section).replace(/^§/, '§'));
    const inRange = range ? hits.filter((h) => h >= range[0] && h <= range[1]) : [];
    let verdict;
    if (!a) verdict = '❌ 空承诺串';
    else if (hits.length === 0) verdict = '❌ 承诺未落（全档 0 命中）';
    else if (range && inRange.length === 0) verdict = '❌ 射程不符（命中全在声明区间外）';
    else verdict = '✅';
    rows.push({ ...c, hits, range, inRange, verdict });
  }
  const bad = rows.filter((r) => r.verdict.startsWith('❌'));
  return { ok: true, doc: m, rows, bad };
}

export function report(r) {
  console.log(`档：${r.doc.path}  ·  ${r.doc.gc} 行 · sha16 ${r.doc.sha16}`);
  console.log('');
  console.log('| 编号 | 承诺串（截 30） | 期望命中（节 / 行区间） | 实际命中行 | 落在区间内 | 结论 |');
  console.log('|---|---|---|---|---|---|');
  for (const x of r.rows) {
    const rng = x.range ? `${x.section ?? ''}L${x.range[0]}-L${x.range[1]}` : '（未声明）';
    console.log(`| ${x.id} | ${(x.anchor || '').slice(0, 30)} | ${rng} | ${x.hits.length ? x.hits.slice(0, 8).join(',') + (x.hits.length > 8 ? ` …(+${x.hits.length - 8})` : '') : '—'} | ${x.inRange.length ? x.inRange.slice(0, 4).join(',') : '—'} | ${x.verdict} |`);
  }
  const pass = r.rows.length - r.bad.length;
  console.log('');
  console.log(`[汇总] ${r.rows.length} 项 · 通过 ${pass} · 失败 ${r.bad.length} ⇒ ${r.bad.length === 0 ? 'PASS' : 'FAIL'}`);
  return r.bad.length === 0 ? EXIT.OK : EXIT.FAIL;
}

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-promises-');
  const doc = writeTmp(dir, 'doc.md', [
    '# 假方案档',
    '',
    '## §3 判据索引',
    '',
    '索引只留判据名 / 命令',
    '命令与执行者同栏',
    '',
    '## §4 落地方案',
    '',
    '这里也出现「索引只留判据名」字样（在 §3 之外）',
  ].join('\n'));
  const claims = writeTmp(dir, 'claims.json', JSON.stringify({
    claims: [
      { id: 'C1', anchor: '索引只留判据名', expect: { section: '§3' } },
      { id: 'C2', anchor: '命令与执行者同栏', expect: { section: '§4' } },
      { id: 'C3', anchor: '这条承诺根本不存在', expect: { section: '§3' } },
    ],
  }, null, 2));
  const r = check({ doc, claims: parseClaims(claims) });
  assertEq(r.rows.map((x) => x.verdict), ['✅', '❌ 射程不符（命中全在声明区间外）', '❌ 承诺未落（全档 0 命中）'], '三条承诺三态判定', res);
  assertEq(r.rows[0].hits, [5, 10], '命中行动态定位（L5 + §4 内的 L10）', res);
  assertEq(r.rows[0].range, [3, 7], '§3 节区间动态计算（到下一个同级标题前）', res);
  const rowsTxt = writeTmp(dir, 'claims.txt', '- C4 | 判据名 | §3\n- C5 | 判据名 | L10-L12\n');
  const c2 = parseClaims(rowsTxt);
  assertEq([c2[0].section, c2[1].lines], ['§3', [10, 12]], '文本格式回应表解析（节 / 行区间）', res);
  rmrf(dir);
  finishSelfTest('check-promises', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'claims'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '承诺自核（第 7 条④⑤ · 承诺串落点）',
      usage: 'node check-promises.mjs --doc <方案档> --claims <回应表.json|.md> [--json]',
      form: ['编号 | 承诺串（截 30） | 期望命中（节 / 行区间） | 实际命中行 | 落在区间内 | 结论',
        '[汇总] N 项 · 通过 x · 失败 y'],
      caliber: ['承诺串与命中行**动态搜索**（归一后 includes），脚本内无硬编码行号、无硬编码串',
        '区间来自回应表声明：`§N`⇒该节标题覆盖区间（由标题层级算出）；`L a-b`⇒直接用',
        '命中集合非空但全在区间外 ⇒ 判"射程不符"（不放行）'],
      scope: { docs: '方案档（承诺串的落点档）', stage: '回修交付阶段', who: '回修方' },
      exits: ['0 = 全部承诺落在声明区间内', '3 = 有承诺未落 / 射程不符', '2 = 用法错 / 回应表不可读'],
      selfTest: 'node check-promises.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    selfTest();
  } else if (!a.doc || !a.claims) {
    console.log('✗ 缺 --doc / --claims（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else {
    try {
      process.exitCode = report(check({ doc: a.doc, claims: parseClaims(a.claims) }));
    } catch (e) {
      console.log(`✗ 回应表不可读：${e.message}`);
      process.exitCode = EXIT.USAGE;
    }
  }
}
