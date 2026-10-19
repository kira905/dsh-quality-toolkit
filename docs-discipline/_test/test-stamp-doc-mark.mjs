#!/usr/bin/env node
// tools\docs-discipline\_test\test-stamp-doc-mark.mjs —— impl-2 新增导出的独立单测
//
// 对象：权威源 `tools\lib\generated-docs.mjs` 的两个 impl-2 导出
//   · `firstH1Index(text)`  —— `insertAtFor()` 的入参口径（§2.2 参数语义写死：无 H1 ⇒ -1）
//   · `stampDocMark(text, familyId, at)` —— 生成器侧盖章（§2.2 唯一形态 · **幂等**）
//
// 依据：<DSH_ROOT>\docs\规划-自动生成档判据清单-20260925.md（v3c · 已过审）
//   §2.2（标记字面 + 插入点统一规则 `insertAtFor = firstH1>=0 ? clamp(firstH1+1,0,N-1) : 0`）
//   §2.3（N = 5 的取值理由）· §3.1（15 族 id）· §4.4-6（无资格族也要有标记但不豁免）
//   §3.3-2b（生成器源文件必须出现 `insertAtFor(` 调用点）
//
// 纪律：只读（不改任何生产文件）· 零写盘 · 收尾 process.exitCode（禁 process.exit）
// 跑法：node <DSH_ROOT>\tools\docs-discipline\_test\test-stamp-doc-mark.mjs
//   env `AUTODOC_PROD_ROOT` 可注入"生成器源码所在根"（默认 <DSH_ROOT>；测试环境指镜像根）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newResults, assertEq, assertTrue, finishSelfTest } from '../lib/common.mjs';
import * as GD from '../../lib/generated-docs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROD_ROOT = process.env.AUTODOC_PROD_ROOT || process.cwd();

const res = newResults();
const T = [];
const OBS = (label, val) => T.push(`${label}：${JSON.stringify(val)}`);

const M = (id) => `<!-- dsh-generated-doc:auto family=${id} -->`;
const atOf = (t) => GD.insertAtFor(GD.firstH1Index(t));

// ---------------------------------------------------------------- A. firstH1Index 口径（§2.2）
assertEq(GD.firstH1Index('# T\n\nbody\n'), 0, 'A1 H1 在 L1 ⇒ 索引 0', res);
assertEq(GD.firstH1Index('====\nfoo\n'), -1, 'A2 无 H1 ⇒ -1（upstream 档形态）', res);
assertEq(GD.firstH1Index('body\n### 小标题\n'), -1, 'A3 只有 h3 ⇒ -1（判据 /^#\\s+\\S/）', res);
assertEq(GD.firstH1Index('<!-- butler-auto:begin -->\nx\n# 真 H1\n'), 2, 'A4 H1 在第 3 行 ⇒ 索引 2', res);
assertEq(GD.firstH1Index('body\n#\n# 真\n'), 2, 'A5 单字符 `#` 不算 H1（须 `# ` + 非空白）', res);
assertEq(GD.firstH1Index(''), -1, 'A6 空文本 ⇒ -1（不炸）', res);

// ---------------------------------------------------------------- B. 插入点三类分支（§2.2 · N-1 口径）
assertEq(atOf('# T\n\nbody\n'), 1, 'B1 H1 索引 0 ⇒ 索引 1 ⇒ 落点 L2（14 族形态）', res);
assertEq(atOf('====\nfoo\n'), 0, 'B2 无 H1 ⇒ 索引 0 ⇒ 落点 L1（upstream 形态）', res);
const deep = Array.from({ length: 44 }, (_, i) => `line ${i + 1}`).join('\n') + '\n# H1 在 L45\n';
assertEq(GD.firstH1Index(deep), 44, 'B3 深 H1：索引 44（踩坑大全-hostb 实测形态）', res);
assertEq(atOf(deep), 4, 'B4 索引 44 ⇒ 夹紧 4 ⇒ 落点 L5（B-1：不按 H1 绝对定位）', res);
assertTrue([0, 1, 2, 3, 4, 5, -1, 44, 999].every((h) => { const a = GD.insertAtFor(h); return a >= 0 && a <= GD.DOC_MARK_SCAN_LINES - 1; }), 'B5 `insertAtFor` 返回值恒 ∈ [0, N-1]', res);

