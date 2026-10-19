#!/usr/bin/env node
// check-rounds.mjs —— 轮次单调核（第 3 条「编号段声明 / 轮次」与第 4 条「计数随轮次走」的机器核）
//
// 用法：
//   node check-rounds.mjs --doc <审核档|回修报告> [--json]
//   node check-rounds.mjs --doc <档> --ledger <台账 json> [--json]
//   node check-rounds.mjs --self-test
//
// 取值口径：
//   ① 轮次 = 标题行（`#`/`##`/`###` 开头且含「第 N 轮」）与「本轮 = 第 N 轮（重计数第 M 轮）」声明行；
//   ② 按出现顺序取每轮**首见**，重复轮次（回指旧轮）跳过；③ 期望序列严格 +1；
//   ④ 台账 roundNo 只是投影：与审核档不符 ⇒ **以审核档为准**（脚本只提示，不反过来改档）。
import fs from 'node:fs';
import { EXIT, argParse, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp } from './lib/common.mjs';

const TITLE_ROUND_RE = /^#{1,3}\s+(?:§\d+[^\n]{0,20})?[（(]?第\s*(\d+)\s*轮/;
const DECL_RE = /本轮\s*=\s*第\s*(\d+)\s*轮[（(]\s*重计数第\s*(\d+)\s*轮/;

export function scan(text) {
  const lines = text.split(/\r?\n/);
  const seq = [];
  const seen = new Set();
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const d = DECL_RE.exec(lines[i]);
    if (d) decls.push({ round: Number(d[1]), recount: Number(d[2]), line: i + 1, text: lines[i].trim().slice(0, 60) });
    const m = TITLE_ROUND_RE.exec(lines[i]);
    if (m) {
      const n = Number(m[1]);
      if (!seen.has(n)) { seen.add(n); seq.push({ round: n, line: i + 1, text: lines[i].trim().slice(0, 60) }); }
    }
  }
  const gaps = [];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].round !== seq[i - 1].round + 1) gaps.push({ from: seq[i - 1].round, to: seq[i].round, line: seq[i].line });
  }
  // 声明序列：同一轮可能有多条（档头「轮次索引」行 + 章节声明行 + 核验表的引用行）⇒ **每轮只取首见**再核 +1
  const declByRound = new Map();
  for (const d of decls) if (!declByRound.has(d.round)) declByRound.set(d.round, d);
  const declSeq = [...declByRound.values()];
  const declGaps = [];
  for (let i = 1; i < declSeq.length; i++) {
    if (declSeq[i].round !== declSeq[i - 1].round + 1) declGaps.push({ kind: '轮次', from: declSeq[i - 1].round, to: declSeq[i].round, line: declSeq[i].line });
    else if (declSeq[i].recount !== declSeq[i - 1].recount + 1) declGaps.push({ kind: '重计数', from: declSeq[i - 1].recount, to: declSeq[i].recount, line: declSeq[i].line });
  }
  const declOk = declGaps.length === 0;
  return { seq, decls, declSeq, gaps, declGaps, declOk };
}

/** 台账 roundNo 取值口径（两种形态都认；**认不出一律显式报，不静默**）：
 *  ① `records` 形态（真源 `~/.dsh/butler-doc-discipline.json`）：取**末条**记录的 roundNo
 *     —— 台账 append-only ⇒ "最后一次豁免的轮次"才是要跟档对的那个（不取最大值）；
 *  ② 顶层形态：顶层 `roundNo` / `round`。
 *  返回 kind：`records` 取到 · `records-empty` 台账空（无可核）· `top` 顶层取到 ·
 *             `bad` 有值但取不出有限数 · `unknown` 形态不认识 —— 后两类由 run() 转成显式提示。 */
export function ledgerRoundOf(lj) {
  if (!lj || typeof lj !== 'object' || Array.isArray(lj)) return { kind: 'unknown', round: null, why: '顶层不是 JSON 对象' };
  if (Array.isArray(lj.records)) {
    if (lj.records.length === 0) return { kind: 'records-empty', round: null, why: 'records 为空' };
    const lastRec = lj.records[lj.records.length - 1];
    const raw = (lastRec && typeof lastRec === 'object') ? (lastRec.roundNo ?? lastRec.round) : undefined;
    if (raw === undefined || raw === null) {
      return { kind: 'bad', round: null, why: `records 末条无 roundNo（该条键：${Object.keys(lastRec || {}).join('/') || '—'}）` };
    }
    const n = Number(raw);
    return Number.isFinite(n)
      ? { kind: 'records', round: n, why: `records 末条 / 共 ${lj.records.length} 条` }
      : { kind: 'bad', round: null, why: `records 末条 roundNo 非数：${JSON.stringify(raw)}` };
  }
  const top = lj.roundNo ?? lj.round;
  if (top !== undefined && top !== null) {
    const n = Number(top);
    return Number.isFinite(n)
      ? { kind: 'top', round: n, why: '顶层 roundNo' }
      : { kind: 'bad', round: null, why: `顶层 roundNo 非数：${JSON.stringify(top)}` };
  }
  return { kind: 'unknown', round: null, why: `顶层键：${Object.keys(lj).join('/') || '—'}` };
}

