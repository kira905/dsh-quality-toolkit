#!/usr/bin/env node
// check-residue.mjs —— 旧值残留扫描（判定 / 展示分离 · 黑名单由本轮被替换的旧值清单**自动生成**）
//
// 用法：
//   node check-residue.mjs --doc <方案档> --report <回修报告> --snapshot <回修前快照目录>
//   node check-residue.mjs --doc <档> --report <档> --snapshot <目录> --values <补充清单.json> --json
//   node check-residue.mjs --self-test
//
// 口径（写死 · 解第 9 轮 M2 的"自指恒红"）：
//   ① 黑名单 = 从**回修前快照**（<snapshot>\before\*.md）自动收割的旧值（sha16 / 重计数累计 N 次），**不是手工枚举**；
//   ② **判定面** = 方案档里**非豁免行**含"旧 sha16" ⇒ 判红（FAIL）；
//   ③ **展示面** = 行数 / 字节 / 计数类旧值命中 + 报告档的全部命中 ⇒ **只列出、不判红**
//      （命中列表本身不作为待核文本 ⇒ 不再出现"要求 0 命中却必须列出旧值"的自指矛盾）；
//   ④ 豁免行（= 展示面）判据：含「订正注 / 订正说明」· 位于 §8 修订记录或 §9.1 版本保全自证内 ·
//      含「快照 / before / STAMP」· 位于档头引述块内（首个 `## ` 之前）· 含「送审件 / 上一版 / 旧值 / 历史 / 实测」。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, argParse, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp, makeExemptFn } from './lib/common.mjs';

const SHA16_RE = /(?<![0-9A-Fa-f])[0-9A-F]{16}(?![0-9A-Fa-f])/g;
const COUNT_RE = /重计数累计\s*\*{0,2}(\d+)\s*次/g;
const NUMFAM_RE = /(\d[\d\s]{0,8}?)\s*(行\(GC\)|行|B|次)(?![0-9])/g;

export function harvest(snapshotDir, extraValuesPath) {
  const values = new Set();
  const numbers = new Set();
  const baddir = path.join(snapshotDir, 'before');
  const dir = fs.existsSync(baddir) ? baddir : snapshotDir;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of t.matchAll(SHA16_RE)) values.add(m[0].toUpperCase());
    for (const m of t.matchAll(COUNT_RE)) numbers.add(`${m[1]} 次`);
    for (const m of t.matchAll(NUMFAM_RE)) numbers.add(`${m[1].replace(/\s+/g, ' ').trim()} ${m[2].replace(/\(GC\)/, '')}`);
  }
  if (extraValuesPath && fs.existsSync(extraValuesPath)) {
    const j = JSON.parse(fs.readFileSync(extraValuesPath, 'utf8'));
    for (const v of (j.values ?? [])) values.add(String(v).toUpperCase());
    for (const v of (j.numbers ?? [])) numbers.add(String(v));
  }
  return { values: [...values], numbers: [...numbers], from: dir };
}

/** 档头引述块 = 首个 `## ` 标题之前的行（判据见 lib/common.mjs#makeExemptFn） */
export function scanFile(p, values, numbers, { judgementFace }) {
  const m = meta(p);
  const exemptOf = makeExemptFn(m.lines);
  const hits = { judge: [], show: [] };
  for (let i = 0; i < m.lines.length; i++) {
    const line = m.lines[i];
    const exempt = exemptOf(i);
    for (const v of values) {
      if (line.toUpperCase().includes(v)) {
        const rec = { line: i + 1, value: v, kind: 'sha16', text: line.trim().slice(0, 70) };
        (judgementFace && !exempt ? hits.judge : hits.show).push(rec);
      }
    }
    for (const n of numbers) {
      if (line.includes(n)) hits.show.push({ line: i + 1, value: n, kind: 'num', text: line.trim().slice(0, 70) });
    }
  }
  return { meta: m, hits };
}

export function run({ doc, report, snapshot, valuesPath }) {
  const bl = harvest(snapshot, valuesPath);
  const d = scanFile(doc, bl.values, bl.numbers, { judgementFace: true });
  const r = scanFile(report, bl.values, bl.numbers, { judgementFace: false });
  return { ok: true, blacklist: bl, doc: d, report: r };
}

