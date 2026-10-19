#!/usr/bin/env node
// scan-four.mjs —— 文档纪律四扫（**薄封装**既有 <DSH_ROOT>\tools\docs-consistency-scan.mjs）
//
// 用法：
//   node scan-four.mjs --doc <档> [--defs 4.4,5,8] [--lists 5,8,12]
//   node scan-four.mjs --doc <档> --json
//   node scan-four.mjs --self-test
//
// 口径（写死 · 第 9 条）：
//   ① **档位恒 `report`（只报不拦）**：本包装器 **永远以 0 退出**，命中数**不作**收敛 / 验收判据；
//      （被包装的四扫脚本本体可保留 3 供人工诊断 —— 那是"工具口味"，不是"门"。）
//   ② 本包装器**不含任何阻断 / 回滚调用**（无 unlink / rename / copyFile / taskkill / 杀进程），自测里直接扫源码断言；
//   ③ 封装理由：把四扫从"随手跑一次"升级成**可被索引行引用、可被 selfcheck-rerun 复跑**的一项判据。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT, argParse, helpBlock, isMain, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp } from './lib/common.mjs';

export const DOC_SCAN_MODE = 'report';
const SCAN_TOOL = fileURLToPath(new URL('../docs-consistency-scan.mjs', import.meta.url));

export function runFour({ doc, defs, lists, ignoreOwnHeadings, allowDocPrefix }) {
  if (!fs.existsSync(SCAN_TOOL)) return { ok: false, error: `被封装工具不存在：${SCAN_TOOL}` };
  const args = [SCAN_TOOL, doc, '--json'];
  if (defs) args.push('--defs', defs);
  if (lists) args.push('--lists', lists);
  // 两个容差开关（2026-09-24 落地②）**原样透传**给被封装工具 —— 包装器不自造口径。
  if (ignoreOwnHeadings) args.push('--ignore-own-headings');
  if (Number.isInteger(allowDocPrefix) && allowDocPrefix > 0) args.push('--allow-doc-prefix', String(allowDocPrefix));
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 解析失败见下 */ }
  if (!j) return { ok: false, error: `被封装工具输出非 JSON（exit=${r.status}）`, stderr: (r.stderr ?? '').slice(0, 400) };
  const hits = { r1: j.r1?.length ?? 0, r1b: j.r1b?.length ?? 0, r1c: j.r1c?.length ?? 0, r1d: j.r1d?.length ?? 0, r2: j.r2?.length ?? 0, r3: j.r3?.length ?? 0, r4: j.r4?.length ?? 0 };
  return { ok: true, doc, toolExit: r.status, json: j, hits };
}

