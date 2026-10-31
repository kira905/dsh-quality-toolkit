#!/usr/bin/env node
// _test/test-deny-literal.mjs —— 脱敏第三层（字面量表）单测
//
// 主要盯四件事：
//   ① 7 类**每类至少 1 条**才算过 —— "非空"不算过（3 个词的合法空表就是漏洞）；
//   ② 坏正则必须被抓出来并指出行号（静默跳过 = 悄悄收窄闸门）；
//   ③ 命中落在围栏代码块 / 行内反引号 / 引用块里 ⇒ allow（命令原文·被引用证据·原文摘录），其余算待复核；
//   ④ 两份表自身在扫描时被跳过（否则它们必然命中自己）；
//   ⑤ 允许规则的第 4 列「值锚」：只放行**命中文本逐字相等**的那一个字面量，
//      换一个端口 / 换一类标识照样判 review（放行粒度是值，不是整个文件）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newResults, assertEq, assertTrue, finishSelfTest, rmrf } from '../docs-discipline/lib/common.mjs';
import { loadTables, auditTables, scanText, scanDir, configuredAllow, CATEGORIES, mask, ALLOW_REASONS } from '../lib/deny-literal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), `k7-deny-${process.pid}-${Date.now().toString(36)}`);
const res = newResults();

const WORDS = [
  'device-tag\t【设备：',
  'host-name\tDESKTOP-',
  'mainline-name\t主线「',
].join('\n');

const PATTERNS = [
  'device-tag\t【设备[：:]',
  'stick-number\t第\\s*[0-9]{1,3}\\s*棒',
  'card-number\t卡[\\s　]*[0-9a-fA-F]{4,}',
  'mainline-name\t主线「[^」\\n]{1,40}」',
  'internal-report\t交付报告-[^\\s）)\\]]{1,60}-[0-9]{8}',
  'host-name\t(?<![A-Za-z0-9])(?:DESKTOP|LAPTOP)-[A-Z0-9]{4,}(?![A-Za-z0-9])',
  'drive-port\t(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]',
  'drive-port\t(?:127\\.0\\.0\\.1|localhost):[0-9]{2,5}',
].join('\n');

