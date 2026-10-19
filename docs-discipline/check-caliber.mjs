#!/usr/bin/env node
// check-caliber.mjs —— 口径自核（两种模式）
//
//   模式 A（默认 / 射程自量）· `--scope`：逐条核 §2 各条 `[射程]` 的**三要素**
//     （管哪类档 / 管哪个阶段 / 谁执行）—— 第 2 条射程总则的判据若"一缺全灰"，
//     本模式就是那次"补完后在档内自量一次并留产物"的执行者。
//   模式 B · `--changed <改动行集合>` [--old <旧值清单.json>]：口径自核
//     （规则 → 相关载体 → 是否已按新口径重写），样本集 = 改动行 ∪ **因新规则而失真的既有行**。
//
// 用法：
//   node check-caliber.mjs --scope --doc <方案档>
//   node check-caliber.mjs --doc <方案档> --changed <行号清单> [--old <旧值.json>] [--json]
//   node check-caliber.mjs --self-test
//
// 取值口径（三条 · 写死）：
//   ① **证据串取自本轮新口径文本**（从改动行里现抽 `` `…` `` / `**…**` 内的串），**禁沿用旧串**（不预置任何黑名单）；
//   ② **动态定位**：条目 / 节 / 载体全部由标题与行内容现算，**脚本内无任何硬编码行号**（自测里有一条断言直接扫脚本源码）；
//   ③ **命中须落在该规则声明的行区间**（条目的行区间 = 该条行的起止；节区间 = 标题层级算出）。
import fs from 'node:fs';
import { EXIT, argParse, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp, makeExemptFn, norm } from './lib/common.mjs';

// —— 三要素词表（口径写在本目录；改口径改这里并跑 --self-test）——
const RE_DOCFACE = /(方案|审核|回修|复审|交付报告|变更流水|管家报告|交接档|台账|全生态|任何档|全部档|全部四类|全部文档类)/;
const RE_STAGE = /(阶段|起草|送审|回修|交付|收尾|申请|登记|到期|出口判定|全流程|全程|写入时|送审—回修—出证)/;
const RE_WHO = /(审核方|回修方|复审方|主人|脚本|机器门|执行者|发起方|tick|日报段|引用方|人只跑|施工方|交付方)/;

/** 抽出 §2 的条文（`| **N** | … |` 行），以及每条的 `[射程]` 段 */
export function extractClauses(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\|\s*\*\*(\d+)\*\*\s*\|(.*)$/.exec(lines[i]);
    if (!m) continue;
    let cell = m[2];
    if (cell.endsWith('|')) cell = cell.slice(0, -1);
    out.push({ n: Number(m[1]), line: i + 1, cell, scope: scopeSegment(cell) });
  }
  return out;
}

export function scopeSegment(cell) {
  const i = cell.indexOf('[射程]');
  if (i < 0) return null;
  let rest = cell.slice(i + 4);
  const cut = rest.search(/`\[(触发|动作|判据|射程)\]`|<br>|\*\*细则\*\*/);
  if (cut >= 0) rest = rest.slice(0, cut);
  return rest;
}

export function scopeCheck(docPath) {
  const m = meta(docPath);
  const clauses = extractClauses(m.lines);
  const rows = clauses.map((c) => {
    const s = c.scope;
    const has = {
      docs: !!s && RE_DOCFACE.test(s),
      stage: !!s && RE_STAGE.test(s),
      who: !!s && RE_WHO.test(s),
    };
    const missing = Object.entries(has).filter(([, v]) => !v).map(([k]) => ({ docs: '管档类', stage: '管阶段', who: '执行者' }[k]));
    return { ...c, has, missing, verdict: !s ? '❌ 无 [射程] 段' : (missing.length ? `❌ 缺 ${missing.join(' + ')}` : '✅ 三要素齐备') };
  });
  const bad = rows.filter((r) => r.verdict.startsWith('❌'));
  return { ok: true, doc: m, rows, bad };
}

