#!/usr/bin/env node
// check-volume.mjs —— 体量核（第 8 条「单轮章节 ≤ 61 440 B / 全档 > 800 行 ⇒ 搬家」的机器核）
//
// 用法：
//   node check-volume.mjs --doc <审核档|回修报告> --round <N|last>
//   node check-volume.mjs --doc <档> --round 10 --json
//   node check-volume.mjs --self-test
//
// 区间口径（写死 · 与第 9/10 轮审核方的自量口径一致）：
//   单轮章节 = 「`# 第 N 轮审核`（或 `# 第 N 轮回修`）标题行（含）」→「章节正文最后一行（含）」，
//   **不含**其后用于分隔的 `---` 行与空行；行间以 LF 拼（**不用 CRLF** —— CRLF 会每行多算 1 字节，
//   第 10 轮实测差 309 字节 = 章节行数）。
//   全档行数 = 两套口径都给：gc（Get-Content）/ split（split(/\r?\n/)）。
import fs from 'node:fs';
import { EXIT, argParse, counts, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp } from './lib/common.mjs';

export const LIMIT_BYTES = 61440; // 单轮章节上限（60 KiB）
export const LIMIT_LINES = 800;   // 全档行数上限

// 注意：CJK 字符在 JS 正则里不是 \w ⇒ 不能图省事写 \b（`轮审核 ` 处 \b 永不成立）
const TITLE_RE = /^#\s+第\s*(\d+)\s*轮(?:审核|回修)/;

/** 定位全部轮次章节标题行（0-based 索引） */
export function findChapters(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TITLE_RE.exec(lines[i]);
    if (m) out.push({ round: Number(m[1]), line: i });
  }
  return out;
}

/** 求某章节的正文区间 [start, endExclusive)：正文最后一行 = 边界前最后一个非空且非 `---` 的行 */
export function chapterRange(lines, startIdx) {
  let bound = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (TITLE_RE.test(lines[i])) { bound = i; break; }
    if (/^#\s/.test(lines[i])) { bound = i; break; }
  }
  let last = bound - 1;
  while (last > startIdx && (lines[last].trim() === '' || lines[last].trim() === '---')) last--;
  return { start: startIdx, last, endExclusive: last + 1 };
}

export function run({ doc, round }) {
  const m = meta(doc);
  const chapters = findChapters(m.lines);
  if (!chapters.length) return { ok: false, error: `未找到任何「第 N 轮」章节标题：${doc}` };
  const pick = round === 'last' ? chapters[chapters.length - 1]
    : chapters.filter((c) => c.round === Number(round)).pop();
  if (!pick) return { ok: false, error: `未找到第 ${round} 轮章节（共 ${chapters.length} 个）` };

  const { start, last } = chapterRange(m.lines, pick.line);
  const chunk = m.lines.slice(start, last + 1).join('\n');
  const bytes = Buffer.byteLength(chunk, 'utf8');
  return {
    ok: true,
    doc: m.path,
    docSha16: m.sha16,
    docBytes: m.bytes,
    round: pick.round,
    titleLine: start + 1,
    lastLine: last + 1,
    chapterLines: last - start + 1,
    chapterBytes: bytes,
    bytesOk: bytes <= LIMIT_BYTES,
    bytesHeadroom: LIMIT_BYTES - bytes,
    totalGc: m.gc,
    totalSplit: m.split,
    linesOk: m.gc <= LIMIT_LINES,
    chapters: chapters.map((c) => c.round),
  };
}

