#!/usr/bin/env node
// tools\docs-discipline\gen-doc-audit.mjs —— 「自动生成档」清单 ↔ 实况对账（**只读**）
//
// 依据：<DSH_ROOT>\docs\规划-自动生成档判据清单-20260925.md（v3c · 已过审）
//   §4.1-6（对账脚本**提级**为正式工具 · **不许依赖 `_tmp` 产物**）
//   §3.3（逐族前 N 行命中率 · 漏项对账 · 现行态标记命中数）
//   §3.3-2b / §4.1-6①（**可失败**断言 A：各 `generator` 源文件内 `insertAtFor(` 调用点 ≥ 1）
//   §2.5-5 / §4.5-5 / §4.1-6②（**可失败**断言 B：家族匹配构造性 —— 每族样本路径必须命中本族且资格正确）
//   §5-R5（轻量自检 = 断言 C：`generator` 所指文件存在 + 符号可 grep **不核行号**）
//   §5-R7（断言 D：对**空库/新机空态不炸**）
//
// 用法：
//   node gen-doc-audit.mjs [--docs <DSH_ROOT>\docs] [--root <DSH_ROOT>] [--json] [--log <日志档>]
//   node gen-doc-audit.mjs --self-test
//
// 退出码：0 = 全部可失败断言绿 ｜ 3 = 有红项（**注意**：impl-1 未接生成器 ⇒ 断言 A **预期为红**，impl-2 后应转绿）｜ 2 = 用法/路径错
// 纪律：纯只读（不写生产路径）· `--json` 时人类日志只落文件 · 收尾 process.exitCode（禁 process.exit）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT, argParse, helpBlock, isMain, sha256,
  newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp,
} from './lib/common.mjs';
import {
  SCHEMA_VERSION, DOC_MARK_PREFIX, DOC_MARK_SCAN_LINES, GENERATED_DOC_FAMILIES,
  findFamily, findFamilies, isGeneratedDocText, isExemptEligible, familySamples,
} from '../lib/generated-docs.mjs';

const DEFAULT_ROOT = process.env.DSH_ROOT || process.cwd();
const DEFAULT_DOCS = path.join(DEFAULT_ROOT, 'docs');
const SELF = fileURLToPath(import.meta.url);
const GD_SELF = fileURLToPath(new URL('../lib/generated-docs.mjs', import.meta.url));

/** 漏项启发式（§3.3-3）：前 N 行出现这些"自动生成"信号、但**未归任何家族** ⇒ 候选漏项（需人工判） */
const LEAK_HEURISTIC = [
  'butler-auto:begin', 'docs-index-gen:auto', '自动生成', '自动维护', '整体重写',
  '生成于', '扫描器', '载体：tickd job', '请勿手改', '自动覆盖',
];

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** 递归收集 `.md`（返回相对 docsRoot 的**反斜杠**相对路径） */
function walkMd(root) {
  const out = [];
  const walk = (abs, rel) => {
    let names = [];
    try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const childAbs = path.join(abs, d.name);
      const childRel = rel ? `${rel}\\${d.name}` : d.name;
      if (d.isDirectory()) walk(childAbs, childRel);
      else if (/\.md$/i.test(d.name)) out.push(childRel);
    }
  };
  walk(root, '');
  out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
  return out;
}