export function reportFour(res) {
  console.log(`DOC_SCAN_MODE = '${DOC_SCAN_MODE}'   （恒只报不拦；命中数不作收敛判据）`);
  if (!res.ok) { console.log(`⚠️ ${res.error}${res.stderr ? `\n${res.stderr}` : ''}`); return EXIT.OK; }
  const h = res.hits;
  const total = h.r1 + h.r2 + h.r3 + h.r4;
  console.log(`档：${res.doc}  ·  ${res.json.lines} 行 / ${res.json.bytes} B / ${res.json.sections} 节`);
  console.log(`①跨节引用死链 r1 = ${h.r1}（带文档前缀的跨档引用另计 r1b = ${h.r1b}；按容差跳过：节标题自指 r1c = ${h.r1c} / 未写档名 r1d = ${h.r1d}）· ②字段定义 r2 = ${h.r2} · ③阈值一致性 r3 = ${h.r3} · ④清单覆盖 r4 = ${h.r4}`);
  console.log(`被封装工具自身退出码 = ${res.toolExit}（3 = 有命中，属"工具口味"）· 本包装器退出码恒 0`);
  console.log(`[汇总] 命中合计 ${total} ⇒ 只报不拦（人工抽样确认；②③④带启发式，不是结论）`);
  return EXIT.OK;
}

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-scanfour-');
  const doc = writeTmp(dir, 'fixture.md', [
    '# 假档 1.0',
    '',
    '## 1.1 节',
    '',
    '见 §9.9（本档不存在的节 ⇒ 应命中 r1）',
    '',
    '## 1.2 节',
    '',
    '阈值 = 30 分钟',
    '阈值 = 45 分钟（同词多值 ⇒ 可能命中 r3）',
  ].join('\n'));
  const src = fs.readFileSync(new URL('./scan-four.mjs', import.meta.url).href.replace(/^file:\/\/\//, ''), 'utf8');
  assertTrue(DOC_SCAN_MODE === 'report', "DOC_SCAN_MODE 显式常量为 'report'", res);
  // 自指规避：禁用词拆开拼，免得"检查串"自己出现在源码里把断言判红（第 9 轮 M2 同款自指坑）
  // 只扫**包装主路径**（selfTest 段之前）——自测里的临时目录清理不属"对目标档的阻断 / 回滚"
  const FORBIDDEN = ['unlink' + 'Sync', 'rm' + 'Sync', 'rename' + 'Sync', 'copyFile' + 'Sync', 'task' + 'kill', 'process.exit' + '('];
  const mainPath = src.split('export function selfTest')[0]
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');   // 去注释行（注释里会写禁用词的名字）
  const hit = FORBIDDEN.find((t) => mainPath.includes(t));
  assertTrue(!hit, '包装主路径无阻断 / 回滚 / 强退调用', res, hit ? `命中禁用词 ${hit}` : '');
  const r = runFour({ doc });
  assertTrue(r.ok, '被封装四扫可跑通并返回 JSON', res, JSON.stringify(r.error ?? r.hits));
  assertEq(reportFour(r), 0, '命中数任意 ⇒ 包装器仍以 0 退出（恒 report）', res);
  assertTrue(r.hits.r1 >= 1, '死链样本确实被 ① 扫命中（证明封装真的在跑）', res, JSON.stringify(r.hits));
  // ── 2026-09-24 落地② 新增：节解析认 `§N` + 两个容差开关**真透传**（包装器不吞参数）──
  const doc2 = writeTmp(dir, 'fixture2.md', [
    '# 假档 2.0（§ 体例）',
    '',
    '## §3 章节',
    '',
    '见 §3（本节存在 ⇒ 不该命中）',
    '',
    '## 3.1 小节（裸序号体例）',
    '',
    '见 §9.9（本档不存在 ⇒ 应命中）',
  ].join('\n'));
  const r2 = runFour({ doc: doc2 });
  assertTrue(r2.ok, '§ 体例档可跑通', res, JSON.stringify(r2.error ?? ''));
  assertEq(r2.hits.r1, 1, '节解析认 §N：§3 视为存在 ⇒ 只剩 §9.9 一条死链', res);
  const r2b = runFour({ doc: doc2, allowDocPrefix: 1 });
  assertEq(r2b.hits.r1, 0, '--allow-doc-prefix 1：前 1 处未写档名的跨档引用不计命中', res);
  assertEq(r2b.hits.r1d, 1, '--allow-doc-prefix：被容差那处改记 r1d（留痕，不静默）', res);
  const doc3 = writeTmp(dir, 'fixture3.md', [
    '# 假档 3.0（标题自指）',
    '',
    '## 3.1 见 §8.8（标题行自指；本档没有 8.8 节）',
    '',
  ].join('\n'));
  const r3a = runFour({ doc: doc3 });
  const r3b = runFour({ doc: doc3, ignoreOwnHeadings: true });
  assertEq(r3a.hits.r1, 1, '未开 --ignore-own-headings：节标题行自指照旧命中', res);
  assertEq(r3b.hits.r1, 0, '--ignore-own-headings：节标题行自指不计命中', res);
  assertEq(r3b.hits.r1c, 1, '--ignore-own-headings：命中改记 r1c（留痕，不静默）', res);
  rmrf(dir);
  finishSelfTest('scan-four', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'defs', 'lists', 'allow-doc-prefix'], flags: ['ignore-own-headings'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '文档纪律四扫（第 9 条 · 机器门恒 report）',
      usage: 'node scan-four.mjs --doc <档> [--defs 4.4,5,8] [--lists 5,8,12] [--ignore-own-headings] [--allow-doc-prefix N] [--json]',
      form: ['DOC_SCAN_MODE = \'report\'（显式常量）', '档路径 · 行数 / 字节 / 节数', '①r1 / ①r1b（+ 容差跳过 r1c / r1d）/ ②r2 / ③r3 / ④r4 命中数 + 被封装工具自身退出码', '[汇总] 命中合计 ⇒ 只报不拦'],
      caliber: ['**薄封装** <DSH_ROOT>\\tools\\docs-consistency-scan.mjs（spawnSync + --json），不复制它的扫描逻辑',
        '本包装器**恒以 0 退出**；命中数不作收敛 / 验收判据（第 9 条①）',
        '本包装器不含阻断 / 回滚调用（自测直接扫源码断言）',
        '两个容差开关 `--ignore-own-headings` / `--allow-doc-prefix <N>` **原样透传**给被封装工具（包装器不自造口径）；语义与阈值口径见被封装脚本头部与 tools\\docs-discipline\\README.md'],
      scope: { docs: '任何 md 档（人工诊断面）；部署上接入日报段时恒 report', stage: '写入后 / 收尾诊断', who: '人工诊断 + 日报段（机器门）' },
      exits: ['0 = 永远（含"有命中"与"工具不可读"）', '2 = 用法错'],
      selfTest: 'node scan-four.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    selfTest();
  } else if (!a.doc) {
    console.log('✗ 缺 --doc（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else {
    const allow = a['allow-doc-prefix'] === undefined ? 0 : Number(a['allow-doc-prefix']);
    if (!Number.isInteger(allow) || allow < 0) {
      console.log('✗ --allow-doc-prefix 需要 ≥0 的整数（--help 看用法）');
      process.exitCode = EXIT.USAGE;
    } else {
      process.exitCode = reportFour(runFour({
        doc: a.doc, defs: a.defs, lists: a.lists,
        ignoreOwnHeadings: a['ignore-own-headings'] === true, allowDocPrefix: allow,
      }));
    }
  }
}