export function report(r) {
  if (!r.ok) { console.log(`✗ ${r.error}`); return EXIT.USAGE; }
  console.log(`档：${r.doc}  ·  sha16 ${r.docSha16}  ·  ${r.totalGc} 行(GC) / ${r.totalSplit} 行(split) / ${r.docBytes} B`);
  console.log(`章节：第 ${r.round} 轮  ·  L${r.titleLine} → L${r.lastLine}（${r.chapterLines} 行）  ·  区间字节 ${r.chapterBytes} B`);
  console.log(`判定①单轮章节：${r.bytesOk ? 'PASS' : 'FAIL'}（上限 ${LIMIT_BYTES} B · 余量 ${r.bytesHeadroom} B）`);
  console.log(`判定②全档行数：${r.linesOk ? 'PASS' : 'FAIL'}（上限 ${LIMIT_LINES} 行 · 实测 ${r.totalGc}）`);
  console.log(`判定③搬迁触发：${r.linesOk ? '否' : '是'}（触发 ⇒ 必须跑 archive-rounds.mjs --apply 或记一行待办；不得静默不搬）`);
  if (!r.linesOk) console.log('  ⇒ 全档超限不是"体量核判不过"，而是**搬家动作的触发条件**（第 8 条：执行者 = 脚本）。');
  if (!r.bytesOk) console.log('  ⇒ 单轮章节超限：该轮章节本身必须先瘦身或拆轮（此项才是体量核的判不过项）。');
  console.log(`[汇总] 本章节 ${r.chapterBytes} B ${r.bytesOk ? '≤' : '>'} ${LIMIT_BYTES} ⇒ 体量核 ${r.bytesOk ? 'PASS' : 'FAIL'} · 全档 ${r.totalGc} 行 ${r.linesOk ? '≤' : '>'} ${LIMIT_LINES} ⇒ 搬家触发 ${r.linesOk ? '否' : '是'}`);
  return r.bytesOk ? EXIT.OK : EXIT.FAIL;
}

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-volume-');
  const f = writeTmp(dir, 'fixture.md', [
    '# 假审核档',
    '',
    '# 第 1 轮审核 · X',
    '',
    '正文一',
    '',
    '---',
    '',
    '# 第 2 轮审核 · Y',
    '',
    '正文二',
    '尾部行',
    '',
    '---',
    '',
  ].join('\n'));
  const r1 = run({ doc: f, round: 1 });
  assertEq([r1.titleLine, r1.lastLine], [3, 5], '第 1 轮区间 = 标题行 → 正文最后一行（不含其后 --- 与空行）', res);
  assertEq(r1.chapterBytes, Buffer.byteLength(['# 第 1 轮审核 · X', '', '正文一'].join('\n'), 'utf8'), '区间字节按 LF 拼', res);
  const r2 = run({ doc: f, round: 'last' });
  assertEq([r2.round, r2.lastLine], [2, 12], 'last 取最后一轮且含尾部正文行', res);
  const r3 = run({ doc: f, round: 9 });
  assertTrue(!r3.ok, '不存在的轮次 ⇒ 拒绝（不静默返回 0）', res, JSON.stringify(r3));
  // 与真实档无关的自洽性：全档行数两口径
  const c = counts(fs.readFileSync(f, 'utf8'));
  assertEq([c.gc, c.split], [14, 15], '两套行数口径（GC / split）复算', res);
  rmrf(dir);
  finishSelfTest('check-volume', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'round'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '体量核（第 8 条）',
      usage: 'node check-volume.mjs --doc <审核档|回修报告> --round <N|last> [--json]',
      form: ['档路径 · sha16 · 全档行数（GC / split）· 字节',
        '章节：第 N 轮 · 起止行号 · 行数 · 区间字节',
        '判定①单轮章节 ≤ 61 440 B / 判定②全档 ≤ 800 行（各自 PASS/FAIL + 余量）',
        '[汇总] 一行'],
      caliber: ['轮次章节靠标题行 `# 第 N 轮审核|回修` 动态定位，脚本内无任何硬编码行号',
        '区间 = 标题行（含）→ 正文最后一行（含）；不含其后 `---` 与空行；行间以 LF 拼（CRLF 会每行多 1 字节）',
        '全档行数给两套口径：gc（Get-Content）/ split'],
      scope: { docs: '审核档 + 回修报告（第 8 条射程）', stage: '每轮审核 / 回修收尾', who: '审核方（收尾）；搬家则交脚本' },
      exits: ['0 = 两判定均 PASS', '3 = 至少一项 FAIL', '2 = 用法错 / 未找到章节'],
      selfTest: 'node check-volume.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    selfTest();
  } else if (!a.doc || !a.round) {
    console.log('✗ 缺 --doc / --round（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else {
    process.exitCode = report(run({ doc: a.doc, round: a.round }));
  }
}