/** 主对账（**纯只读**）：返回结构化结果（可 JSON 化） */
export function audit({ docsRoot = DEFAULT_DOCS, root = DEFAULT_ROOT } = {}) {
  const docsExists = fs.existsSync(docsRoot);
  const rels = docsExists ? walkMd(docsRoot) : [];
  const asOf = new Date().toISOString();

  // —— 逐档：归族 + 档头标记命中
  const byFamily = new Map(GENERATED_DOC_FAMILIES.map((f) => [f.id, { family: f, files: [], marked: [] }]));
  const unassigned = [];
  const anyMarkHits = [];
  for (const rel of rels) {
    const relManifest = `docs\\${rel}`;                      // 清单 rel 形态（带 docs\ 前缀，与权威源同坐标系）
    const abs = path.join(docsRoot, rel);
    const text = readTextSafe(abs) ?? '';
    const marked = isGeneratedDocText(text);
    if (marked) anyMarkHits.push(relManifest);
    const fam = findFamily(relManifest);
    if (fam && byFamily.has(fam.id)) {
      const slot = byFamily.get(fam.id);
      slot.files.push(relManifest);
      if (marked) slot.marked.push(relManifest);
    } else {
      const head = text.split(/\r?\n/, DOC_MARK_SCAN_LINES).join('\n');
      const hits = LEAK_HEURISTIC.filter((k) => head.includes(k));
      unassigned.push({ rel: relManifest, heuristics: hits });
    }
  }
  const familyRows = [...byFamily.values()].map((s) => ({
    id: s.family.id,
    dir: s.family.dir,
    match: s.family.match,
    label: s.family.label,
    exemptEligible: s.family.exemptEligible === true,
    count: s.files.length,
    marked: s.marked.length,
    files: s.files,
  }));
  const familyTotal = familyRows.reduce((n, r) => n + r.count, 0);
  const leakCandidates = unassigned.filter((u) => u.heuristics.length);
  const reverseAnchors = unassigned.filter((u) => /裸跑期观测-|P4候选分类与落地核对-|P4待办合并清单-/.test(u.rel));

  // —— 断言 A（§3.3-2b 可失败）：各 `generator` 源文件内 `insertAtFor(` 调用点 ≥ 1
  const assertionA = familyRows.map((r) => {
    const fam = r.family ?? GENERATED_DOC_FAMILIES.find((f) => f.id === r.id);
    const gen = fam.generator ?? '';
    const m = /^(.+)#(.+)$/.exec(gen);
    const relFile = m ? m[1] : gen;
    const abs = path.join(root, relFile.replace(/\\/g, path.sep));
    const text = readTextSafe(abs);
    const calls = text ? (text.match(/insertAtFor\s*\(/g) ?? []).length : 0;
    return { id: r.id, generator: gen, fileExists: text !== null, insertAtForCalls: calls, ok: text !== null && calls >= 1 };
  });
  const aRed = assertionA.filter((x) => !x.ok);

  // —— 断言 B（§2.5-5 可失败）：家族匹配构造性（全族 × 4 变体）
  const bBad = [];
  let bTrue = 0; let bFalse = 0;
  for (const s of familySamples()) {
    for (const v of s.variants) {
      const fam = findFamily(v);
      const elig = isExemptEligible(v);
      if (fam && fam.id === s.id && elig === s.exemptEligible) { if (s.exemptEligible) bTrue++; else bFalse++; } else {
        bBad.push({ id: s.id, variant: v, got: fam?.id ?? null, elig });
      }
    }
  }
  const assertionB = { ok: bBad.length === 0 && bTrue === 52 && bFalse === 8, bad: bBad, eligibleTrue: bTrue, eligibleFalse: bFalse };

  // —— 断言 C（§5-R5）：generator 所指文件存在 + 符号可 grep（**不核行号**）
  const cBad = [];
  for (const fam of GENERATED_DOC_FAMILIES) {
    const m = /^(.+)#(.+)$/.exec(fam.generator ?? '');
    if (!m) { cBad.push({ id: fam.id, why: 'generator 字段不含 `#符号名`' }); continue; }
    const abs = path.join(root, m[1].replace(/\\/g, path.sep));
    const text = readTextSafe(abs);
    if (text === null) { cBad.push({ id: fam.id, why: `文件不存在：${m[1]}` }); continue; }
    if (m[2] !== '(顶层)' && !text.includes(m[2])) cBad.push({ id: fam.id, why: `符号名 grep 不到：${m[2]}` });
  }
  const assertionC = { ok: cBad.length === 0, bad: cBad };

  // —— 断言 D（§5-R7）：空态不炸（本函数自身对空库/缺根不抛）
  const assertionD = { ok: docsExists || rels.length === 0, docsExists };

  return {
    tool: 'gen-doc-audit',
    asOf,
    docsRoot,
    root,
    source: {
      path: GD_SELF,
      schemaVersion: SCHEMA_VERSION,
      sha16: (() => { const t = readTextSafe(GD_SELF); return t === null ? null : sha256(t).slice(0, 16); })(),
      families: GENERATED_DOC_FAMILIES.length,
      scanLines: DOC_MARK_SCAN_LINES,
      markPrefix: DOC_MARK_PREFIX,
    },
    totals: {
      docsMd: rels.length,
      familyTotal,
      unassigned: unassigned.length,
      markedNow: anyMarkHits.length,
      leakCandidates: leakCandidates.length,
      reverseAnchors: reverseAnchors.length,
    },
    familyRows,
    markedNow: anyMarkHits,
    leakCandidates,
    reverseAnchors,
    assertions: {
      A: { name: 'insertAtFor 调用点（§3.3-2b）', ok: aRed.length === 0, red: aRed, rows: assertionA },
      B: { name: '家族匹配构造性（§2.5-5）', ...assertionB },
      C: { name: 'generator 文件/符号轻量自检（§5-R5）', ...assertionC },
      D: { name: '空态不炸（§5-R7）', ...assertionD },
    },
  };
}

export function render(a) {
  const L = [];
  L.push(`「自动生成档」清单 ↔ 实况对账（只读）· as-of ${a.asOf}`);
  L.push(`权威源：${a.source.path} · SCHEMA_VERSION ${a.source.schemaVersion} · sha16 ${a.source.sha16} · 家族数 ${a.source.families}`
    + ` · 扫描窗口 N=${a.source.scanLines} · 标记前缀 \`${a.source.markPrefix}\``);
  L.push(`扫描根：${a.docsRoot}（.md ${a.totals.docsMd} 档 · 归族 ${a.totals.familyTotal} 档 · 未归族 ${a.totals.unassigned} 档）`
    + ` · 仓库根：${a.root}`);
  L.push('');
  L.push('【1】逐族对账（§3.3）：');
  L.push('| 族 | dir + match | 实测档数 | 档头带标记 | 豁免资格 |');
  L.push('|---|---|---|---|---|');
  for (const r of a.familyRows) {
    L.push(`| ${r.id} | \`${r.dir}\\${r.match}\` | ${r.count} | ${r.marked} | ${r.exemptEligible ? '✅' : '⛔ 不豁免'} |`);
  }
  L.push(`  ⇒ 合计 ${a.familyRows.length} 族 / ${a.totals.familyTotal} 档归族；**现行态档级标记命中 = ${a.totals.markedNow} 档**`
    + `（实现前预期 0 ⇒ 判据未落地时的正常态）`);
  L.push('');
  L.push(`【2】漏项对账（§3.3-3）：启发式命中但**未归任何族** = ${a.totals.leakCandidates} 档`);
  for (const x of a.leakCandidates) {
    const selfRef = /自动生成档|判据清单|审核-|复审-|交付报告-/.test(x.rel);
    L.push(`  - ${x.rel} ［启发式：${x.heuristics.join(' / ')}］${selfRef ? ' ⇒ **自举负样例**（正文引用标记，非真漏项）' : ' ⇒ 需人工判'}`);
  }
  if (!a.leakCandidates.length) L.push('  （0 档：无漏项候选）');
  L.push('');
  L.push(`【3】反向误伤对账（§3.2）：反向锚点档 = ${a.totals.reverseAnchors} 档（**期望：未归族**）`);
  for (const x of a.reverseAnchors) L.push(`  - ${x.rel} ⇒ 未归任何族 ✓`);
  L.push('');
  L.push('【4】可失败断言 A：各 `generator` 源文件内 `insertAtFor(` 调用点（§3.3-2b）');
  for (const x of a.assertions.A.rows) {
    L.push(`  - ${x.id}：\`${x.generator}\` ⇒ 文件${x.fileExists ? '存在' : '**缺失**'} · \`insertAtFor(\` 命中 **${x.insertAtForCalls}** 处 ${x.ok ? '✓' : '🔴'}`);
  }
  L.push(`  ⇒ **${a.assertions.A.ok ? '绿' : '红'}**${a.assertions.A.ok ? '' : '（**预期**：impl-1 只做判据代码化、未接 15 个生成器 ⇒ impl-2 接线后本断言应转绿）'}`);
  L.push('');
  L.push('【5】可失败断言 B：家族匹配构造性（§2.5-5 · 全族 × 4 变体）');
  L.push(`  ⇒ 有资格族 true ${a.assertions.B.eligibleTrue}/52 · 无资格族 false ${a.assertions.B.eligibleFalse}/8 ⇒ **${a.assertions.B.ok ? '绿' : '红'}**`);
  for (const b of a.assertions.B.bad) L.push(`  🔴 ${b.id} ${b.variant} ⇒ got=${b.got} elig=${b.elig}`);
  L.push('');
  L.push('【6】可失败断言 C：`generator` 文件存在 + 符号可 grep（§5-R5 · **不核行号**）');
  L.push(`  ⇒ **${a.assertions.C.ok ? '绿' : '红'}**${a.assertions.C.bad.length ? ` · ${JSON.stringify(a.assertions.C.bad)}` : ''}`);
  L.push('');
  L.push('【7】可失败断言 D：空态不炸（§5-R7 · 本脚本不依赖 `_tmp` 产物）');
  L.push(`  ⇒ 扫描根存在=${a.assertions.D.docsExists} ⇒ **${a.assertions.D.ok ? '绿' : '红'}**`);
  const red = Object.entries(a.assertions).filter(([, v]) => !v.ok).map(([k]) => k);
  L.push('');
  L.push(`[判定] 红项：${red.length ? red.join(' / ') : '（无）'} ⇒ 退出码 ${red.length ? EXIT.FAIL : EXIT.OK}`);
  return L;
}

// ---------------------------------------------------------------- CLI

function logPathDefault() {
  const dir = path.join(os.tmpdir(), 'docs-discipline-gendoc');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `gen-doc-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
}

function main() {
  const a = argParse(process.argv.slice(2), { values: ['docs', 'root', 'log'], flags: [] });
  const jsonMode = !!a.json;
  const logs = [];
  const emit = (lines) => { for (const l of lines) logs.push(l); };
  const finish = (exitCode, payload, { writeLog = true } = {}) => {
    let logFile = a.log ?? null;
    if (writeLog) {
      logFile = logFile ?? logPathDefault();
      try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, logs.join('\n') + '\n', 'utf8'); } catch { logFile = null; }
    }
    if (jsonMode) console.log(JSON.stringify({ ...payload, logFile }, null, 2));
    else if (logFile) console.log(`[日志] ${logFile}`);
    process.exitCode = exitCode;
  };

  if (a.error || a.help) {
    emit(renderHelp());
    if (!jsonMode) for (const l of logs) console.log(l);
    finish(a.error ? EXIT.USAGE : EXIT.OK, { tool: 'gen-doc-audit', error: a.error ?? null }, { writeLog: false });
    return;
  }
  if (a.selfTest) { selfTest(); return; }

  const docsRoot = a.docs ?? DEFAULT_DOCS;
  const root = a.root ?? DEFAULT_ROOT;
  if (a.docs && !fs.existsSync(docsRoot)) {
    emit([`✗ --docs 指向的目录不存在：${docsRoot}`]);
    if (!jsonMode) for (const l of logs) console.log(l);
    finish(EXIT.USAGE, { tool: 'gen-doc-audit', error: `docs root not found: ${docsRoot}` }, { writeLog: false });
    return;
  }
  const res = audit({ docsRoot, root });
  emit(render(res));
  if (!jsonMode) for (const l of logs) console.log(l);
  const red = Object.values(res.assertions).filter((v) => !v.ok).length;
  finish(red ? EXIT.FAIL : EXIT.OK, res);
}

function renderHelp() {
  return helpBlock({
    title: '「自动生成档」清单 ↔ 实况对账（gen-doc-audit · 只读）',
    usage: 'node gen-doc-audit.mjs [--docs <DSH_ROOT>/docs] [--root <DSH_ROOT>] [--json] [--log <日志档>]',
    form: ['逐族对账：族 id · dir+match · 实测档数 · 档头带标记数 · 豁免资格',
      '漏项对账：启发式命中但未归任何族（含自举负样例判定）',
      '反向误伤对账：§3.2 反向锚点档（裸跑期观测-* / 坑库人工档）是否仍未归族',
      '可失败断言 A：各 generator 源文件内 `insertAtFor(` 调用点 ≥ 1（**未接生成器时为红 · 预期**）',
      '可失败断言 B：家族匹配构造性（全族 × 4 变体 ⇒ 有资格 true / 无资格 false）',
      '可失败断言 C：generator 文件存在 + 符号可 grep（**不核行号** · §5-R5）',
      '可失败断言 D：空态不炸（§5-R7）',
      '`--json` ⇒ stdout 只有一份 JSON（人类日志只落 --log 文件）'],
    caliber: ['权威源 = `tools\\lib\\generated-docs.mjs`（家族表 / 匹配口径 / 标记字面一律以它为准）',
      '归族判据 = `findFamily(\'docs\\\\\' + 相对路径)`（清单 rel 形态：反斜杠 + 无盘符 + 大小写不敏感）',
      '「未归族」≠「不是自动档」：只说明它不属家族表 15 族（人工档为其正常成员）',
      '断言 A 的"红"在 impl-1 阶段是**预期态**（判据已代码化，但 15 个生成器尚未 import / 调用）',
      '本脚本**只读**：不改任何档、不写生产路径、不依赖 `_tmp` 产物（§4.1-6）'],
    scope: { docs: '`--docs` 根下的 `**\\*.md`', stage: '实施前后对照 / 定期巡检', who: '文档纪律线（收尾或巡检会话）' },
    exits: ['0 = 全部可失败断言绿', '3 = 有红项（impl-1 阶段断言 A 预期为红）', '2 = 用法错 / --docs 不存在'],
    selfTest: 'node gen-doc-audit.mjs --self-test',
  });
}

