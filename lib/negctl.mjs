// negctl.mjs —— 脱敏第二层·证伪层：阴性对照四步时序
//
// 为什么要这套时序（一句话）：样本放在仓外（%TEMP%）且被扫描器排除，
// 那么"扫描器必须判红"这件事**永远不可能被验证** —— 它根本读不到样本。
// 所以四步必须写死：
//   ① 注入：把 7 类各一条的样本写到仓外固定路径  %TEMP%/oss-negative-control/<仓>.txt
//   ② 复制：把样本复制进**被扫目录**，用唯一哨兵名 .negctl-<runId>.txt
//   ③ 扫 + 断言：扫被扫目录（这一步刻意不排除哨兵），断言三类核心类别必须命中
//      （设备标签 / 盘符主机名 / 棒号卡号）
//   ④ 清理：finally 删掉哨兵与样本；再扫一次断言哨兵命中归零，并核 git 工作树没被污染
//
// "扫描器排除 %TEMP% 路径"只约束**正常扫描**（第 ③ 步之外），不约束阴性对照这一步 ——
// 这两件事不冲突，别混成一条。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanDir, scanText, CATEGORIES } from './deny-literal.mjs';

/** 三类核心类别：它们的样本必须命中，否则闸门是死的。 */
export const CORE_CATEGORIES = ['device-tag', 'host-name', 'stick-number', 'card-number'];

/** 样本正文：7 类各一条。刻意用通用样例，不含任何私有真值。 */
export function sampleText() {
  const b = '\\';
  return [
    `device-tag\t【设备：样例机】`,
    `stick-number\t第 42 棒`,
    `card-number\t卡 7cc6a8fc`,
    `mainline-name\t主线「样例主线」`,
    `internal-report\t交付报告-样例件-20260101.md`,
    `host-name\tDESKTOP-ABCD1234`,
    `drive-port\tC:${b}样例${b}路径 与 127.0.0.1:3080`,
  ].join('\n') + '\n';
}

export function negativeControlDir() {
  return path.join(os.tmpdir(), 'oss-negative-control');
}

function gitStatusCount(dir) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * 跑四步时序。dir = 被扫目录（一个仓），tables = loadTables() 的结果。
 * 返回 { ok, steps, core, cleanup } —— 每一步都带人话 detail，便于原样贴进交付报告。
 */
