#!/usr/bin/env node
// check-rootcause.mjs —— 根因回测（成因 → 改进 → 回测 三列；成因表缺项 ⇒ 判本轮回修未完成）
//
// 用法：
//   node check-rootcause.mjs --doc <方案档> --families <族表.json> --fixture <夹具目录>
//   node check-rootcause.mjs --doc <档> --families f.json --fixture dir --json
//   node check-rootcause.mjs --self-test
//
// 族表格式（每条一族）：
//   {"families":[{"id":"F1","名称":"…","成因":"…（机制层：哪条规则缺位 / 判据类型错位 / 载体与判据不同步）",
//                 "改进落点":"第 7 条",                       // 须能在方案档里动态定位到
//                 "fixture":{"tool":"check-selfclaim","args":{…相对夹具目录的路径…}},
//                 "expect":"FAIL"}]}                           // 回测：拿历史实例喂改进后的判据，**必须判不过**
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, argParse, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp } from './lib/common.mjs';
import { runTool } from './lib/dispatch.mjs';

/** 改进落点是否真在方案档里存在（动态定位：条号 `| **N** |` 或节标题或 §N） */
export function locateImprovement(docLines, token) {
  const t = String(token ?? '').trim();
  if (!t) return null;
  const m = /第\s*(\d+)\s*条/.exec(t);
  if (m) {
    const re = new RegExp(`^\\|\\s*\\*\\*${m[1]}\\*\\*\\s*\\|`);
    const i = docLines.findIndex((l) => re.test(l));
    return i < 0 ? null : { line: i + 1, text: docLines[i].trim().slice(0, 70) };
  }
  const s = /§\s*([0-9.]+)/.exec(t);
  if (s) {
    const i = docLines.findIndex((l) => /^#{2,4}\s/.test(l) && l.includes(`§${s[1]}`));
    return i < 0 ? null : { line: i + 1, text: docLines[i].trim().slice(0, 70) };
  }
  const i = docLines.findIndex((l) => l.includes(t));
  return i < 0 ? null : { line: i + 1, text: docLines[i].trim().slice(0, 70) };
}

/** 夹具里的相对路径 → 绝对路径（绝对路径原样保留） */
export function absolutize(obj, base) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    out[k] = (typeof v === 'string' && /\.(md|json|txt|diff)$/i.test(v) && !path.isAbsolute(v)) ? path.join(base, v) : v;
  }
  return out;
}

export async function run({ doc, familiesPath, fixtureDir }) {
  const m = meta(doc);
  const spec = JSON.parse(fs.readFileSync(familiesPath, 'utf8'));
  const families = Array.isArray(spec) ? spec : spec.families;
  const rows = [];
  for (const f of families) {
    const missing = [];
    if (!f.成因 || !String(f.成因).trim()) missing.push('成因');
    if (!f.改进落点) missing.push('改进落点');
    if (!f.fixture?.tool) missing.push('夹具（tool）');
    const improve = locateImprovement(m.lines, f.改进落点);
    if (f.改进落点 && !improve) missing.push('改进落点在方案档内定位不到');
    let back = null;
    if (!missing.length) {
      try {
        back = await runTool(f.fixture.tool, absolutize(f.fixture.args, fixtureDir));
      } catch (e) {
        back = { verdict: 'ERROR', detail: e.message };
        missing.push('夹具执行异常');
      }
    }
    const expect = f.expect ?? 'FAIL';
    const verdict = missing.length ? `❌ 本族回修未完成（缺 ${missing.join(' + ')}）`
      : (back.verdict === expect ? `✅ 回测成立（判 ${back.verdict}）` : `❌ 回测不成立（期望 ${expect}，实际 ${back.verdict}）`);
    rows.push({ ...f, improve, back, expect, missing, verdict });
  }
  const bad = rows.filter((r) => r.verdict.startsWith('❌'));
  return { ok: true, doc: m, rows, bad };
}

export async function report(r) {
  console.log(`档：${r.doc.path}  ·  ${r.doc.gc} 行 · sha16 ${r.doc.sha16}`);
  console.log('');
  console.log('| 族 | 成因（机制层，截 46） | 改进措施（落点 → 方案档实测行） | 回测（工具 → 判定） | 结论 |');
  console.log('|---|---|---|---|---|');
  for (const x of r.rows) {
    const imp = x.improve ? `${x.改进落点} → L${x.improve.line}` : `${x.改进落点 ?? '（缺）'} → 定位不到`;
    const bk = x.back ? `${x.fixture.tool} → ${x.back.verdict}（${x.back.detail ?? ''}）` : '（未执行）';
    console.log(`| ${x.id ?? ''} | ${String(x.成因 ?? '').slice(0, 46)} | ${imp} | ${bk} | ${x.verdict} |`);
  }
  console.log('');
  console.log(`[汇总] 族 ${r.rows.length} · 回测成立 ${r.rows.length - r.bad.length} · 未成立 ${r.bad.length} ⇒ ${r.bad.length === 0 ? 'PASS' : 'FAIL（成因表缺项或缺回测 ⇒ 判本轮回修未完成）'}`);
  return r.bad.length === 0 ? EXIT.OK : EXIT.FAIL;
}

