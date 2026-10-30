#!/usr/bin/env node
// _test/test-self-audit.mjs —— 交付前自批（六条判据）单测
//
// 重点在两条最容易变成"自证"的判据：
//   ③ 有未决项却没「待拍板」段 ⇒ 红（不是"看着有就行"）；
//   ④ 内部标识走三层：字面量表缺类别判红 · 报告里出现「P0 段未启用」判红 ·
//      既没给机器层读数也没跑阴性对照 ⇒ 只能判黄（"证据不足"不等于通过）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newResults, assertEq, assertTrue, finishSelfTest, rmrf } from '../docs-discipline/lib/common.mjs';
import { loadTables } from '../lib/deny-literal.mjs';
import { auditReport, verdictOf, findCommands, findPendingLines, hasPendingSection, extractCitedPaths, parseMachineReport } from '../lib/self-audit-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE_DIR = path.resolve(HERE, '..', 'config');
const TMP = path.join(os.tmpdir(), `k7-audit-${process.pid}-${Date.now().toString(36)}`);
const WS = path.join(TMP, 'ws');
const res = newResults();
const tables = loadTables(TABLE_DIR);

const DOD = [
  '## DoD 十条',
  '1. [x] ① 语法真跑（node --check 全绿）',
  '2. [x] ② 隔离/夹具',
  '3. [x] ③ 回滚点且演练',
  '4. [x] ④ 生产有备份',
  '5. [x] ⑤ 流水一行',
  '6. [x] ⑥ 过 P5',
  '7. [x] ⑦ 六包回写',
  '8. [x] ⑧ 不越授权细则',
  '9. [x] ⑨ 判据可现跑',
  '10. [x] ⑩ 未查证如实登记',
].join('\n');

const GOOD = `# 交付报告 · 样例件

${DOD}

## 当次命令原文

\`\`\`powershell
node dsh-ref-scan.mjs --help
node dsh-self-audit.mjs report.md
\`\`\`

## 待拍板

- 待拍板：要不要在下一批里把这条判据改成可配置。

## 正文

证据见 \`docs/other.md\` 这一份。
`;