function makeTables(dir, { words = WORDS, patterns = PATTERNS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (words !== null) fs.writeFileSync(path.join(dir, 'deny-words.txt'), `${words}\n`, 'utf8');
  if (patterns !== null) fs.writeFileSync(path.join(dir, 'deny-patterns.txt'), `${patterns}\n`, 'utf8');
  return loadTables(dir);
}

try {
  // ---------------- A. 表结构判据
  const okDir = path.join(TMP, 'ok');
  const okTables = makeTables(okDir);
  const okAudit = auditTables(okTables);
  assertEq(okAudit.missing, [], 'A1 7 类每类 ≥1 条 ⇒ 无缺失', res);
  assertTrue(okAudit.ok, 'A2 表结构通过', res, JSON.stringify(okAudit.parseErrors));
  assertEq(okAudit.rows.map((r) => r.id), CATEGORIES.map((c) => c.id), 'A3 类别清单与 CATEGORIES 同序', res);
  assertTrue(okAudit.rows.every((r) => r.total >= 1), 'A4 每一类都有条目', res, JSON.stringify(okAudit.rows.map((r) => [r.id, r.total])));

  const missingDir = path.join(TMP, 'missing');
  const missingTables = makeTables(missingDir, {
    words: WORDS,
    patterns: PATTERNS.split('\n').filter((l) => !l.startsWith('card-number')).join('\n'),
  });
  const missingAudit = auditTables(missingTables);
  assertEq(missingAudit.missing, ['card-number'], 'A5 删掉 card-number 两类来源 ⇒ 判红并点名缺哪类', res);
  assertTrue(!missingAudit.ok, 'A6 缺类别 ⇒ ok=false（不是"非空就算过"）', res);

  const badDir = path.join(TMP, 'badre');
  const badTables = makeTables(badDir, { words: WORDS, patterns: `${PATTERNS}\ncard-number\t卡([0-9` });
  const badAudit = auditTables(badTables);
  assertTrue(badAudit.parseErrors.length >= 1, 'A7 坏正则被抓出来（不静默跳过）', res, JSON.stringify(badAudit.parseErrors));
  assertTrue(badAudit.parseErrors.every((e) => typeof e.line === 'number'), 'A8 解析错误带行号', res);
  assertTrue(!badAudit.ok, 'A9 有解析错误 ⇒ ok=false', res);

  // ---------------- B. 命中与 allow 判据
  const SAMPLE = [
    '【设备：某机】',
    '第 12 棒',
    '卡 7cc6a8fc',
    '主线「某主线」',
    '交付报告-某件-20260101.md',
    'DESKTOP-ABCD1234',
    'X:\\some\\path',
  ].join('\n');
  const hits = scanText(SAMPLE, okTables, { file: 'sample.txt' });
  const review = hits.filter((h) => !h.allow);
  assertTrue(review.length >= 7, 'B1 7 类样本逐行命中（每行至少一条待复核）', res, `实际 ${review.length} 条`);
  const covered = new Set(review.map((h) => h.category));
  assertEq([...covered].sort(), CATEGORIES.map((c) => c.id).sort(), 'B2 7 类全部命中（类别不漏）', res);
  assertTrue(hits.every((h) => h.masked.length <= 13), 'B3 输出默认打码（≤ 12 字 + 省略号）', res, hits[0]?.masked);
  assertEq(mask('abcdefghijklmnop'), 'abcdefghijkl…', 'B4 mask 保前 12 字', res);

  const fenced = ['```powershell', ...SAMPLE.split('\n'), '```'].join('\n');
  const fencedHits = scanText(fenced, okTables, { file: 'fenced.md' });
  assertTrue(fencedHits.length > 0 && fencedHits.every((h) => h.allow), 'B5 围栏代码块内 ⇒ 全部 allow（命令原文）', res);
  assertTrue(fencedHits.every((h) => h.allowReason === ALLOW_REASONS.fence), 'B6 allow 理由 = 可执行命令原文', res);

  const inline = '见 `X:\\some\\path` 这一处';
  const inlineHits = scanText(inline, okTables, { file: 'inline.md' });
  assertTrue(inlineHits.length > 0 && inlineHits.every((h) => h.allow && h.allowReason === ALLOW_REASONS.inline), 'B7 行内反引号内 ⇒ allow（被引用证据）', res);

  const quoted = '> 原文：第 12 棒，来自某记录';
  const quotedHits = scanText(quoted, okTables, { file: 'quote.md' });
  assertTrue(quotedHits.every((h) => h.allow && h.allowReason === ALLOW_REASONS.quote), 'B8 引用块 ⇒ allow（原文摘录）', res);

  // ---------------- C. 目录扫描：两份表自身被跳过
  const tree = path.join(TMP, 'tree');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, 'doc.md'), '正文里有一条 【设备：某机】\n', 'utf8');
  fs.writeFileSync(path.join(tree, 'clean.md'), '干净文件，什么都没有\n', 'utf8');
  fs.copyFileSync(path.join(okDir, 'deny-words.txt'), path.join(tree, 'deny-words.txt'));
  fs.copyFileSync(path.join(okDir, 'deny-patterns.txt'), path.join(tree, 'deny-patterns.txt'));
  fs.mkdirSync(path.join(tree, 'node_modules'));
  fs.writeFileSync(path.join(tree, 'node_modules', 'x.md'), '【设备：不该被扫】\n', 'utf8');
  const scanned = scanDir(tree, okTables);
  assertEq(scanned.summary.scanned, 2, 'C1 只扫 2 个正文文件（表自身与 node_modules 被跳过）', res);
  assertTrue(scanned.hits.every((h) => path.basename(h.file) === 'doc.md'), 'C2 命中只来自正文（表自身不命中自己）', res);
  assertTrue(scanned.skipped.dirs.includes('node_modules'), 'C3 跳过目录记进证据（skipped.dirs）', res);

  const skipAbsTree = scanDir(tree, okTables, { skipAbs: [tree] });
  assertEq(skipAbsTree.summary.scanned, 0, 'C4 skipAbs 前缀黑名单生效（阴性对照靠它排除仓外样本）', res);

  // ---------------- D. 本地表合并
  fs.writeFileSync(path.join(okDir, 'deny-words.local.txt'), 'host-name\t某私有主机\n', 'utf8');
  const withLocal = loadTables(okDir);
  assertTrue(withLocal.words.some((w) => w.raw === '某私有主机'), 'D1 .local.txt 私有词自动并表', res);
  assertTrue(auditTables(withLocal).ok, 'D2 并入私有词后仍然结构通过', res);

  // ---------------- E. 值锚定白名单（第 4 列）
  const anchorDir = path.join(TMP, 'anchor');
  makeTables(anchorDir);
  fs.writeFileSync(path.join(anchorDir, 'deny-allow.txt'), [
    '# 三列 = 只按路径放行（老格式，向后兼容）',
    'drive-port\t**/legacy.mjs\t夹具用合成盘符（假盘），不指向真机',
    '# 四列 = 值锚：命中文本逐字相等才放行',
    'drive-port\t**\t环回地址 + 产品公开缺省端口，不含机器信息\t127.0.0.1:3080',
  ].join('\n') + '\n', 'utf8');
  const anchorTables = loadTables(anchorDir);
  assertEq(anchorTables.errors, [], 'E1 四列允许规则解析零错误', res);

  const portHits = scanText('const B = "http://127.0.0.1:3080";', anchorTables, { file: 'app.mjs' });
  assertTrue(portHits.length === 1 && portHits[0].allow, 'E2 值锚命中 ⇒ allow', res, JSON.stringify(portHits));
  assertTrue(/值锚：127\.0\.0\.1:3080/.test(portHits[0].allowReason), 'E3 allow 理由里点名值锚（放行了什么可审）', res, portHits[0].allowReason);

  const otherPort = scanText('const C = "http://127.0.0.1:3081";', anchorTables, { file: 'app.mjs' });
  assertTrue(otherPort.length === 1 && !otherPort[0].allow, 'E4 换一个端口 ⇒ 照样待复核（值锚不放松整类）', res, JSON.stringify(otherPort));

  const tagHits = scanText('正文 【设备：某机】', anchorTables, { file: 'app.mjs' });
  assertTrue(tagHits.length > 0 && tagHits.every((h) => !h.allow), 'E5 值锚只作用于自己那条类别（别的类别照样待复核）', res, JSON.stringify(tagHits));

  const legacyHits = scanText('path X:\\a here', anchorTables, { file: 'sub/legacy.mjs' });
  assertTrue(legacyHits.length === 1 && legacyHits[0].allow, 'E6 三列老格式按路径放行（向后兼容）', res, JSON.stringify(legacyHits));

  assertEq(configuredAllow('app.mjs', 'drive-port', anchorTables, null), null, 'E7 不传命中文本 ⇒ 值锚规则不生效（保守，宁报 review 不误放）', res);
} finally {
  rmrf(TMP);
}

finishSelfTest('test-deny-literal', res);
