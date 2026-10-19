#!/usr/bin/env node
// archive-rounds.mjs —— 轮次搬家（第 8 条：全档超 800 行 ⇒ 由脚本按「最旧轮次优先」搬家）
//
// 用法：
//   node archive-rounds.mjs --doc <审核档> --keep-lines 800            # 默认 dry-run（只出计划）
//   node archive-rounds.mjs --doc <审核档> --keep-lines 800 --apply --archive <归档目录>
//   node archive-rounds.mjs --self-test
//
// 口径（写死）：
//   ① 只搬**整轮章节**（顶层 `# 第 N 轮审核|回修`），最旧优先，搬到全档 ≤ keep-lines 为止；
//   ② 搬家**不改内容、只改位置**：章节原文整段落 `<archive>\第N轮.md`，正文留**一行指针**
//      （指针必须写「引用请按『轮次 + 编号』，勿按行号」）；
//   ③ 默认 dry-run；写动作须显式 `--apply` **且** 显式 `--archive`；写前自动把原档备份到
//      `<archive>\before\<原档名>`，并在 stdout 打印一键回滚命令；
//   ④ 单轮章节自身超限（> 61 440 B）不属本脚本射程 ⇒ 报错退出（先瘦身或拆轮）。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, argParse, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp } from './lib/common.mjs';
import { findChapters, chapterRange, LIMIT_BYTES } from './check-volume.mjs';

export function plan({ doc, keepLines }) {
  const m = meta(doc);
  const chapters = findChapters(m.lines);
  const segs = chapters.map((c) => {
    const { start, last } = chapterRange(m.lines, c.line);
    const text = m.lines.slice(start, last + 1).join('\n');
    return { round: c.round, start, last, lines: last - start + 1, bytes: Buffer.byteLength(text, 'utf8'), text };
  });
  const moving = [];
  let remaining = m.gc;
  let virtual = m.lines.slice();
  for (const s of segs) {
    if (remaining <= keepLines) break;
    // 该章节此时在 virtual 中的位置（前面章节可能已被替换成指针行）
    moving.push({ ...s, pointerAfter: null });
    remaining -= (s.lines - 1); // 整段 → 一行指针
  }
  // 模拟应用后的行号（供 dry-run 报指针落点）
  let out = m.lines.slice();
  const ptrInfo = [];
  for (const s of moving) {
    const idx = out.findIndex((l, i) => i >= 0 && l === s.text.split('\n')[0]);
    const ptr = pointerLine(s);
    if (idx >= 0) {
      out = [...out.slice(0, idx), ptr, ...out.slice(idx + s.lines)];
      ptrInfo.push({ round: s.round, pointerLine: idx + 1, ptr });
    }
  }
  return { ok: true, doc: m, chapters: segs, moving, remainingLines: remaining, finalLines: m.gc - moving.reduce((a, s) => a + (s.lines - 1), 0), ptrInfo, keepLines };
}

function pointerLine(s) {
  return `> 🗂 **第 ${s.round} 轮章节已搬家**（原文 ${s.lines} 行已整段移出本档）⇒ 见归档目录下的 \`第${s.round}轮.md\`。**引用请按「轮次 + 编号」，勿按行号**（本档行号随搬家变动）。`;
}

export function apply({ doc, keepLines, archiveDir }) {
  const p = plan({ doc, keepLines });
  if (!p.ok) return p;
  if (!archiveDir) return { ok: false, error: '--apply 必须同时给 --archive <归档目录>（不默认往生产路径写）' };
  const oversized = p.moving.filter((s) => s.bytes > LIMIT_BYTES);
  if (oversized.length) return { ok: false, error: `单轮章节自身超限（${oversized.map((s) => `第 ${s.round} 轮 ${s.bytes} B`).join(' / ')}）⇒ 先瘦身或拆轮，不属搬家射程` };
  fs.mkdirSync(path.join(archiveDir, 'before'), { recursive: true });
  fs.copyFileSync(doc, path.join(archiveDir, 'before', path.basename(doc)));
  let text = p.doc.text;
  for (const s of p.moving) {
    const block = s.text;
    if (!text.includes(block)) return { ok: false, error: `章节块定位失败（第 ${s.round} 轮）—— 拒绝写入，先用 dry-run 复核` };
    fs.writeFileSync(path.join(archiveDir, `第${s.round}轮.md`), block + '\n', 'utf8');
    text = text.replace(block, pointerLine(s));
  }
  fs.writeFileSync(doc, text, 'utf8');
  const after = meta(doc);
  return {
    ok: true, applied: true, doc: after, moved: p.moving, archiveDir,
    rollback: `Copy-Item -LiteralPath "${path.join(archiveDir, 'before', path.basename(doc))}" -Destination "${doc}" -Force`,
  };
}