export function runNegativeControl({ dir, tables, runId = Date.now().toString(36), keepSample = false }) {
  const absDir = path.resolve(dir);
  const repoName = path.basename(absDir);
  const sampleDir = negativeControlDir();
  const sampleFile = path.join(sampleDir, `${repoName}.txt`);
  const sentinelName = `.negctl-${runId}.txt`;
  const sentinel = path.join(absDir, sentinelName);
  const steps = [];
  let ok = true;
  let core = { covered: [], missing: [] };
  let cleanup = {};

  const step = (n, name, good, detail) => {
    steps.push({ n, name, ok: good, detail });
    if (!good) ok = false;
    return good;
  };

  // ① 注入：样本落仓外固定路径
  fs.mkdirSync(sampleDir, { recursive: true });
  const text = sampleText();
  fs.writeFileSync(sampleFile, text, 'utf8');
  const outsideRepo = !path.resolve(sampleFile).toLowerCase().startsWith(absDir.toLowerCase() + path.sep);
  step(1, '注入（仓外生成样本）', fs.existsSync(sampleFile) && outsideRepo,
    `样本 ${sampleFile}（7 类各 1 条） · 在仓外 = ${outsideRepo ? '是' : '否'}`);

  try {
    // ② 复制进被扫目录（唯一哨兵名）
    if (fs.existsSync(sentinel)) fs.rmSync(sentinel);
    fs.copyFileSync(sampleFile, sentinel);
    step(2, '复制（样本进被扫目录）', fs.existsSync(sentinel),
      `哨兵 ${sentinelName} · ${fs.statSync(sentinel).size} B · 在仓内 = 是`);

    // ③ 扫 + 断言：整目录扫一次（不排除哨兵），只要命中里出现全部 7 类即通过
    const scanned = scanDir(absDir, tables, {
      skipAbs: [sampleDir], // 只排除**仓外**样本目录，不排除哨兵
      skipDirs: [],
    });
    const seen = new Set(scanned.hits.filter((h) => path.basename(h.file) === sentinelName).map((h) => h.category));
    const covered = CATEGORIES.map((c) => c.id).filter((id) => seen.has(id));
    const missing = CATEGORIES.map((c) => c.id).filter((id) => !seen.has(id));
    core = { covered, missing: CORE_CATEGORIES.filter((id) => !seen.has(id)) };
    const reviewHits = scanned.hits.filter((h) => !h.allow && path.basename(h.file) === sentinelName).length;
    step(3, '扫 + 断言（样本必须命中）', missing.length === 0 && reviewHits > 0,
      `扫了 ${scanned.summary.scanned} 个文件 · 哨兵命中 ${scanned.hits.filter((h) => path.basename(h.file) === sentinelName).length} 条 / 待复核 ${reviewHits} 条 · 类别覆盖 ${covered.length}/7` +
      (missing.length ? ` · 缺 ${missing.join(',')}` : ''));

    // 单文件直扫（不依赖目录遍历，用于复核第 ③ 步不是靠别的文件凑出来的）
    const single = scanText(text, tables, { file: sentinelName });
    step('3b', '单文件直扫（同样的样本）', single.filter((h) => !h.allow).length >= 7,
      `待复核命中 ${single.filter((h) => !h.allow).length} 条 / 共 ${single.length} 条`);
  } finally {
    // ④ 清理：删哨兵（无论前面成没成）；再扫一次断言归零
    let removed = false;
    try {
      if (fs.existsSync(sentinel)) { fs.rmSync(sentinel); removed = true; }
    } catch { /* 删不掉也会在下面按"残留"判红 */ }
    const after = scanDir(absDir, tables, { skipAbs: [sampleDir], skipDirs: [] });
    const leftInRepo = after.hits.filter((h) => path.basename(h.file) === sentinelName).length;
    const leftovers = fs.existsSync(sentinel);
    if (!keepSample && fs.existsSync(sampleFile)) { try { fs.rmSync(sampleFile); } catch { /* 下一条按残留判 */ } }
    const sampleGone = !fs.existsSync(sampleFile);
    const dirty = gitStatusCount(absDir);
    // 只认**这次哨兵/样本**，别拿 "negctl" 这种词去 grep 整个工作树
    // （工作树里本来就可能有一个叫 test-negctl.mjs 的文件 —— 那是自伤式假红）
    const sentinelRe = new RegExp(`\\.negctl-${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.txt`);
    const polluted = dirty ? dirty.filter((l) => sentinelRe.test(l) || /oss-negative-control/.test(l)) : [];
    cleanup = { removed, leftovers, sampleGone, dirty: dirty ? dirty.length : null, polluted: polluted.length };
    step(4, '清理（跑完即删）', !leftovers && leftInRepo === 0 && polluted.length === 0,
      `哨兵已删 = ${removed ? '是' : '否'} · 仓内残留 ${leftInRepo} 条 · 样本已删 = ${sampleGone ? '是' : '否（--keep-sample）'} · 工作树脏项 ${dirty ? dirty.length : '非 git 仓'}` +
      (polluted.length ? ` · 🔴 工作树被污染 ${polluted.length} 项` : ''));
  }

  return { ok, steps, core, cleanup, sampleFile, sentinelName };
}

/** 人话渲染：直接贴进交付报告。 */
export function renderNegativeControl(result) {
  const L = [];
  L.push(`阴性对照四步时序（runId=${result.sentinelName.replace(/^\.negctl-|\.txt$/g, '')}）：`);
  for (const s of result.steps) L.push(`  ${s.ok ? '✓' : '✗'} ${s.n} ${s.name} —— ${s.detail}`);
  L.push(`  核心三类（设备标签 / 盘符主机名 / 棒号卡号）未命中 = ${result.core.missing.length ? result.core.missing.join(',') : '无'}`);
  L.push(`  结论：${result.ok ? '闸门是活的（样本必然判红）' : '🔴 闸门失效 —— 停止发布'}`);
  return L.join('\n');
}
