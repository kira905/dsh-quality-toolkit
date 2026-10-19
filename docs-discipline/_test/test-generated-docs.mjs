#!/usr/bin/env node
// tools\docs-discipline\_test\test-generated-docs.mjs —— 「自动生成档」判据权威源独立单测
//
// 依据：<DSH_ROOT>\docs\规划-自动生成档判据清单-20260925.md（v3c · 已过审）
//   §2.2（标记规范 + 插入点统一规则 · 三类分支）· §2.4（判据实现形态）
//   §2.5（findFamily 匹配口径逐条 · 多族裁决 · 未命中 ⇒ null）
//   §3.1（15 族构造性断言）· §3.2（反向锚点：反向误伤 = 0）· §4.5-3（自举负样例）· §5-R5（轻量自检）
//
// 纪律：只读（不改任何生产文件）· 夹具/临时零写入 · 收尾 process.exitCode
// 跑法：node <DSH_ROOT>\tools\docs-discipline\_test\test-generated-docs.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  newResults, assertEq, assertTrue, finishSelfTest,
} from '../lib/common.mjs';
import * as GD from '../../lib/generated-docs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));            // …\tools\docs-discipline\_test
const TOOLS_ROOT = path.resolve(HERE, '..', '..');                    // 本模块所在 tools 根（候选树 / 生产树）
/** 生产数据根（docs / 生成器源码）——**显式给**：候选树不在 <DSH_ROOT>\tools 位置，
 *  故「被引生产数据」与「本模块自身」必须分开解析；可用 env AUTODOC_PROD_ROOT 注入（测试环境用） */
const PROD_ROOT = process.env.AUTODOC_PROD_ROOT || process.cwd();
const PLAN_DOC = path.join(PROD_ROOT, 'docs', '规划-自动生成档判据清单-20260925.md');

const res = newResults();
const observations = [];
/** 观测输出（**不进断言计数**：只作报告取证） */
const T = (label, val) => { observations.push(`${label}：${JSON.stringify(val)}`); };

// ---------------------------------------------------------------- A. 常量（§2.2 / §2.4）
assertEq(GD.SCHEMA_VERSION, 1, 'A1 SCHEMA_VERSION = 1（§2.5）', res);
assertEq(GD.DOC_MARK_PREFIX, '<!-- dsh-generated-doc:auto', 'A2 DOC_MARK_PREFIX = 规范字面前缀（§2.2）', res);
assertEq(GD.DOC_MARK_SCAN_LINES, 5, 'A3 DOC_MARK_SCAN_LINES = 5（= N · §2.3）', res);
assertEq(GD.EXEMPT_ENABLED, true, 'A4 EXEMPT_ENABLED = true（§4.3 逃生舱默认开）', res);
assertTrue(GD.DOC_MARK_TEMPLATE === '<!-- dsh-generated-doc:auto family=<family-id> -->', 'A5 标记模板字面与 §2.2 逐字一致', res, GD.DOC_MARK_TEMPLATE);

// ---------------------------------------------------------------- B. isDocMarkLine / readFamilyId（§2.2 / §2.4）
assertEq(GD.isDocMarkLine('<!-- dsh-generated-doc:auto family=daily -->'), true, 'B1 行首标记 ⇒ true', res);
assertEq(GD.isDocMarkLine('   <!-- dsh-generated-doc:auto family=daily -->'), true, 'B2 允许前置空白（缩进）⇒ true', res);
assertEq(GD.isDocMarkLine('正文里提到 <!-- dsh-generated-doc:auto family=daily --> 但不在行首'), false, 'B3 非行首（正文内引用）⇒ false（防自举/误伤）', res);
assertEq(GD.isDocMarkLine('<!-- docs-index-gen:auto:begin -->'), false, 'B4 段级标记 `docs-index-gen:auto:begin` ⇒ false（命名空间不同）', res);
assertEq(GD.isDocMarkLine('<!-- butler-auto:begin -->'), false, 'B5 段级标记 `butler-auto:begin` ⇒ false', res);
assertEq([GD.isDocMarkLine(null), GD.isDocMarkLine(undefined), GD.isDocMarkLine(42)], [false, false, false], 'B6 非字符串 ⇒ false（不炸）', res);
assertEq(GD.readFamilyId('<!-- dsh-generated-doc:auto family=daily -->'), 'daily', 'B7 readFamilyId 读出 id', res);
assertEq([GD.readFamilyId('<!-- dsh-generated-doc:auto -->'), GD.readFamilyId('')], [null, null], 'B8 无 family ⇒ null（判定不依赖它）', res);