export function reportScope(r) {
  console.log(`档：${r.doc.path}  ·  ${r.doc.gc} 行 · sha16 ${r.doc.sha16}`);
  console.log(`抽查面：§2 条文表（动态定位到 ${r.rows.length} 条）`);
  console.log('');
  console.log('| 条 | 行号 | [射程] 段（截 90） | 管档类 | 管阶段 | 执行者 | 判定 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const x of r.rows) {
    console.log(`| 第 ${x.n} 条 | L${x.line} | ${norm(x.scope ?? '').slice(0, 90) || '（无）'} | ${x.has.docs ? '✅' : '❌'} | ${x.has.stage ? '✅' : '❌'} | ${x.has.who ? '✅' : '❌'} | ${x.verdict} |`);
  }
  const ok = r.rows.length - r.bad.length;
  console.log('');
  console.log(`[汇总] 条文 ${r.rows.length} 条 · 三要素齐备 ${ok} · 缺项 ${r.bad.length} ⇒ ${r.bad.length === 0 ? 'PASS（射程总则不再自我否决）' : 'FAIL（按第 2 条判据：缺项条"待补"，补前不得作为判违规的依据）'}`);
  return r.bad.length === 0 ? EXIT.OK : EXIT.FAIL;
}

// —— 模式 B · 口径自核 ——

/** 读改动行集合：支持每行一个行号 / JSON {lines:[…]} / 统一 diff */
export function parseChanged(p) {
  const raw = fs.readFileSync(p, 'utf8');
  if (p.toLowerCase().endsWith('.json')) {
    const j = JSON.parse(raw);
    return (Array.isArray(j) ? j : j.lines ?? []).map(Number);
  }
  const nums = new Set();
  let ln = 0;
  for (const line of raw.split(/\r?\n/)) {
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/.exec(line);
    if (hunk) { ln = Number(hunk[1]); continue; }
    if (/^[-+]{3}\s/.test(line)) continue;
    if (/^[+-]/.test(line)) { nums.add(ln); if (line[0] === '+') ln++; continue; }
    if (/^\s*\d+\s*$/.test(line)) { nums.add(Number(line.trim())); continue; }
    if (/^\s*\d+\s*[,，]\s*\d+\s*$/.test(line)) { const [a, b] = line.split(/[,，]/).map((x) => Number(x.trim())); for (let k = a; k <= b; k++) nums.add(k); }
  }
  return [...nums].sort((a, b) => a - b);
}

/** 「新规则若使既有行失真 ⇒ 该既有行一并进样本集」：同一行出现同族两个不同数值 ⇒ 该行失真 */
export function findDistorted(lines) {
  const families = [
    /重计数累计\s*\*{0,2}(\d+)\s*次/g,
    /累计\s*\*{0,2}(\d+)\s*次/g,
    /全档\s*\*{0,2}(\d[\d\s]*)\s*行/g,
    /(\d[\d\s]*)\s*B\b/g,
    /重计数第\s*(\d+)\s*轮/g,
  ];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    for (const re of families) {
      const vals = [...lines[i].matchAll(re)].map((m) => m[1].replace(/\s+/g, ''));
      if (new Set(vals).size > 1) { out.push({ line: i + 1, family: String(re), values: [...new Set(vals)], text: lines[i].trim().slice(0, 70) }); break; }
    }
  }
  return out;
}

/** 动态定位某行所属「规则」：§2 的条（`| **N** |`）优先，否则取最近的标题 */
export function locateRule(lines, lineNo) {
  const i = lineNo - 1;
  for (let k = i; k >= 0; k--) {
    const m = /^\|\s*\*\*(\d+)\*\*\s*\|/.exec(lines[k]);
    if (m) return { kind: 'clause', id: `第 ${m[1]} 条`, line: k + 1 };
  }
  for (let k = i; k >= 0; k--) {
    if (/^#{2,4}\s/.test(lines[k])) return { kind: 'section', id: lines[k].trim().slice(0, 40), line: k + 1 };
  }
  return null;
}

/** 相关载体 = 全档中引用该规则编号 / 该节标题的行（排除样本行自身） */
export function findCarriers(lines, rule, lineNo) {
  const out = [];
  if (!rule) return out;
  const token = rule.kind === 'clause' ? rule.id : rule.id.replace(/^#+\s*/, '').slice(0, 12);
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 === lineNo) continue;
    if (lines[i].includes(token) && i + 1 !== rule.line) out.push({ line: i + 1, text: lines[i].trim().slice(0, 70) });
  }
  return out;
}