export async function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-rootcause-');
  const fx = path.join(dir, 'fx');
  fs.mkdirSync(fx, { recursive: true });
  const doc = writeTmp(dir, 'doc.md', ['# 假方案档', '', '## §2 条文', '', '| # | 条款 |', '|---|---|', '| **7** | **回修纪律**。 |'].join('\n'));
  const bad = writeTmp(fx, 'bad.md', ['# 第 1 轮回修', '', '甲.md 已改：9 999 B。'].join('\n'));
  const d = writeTmp(fx, 'd.txt', ['--- a/docs/甲.md', '+++ b/docs/甲.md', '@@ -1 +1 @@', '-x', '+y'].join('\n'));
  const families = writeTmp(dir, 'families.json', JSON.stringify({
    families: [
      { id: 'F1', 名称: '自述无实证', 成因: '人写的声明没有回原始证据', 改进落点: '第 7 条', fixture: { tool: 'check-selfclaim', args: { report: 'bad.md', diff: 'd.txt' } }, expect: 'FAIL' },
      { id: 'F2', 名称: '缺成因', 改进落点: '第 7 条', fixture: { tool: 'check-selfclaim', args: { report: 'bad.md', diff: 'd.txt' } }, expect: 'FAIL' },
      { id: 'F3', 名称: '落点定位不到', 成因: 'x', 改进落点: '第 99 条', fixture: { tool: 'check-selfclaim', args: { report: 'bad.md', diff: 'd.txt' } }, expect: 'FAIL' },
    ],
  }, null, 2));
  const r = await run({ doc, familiesPath: families, fixtureDir: fx });
  assertEq(r.rows[0].verdict, '✅ 回测成立（判 FAIL）', '历史实例喂改进后判据 ⇒ 必须判不过 ⇒ 回测成立', res);
  assertEq(r.rows[0].improve.line, 7, '改进落点动态定位到方案档行号', res);
  assertTrue(r.rows[1].verdict.startsWith('❌ 本族回修未完成'), '缺成因 ⇒ 判本轮回修未完成', res, r.rows[1].verdict);
  assertTrue(r.rows[2].verdict.includes('定位不到'), '改进落点在方案档内定位不到 ⇒ 同样判未完成', res, r.rows[2].verdict);
  assertEq(r.bad.length, 2, '两族未成立', res);
  rmrf(dir);
  finishSelfTest('check-rootcause', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'families', 'fixture'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '根因回测（成因 → 改进 → 回测）',
      usage: 'node check-rootcause.mjs --doc <方案档> --families <族表.json> --fixture <夹具目录> [--json]',
      form: ['族 | 成因（截 46） | 改进措施（落点 → 方案档实测行） | 回测（工具 → 判定） | 结论', '[汇总] 族 N · 回测成立 x · 未成立 y'],
      caliber: ['成因表缺任一要素（成因 / 改进落点 / 夹具）⇒ 判本族"回修未完成"，不静默跳过',
        '改进措施须能在方案档里**动态定位**（条号 `第 N 条` / 节 `§N` / 字面），定位不到同样判未完成',
        '回测 = 拿**历史实例或夹具**喂给改进后的判据，**必须判不过**（判过 ⇒ 回测不成立）',
        '调用走 lib/dispatch.mjs 的动态 import（无子进程 / 无管道），与 selfcheck-rerun 用同一张调用表'],
      scope: { docs: '方案档（改进落点）+ 夹具目录（历史实例）', stage: '回修交付阶段', who: '回修方写 + 审核方复跑' },
      exits: ['0 = 全部族回测成立', '3 = 有族未成立 / 成因表缺项', '2 = 用法错'],
      selfTest: 'node check-rootcause.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    await selfTest();
  } else if (!a.doc || !a.families || !a.fixture) {
    console.log('✗ 缺 --doc / --families / --fixture（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else {
    try {
      process.exitCode = await report(await run({ doc: a.doc, familiesPath: a.families, fixtureDir: a.fixture }));
    } catch (e) {
      console.log(`✗ ${e.message}`);
      process.exitCode = EXIT.INTERNAL;
    }
  }
}
