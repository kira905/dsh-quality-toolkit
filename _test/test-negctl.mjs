#!/usr/bin/env node
// _test/test-negctl.mjs —— 阴性对照四步时序单测（脱敏证伪层）
//
// 这条单测专门钉住 R3-M5 那个坑：样本放仓外（%TEMP%）+ 扫描器排除该路径
// ⇒ "扫描器必须判红"永远不可能被验证（它根本读不到样本）。
// 所以四步必须写死：① 注入（仓外）→ ② 复制进被扫目录 → ③ 扫 + 断言命中 → ④ 清理（跑完即删）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newResults, assertEq, assertTrue, finishSelfTest, rmrf } from '../docs-discipline/lib/common.mjs';
import { loadTables, scanDir } from '../lib/deny-literal.mjs';
import { runNegativeControl, negativeControlDir, sampleText, CORE_CATEGORIES } from '../lib/negctl.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE_DIR = path.resolve(HERE, '..', 'config');
const TMP = path.join(os.tmpdir(), `k7-negctl-${process.pid}-${Date.now().toString(36)}`);
const REPO_DIR = path.join(TMP, 'dsh-fake-repo');
const res = newResults();
const tables = loadTables(TABLE_DIR);

try {
  fs.mkdirSync(path.join(REPO_DIR, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(REPO_DIR, 'docs', 'a.md'), '# 一个干净的文件\n没有内部标识。\n', 'utf8');
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# fake repo\nreadme body\n', 'utf8');

  // 样本正文本身：7 类各一条
  const sampleLines = sampleText().trim().split('\n');
  assertEq(sampleLines.length, 7, 'A1 样本正文 7 行（7 类各一条）', res);

  const dir = negativeControlDir();
  const runId = 'testrun1';
  const sentinel = path.join(REPO_DIR, `.negctl-${runId}.txt`);
  const result = runNegativeControl({ dir: REPO_DIR, tables, runId });

  assertTrue(result.ok, 'B1 四步时序整体通过（闸门是活的）', res, JSON.stringify(result.steps.filter((s) => !s.ok)));
  assertEq(result.steps.map((s) => String(s.n)), ['1', '2', '3', '3b', '4'], 'B2 步骤次序 = 注入 → 复制 → 扫+断言 → 单文件直扫 → 清理', res);
  assertEq(result.steps[0].detail.includes('在仓外 = 是'), true, 'B3 第① 步落在仓外', res);
  assertEq(result.sampleFile.toLowerCase().startsWith(dir.toLowerCase()), true, 'B4 样本固定落 %TEMP%/oss-negative-control', res);
  assertTrue(!result.sampleFile.toLowerCase().startsWith(REPO_DIR.toLowerCase()), 'B5 样本不在被扫目录里（放仓内 = 自污染）', res);
  assertEq(result.core.missing, [], 'B6 三类核心（设备标签 / 盘符主机名 / 棒号卡号）全部命中', res);
  assertTrue(CORE_CATEGORIES.includes('device-tag') && CORE_CATEGORIES.includes('card-number'), 'B7 核心类别清单含设备标签与棒号卡号', res);

  // ④ 清理
  assertTrue(!fs.existsSync(sentinel), 'C1 哨兵文件跑完即删（仓内不留痕）', res);
  assertTrue(!fs.existsSync(result.sampleFile), 'C2 仓外样本跑完即删', res);
  assertEq(result.cleanup.leftovers, false, 'C3 cleanup 标记：仓内无残留', res);
  const after = scanDir(REPO_DIR, tables, { skipAbs: [dir], skipDirs: [] });
  assertEq(after.summary.hits, 0, 'C4 清理后整仓扫描命中归零（只扫自己不借样本凑数）', res);

  // 排除口径：正常扫描必须排除仓外样本目录
  const outside = path.join(TMP, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const stray = path.join(outside, 'stray.txt');
  fs.writeFileSync(stray, sampleText(), 'utf8');
  const withSkip = scanDir(TMP, tables, { skipAbs: [outside], skipDirs: [] });
  const withoutSkip = scanDir(TMP, tables, { skipDirs: [] });
  assertEq(withSkip.hits.filter((h) => h.file === stray).length, 0, 'D1 正常扫描排除仓外样本目录（不然它每次都是命中）', res);
  assertTrue(withoutSkip.hits.filter((h) => h.file === stray).length >= 7, 'D2 不排除时它确实会被扫到（说明 D1 不是"文件不存在"造成的巧合）', res);

  // keepSample 开关
  const keep = runNegativeControl({ dir: REPO_DIR, tables, runId: 'testrun2', keepSample: true });
  assertTrue(fs.existsSync(keep.sampleFile), 'E1 --keep-sample 时保留仓外样本（调试用）', res);
  fs.rmSync(keep.sampleFile);
  assertTrue(!fs.existsSync(path.join(REPO_DIR, '.negctl-testrun2.txt')), 'E2 即使保留样本，仓内哨兵照样删', res);
} finally {
  rmrf(TMP);
  try { fs.rmSync(path.join(negativeControlDir(), 'dsh-fake-repo.txt')); } catch { /* 已删 */ }
}

finishSelfTest('test-negctl', res);