export function caliberCheck({ doc, changedPath, oldPath }) {
  const m = meta(doc);
  const exemptOf = makeExemptFn(m.lines);
  const changed = parseChanged(changedPath);
  const distorted = findDistorted(m.lines);
  const sample = [...new Set([...changed, ...distorted.map((d) => d.line)])].sort((a, b) => a - b);
  const oldVals = oldPath && fs.existsSync(oldPath)
    ? [...new Set((JSON.parse(fs.readFileSync(oldPath, 'utf8')).values ?? []).map((v) => String(v).toUpperCase()))]
    : [];
  const rows = sample.map((ln) => {
    const rule = locateRule(m.lines, ln);
    const carriers = findCarriers(m.lines, rule, ln);
    const newTokens = [...new Set([...(m.lines[ln - 1] ?? '').matchAll(/\*\*([^*]{2,40})\*\*|`([^`]{2,40})`/g)].map((x) => x[1] ?? x[2]))];
    let verdict;
    if (!oldVals.length) verdict = carriers.length ? '⚠️ 未给旧值清单（只展示）' : '⚠️ 无相关载体';
    else {
      const stale = carriers.filter((c) => oldVals.some((v) => m.lines[c.line - 1].toUpperCase().includes(v)) && !exemptOf(c.line - 1));
      verdict = stale.length ? `❌ 未重写（载体 L${stale.map((s) => s.line).join('/')} 仍含旧值）` : '✅ 已按新口径重写';
    }
    return { line: ln, rule, carriers, newTokens, distorted: distorted.find((d) => d.line === ln) ?? null, exempt: exemptOf(ln - 1), verdict };
  });
  const bad = rows.filter((r) => r.verdict.startsWith('❌'));
  return { ok: true, doc: m, changed, distorted, sample, oldVals, rows, bad };
}

export function reportCaliber(r) {
  console.log(`档：${r.doc.path}  ·  ${r.doc.gc} 行 · sha16 ${r.doc.sha16}`);
  console.log(`样本集：改动行 ${r.changed.length} 条 + 失真既有行 ${r.distorted.length} 条 ⇒ 合计 ${r.sample.length} 条（全部列出）`);
  if (r.distorted.length) for (const d of r.distorted) console.log(`  ⚠️ 失真既有行 L${d.line}（同族两个值 ${d.values.join(' / ')}）⇒ 已并入样本集：${d.text}`);
  console.log('');
  console.log('| 样本行 | 规则 | 相关载体 | 新口径证据串（取本轮文本） | 判定 |');
  console.log('|---|---|---|---|---|');
  for (const x of r.rows) {
    console.log(`| L${x.line} | ${x.rule ? `${x.rule.id}（L${x.rule.line}）` : '（定位不到）'} | ${x.carriers.length ? x.carriers.map((c) => 'L' + c.line).join(',') : '—'} | ${x.newTokens.slice(0, 3).join(' · ').slice(0, 60) || '—'} | ${x.verdict}${x.exempt ? '（豁免行）' : ''} |`);
  }
  console.log('');
  console.log(`[汇总] 样本 ${r.sample.length} 条 · 未重写 ${r.bad.length} ⇒ ${r.bad.length === 0 ? 'PASS' : 'FAIL'}${r.oldVals.length ? '' : '（未给 --old ⇒ 只展示不判红）'}`);
  return r.bad.length === 0 ? EXIT.OK : EXIT.FAIL;
}

export function selfTest() {
  const res = newResults();
  // ① 脚本源码里不得出现硬编码行号（取值动态定位的可验证属性）
  const self = fs.readFileSync(new URL('./check-caliber.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8');
  assertTrue(!/\bL\s?\d{2,}\b/.test(self.replace(/^\s*\/\/.*$/gm, '')), '源码内无硬编码行号（注释除外）', res, (self.match(/\bL\s?\d{2,}\b/) ?? [''])[0]);

  const dir = makeTmp('dd-caliber-');
  const good = writeTmp(dir, 'good.md', [
    '# 假方案档',
    '',
    '## §2 条文',
    '',
    '| # | 条款 |',
    '|---|---|',
    '| **1** | **甲**。`[射程]` 方案档 · 送审阶段 · 执行者 = 审核方。`<br>**细则**：x |',
    '| **2** | **乙**。`[射程]` 本纪律全文。`<br>**细则**：x |',
  ].join('\n'));
  const s = scopeCheck(good);
  assertEq(s.rows.length, 2, '动态定位到 2 条条文', res);
  assertEq(s.rows[0].verdict, '✅ 三要素齐备', '三要素齐备条判 PASS', res);
  assertEq(s.rows[1].missing, ['管档类', '管阶段', '执行者'], '缺项逐条点名（不通过/不静默）', res);
  assertEq(s.bad.length, 1, '缺项条计入 bad', res);

  const doc = writeTmp(dir, 'doc.md', [
    '# 假方案档',
    '',
    '## §2 条文',
    '',
    '| # | 条款 |',
    '|---|---|',
    '| **4** | **计数**。`[射程]` 方案档 · 收尾阶段 · 审核方。`<br>**细则**：重计数累计 5 次 |',
    '',
    '## §8 修订记录',
    '',
    '| 版本 | 说明 |',
    '|---|---|',
    '| v11 | 按第 4 条口径改：重计数累计 7 次 · 重计数第 8 轮 |',
  ].join('\n'));
  const ch = writeTmp(dir, 'changed.json', JSON.stringify({ lines: [7] }));
  const c = caliberCheck({ doc, changedPath: ch });
  assertEq(c.sample, [7], '样本集 = 改动行（无失真行时）', res);
  assertTrue(c.rows[0].rule && c.rows[0].rule.id === '第 4 条', '规则动态定位到「第 4 条」', res, JSON.stringify(c.rows[0].rule));
  assertTrue(c.rows[0].carriers.length >= 1, '相关载体动态找到（引用该条的行）', res, JSON.stringify(c.rows[0].carriers));
  assertEq(c.bad.length, 0, '未给 --old ⇒ 不判红', res);

  const distDoc = writeTmp(dir, 'dist.md', [
    '# 假档',
    '',
    '累计 5 次 与 累计 7 次 同现 ⇒ 该行失真',
    '',
    '正常行 累计 7 次',
  ].join('\n'));
  const d = findDistorted(meta(distDoc).lines);
  assertEq(d.map((x) => x.line), [3], '同族两值同行 ⇒ 判该既有行失真（自动进样本集）', res);
  rmrf(dir);
  finishSelfTest('check-caliber', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'changed', 'old'], flags: ['scope'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '口径自核 / 射程自量（第 2 条 · 第 7 条④）',
      usage: 'node check-caliber.mjs --scope --doc <方案档> ｜ --doc <方案档> --changed <改动行集合> [--old <旧值.json>] [--json]',
      form: ['模式 A：（条 | 行号 | [射程] 段 | 管档类 | 管阶段 | 执行者 | 判定）+ [汇总] N 条齐备 / M 缺项',
        '模式 B：（样本行 | 规则 | 相关载体 | 新口径证据串 | 判定）+ 失真既有行明细 + [汇总]'],
      caliber: ['证据串取自**本轮新口径文本**（从改动行现抽 `` `…` `` / `**…**`），禁沿用旧串、不预置黑名单',
        '条目 / 节 / 载体**动态定位**（标题与行内容现算）；脚本内无硬编码行号（自测直接扫源码断言）',
        '样本集 = 改动行 ∪ 因新规则而**失真的既有行**（同行出现同族两个数值 ⇒ 判失真）',
        '三要素词表在本文件顶部（RE_DOCFACE / RE_STAGE / RE_WHO），改口径改这里并跑 --self-test'],
      scope: { docs: '方案档（§2 条文 + 改动行）', stage: '回修交付阶段（交付前）', who: '回修方' },
      exits: ['0 = 三要素齐备 / 无未重写载体', '3 = 有缺项 / 有未重写', '2 = 用法错'],
      selfTest: 'node check-caliber.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    selfTest();
  } else if (a.scope && a.doc) {
    process.exitCode = reportScope(scopeCheck(a.doc));
  } else if (a.doc && a.changed) {
    process.exitCode = reportCaliber(caliberCheck({ doc: a.doc, changedPath: a.changed, oldPath: a.old }));
  } else {
    console.log('✗ 用法：--scope --doc <档> ｜ --doc <档> --changed <清单>（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  }
}