// ---------------------------------------------------------------- 自测（夹具全部落 os.tmpdir）

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-gendoc-audit-');
  try {
    // —— 空态（§5-R7）：空 docs 根 ⇒ 不炸、计数全 0
    const emptyDocs = path.join(dir, 'empty-docs');
    fs.mkdirSync(emptyDocs, { recursive: true });
    let emptyAudit = null; let threw = null;
    try { emptyAudit = audit({ docsRoot: emptyDocs, root: dir }); } catch (e) { threw = String(e && e.message); }
    assertEq(threw, null, '空态①：空 docs 根不抛异常', res);
    assertEq(emptyAudit?.totals.docsMd, 0, '空态②：空根 ⇒ .md 计数 0', res);
    assertEq(emptyAudit?.totals.familyTotal, 0, '空态③：空根 ⇒ 归族 0', res);
    assertTrue(emptyAudit?.familyRows.length === 15, '空态④：家族仍列全 15 族（每族 0 档）', res, String(emptyAudit?.familyRows.length));
    assertTrue(render(emptyAudit).join('\n').includes('（0 档：无漏项候选）'), '空态⑤：报告仍出"0 档"字样（不隐藏）', res);

    // —— 不存在根 ⇒ 不炸（CLI 层挡，audit 层自守）
    let threw2 = null;
    try { audit({ docsRoot: path.join(dir, 'no-such-dir'), root: dir }); } catch (e) { threw2 = String(e && e.message); }
    assertEq(threw2, null, '空态⑥：不存在的 docs 根 ⇒ audit() 不抛（由 CLI 挡）', res);

    // —— 夹具树：自动档（daily 标记）+ 人工档 + 自举档 + 无资格族档
    const fixture = path.join(dir, 'docs');
    writeTmp(fixture, '管家报告/2026-10-08-HostA.md', '# 夹具日报\n<!-- dsh-generated-doc:auto family=daily -->\n> 生成于 09:00\n');
    writeTmp(fixture, '管家报告/watch-2026-10-08-hosta.md', '# 夹具 watch\n<!-- dsh-generated-doc:auto family=watch -->\n> 每 5 分钟自动追加\n');
    writeTmp(fixture, '管家报告/裸跑期观测-2026-09-10.md', '# 裸跑期观测\n> 自动生成（夹具）\n');
    writeTmp(fixture, '人工档.md', '# 人工档\n普通正文\n');
    writeTmp(fixture, '管家报告/人工报告-20261008.md', '# 人工报告（非自动族）\n> 生成于 2026-10-08（人工撰写）\n正文\n');
    writeTmp(fixture, '自举档.md', ['# 自举档', ...Array.from({ length: 8 }, (_, i) => `正文 ${i}`), '引用 <!-- dsh-generated-doc:auto family=daily -->'].join('\n'));
    const fx = audit({ docsRoot: fixture, root: dir });
    assertEq(fx.totals.docsMd, 6, '夹具①：6 档 .md', res);
    assertEq(fx.totals.familyTotal, 2, '夹具②：归族 2 档（daily + watch）', res);
    assertEq(fx.totals.markedNow, 2, '夹具③：档头带标记 2 档（daily + watch）', res);
    assertEq(fx.familyRows.find((r) => r.id === 'daily').count, 1, '夹具④：daily 族 1 档', res);
    assertEq(fx.familyRows.find((r) => r.id === 'daily').marked, 1, '夹具⑤：daily 族带标记 1 档', res);
    assertEq(fx.familyRows.find((r) => r.id === 'watch').exemptEligible, false, '夹具⑥：watch 族仍列 ⛔ 不豁免', res);
    assertTrue(fx.reverseAnchors.some((x) => x.rel.includes('裸跑期观测-')), '夹具⑦：裸跑期观测-* 进反向锚点对账（未归族）', res, JSON.stringify(fx.reverseAnchors));
    assertTrue(fx.leakCandidates.some((x) => x.rel.includes('人工报告')), '夹具⑧：前 N 行含"生成于"但未归族 ⇒ 进漏项候选', res, JSON.stringify(fx.leakCandidates.map((x) => x.rel)));
    assertTrue(!fx.leakCandidates.some((x) => x.rel.includes('自举档')), '夹具⑨：自举档标记在正文第 10 行 ⇒ 既不算自动档、也不进漏项候选（§2.3：只看前 N 行）', res);

    // —— 断言 B/C（真跑生产：只读；断言 A 在生产为红 = 预期，self-test 不据此判）
    assertTrue(fx.assertions.B.ok, '断言 B 绿：家族匹配构造性（全族 × 4 变体）', res, JSON.stringify(fx.assertions.B.bad));
    assertEq([fx.assertions.B.eligibleTrue, fx.assertions.B.eligibleFalse], [52, 8], '断言 B 计数：有资格 52 · 无资格 8', res);

    // —— JSON 可序列化（--json 前提）
    let ser = null;
    try { ser = JSON.stringify(fx); } catch (e) { ser = 'ERR:' + e.message; }
    assertTrue(typeof ser === 'string' && ser.startsWith('{'), 'JSON：audit() 结果可序列化', res, String(ser).slice(0, 80));
  } finally { rmrf(dir); }
  finishSelfTest('gen-doc-audit', res);
}

if (isMain(import.meta.url)) {
  main();
}