// ---------------------------------------------------------------- C. stampDocMark 基本行为（§2.2）
const t1 = '# 大管家日报 · 2026-10-08\n\n> 生成于 09:00\n\n正文\n';
const s1 = GD.stampDocMark(t1, 'daily', atOf(t1));
assertEq(s1, `# 大管家日报 · 2026-10-08\n${M('daily')}\n\n> 生成于 09:00\n\n正文\n`, 'C1 标记插到 L2 且字面逐字一致', res);
assertTrue(GD.isGeneratedDocText(s1), 'C2 盖章后 isGeneratedDocText = true', res);
assertEq(GD.readFamilyId(s1.split('\n')[1]), 'daily', 'C3 family 值可读回', res);
assertEq(s1.split('\n').length, t1.split('\n').length + 1, 'C4 只多 1 行（内容零改动）', res);
assertEq(t1, '# 大管家日报 · 2026-10-08\n\n> 生成于 09:00\n\n正文\n', 'C5 纯函数：入参文本未被改动', res);

// ---------------------------------------------------------------- D. 幂等（重复盖章 / 家族纠正）
assertEq(GD.stampDocMark(s1, 'daily', atOf(s1)), s1, 'D1 幂等：重复盖章逐字节相同（不重复插入）', res);
assertEq(GD.stampDocMark(s1, 'daily', 0), s1, 'D2 幂等与传入的 at 无关（档头已有标记 ⇒ 原位替换）', res);
const s1c = GD.stampDocMark(s1, 'progress', atOf(s1));
assertTrue(s1c.includes('family=progress') && !s1c.includes('family=daily'), 'D3 家族写错 ⇒ 原位纠正', res);
assertEq(s1c.split('\n').length, s1.split('\n').length, 'D4 纠正不改变行数', res);
assertEq(s1c.split('\n').filter((l) => GD.isDocMarkLine(l)).length, 1, 'D5 恒只有 1 行档级标记', res);

// ---------------------------------------------------------------- E. 边界（无 H1 / 短档 / CRLF / 深 H1）
const t2 = '====================================\n官方上游动态 · xxx\n';
const s2 = GD.stampDocMark(t2, 'upstream', atOf(t2));
assertTrue(s2.startsWith(`${M('upstream')}\n====`), 'E1 无 H1 档（upstream 形态）⇒ 标记插 L1', res);
const s3 = GD.stampDocMark('# 只有一行', 'todo', atOf('# 只有一行'));
assertEq(s3, `# 只有一行\n${M('todo')}`, 'E2 单行档 ⇒ 追加到末尾（splice 不越界）', res);
const s4 = GD.stampDocMark(deep, 'pitfall', atOf(deep));
assertEq(s4.split('\n')[4], M('pitfall'), 'E3 深 H1 档 ⇒ 标记落 L5（窗口内）', res);
assertTrue(GD.isGeneratedDocText(s4), 'E4 深 H1 档仍命中（前 N 行窗口）', res);
const crlf = '# T\r\n\r\nbody\r\n';
const s5 = GD.stampDocMark(crlf, 'daily', atOf(crlf));
assertEq(s5.split('\n')[1], `${M('daily')}\r`, 'E5 CRLF 档 ⇒ 标记行也带 \\r（不混 LF/CRLF）', res);
assertEq((s5.match(/\r\n/g) ?? []).length, (crlf.match(/\r\n/g) ?? []).length + 1, 'E6 CRLF 行数 +1（行尾风格统一）', res);
assertEq(GD.stampDocMark(s5, 'daily', atOf(s5)), s5, 'E7 CRLF 档幂等', res);
const s6 = GD.stampDocMark('# T\n只一行\n', 'todo', 99);
assertTrue(GD.isGeneratedDocText(s6), 'E8 `at` 越界（正常调用不可能出现）⇒ 夹紧且不抛，标记仍落前 N 行窗口内', res);
assertEq(s6.split('\n').filter((l) => GD.isDocMarkLine(l)).length, 1, 'E9 越界 `at` 也只插 1 行（不重复）', res);

// ---------------------------------------------------------------- F. 15 族全量（§3.1 · 正向门）
let famOk = 0; const famBad = [];
for (const f of GD.GENERATED_DOC_FAMILIES) {
  const body = `# 夹具档 · ${f.id}\n\n> 自动生成\n`;
  const s = GD.stampDocMark(body, f.id, atOf(body));
  const back = GD.readFamilyId(s.split('\n')[1]);
  if (GD.isGeneratedDocText(s) && back === f.id) famOk++; else famBad.push({ id: f.id, back });
}
assertEq(famOk, 15, 'F1 全 15 族：盖章后均命中且 family 可读回', res);
assertEq(famBad, [], 'F2 无失败族', res);
OBS('F 族覆盖明细', { ok: famOk, families: GD.GENERATED_DOC_FAMILIES.map((f) => f.id).join(',') });

