#!/usr/bin/env node
// _test/test-sim-scan.mjs —— 同源度扫描单测
//
// 盯六件事：
//   ① 同名件按 basename 匹配，扩展名与 skip 目录按配置走；
//   ② 行级用**多重集扣减**（同一行出现 3 次、对端只有 1 次 ⇒ 只扣到 1）；
//   ③ 同名候选取**行同度最高者**（不是第一份）；
//   ④ 三档分桶 + 主结论列「≥50% 行同占比」的算术；
//   ⑤ 与基线对比时，差异**逐行给可复现原因**；归不上三种原因就明说"无法归因"（不许蒙）；
//   ⑥ 仓根下 `_backup` / `_publish` 这类目录不算仓（不进分母）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { newResults, assertEq, assertTrue, finishSelfTest, rmrf } from '../docs-discipline/lib/common.mjs';
import {
  buildProductionIndex, scanRepo, scanAll, lineRatio, verdictFor, caliberFingerprint,
  compareBaseline, gitDirtyCount, listRepos,
} from '../lib/sim-scan-core.mjs';

const TMP = path.join(os.tmpdir(), `k7-sim-${process.pid}-${Date.now().toString(36)}`);
const PROD = path.join(TMP, 'prod');
const OSS = path.join(TMP, 'oss');
const REPO = path.join(OSS, 'dsh-r1');
const res = newResults();

const CFG = {
  caliber: 'test-v1',
  ext: ['.mjs', '.ps1'],
  skipDirs: ['node_modules'],
  production: { roots: [{ path: 'tools', mode: 'recursive' }, { path: '.', mode: 'root-files' }] },
  repo: { roots: [{ path: '.', mode: 'recursive' }], minFilesToJudge: 1 },
  buckets: { high: 0.9, mid: 0.5 },
  verdict: [
    { minPct: 90, label: 'near-source-copy', zh: '近源副本' },
    { minPct: 50, label: 'partial-rewrite', zh: '部分重写' },
    { minPct: 0, label: 'rewrite-first', zh: '重写为主' },
  ],
};
const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n') + '\n';

function put(base, rel, content) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