// ---------------------------------------------------------------- C. insertAtFor —— §2.2 三类分支（0 / -1 / 44）
assertEq(GD.insertAtFor(0), 1, 'C1 H1 索引 0 ⇒ 索引 1 ⇒ 落 L2（14 族形态）', res);
assertEq(GD.insertAtFor(-1), 0, 'C2 无 H1（索引 -1）⇒ 索引 0 ⇒ 落 L1（upstream 形态）', res);
assertEq(GD.insertAtFor(44), 4, 'C3 H1 索引 44 ⇒ 夹紧 4 ⇒ 落 L5（pitfall/hostb 形态 · B-1）', res);
assertEq([GD.insertAtFor(1), GD.insertAtFor(2), GD.insertAtFor(3), GD.insertAtFor(99), GD.insertAtFor(-5)], [2, 3, 4, 4, 0], 'C4 夹紧与边界（含负值/超窗）', res);
const allIn = [-5, 0, 1, 2, 3, 4, 5, 44, 1000].every((x) => GD.insertAtFor(x) >= 0 && GD.insertAtFor(x) <= GD.DOC_MARK_SCAN_LINES - 1);
assertTrue(allIn, 'C5 返回值恒 ∈ [0, N-1]（落点必在前 N 行窗口内）', res);

// ---------------------------------------------------------------- C′. 15 族代表档真档落点（实现 vs 方案 §3.1 落点表 · 可失败）
{
  const rows = [];
  let ok = true;
  for (const fam of GD.GENERATED_DOC_FAMILIES) {
    const abs = path.join(PROD_ROOT, fam.sample.replace(/\\/g, path.sep));
    if (!fs.existsSync(abs)) { rows.push({ id: fam.id, note: '档不存在（跳过）' }); continue; }
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const firstH1 = lines.findIndex((l) => /^#\s+\S/.test(l));
    const at = GD.insertAtFor(firstH1);
    const expectLine = fam.id === 'upstream' ? 1 : 2;
    rows.push({ id: fam.id, firstH1, atIndex: at, line: at + 1, expect: expectLine });
    if (at + 1 !== expectLine) ok = false;
  }
  assertTrue(ok, 'C′1 各族代表档落点与 §3.1 落点表一致（upstream ⇒ L1 · 其余 ⇒ L2）', res, JSON.stringify(rows));
  T('C′1 落点表（只读实测 · 供报告取证）', rows);
  // pitfall 的 hostb 档：H1 在 L45（索引 44）⇒ 夹紧落 L5（B-1 点名的族）
  const kira = path.join(PROD_ROOT, 'docs', '踩坑大全-hostb.md');
  if (fs.existsSync(kira)) {
    const kl = fs.readFileSync(kira, 'utf8').split(/\r?\n/);
    const h1 = kl.findIndex((l) => /^#\s+\S/.test(l));
    assertEq(GD.insertAtFor(h1) + 1, 5, 'C′2 pitfall/hostb：H1 不在前 N 行 ⇒ 夹紧落 L5（不按 H1 绝对定位）', res);
    T('C′2 hostb H1 索引（实测）', h1);
  } else {
    T('C′2 hostb 档不存在（跳过）', null);
  }
}

// ---------------------------------------------------------------- D. normalizePath（§2.5-1 三步）
assertEq(GD.normalizePath('docs\\管家报告\\a.md'), 'docs\\管家报告\\a.md', 'D1 反斜杠 + 无盘符 ⇒ 原样（小写）', res);
assertEq(GD.normalizePath('docs/管家报告/a.md'), 'docs\\管家报告\\a.md', 'D2 正斜杠 ⇒ 反斜杠', res);
assertEq(GD.normalizePath('X:\\DSH\\docs\\管家报告\\a.md'), 'docs\\管家报告\\a.md', 'D3 去盘符前缀 `X:\\DSH\\`', res);
assertEq(GD.normalizePath('x:/DSH/docs/管家报告/A.MD'), 'docs\\管家报告\\a.md', 'D4 盘符 + 正斜杠 + 大写 ⇒ 全小写', res);
assertEq([GD.normalizePath(null), GD.normalizePath(undefined), GD.normalizePath(1)], ['', '', ''], 'D5 非字符串 ⇒ 空串（不炸）', res);

// ---------------------------------------------------------------- E. familyMatchToRe / findFamily（§2.5-2 / §2.5-3）
const F = (p) => (GD.findFamily(p) ? GD.findFamily(p).id : null);
assertEq(F('docs\\管家报告\\2026-09-17-progress-hosta.md'), 'progress', 'E1 M-6 关键：progress 档 ⇒ 归 progress（不是 daily）', res);
assertEq(F('docs\\管家报告\\2026-10-08-HostA.md'), 'daily', 'E2 daily 档 ⇒ daily（大小写不敏感）', res);
assertEq(F('docs\\待你操作-ROG.md'), 'todo', 'E3 todo 档 ⇒ todo', res);
assertEq(F('docs\\文档总索引.md'), 'index', 'E4 index 档 ⇒ index', res);
assertEq(F('docs\\管家报告\\watch-2026-10-08-hosta.md'), 'watch', 'E5 watch 档 ⇒ watch（登记但不豁免）', res);
assertEq(F('docs\\管家报告\\external-2026-10-08-HostA.md'), 'external', 'E6 external 档 ⇒ external（登记但不豁免）', res);
assertEq(F('docs\\管家报告\\裸跑期观测-2026-09-10.md'), null, 'E7 §3.2 反向锚点①：裸跑期观测-* ⇒ 未命中任何族（不豁免）', res);
assertEq(F('docs\\管家报告\\裸跑期观测-2026-09-10-HostB-第0天基线.md'), null, 'E8 同上（带后缀形态）⇒ null', res);
assertEq(F('docs\\坑库\\P4候选分类与落地核对-20260920.md'), null, 'E9 §3.2 反向锚点①：坑库人工档 ⇒ null（match 收窄到 host 后缀）', res);
assertEq(F('docs\\坑库\\P4待办合并清单-20260920.md'), null, 'E10 同上 ⇒ null', res);
assertEq(F('docs\\坑库\\README-hostb.md'), 'pitlibrary', 'E11 pitlibrary 含 README-<host>.md', res);
assertEq(F('docs\\变更流水\\2026-10.md'), 'changelog', 'E12 changelog `<月>.md`', res);
assertEq(F('docs\\变更流水\\2026-10.md.bak'), null, 'E13 锚定 `^…$`：后缀多余 ⇒ null', res);
assertEq(F('docs\\规划-自动生成档判据清单-20260925.md'), null, 'E14 自举：本方案档名 ⇒ null', res);
assertEq(F('docs\\踩坑大全-hostb.md'), 'pitfall', 'E15 pitfall（docs 根）⇒ pitfall', res);
assertEq([F(''), F(null), F(undefined)], [null, null, null], 'E16 空/非法输入 ⇒ null（不炸）', res);
assertEq(F('X:\\other-root\\DSH-test\\docs\\待你操作-ROG.md'), null, 'E17 跨根路径（非 X:\\DSH\\ 前缀）⇒ null（保守不误判）', res);
{
  const amb = GD.GENERATED_DOC_FAMILIES.map((f) => ({ id: f.id, n: GD.findFamilies(f.sample).length }));
  const noAmb = amb.every((x) => x.n === 1);
  assertTrue(noAmb, 'E18 每族样本的命中族数 = 1（无多族歧义）', res, JSON.stringify(amb));
}

// ---------------------------------------------------------------- F. isExemptEligible（M-1 资格维）
assertEq(GD.isExemptEligible('docs\\管家报告\\watch-2026-10-08-hosta.md'), false, 'F1 watch ⇒ 不豁免（exemptEligible=false）', res);
assertEq(GD.isExemptEligible('docs\\管家报告\\external-2026-10-08-HostA.md'), false, 'F2 external ⇒ 不豁免', res);
assertEq(GD.isExemptEligible('docs\\管家报告\\2026-10-08-HostA.md'), true, 'F3 daily ⇒ 有资格', res);
assertEq(GD.isExemptEligible('docs\\待你操作-ROG.md'), true, 'F4 todo ⇒ 有资格', res);
assertEq(GD.isExemptEligible('docs\\规划-自动生成档判据清单-20260925.md'), false, 'F5 未命中任何族 ⇒ false（不是"未登记即默认豁免"）', res);
assertEq([GD.isExemptEligible(''), GD.isExemptEligible(null)], [false, false], 'F6 空输入 ⇒ false（不炸）', res);

// ---------------------------------------------------------------- G. 构造性断言（§2.5-5 / §4.5-5 第 5 类夹具）
{
  let okTrue = 0; let okFalse = 0; const bad = [];
  for (const s of GD.familySamples()) {
    for (const v of s.variants) {
      const fam = GD.findFamily(v);
      const elig = GD.isExemptEligible(v);
      const good = fam && fam.id === s.id && elig === s.exemptEligible;
      if (!good) bad.push({ id: s.id, variant: v, got: fam?.id ?? null, elig });
      else if (s.exemptEligible) okTrue++; else okFalse++;
    }
  }
  assertEq(bad, [], 'G1 全族 × 4 变体：命中本族 且 资格=表值（有资格 52 / 无资格 8）', res);
  assertEq([okTrue, okFalse], [13 * 4, 2 * 4], 'G2 构造性断言计数：有资格 52 条 true · 无资格 8 条 false', res);
  T('G2 构造性断言明细', { eligibleTrue: okTrue, eligibleFalse: okFalse });
}

// ---------------------------------------------------------------- H. 自举负样例（§2.3 / §4.5-3）
{
  const fixture = `${['# 夹具档', '', '> 说明行', ...Array.from({ length: 16 }, (_, i) => `正文第 ${i + 4} 行`), '逐字引用 `<!-- dsh-generated-doc:auto family=daily -->` 的正文档'].join('\n')}\n`;
  assertEq(GD.isGeneratedDocText(fixture), false, 'H1 标记出现在第 20+ 行 ⇒ 不判自动生成档（只看前 N 行）', res);
  const okHead = `# t\n<!-- dsh-generated-doc:auto family=daily -->\n正文\n`;
  assertEq(GD.isGeneratedDocText(okHead), true, 'H2 标记在第 2 行 ⇒ 判自动生成档', res);
  if (fs.existsSync(PLAN_DOC)) {
    const t = fs.readFileSync(PLAN_DOC, 'utf8');
    assertEq(GD.isGeneratedDocText(t), false, 'H3 真实方案档（正文逐字引用标记）⇒ 不判自动生成档（§2.3 自举负样例）', res);
    T('H3 方案档 sha16', crypto.createHash('sha256').update(fs.readFileSync(PLAN_DOC)).digest('hex').slice(0, 16));
  } else {
    T('H3 方案档不存在（跳过）', null);
  }
}

// ---------------------------------------------------------------- I. 家族表元数据自检（§5-R5 轻量自检 · 不核行号）
{
  const ids = GD.GENERATED_DOC_FAMILIES.map((f) => f.id);
  assertEq(ids.length, 15, 'I1 家族表 15 族（§3.1）', res);
  assertEq(new Set(ids).size, ids.length, 'I2 id 唯一', res);
  const dupSample = GD.GENERATED_DOC_FAMILIES.map((f) => f.sample);
  assertEq(new Set(dupSample).size, dupSample.length, 'I3 sample 互不重复', res);
  const badGen = []; const badSym = []; const badSample = [];
  for (const f of GD.GENERATED_DOC_FAMILIES) {
    const m = /^(.+)#(.+)$/.exec(f.generator ?? '');
    if (!m) { badGen.push(f.id); continue; }
    const abs = path.join(PROD_ROOT, m[1].replace(/\\/g, path.sep));
    if (!fs.existsSync(abs)) { badGen.push(f.id); continue; }
    const sym = m[2];
    if (sym !== '(顶层)') {
      const src = fs.readFileSync(abs, 'utf8');
      if (!src.includes(sym)) badSym.push(`${f.id}:${sym}`);
    }
    if (!GD.findFamily(f.sample) || GD.findFamily(f.sample).id !== f.id) badSample.push(f.id);
  }
  assertEq(badGen, [], 'I4 generator 字段 = `路径#符号名` 且文件存在（M-3）', res);
  assertEq(badSym, [], 'I5 generator 符号名可 grep 到（R5 轻量自检 · 不核行号）', res);
  assertEq(badSample, [], 'I6 sample 落在本族', res);
  assertEq(GD.GENERATED_DOC_FAMILIES.filter((f) => f.exemptEligible === true).length, 13, 'I7 有资格族 13（§3.1：watch/external 除外）', res);
  assertEq(GD.GENERATED_DOC_FAMILIES.filter((f) => f.exemptEligible === false).map((f) => f.id), ['watch', 'external'], 'I8 无资格族 = watch / external（§3.2 反向锚点）', res);
  T('I9 familyTableDigest', GD.familyTableDigest().split('\n').length);
}

// ---------------------------------------------------------------- J. 逃生舱（§4.3 · M-5）
assertEq(GD.isExemptEnabled({}), true, 'J1 默认 ⇒ 开', res);
assertEq(GD.isExemptEnabled({ DSH_CITES_EXEMPT: 'off' }), false, 'J2 env=off ⇒ 关', res);
assertEq(GD.isExemptEnabled({ DSH_CITES_EXEMPT: 'OFF' }), false, 'J3 env 大小写不敏感', res);
assertEq(GD.isExemptEnabled({ DSH_CITES_EXEMPT: 'on' }), true, 'J4 env=on ⇒ 开', res);
assertEq(GD.isExemptEnabled({ DSH_CITES_EXEMPT: 'false' }), false, 'J5 env=false ⇒ 关', res);

// ---------------------------------------------------------------- K. 白名单支路占位（§6.1-8 / 残留-b）
assertEq(GD.isListedExempt('docs\\any.md'), false, 'K1 isListedExempt 占位恒 false（本轮不实现白名单支路）', res);
{
  const wl = path.join(TOOLS_ROOT, 'lib', 'generated-docs-whitelist.json');
  assertTrue(fs.existsSync(wl), 'K2 白名单文件已落结构（§4.3-2）', res, wl);
  if (fs.existsSync(wl)) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(wl, 'utf8')); } catch { /* 下面断言报 */ }
    assertTrue(!!j, 'K3 白名单文件是合法 JSON', res);
    assertEq(j?.entries, [], 'K4 白名单默认内容为空数组（不预置）', res);
    assertEq(j?.schemaVersion, 1, 'K5 schemaVersion = 1', res);
  }
}

// ---------------------------------------------------------------- L. 空态 / 新机（R7：对空库不炸）
{
  let threw = null;
  try {
    GD.headLinesOf(null); GD.isGeneratedDocText(null); GD.findFamilies(undefined);
    GD.familyMatchToRe(null); GD.familySampleVariants({ sample: '' });
  } catch (e) { threw = String(e && e.message); }
  assertEq(threw, null, 'L1 空态/非法输入不抛异常（新机空库不炸）', res);
  assertEq(GD.headLinesOf('a\nb\nc\nd\ne\nf\ng').length, 5, 'L2 headLinesOf 截断到前 N 行', res);
  assertEq(GD.headLinesOf('a\nb').length, 2, 'L3 行数不足 N ⇒ 原样返回（不补空）', res);
}

if (observations.length) {
  console.log('');
  console.log(`[观测 · 不进断言计数 · ${observations.length} 条]`);
  for (const o of observations) console.log(`  · ${o}`);
}
finishSelfTest('test-generated-docs', res);