export function report(r) {
  console.log(`黑名单来源：${r.blacklist.from}（自动收割）`);
  console.log(`  旧 sha16 ${r.blacklist.values.length} 个：${r.blacklist.values.join(' ')}`);
  console.log(`  旧数字族 ${r.blacklist.numbers.length} 个：${r.blacklist.numbers.slice(0, 12).join(' / ')}${r.blacklist.numbers.length > 12 ? ' …' : ''}`);
  console.log('');
  console.log('—— 展示面（**本列表不作为待核文本**；命中列表本身就是"扫过"的证据）——');
  console.log(`方案档 ${r.doc.meta.gc} 行 · sha16 ${r.doc.meta.sha16}：展示命中 ${r.doc.hits.show.length} 处`);
  for (const h of r.doc.hits.show.slice(0, 10)) console.log(`  L${h.line} [${h.kind} ${h.value}] ${h.text}`);
  if (r.doc.hits.show.length > 10) console.log(`  … 其余 ${r.doc.hits.show.length - 10} 处略`);
  console.log(`报告档 ${r.report.meta.gc} 行 · sha16 ${r.report.meta.sha16}：展示命中 ${r.report.hits.show.length} 处（报告档全表属展示面）`);
  for (const h of r.report.hits.show.slice(0, 6)) console.log(`  L${h.line} [${h.kind} ${h.value}] ${h.text}`);
  if (r.report.hits.show.length > 6) console.log(`  … 其余 ${r.report.hits.show.length - 6} 处略`);
  console.log('');
  console.log('—— 判定面（方案档非豁免行 × 旧 sha16）——');
  if (r.doc.hits.judge.length === 0) console.log('  0 处 ⇒ PASS');
  else for (const h of r.doc.hits.judge) console.log(`  ❌ L${h.line} [${h.value}] ${h.text}`);
  const bad = r.doc.hits.judge.length;
  console.log(`[汇总] 判定面命中 ${bad} · 展示面 ${r.doc.hits.show.length + r.report.hits.show.length} ⇒ ${bad === 0 ? 'PASS' : 'FAIL'}`);
  return bad === 0 ? EXIT.OK : EXIT.FAIL;
}

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-residue-');
  const snap = path.join(dir, 'snap');
  fs.mkdirSync(path.join(snap, 'before'), { recursive: true });
  fs.writeFileSync(path.join(snap, 'before', 'old.md'), '旧 sha16 AAAA1111BBBB2222 · 重计数累计 5 次 · 257 行 · 39 532 B\n', 'utf8');
  fs.writeFileSync(path.join(snap, 'SHA256.txt'), 'x', 'utf8');
  const doc = writeTmp(dir, 'doc.md', [
    '# 假方案档',
    '',
    '普通行引用了旧 sha16 AAAA1111BBBB2222 ⇒ 该判红',   // 非豁免 ⇒ 判定面
    '⚠️ 订正注：旧值 AAAA1111BBBB2222 ⇒ 新值 CCCC3333DDDD4444', // 豁免 ⇒ 展示面
  ].join('\n'));
  const rep = writeTmp(dir, 'report.md', ['# 第 1 轮回修', '本报告提到旧 sha16 AAAA1111BBBB2222（展示面，不判红）'].join('\n'));
  const bl = harvest(snap);
  assertTrue(bl.values.includes('AAAA1111BBBB2222'), '黑名单从快照 before 自动收割 sha16', res, JSON.stringify(bl));
  assertTrue(bl.numbers.includes('5 次'), '黑名单自动收割「重计数累计 N 次」', res, JSON.stringify(bl.numbers));
  const r = run({ doc, report: rep, snapshot: snap });
  assertEq(r.doc.hits.judge.length, 1, '非豁免行 × 旧 sha16 ⇒ 判定面 1 处（判红）', res);
  assertTrue(r.doc.hits.show.length >= 1, '订正注行 ⇒ 归展示面（不自指恒红）', res);
  const clean = writeTmp(dir, 'clean.md', '# 干净档\n\n本档不含任何旧值。\n');
  const r2 = run({ doc: clean, report: clean, snapshot: snap });
  assertEq(r2.doc.hits.judge.length, 0, '干净档 ⇒ 判定面 0 ⇒ PASS', res);
  rmrf(dir);
  finishSelfTest('check-residue', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'report', 'snapshot', 'values'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '旧值残留扫描（第 7 条④ · 判定 / 展示分离）',
      usage: 'node check-residue.mjs --doc <方案档> --report <回修报告> --snapshot <回修前快照目录> [--values <补充清单.json>] [--json]',
      form: ['黑名单来源 + 自动收割到的旧 sha16 / 旧数字族',
        '展示面：逐处列出命中（方案档 + 报告档；**本列表不作为待核文本**）',
        '判定面：方案档**非豁免行** × 旧 sha16 的命中（0 ⇒ PASS）',
        '[汇总] 判定面命中 N · 展示面 M'],
      caliber: ['黑名单**由回修前快照的 before 档自动收割**（sha16 / 重计数累计 N 次 / 数字族），禁手工枚举',
        '判定面只判 sha16（数字族 / 计数类只进展示面 ⇒ 避免"合法引用历史实测值"被误判）',
        '豁免行（= 展示面）判据：含订正注 / §8 修订记录内 / §9.1 内 / 含快照·before·STAMP / 档头引述块内 / 含送审件·上一版·旧值·历史·实测',
        '**射程例外**：回修报告整档属展示面（它的体例就要求列旧值）⇒ 解第 9 轮 M2 的"自指恒红"'],
      scope: { docs: '方案档（判定面）+ 回修报告（展示面）', stage: '回修交付阶段', who: '回修方' },
      exits: ['0 = 判定面 0 命中', '3 = 判定面有残留', '2 = 用法错 / 快照不可读'],
      selfTest: 'node check-residue.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    selfTest();
  } else if (!a.doc || !a.report || !a.snapshot) {
    console.log('✗ 缺 --doc / --report / --snapshot（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else if (!fs.existsSync(a.snapshot)) {
    console.log(`✗ 快照目录不存在：${a.snapshot}`);
    process.exitCode = EXIT.USAGE;
  } else {
    process.exitCode = report(run({ doc: a.doc, report: a.report, snapshot: a.snapshot, valuesPath: a.values }));
  }
}