try {
  // 生产面：tools/ 递归 + 根下文件
  put(PROD, 'tools/p1/a.mjs', lines('A', 10));      // a 的最佳候选
  put(PROD, 'tools/p2/a.mjs', lines('A', 3));       // a 的次佳候选（只看第一份会误判）
  put(PROD, 'tools/b.mjs', lines('B', 10));
  put(PROD, 'tools/c.mjs', lines('C', 8));
  put(PROD, 'tools/e.mjs', 'E1\n');                 // 只有 1 行，用于多重集扣减
  put(PROD, 'tools/f.mjs', lines('F', 5));
  put(PROD, 'root.ps1', lines('R', 3));

  // 仓：一份逐字节同 / 一份近 90 / 两份 50–90 / 一份多重集对不上 / 一份没有同名件
  put(REPO, 'a.mjs', `A-extra\n${lines('A', 10)}`);      // 10/11 ≈ 0.909 ⇒ ≥90%
  put(REPO, 'b.mjs', `${lines('B', 7)}${lines('X', 3)}`); // 7/10 = 0.7 ⇒ 50–90%
  put(REPO, 'c.mjs', `${lines('C', 4)}${lines('Y', 4)}`); // 4/8 = 0.5 ⇒ 50–90%（边界）
  put(REPO, 'e.mjs', 'E1\nE1\nE1\nZ1\n');                // 多重集：只扣到 1 ⇒ 1/4
  put(REPO, 'f.mjs', lines('F', 5));                     // 逐字节同
  put(REPO, 'no-such.mjs', 'Q1\nQ2\n');                  // 没有同名件
  put(OSS, '_backup/a.mjs', lines('A', 10));             // 不是仓，不进分母
  put(OSS, 'dsh-empty/readme.txt', 'nothing here\n');    // 没有同名件 ⇒ 判不了

  const index = buildProductionIndex({ prodRoot: PROD, cfg: CFG });
  assertEq(index.fileCount, 7, 'A1 生产面列了 7 个件（tools 递归 6 + 根下 1）', res);
  assertTrue(index.byName.get('a.mjs')?.length === 2, 'A2 同名多候选都进索引（取最高者的前提）', res);

  // ---------------- B. 行同度与分桶
  assertEq(lineRatio(['x', 'x', 'x'], ['x']), 1 / 3, 'B1 多重集扣减：3 次对 1 次 ⇒ 只扣到 1/3', res);
  assertEq(lineRatio(['x', 'y'], ['y', 'x']), 1, 'B2 顺序无关', res);
  assertEq(lineRatio([], ['x']), 0, 'B3 空文件 ⇒ 0（不炸也不白给）', res);
  assertEq(verdictFor(93, CFG).label, 'near-source-copy', 'B4 93% ⇒ 近源副本', res);
  assertEq(verdictFor(50, CFG).label, 'partial-rewrite', 'B5 50% ⇒ 部分重写（边界含）', res);
  assertEq(verdictFor(49, CFG).label, 'rewrite-first', 'B6 49% ⇒ 重写为主', res);

  const row = scanRepo({ repoPath: REPO, index, cfg: CFG, collectDetail: true });
  assertEq(row.sameName, 5, 'C1 同名件 5 个（no-such.mjs 不算）', res);
  assertEq([row.identical, row.near90, row.mid, row.low], [1, 1, 2, 1], 'C2 逐字节同 1 / ≥90% 1 / 50–90% 2 / <50% 1', res);
  assertEq(row.pct, 80, 'C3 主结论列 = (1+1+2)/5 = 80%', res);
  assertEq(row.verdict.zh, '部分重写', 'C4 判定跟着主结论列走', res);
  const aDetail = row.detail.find((d) => d.file === 'a.mjs');
  assertEq(aDetail.candidate, 'tools/p1/a.mjs', 'C5 多候选时取行同度最高者（不是第一份）', res);
  assertEq(aDetail.ratio, 90.9, 'C6 行同度百分比保留 1 位小数', res);
  const eDetail = row.detail.find((d) => d.file === 'e.mjs');
  assertEq(eDetail.ratio, 25, 'C7 多重集：E1 三行只扣到一行 ⇒ 25%（集合包含会给 75%）', res);

  // ---------------- D. 仓根过滤与脏项数
  const repos = listRepos(OSS, CFG).map((p) => path.basename(p));
  assertEq(repos, ['dsh-empty', 'dsh-r1'], 'D1 仓根下只收 dsh-* 目录（_backup 不进分母）', res);
  const rows = scanAll({ repoRoot: OSS, index, cfg: CFG });
  assertEq(rows.map((r) => [r.repo, r.sameName]), [['dsh-r1', 5], ['dsh-empty', 0]], 'D2 每个仓一行，按同名件降序', res);
  const empty = rows.find((r) => r.repo === 'dsh-empty');
  assertEq(empty.judged, false, 'D3 同名件为 0 ⇒ 判不了（不判"重写为主"，那是白给分）', res);
  assertEq(empty.verdict.label, 'not-judgeable', 'D4 判不了的标记', res);
  assertEq(gitDirtyCount(REPO), null, 'D5 非 git 目录 ⇒ 脏项数如实给 null', res);

  const gitRepo = path.join(TMP, 'gitrepo');
  fs.mkdirSync(gitRepo, { recursive: true });
  const g = (args) => spawnSync('git', ['-C', gitRepo, ...args], { encoding: 'utf8' });
  const hasGit = !g(['init']).error;
  if (hasGit) {
    g(['config', 'user.email', 't@example.invalid']);
    g(['config', 'user.name', 't']);
    put(gitRepo, 'x.mjs', 'x1\n');
    g(['add', '-A']);
    g(['commit', '-m', 'init']);
    assertEq(gitDirtyCount(gitRepo), 0, 'D6 干净 git 仓 ⇒ 脏项 0', res);
    fs.writeFileSync(path.join(gitRepo, 'x.mjs'), 'x2\n', 'utf8');
    assertEq(gitDirtyCount(gitRepo), 1, 'D7 改一个文件 ⇒ 脏项 1（表头要打的就是这个数）', res);
  } else {
    assertTrue(true, 'D6/D7 跳过（本机没有 git）', res);
  }

  // ---------------- E. 与基线对比：差异逐行给原因，归不上就明说
  const cal = caliberFingerprint(CFG);
  const baseRow = { repo: 'dsh-r1', sameName: 5, identical: 1, near90: 1, mid: 2, low: 1, pct: 80 };
  const mk = (over) => ({ at: '2026-10-30T00:00:00+08:00', caliber: cal, rows: [{ ...baseRow, ...over }] });

  const same = compareBaseline({ rows, baseline: mk({}), cfg: CFG, prodRoot: PROD });
  assertEq(same.diffRows, 0, 'E1 数字全等 ⇒ 差异 0 行', res);

  const t1 = compareBaseline({ rows, baseline: mk({ mid: 9 }), cfg: CFG, prodRoot: PROD });
  assertEq([t1.diffRows, t1.diffs[0].reason], [1, 'time-point'], 'E2 无新提交但有更新文件 ⇒ 取数时点不同', res);
  assertTrue(t1.diffs[0].cols.some((c) => c.col === 'mid' && c.baseline === 9 && c.now === 2), 'E3 差异逐列给出旧值→新值', res);

  const t2 = compareBaseline({ rows, baseline: { at: '2099-01-01T00:00:00+08:00', caliber: cal, rows: [{ ...baseRow, mid: 9 }] }, cfg: CFG, prodRoot: PROD });
  assertEq([t2.diffRows, t2.diffs[0].reason], [1, 'unattributed'], 'E4 口径同、无提交、文件未更新 ⇒ 判"无法归因"（不许拿时点糊过去）', res);

  const t3 = compareBaseline({ rows, baseline: { at: '2026-10-30T00:00:00+08:00', caliber: 'ext=.txt', rows: [{ ...baseRow, mid: 9 }] }, cfg: CFG, prodRoot: PROD });
  assertEq([t3.diffRows, t3.diffs[0].reason], [1, 'caliber'], 'E5 口径指纹不同 ⇒ 归因为口径差异', res);
} finally {
  rmrf(TMP);
}

finishSelfTest('test-sim-scan', res);