function put(rel, content) {
  const p = path.join(WS, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

try {
  put('docs/other.md', '# 被引用的文件\n');
  const good = put('docs/report-good.md', GOOD);
  const machine = put('scan.txt', '注入的私有标识词表（P0）：4 条\nhits=0 allow=0 review=0\n');
  const negctlOk = { ok: true };

  const r1 = auditReport({ file: good, tables, machineReport: machine, negctl: negctlOk });
  assertEq(r1.checks.map((c) => c.state), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass'], 'A1 六条全绿', res);
  assertEq(verdictOf(r1.tally), { id: 'green', zh: '绿（六条全过）', rc: 0 }, 'A2 全绿 ⇒ rc 0', res);
  assertTrue(r1.checks[5].evidence[0].includes('引用路径 1 条'), 'A3 引用路径只算真引用（1 条）', res, r1.checks[5].evidence[0]);

  // ---------------- B. ① DoD 块
  const noDod = put('docs/report-nodod.md', GOOD.replace(/## DoD 十条[\s\S]*?\n\n/, ''));
  const r2 = auditReport({ file: noDod, tables, machineReport: machine, negctl: negctlOk });
  assertEq(r2.checks[0].state, 'fail', 'B1 没有 DoD 块 ⇒ 判红', res);
  assertEq(verdictOf(r2.tally).rc, 4, 'B2 有红 ⇒ rc 4（停止发布）', res);
  const shortDod = put('docs/report-shortdod.md', GOOD.replace('10. [x] ⑩ 未查证如实登记\n', ''));
  assertEq(auditReport({ file: shortDod, tables, machineReport: machine, negctl: negctlOk }).checks[0].state, 'fail', 'B3 DoD 条目不足 10 条 ⇒ 判红（不是"有标题就算"）', res);

  // ---------------- C. ② 当次命令原文
  const noCmd = put('docs/report-nocmd.md', GOOD.replace(/```powershell[\s\S]*?```/, '跑过了，都过了。'));
  const r3 = auditReport({ file: noCmd, tables, machineReport: machine, negctl: negctlOk });
  assertEq(r3.checks[1].state, 'fail', 'C1 没有围栏命令行 ⇒ 判红（"跑过了"不算）', res);
  assertEq(findCommands(['```', 'node a.mjs --help', '```']).length, 1, 'C2 围栏内命令行识别', res);
  assertEq(findCommands(['node a.mjs --help']).length, 0, 'C3 围栏外的裸命令行不算"当次命令原文"', res);

  // ---------------- D. ③ 待拍板段
  const pendNoSection = put('docs/report-pend.md', GOOD.replace('## 待拍板\n\n- 待拍板：要不要在下一批里把这条判据改成可配置。', '- 另外：待确认一下要不要改配置。'));
  const r4 = auditReport({ file: pendNoSection, tables, machineReport: machine, negctl: negctlOk });
  assertEq(r4.checks[2].state, 'fail', 'D1 有未决项却没有「待拍板」段 ⇒ 判红', res);
  assertTrue(findPendingLines(['- 待确认一下']).length === 1, 'D2 未决项标记能认出来', res);
  assertTrue(findPendingLines(['本次无待拍板项']).length === 0, 'D3 "无待拍板"这种否定式不算未决项', res);
  assertTrue(hasPendingSection(['## 待拍板']), 'D4 段标题识别', res);
  const noPending = put('docs/report-nopend.md', GOOD.replace('## 待拍板\n\n- 待拍板：要不要在下一批里把这条判据改成可配置。\n', ''));
  assertEq(auditReport({ file: noPending, tables, machineReport: machine, negctl: negctlOk }).checks[2].state, 'pass', 'D5 没有未决项 ⇒ 不要求该段', res);

  // ---------------- E. ④ 内部标识三层
  const withId = put('docs/report-id.md', `${GOOD}\n另外本机是【设备：某机】上跑的。\n`);
  const r5 = auditReport({ file: withId, tables, machineReport: machine, negctl: negctlOk });
  assertEq(r5.checks[3].state, 'fail', 'E1 正文裸写内部标识 ⇒ 判红', res);
  assertTrue(r5.checks[3].evidence.some((e) => e.includes('device-tag')), 'E2 指名是哪一类（device-tag）', res, r5.checks[3].evidence.join(' | '));

  const fencedId = put('docs/report-id-fence.md', `${GOOD}\n命令里出现的路径不算泄漏：\n\n\`\`\`\nC:\\some\\dir\\x.mjs\n\`\`\`\n`);
  assertEq(auditReport({ file: fencedId, tables, machineReport: machine, negctl: negctlOk }).checks[3].state, 'pass', 'E3 围栏内的命令原文 ⇒ allow，不阻断', res);

  const incomplete = put('docs/report-incomplete.md', `${GOOD}\n- 注入的私有标识词表（P0）：本次扫描不完整，请补词表后重跑\n`);
  assertEq(auditReport({ file: incomplete, tables, machineReport: machine, negctl: negctlOk }).checks[3].state, 'fail', 'E4 报告里出现「本次扫描不完整」⇒ 机器层不过（不看 rc）', res);

  const badMachine = put('bad-scan.txt', '注入的私有标识词表（P0）：未提供 ⇒ P0 段未启用（**本次扫描不完整**）\nhits=0 allow=0 review=0\n');
  assertEq(auditReport({ file: good, tables, machineReport: badMachine, negctl: negctlOk }).checks[3].state, 'fail', 'E5 机器层报告说"P0 段未启用"⇒ 判红（hits=0 也不许放行）', res);

  const reviewMachine = put('review-scan.txt', 'hits=3 allow=2 review=1\n');
  assertEq(auditReport({ file: good, tables, machineReport: reviewMachine, negctl: negctlOk }).checks[3].state, 'fail', 'E6 机器层 review>0 ⇒ 判红', res);

  const noEvidence = auditReport({ file: good, tables });
  assertEq(noEvidence.checks[3].state, 'warn', 'E7 既没机器层也没阴性对照 ⇒ 只判黄（证据不足≠通过）', res);
  assertEq(verdictOf(noEvidence.tally).rc, 3, 'E8 有黄 ⇒ rc 3', res);

  const badTablesDir = path.join(TMP, 'badcfg');
  fs.mkdirSync(badTablesDir, { recursive: true });
  fs.copyFileSync(path.join(TABLE_DIR, 'deny-words.txt'), path.join(badTablesDir, 'deny-words.txt'));
  fs.writeFileSync(path.join(badTablesDir, 'deny-patterns.txt'), 'device-tag\t【设备[：:]\n', 'utf8');
  const badTables = loadTables(badTablesDir);
  const r6 = auditReport({ file: good, tables: badTables, machineReport: machine, negctl: negctlOk });
  assertEq(r6.checks[3].state, 'fail', 'E9 字面量表缺类别 ⇒ 判红（7 类是最小要求）', res);
  assertTrue(r6.checks[3].evidence[0].includes('缺 4 类'), 'E10 点名缺了几类（只留 device-tag 的两类来源 ⇒ 缺 4 类）', res, r6.checks[3].evidence[0]);

  const badNegctl = auditReport({ file: good, tables, machineReport: machine, negctl: { ok: false } });
  assertEq(badNegctl.checks[3].state, 'fail', 'E11 阴性对照失效 ⇒ 判红（闸门是死的）', res);

  // ---------------- F. ⑤⑥ 报告存在 / 引用文件存在
  const ghost = auditReport({ file: path.join(WS, 'docs', 'no-such-report.md'), tables });
  assertEq([ghost.checks[0].id, ghost.checks[0].state], [5, 'fail'], 'F1 报告不存在 ⇒ 只出第 ⑤ 条并判红', res);

  const missingCite = put('docs/report-missing.md', `${GOOD}\n另见 \`docs/not-here.md\`。\n`);
  const r7 = auditReport({ file: missingCite, tables, machineReport: machine, negctl: negctlOk });
  assertEq(r7.checks[5].state, 'fail', 'F2 正文引用了不存在的文件 ⇒ 判红', res);
  assertTrue(r7.checks[5].evidence.some((e) => e.includes('docs/not-here.md')), 'F3 点名是哪个文件找不到', res);

  const cited = extractCitedPaths('见 `docs/a.md` 与 `docs/<待填>.md` 与 https://example.invalid/x.md');
  assertEq(cited.map((c) => c.raw), ['docs/a.md'], 'F4 占位符与 URL 不算引用', res);

  const fencedCite = put('docs/report-fenced-cite.md', `${GOOD}\n\n\`\`\`powershell\nnode tools/not-here.mjs\n\`\`\`\n`);
  const r8 = auditReport({ file: fencedCite, tables, machineReport: machine, negctl: negctlOk });
  assertEq(r8.checks[5].state, 'pass', 'F5 围栏里的命令不算引用（那是第 ② 条的事）', res);

  const repoRel = put('docs/report-repo-rel.md', `${GOOD}\n另见 \`lib/cli-args.mjs\` 与 \`scripts/check-cli-help.mjs\`。\n`);
  const r9 = auditReport({ file: repoRel, tables, machineReport: machine, negctl: negctlOk });
  assertEq(r9.checks[5].state, 'pass', 'F6 仓内相对路径（首段不在扫描根下）⇒ 记"跳过"，不冒充缺文件', res);
  assertTrue(r9.checks[5].evidence[0].includes('跳过'), 'F7 跳过条数写进证据（不静默）', res, r9.checks[5].evidence[0]);

  const misSplit = extractCitedPaths('| 10 | repo | `board-act` | `board-tools/board-act.mjs` | 说明 |');
  assertEq(misSplit.map((c) => c.raw), ['board-tools/board-act.mjs'], 'F8 不把 `board-tools/x.mjs` 截成 `tools/x.mjs`', res);

  // ---------------- G. 机器层报告的两种措辞都要认（英文 key=value / 中文「命中：N（放行 A / 待复核 R）」）
  const zhReport = [
    '# 脱敏扫描报告',
    '- 注入的私有标识词表（P0）：3 条',
    '- 命中：0（放行 0 / 待复核 0）',
  ].join('\n');
  const parsed = parseMachineReport(zhReport);
  assertEq([parsed.p0Injected, parsed.p0Count, parsed.hits, parsed.allow, parsed.review], [true, 3, 0, 0, 0], 'G1 中文措辞的读数解析（P0 条数 / 命中 / 放行 / 待复核）', res);
  const zhFile = put('scan-zh.txt', zhReport);
  assertEq(auditReport({ file: good, tables, machineReport: zhFile, negctl: negctlOk }).checks[3].state, 'pass', 'G2 中文措辞的机器层报告 ⇒ 判过（不必逼用户改扫描器输出）', res);

  const noP0 = put('scan-nop0.txt', '- 命中：0（放行 0 / 待复核 0）\n');
  assertEq(auditReport({ file: good, tables, machineReport: noP0, negctl: negctlOk }).checks[3].state, 'warn', 'G3 看不到 P0 注入证据 ⇒ 只判黄（干净但不完整不算过）', res);
  assertEq(parseMachineReport(fs.readFileSync(noP0, 'utf8')).p0Injected, false, 'G4 没有 P0 行 ⇒ p0Injected=false', res);
} finally {
  rmrf(TMP);
}

finishSelfTest('test-self-audit', res);