export function reportPlan(p) {
  console.log(`档：${p.doc.path}  ·  ${p.doc.gc} 行(GC) / ${p.doc.split} 行(split) · ${p.doc.bytes} B · sha16 ${p.doc.sha16}`);
  console.log(`限额：keep-lines = ${p.keepLines} 行（当前 ${p.doc.gc} ⇒ ${p.doc.gc > p.keepLines ? '超限，触发搬家' : '未超限，无需搬家'}）`);
  console.log(`章节总数：${p.chapters.length}（${p.chapters.map((c) => `第 ${c.round} 轮 ${c.lines} 行`).join(' · ')}）`);
  console.log('');
  console.log('| 序 | 拟搬轮次 | 区间 | 行数 | 字节 | 单轮 ≤ 61440 B |');
  console.log('|---|---|---|---|---|---|');
  p.moving.forEach((s, i) => console.log(`| ${i + 1} | 第 ${s.round} 轮 | L${s.start + 1} → L${s.last + 1} | ${s.lines} | ${s.bytes} | ${s.bytes <= LIMIT_BYTES ? '✅' : '❌'} |`));
  if (!p.moving.length) console.log('| — | （无需搬家） | — | — | — | — |');
  console.log('');
  console.log(`搬家后行数（预计）：${p.finalLines}（自 ${p.doc.gc} 行减 ${p.doc.gc - p.finalLines}）`);
  console.log(`指针行落点（预计）：${p.ptrInfo.length ? p.ptrInfo.map((x) => `第 ${x.round} 轮 → L${x.pointerLine}`).join(' · ') : '—'}`);
  console.log(`指针写法：${p.moving.length ? pointerLine(p.moving[0]) : '（无需）'}`);
  console.log('');
  console.log(`[汇总] 拟搬 ${p.moving.length} 轮 · 预计搬家后 ${p.finalLines} 行 ${p.finalLines <= p.keepLines ? '≤' : '>'} ${p.keepLines} ⇒ ${p.moving.length ? '有动作（dry-run，未写盘）' : '无需动作'}`);
  return EXIT.OK;
}

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-archive-');
  const mk = (n, body) => [`# 第 ${n} 轮审核 · X`, '', ...body, '', '---', ''].join('\n');
  const doc = writeTmp(dir, 'doc.md', mk(1, ['a1', 'a2', 'a3', 'a4']) + mk(2, ['b1', 'b2', 'b3', 'b4']) + mk(3, ['c1', 'c2']));
  const p = plan({ doc, keepLines: 12 });
  assertTrue(p.moving.length >= 1, '超限 ⇒ 有计划', res, JSON.stringify(p.moving.map((s) => s.round)));
  assertEq(p.moving[0].round, 1, '最旧轮次优先', res);
  const arc = path.join(dir, 'arc');
  const r = apply({ doc, keepLines: 12, archiveDir: arc });
  assertTrue(r.ok, 'apply 成功', res, JSON.stringify(r));
  const after = meta(doc);
  assertTrue(after.gc < 22, `搬家后行数下降（${after.gc} < 22）`, res);
  assertTrue(fs.existsSync(path.join(arc, '第1轮.md')), '章节原文整段落归档', res);
  assertTrue(after.text.includes('引用请按「轮次 + 编号」，勿按行号'), '正文留指针行且含指定口径', res);
  assertTrue(fs.existsSync(path.join(arc, 'before', path.basename(doc))), 'apply 前自动备份原档（可回滚）', res);
  const noArc = apply({ doc: writeTmp(dir, 'doc2.md', fs.readFileSync(doc, 'utf8')), keepLines: 1, archiveDir: null });
  assertEq(noArc.ok, false, 'apply 缺 --archive ⇒ 拒绝写入', res);
  const small = writeTmp(dir, 'small.md', mk(1, ['x']));
  const p2 = plan({ doc: small, keepLines: 800 });
  assertEq(p2.moving.length, 0, '未超限 ⇒ 零动作', res);
  rmrf(dir);
  finishSelfTest('archive-rounds', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'keep-lines', 'archive'], flags: ['apply'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '轮次搬家（第 8 条 · 执行者 = 脚本）',
      usage: 'node archive-rounds.mjs --doc <审核档> --keep-lines 800 [--apply --archive <归档目录>] [--json]',
      form: ['档路径 · 行数两口径 · 字节 · sha16 · 限额判定', '拟搬轮次表（轮次 | 区间 | 行数 | 字节 | 单轮是否超限）',
        '搬家后行数（预计）· 指针行落点（预计）· 指针写法', '[汇总] 拟搬 N 轮 · 预计搬家后 M 行'],
      caliber: ['整轮章节靠顶层标题 `# 第 N 轮审核|回修` 动态定位（复用 check-volume 的章节区间口径）',
        '最旧优先逐轮搬，直到全档 ≤ keep-lines；只搬整轮，不改内容，正文留一行指针',
        '默认 dry-run（不写盘）；`--apply` 须同时给 `--archive`，写前自动备份 `before\\<原档名>` 并打印回滚命令',
        '单轮章节自身 > 61 440 B ⇒ 拒绝搬家（先瘦身 / 拆轮）'],
      scope: { docs: '审核档 + 回修报告', stage: '每轮审核 / 回修收尾（超限时）', who: '脚本（人只跑一条命令）' },
      exits: ['0 = 计划生成成功 / 搬家成功', '2 = 用法错 / 缺少 --archive / 章节块定位失败', '3 = 目标档读取失败'],
      selfTest: 'node archive-rounds.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    selfTest();
  } else if (!a.doc) {
    console.log('✗ 缺 --doc（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else {
    const keep = Number(a['keep-lines'] ?? 800);
    if (a.apply) {
      const r = apply({ doc: a.doc, keepLines: keep, archiveDir: a.archive });
      if (!r.ok) { console.log(`✗ ${r.error}`); process.exitCode = EXIT.USAGE; }
      else {
        console.log(`APPLIED  搬 ${r.moved.length} 轮 ⇒ 全档 ${r.doc.gc} 行`);
        console.log(`回滚：${r.rollback}`);
        process.exitCode = EXIT.OK;
      }
    } else {
      process.exitCode = reportPlan(plan({ doc: a.doc, keepLines: keep }));
    }
  }
}