// ---------------------------------------------------------------- G. 负样例（人工档 / 自举）
const human = '# 人工档\n\n正文第 1 行\n';
assertTrue(!GD.isGeneratedDocText(human), 'G1 人工档（未盖章）⇒ 不判自动生成档', res);
const selfRef = ['# 规划档', '', ...Array.from({ length: 20 }, (_, i) => `正文 ${i}`), `引用 ${M('daily')}`].join('\n');
assertTrue(!GD.isGeneratedDocText(selfRef), 'G2 自举负样例：标记在正文第 22 行 ⇒ 不判自动生成档', res);
assertTrue(GD.stampDocMark(selfRef, 'daily', atOf(selfRef)).split('\n').length === selfRef.split('\n').length + 1, 'G3 自举档被盖章时也只 +1 行（不改正文）', res);

// ---------------------------------------------------------------- H. 生成器接线（§3.3-2b · 断言 A 的单测版）
//     H1 = 每族 `generator` 源文件内 `insertAtFor(` 调用点 ≥ 1（**断言 A 的口径**）
//     H2 = 15 族 family id **各自至少有一处盖章调用**（`stampDocMark(text, '<id>'`）
//          —— 跨文件族（`pitfall`：`pitfall-tick.mjs` 定插入点 + 共用渲染器 `pitfall-render.mjs` 盖章）
//             不能只看 generator 单文件，故 H2 扫全 `tools\` 树
const famIds = new Set(GD.GENERATED_DOC_FAMILIES.map((f) => f.id));
const genText = (f) => {
  const m = /^(.+)#(.+)$/.exec(f.generator ?? '');
  const abs = path.join(PROD_ROOT, (m ? m[1] : (f.generator ?? '')).replace(/\\/g, path.sep));
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
};
const aBad = [];
for (const f of GD.GENERATED_DOC_FAMILIES) {
  const t = genText(f);
  const calls = t === null ? -1 : (t.match(/insertAtFor\s*\(/g) ?? []).length;
  if (!(calls >= 1)) aBad.push({ id: f.id, file: f.generator, calls });
}
assertEq(aBad, [], 'H1 全 15 族 generator 源文件内 `insertAtFor(` 调用点 ≥ 1（§3.3-2b 断言 A 的单测版）', res);

const stampIds = new Set(); const stampSites = []; const unknownIds = [];
const walk = (dir) => {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    if (!/\.mjs$/.test(e.name)) continue;
    let t = '';
    try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (!t.includes('stampDocMark')) continue;
    for (const mm of t.matchAll(/stampDocMark\s*\([^,]+,\s*['"]([a-z0-9-]+)['"]/g)) {
      stampIds.add(mm[1]);
      stampSites.push({ file: path.relative(PROD_ROOT, p).replace(/\\/g, '/'), id: mm[1] });
      if (!famIds.has(mm[1])) unknownIds.push({ file: path.relative(PROD_ROOT, p), id: mm[1] });
    }
  }
};
walk(path.join(PROD_ROOT, 'tools'));
const missingIds = [...famIds].filter((id) => !stampIds.has(id));
assertEq(missingIds, [], `H2 全 15 族都有盖章调用点（扫到 ${stampIds.size} 个族 id / ${stampSites.length} 处）`, res);
assertEq(unknownIds, [], 'I1 盖章调用里出现的 family id 全部登记在权威源家族表内（无错族 id）', res);
OBS('H 接线明细', { aBad, stampIds: [...stampIds].sort(), stampSites, unknownIds, prodRoot: PROD_ROOT });

// ---------------------------------------------------------------- J. 与检查器判据的往返一致性
for (const f of GD.GENERATED_DOC_FAMILIES.slice(0, 15)) {
  const body = '# X\n\n正文\n';
  const s = GD.stampDocMark(body, f.id, atOf(body));
  const head = GD.headLinesOf(s);
  if (!head.some(GD.isDocMarkLine)) { assertTrue(false, `J 往返失败：${f.id}`, res); }
}
assertEq(true, true, 'J1 盖章 → 检查器侧 headLinesOf/isDocMarkLine 往返一致（15 族）', res);

// ---------------------------------------------------------------- 观测（不进断言计数）
for (const t of T) console.log(`  · ${t}`);
finishSelfTest('test-stamp-doc-mark', res);