export function run({ doc, ledger }) {
  const m = meta(doc);
  const s = scan(m.text);
  let ledgerIssue = null;
  if (ledger) {
    try {
      const lj = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      const lro = ledgerRoundOf(lj);
      const last = s.decls.length ? s.decls[s.decls.length - 1] : (s.seq.length ? s.seq[s.seq.length - 1] : null);
      if (lro.kind === 'records' || lro.kind === 'top') {
        if (last && lro.round !== last.round) {
          const src = lro.kind === 'records' ? `（${lro.why}）` : '';
          ledgerIssue = `台账 roundNo=${lro.round}${src} ≠ 审核档末轮 ${last.round} ⇒ 以审核档为准（台账是投影）`;
        }
      } else if (lro.kind === 'bad' || lro.kind === 'unknown') {
        // fail-visible：形态认不出 / 有值但取不到数 ⇒ 明说"未核"，不许静默当核过（原缺陷 = 假绿）
        ledgerIssue = `台账形态${lro.kind === 'bad' ? '异常' : '不认识'}（${lro.why}）⇒ **未核**（≠ 核过）`;
      }
      // records-empty：台账无任何记录 ⇒ 无可核（保持静默，与原口径一致）
    } catch (e) {
      ledgerIssue = `台账不可读：${e.message}`;
    }
  }
  return { ok: true, doc: m.path, sha16: m.sha16, ...s, ledgerIssue };
}

/** 唯一判定式（report 与 CLI --json 分支共用，防两处口径分叉） */
export function verdict(r) {
  return r.gaps.length > 0 || (r.decls.length > 0 && !r.declOk);
}

export function report(r) {
  console.log(`档：${r.doc}  ·  sha16 ${r.sha16}`);
  console.log('');
  console.log('| 序 | 轮次 | 首见行号 | 首见标题（截 60） |');
  console.log('|---|---|---|---|');
  r.seq.forEach((x, i) => console.log(`| ${i + 1} | 第 ${x.round} 轮 | L${x.line} | ${x.text} |`));
  console.log('');
  console.log(`[序列] ${r.seq.map((x) => x.round).join(' → ')}`);
  console.log(`[判定①单调 +1] ${r.gaps.length === 0 ? 'PASS' : 'FAIL'}${r.gaps.length ? ' · 断点：' + r.gaps.map((g) => `第 ${g.from} 轮 → 第 ${g.to} 轮（L${g.line}）`).join(' · ') : ''}`);
  console.log('');
  if (r.decls.length) {
    console.log('| 轮次声明（**每轮只取首见**） | 重计数 | 行号 | 原文（截 60） |');
    console.log('|---|---|---|---|');
    r.declSeq.forEach((d) => console.log(`| 第 ${d.round} 轮 | 第 ${d.recount} 轮 | L${d.line} | ${d.text} |`));
    console.log(`[判定②声明双序列单调 +1] ${r.declOk ? 'PASS' : `FAIL · 断点：${r.declGaps.map((g) => `${g.kind} ${g.from} → ${g.to}（L${g.line}）`).join(' · ')}`}`);
    const extra = r.decls.length - r.declSeq.length;
    if (extra > 0) console.log(`  （同一轮另有 ${extra} 条声明 —— 档头轮次索引 / 核验表引用，按口径不计入序列）`);
  } else {
    console.log('[判定②声明双序列单调 +1] ⚠️ 未发现「本轮 = 第 N 轮（重计数第 M 轮）」声明（本档体例未写 ⇒ 只报，不判违规）');
  }
  if (r.ledgerIssue) console.log(`[判定③台账投影] ⚠️ ${r.ledgerIssue}`);
  const bad = verdict(r);
  console.log(`[汇总] 轮次 ${r.seq.length} 个 · 声明 ${r.decls.length} 条 ⇒ ${bad ? 'FAIL' : 'PASS'}`);
  return bad ? EXIT.FAIL : EXIT.OK;
}

