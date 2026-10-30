#!/usr/bin/env node
// _test/test-ref-scan.mjs —— 引用面扫描单测
//
// 盯四件事：
//   ① 四类载体都扫到，命中逐行列出（文件 / 行号 / 片段）；
//   ② 0 命中 ⇒ 判黄（不是 pass、也不是红），且**空表也要有扫描面证据行**；
//   ③ 被排除目录里的命中单独声明（不进处置表、也不进主计数）；
//   ④ 处置列 A/B/C/D 默认留空 —— 机器只列该看的，不代替人判。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newResults, assertEq, assertTrue, finishSelfTest, rmrf } from '../docs-discipline/lib/common.mjs';
import { scanRefs, evidenceLine, renderTable, dispositionLegend } from '../lib/ref-scan-core.mjs';

const TMP = path.join(os.tmpdir(), `k7-refscan-${process.pid}-${Date.now().toString(36)}`);
const ROOT = path.join(TMP, 'ws');
const res = newResults();

const CONFIG = {
  carriers: [
    { name: 'docs', path: 'docs', ext: ['.md'], extraSkipDirs: ['管家报告'] },
    { name: 'skills', path: 'skills', ext: ['.md'] },
    { name: 'persona', path: 'persona', ext: ['.yml'] },
    { name: 'tools', path: 'tools', ext: ['.mjs'] },
  ],
  skipDirs: ['node_modules'],
};

function put(rel, content) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

try {
  put('docs/a.md', '第一行 无关\nalpha 出现两次 alpha\n');
  put('docs/sub/b.md', 'ALPHA 大写也算命中\n');
  put('docs/管家报告/r.md', 'alpha 在被排除目录里\n');
  put('skills/s1/SKILL.md', '技能里提到 alpha\n');
  put('persona/p.yml', 'persona: alpha\n');
  put('tools/t.mjs', '// alpha in tool\n');
  put('tools/skip.mjs.bak', 'alpha 扩展名不匹配，不扫\n');

  const r1 = scanRefs({ root: ROOT, config: CONFIG, keywords: ['alpha'] });
  assertEq(r1.verdict, 'hits', 'A1 有命中 ⇒ verdict=hits', res);
  assertEq(r1.rows.length, 5, 'A2 命中行数 = 5（docs 2 + skills 1 + persona 1 + tools 1）', res);
  assertEq(r1.evidence.totalHits, 6, 'A3 命中次数 = 6（a.md 同一行两次）', res);
  assertEq(r1.evidence.carriers.map((c) => [c.name, c.files, c.hits]), [
    ['docs', 2, 2], ['skills', 1, 1], ['persona', 1, 1], ['tools', 1, 1],
  ], 'A4 每类载体扫了多少文件 / 命中多少行（扫描面证据的底料）', res);
  const aRow = r1.rows.find((x) => x.rel.endsWith('docs/a.md'));
  assertEq([aRow.line, aRow.count], [2, 2], 'A5 行号与同行命中次数都对', res);
  assertTrue(aRow.snippet.includes('alpha'), 'A6 片段带命中原文', res, aRow.snippet);
  assertEq(r1.evidence.excluded.map((e) => [e.dir, e.hits]), [['docs/管家报告', 1]], 'A7 排除目录命中单独计数', res);

  const ev1 = evidenceLine(r1.evidence);
  assertTrue(ev1.startsWith('扫描面证据：载体 4 类'), 'A8 证据行以「扫描面证据」开头（空表也要有）', res, ev1.slice(0, 40));
  assertTrue(ev1.includes('docs 2 文件 / 命中 2'), 'A9 证据行逐类给文件数与命中数', res, ev1);
  assertTrue(ev1.includes('排除目录内另有 1 处命中'), 'A10 证据行声明被排除目录的命中数', res);

  const table1 = renderTable(r1);
  const lines = table1.split('\n');
  assertEq(lines[0], '| # | 载体 | 文件 | 行 | 命中原文片段 | 处置（A/B/C/D） | 理由 |', 'A11 表头含四类处置列', res);
  assertTrue(lines.slice(2).every((l) => l.endsWith('|  |  |')), 'A12 处置列与理由列一律留空（机器不替人判）', res);
  assertTrue(dispositionLegend().includes('C 判定不改'), 'A13 四类处置口径写全', res);

  // 0 命中 ⇒ 判黄
  const r2 = scanRefs({ root: ROOT, config: CONFIG, keywords: ['__nomatch_zzz__'] });
  assertEq(r2.verdict, 'yellow', 'B1 0 命中 ⇒ 判黄（不是 pass）', res);
  assertEq(r2.rows.length, 0, 'B2 空表', res);
  const ev2 = evidenceLine(r2.evidence);
  assertTrue(ev2.startsWith('扫描面证据：'), 'B3 空表也打印扫描面证据行', res, ev2.slice(0, 30));
  assertTrue(ev2.includes('合计 5 文件'), 'B4 空表的证据行仍给出扫了多少文件（docs 2 + skills 1 + persona 1 + tools 1）', res, ev2);
  const table2 = renderTable(r2);
  assertTrue(table2.includes('0 命中：判黄'), 'B5 空表给一句"判黄，先确认扫描面"', res);

  // 大小写
  const r3 = scanRefs({ root: ROOT, config: CONFIG, keywords: ['ALPHA'] });
  assertEq(r3.verdict, 'hits', 'C1 缺省不区分大小写 ⇒ 大写字样也能命中小写词', res);
  const r4 = scanRefs({ root: ROOT, config: CONFIG, keywords: ['ALPHA'], caseSensitive: true });
  assertEq(r4.rows.length, 1, 'C2 区分大小写时只剩 b.md 一处', res);

  // 多个关键词 + 载体不存在
  const r5 = scanRefs({
    root: ROOT,
    config: { carriers: [...CONFIG.carriers, { name: 'nope', path: 'no-such-dir', ext: ['.md'] }], skipDirs: [] },
    keywords: ['alpha', '技能'],
  });
  assertTrue(r5.rows.some((x) => x.keywords.length === 2), 'C3 同一行命中多个关键词时合并计次', res);
  const nope = r5.evidence.carriers.find((c) => c.name === 'nope');
  assertEq([nope.exists, nope.files], [false, 0], 'C4 载体目录不存在 ⇒ 证据里如实写"目录不存在"', res);
  assertTrue(evidenceLine(r5.evidence).includes('nope 目录不存在'), 'C5 证据行不隐瞒缺失载体', res);
} finally {
  rmrf(TMP);
}

finishSelfTest('test-ref-scan', res);