export function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-rounds-');
  const good = writeTmp(dir, 'good.md', [
    '# 第 1 轮审核 · A',
    '> **本轮 = 第 1 轮（重计数第 1 轮）**',
    '# 第 2 轮审核 · B',
    '> **本轮 = 第 2 轮（重计数第 2 轮）**',
    '# 第 3 轮审核 · C',
    '> **本轮 = 第 3 轮（重计数第 3 轮）**',
  ].join('\n'));
  const bad = writeTmp(dir, 'bad.md', [
    '# 第 1 轮审核 · A',
    '# 第 3 轮审核 · C',
  ].join('\n'));
  const s1 = scan(fs.readFileSync(good, 'utf8'));
  assertEq(s1.gaps, [], '连续轮次 ⇒ 无断点', res);
  assertTrue(s1.declOk, '声明双序列单调 +1', res);
  const s2 = scan(fs.readFileSync(bad, 'utf8'));
  assertEq(s2.gaps.length, 1, '跳号 ⇒ 报 1 个断点', res);
  assertEq([s2.gaps[0].from, s2.gaps[0].to], [1, 3], '断点两侧轮次', res);
  const s3 = scan('# 第 1 轮审核 · A\n# 第 2 轮审核 · B\n# 第 2 轮审核 · B2\n# 第 3 轮审核 · C\n');
  assertEq(s3.seq.map((x) => x.round), [1, 2, 3], '重复轮次（回指 / 同轮多章节）只取首见', res);
  // G-1 回归：真源台账是 `records` 形态（顶层无 roundNo）—— 改前此处静默假绿（什么都没说）
  const ledRec = writeTmp(dir, 'ledger-records.json', JSON.stringify({
    schemaVersion: 1,
    records: [{ at: '2026-01-01T00:00:00.000Z', by: 'self-test', reason: '非生产样本', roundNo: 2 }],
  }));
  const rRec = run({ doc: good, ledger: ledRec });
  assertTrue(typeof rRec.ledgerIssue === 'string' && rRec.ledgerIssue.includes('台账 roundNo=2') && rRec.ledgerIssue.includes('末轮 3'),
    'records 形态台账：取末条 roundNo 并与审核档末轮比对（改前静默假绿）', res, `实际：${JSON.stringify(rRec.ledgerIssue)}`);
  // G-1 回归：形态不认识 ⇒ 必须显式报「未核」，不得静默
  const ledOdd = writeTmp(dir, 'ledger-unknown.json', JSON.stringify({ foo: 1 }));
  const rOdd = run({ doc: good, ledger: ledOdd });
  assertTrue(typeof rOdd.ledgerIssue === 'string' && rOdd.ledgerIssue.includes('未核'),
    '台账形态不认识 ⇒ 显式报「未核」（fail-visible，不静默）', res, `实际：${JSON.stringify(rOdd.ledgerIssue)}`);
  rmrf(dir);
  finishSelfTest('check-rounds', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'ledger'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '轮次单调（第 3 / 4 条）',
      usage: 'node check-rounds.mjs --doc <审核档|回修报告> [--ledger <台账 json>] [--json]',
      form: ['档路径 · sha16', '序 / 轮次 / 首见行号 / 首见标题（截 60）', '判定①单调 +1（附断点）· 判定②声明双序列单调 +1 · 判定③台账投影提示', '[汇总] 一行'],
      caliber: ['轮次靠标题行与「本轮 = 第 N 轮（重计数第 M 轮）」声明**动态抽取**，脚本内无硬编码行号',
        '同一轮出现多次（回指 / 同轮多章节）只取**首见**，避免回指被误判成跳号',
        '台账 roundNo 只是投影：与审核档不符 ⇒ 以审核档为准，脚本只提示'],
      scope: { docs: '审核档 + 回修报告', stage: '每轮审核收尾', who: '审核方' },
      exits: ['0 = 单调通过', '3 = 有断点 / 声明序列不单调', '2 = 用法错'],
      selfTest: 'node check-rounds.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    selfTest();
  } else if (!a.doc) {
    console.log('✗ 缺 --doc（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else {
    const r = run({ doc: a.doc, ledger: a.ledger });
    if (a.json) {
      // G-1b：本 CLI 一直在用法 / README 里宣称 [--json]，却从没实现（喂 --json 出的是文本）
      // ⇒ 现按宣称输出机器可读 JSON（= run() 返回值原文；退出码口径与文本模式同源 verdict()）
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = verdict(r) ? EXIT.FAIL : EXIT.OK;
    } else {
      process.exitCode = report(r);
    }
  }
}
