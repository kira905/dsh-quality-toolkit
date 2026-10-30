// sim-scan-core.mjs —— 同源度扫描：这对同名件里，仓内文件有多少条非空行能在生产同名件里找到
//
// 口径（全部写死在 config/sim-scan.json，这里不设第二套默认值）：
//   ① 只比**同名件**（按 basename 匹配，6 类扩展名，skip 目录清单）；
//   ② 逐字节同 = sha256 相等；
//   ③ 其余的算行同度：仓内文件的非空行，去生产同名件里做**多重集扣减**（不是集合包含）；
//   ④ 同名候选取**行同度最高者**（对"是不是副本"这个问题取最有利证据）；
//   ⑤ 三档 ≥90% / 50–90% / <50%；
//   ⑥ 主结论列 = 「≥50% 行同占比」= (逐字节同 + ≥90% + 50–90%) ÷ 同名件。
//
// 为什么不用"逐字节相同比例"：同一段代码删几行注释就判"不同源"，实测会低估 10~20 倍。
// 为什么行级用多重集：集合包含会把"同一行出现 5 次、对端 1 次"当成全中。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** 生产源根：$DSH_ROOT，缺省 ~/DSH（与仓库里其它 bin 同一个口径）。 */
export function defaultProdRoot() {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT;
  return path.join(os.homedir(), 'DSH');
}

export function loadSimConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(cfg.ext) || !cfg.ext.length) throw new Error(`配置缺 ext：${file}`);
  if (!Array.isArray(cfg.skipDirs)) throw new Error(`配置缺 skipDirs：${file}`);
  return cfg;
}

/** 口径指纹：改了口径，两次读数就不可比 —— 把它打在表头。 */
export function caliberFingerprint(cfg) {
  const roots = (cfg.production?.roots ?? []).map((r) => `${r.path}:${r.mode}`).join(',');
  return `ext=${cfg.ext.join(',')}|skip=${cfg.skipDirs.join(',')}|prod=${roots}`;
}

export function sha256Of(file) {
  try {
    const buf = fs.readFileSync(file);
    if (!buf.length) return null;
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}

function nonEmptyLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch { return []; }
}

/** 多重集扣减：a 有多少行能在 b 里扣到（同一行出现次数也扣）。 */
export function lineRatio(aLines, bLines) {
  if (!aLines.length) return 0;
  const pool = new Map();
  for (const l of bLines) pool.set(l, (pool.get(l) ?? 0) + 1);
  let hit = 0;
  for (const l of aLines) {
    const n = pool.get(l) ?? 0;
    if (!n) continue;
    hit += 1;
    pool.set(l, n - 1);
  }
  return hit / aLines.length;
}

/** 按 roots 描述列文件：recursive = 整棵；root-files = 只看该目录下的文件。 */
export function listRoots(baseRoot, roots, ext, skipDirs) {
  const exts = new Set(ext.map((e) => e.toLowerCase()));
  const skip = new Set(skipDirs);
  const out = [];
  const push = (p) => {
    if (exts.size && !exts.has(path.extname(p).toLowerCase())) return;
    out.push(p);
  };
  const walk = (cur) => {
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(p);
      } else if (e.isFile()) push(p);
    }
  };
  for (const r of roots) {
    const base = path.isAbsolute(r.path) ? r.path : path.resolve(baseRoot, r.path);
    let stat;
    try { stat = fs.statSync(base); } catch { continue; }
    if (r.mode === 'root-files') {
      if (!stat.isDirectory()) continue;
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (e.isFile()) push(path.join(base, e.name));
      }
    } else if (stat.isDirectory()) {
      walk(base);
    } else if (stat.isFile()) {
      push(base);
    }
  }
  return out;
}

/** 生产面索引：basename(小写) → [绝对路径...] */
export function buildProductionIndex({ prodRoot, cfg }) {
  const files = listRoots(prodRoot, cfg.production?.roots ?? [{ path: '.', mode: 'recursive' }], cfg.ext, cfg.skipDirs);
  const byName = new Map();
  for (const f of files) {
    const key = path.basename(f).toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }
  return { byName, fileCount: files.length, prodRoot };
}

function bucketOf(ratio, cfg) {
  const high = cfg.buckets?.high ?? 0.9;
  const mid = cfg.buckets?.mid ?? 0.5;
  if (ratio >= high) return 'near90';
  if (ratio >= mid) return 'mid';
  return 'low';
}

export function verdictFor(pct, cfg) {
  const list = [...(cfg.verdict ?? [])].sort((a, b) => b.minPct - a.minPct);
  const hit = list.find((v) => pct >= v.minPct) ?? { label: 'unknown', zh: '未定' };
  return { label: hit.label, zh: hit.zh };
}

/** 扫一个仓。返回 { repo, sameName, identical, near90, mid, low, pct, verdict, files:[...] } */
export function scanRepo({ repoPath, index, cfg, collectDetail = false }) {
  const repoName = path.basename(repoPath);
  const files = listRoots(repoPath, cfg.repo?.roots ?? [{ path: '.', mode: 'recursive' }], cfg.ext, cfg.skipDirs);
  let sameName = 0;
  let identical = 0;
  let near90 = 0;
  let mid = 0;
  let low = 0;
  const detail = [];
  let newest = 0;

  for (const f of files) {
    const cands = index.byName.get(path.basename(f).toLowerCase());
    if (!cands || !cands.length) continue;
    sameName += 1;
    let mtime = 0;
    try { mtime = fs.statSync(f).mtimeMs; } catch { mtime = 0; }
    if (mtime > newest) newest = mtime;

    const sha = sha256Of(f);
    let identHit = false;
    let best = -1;
    let bestCand = null;
    for (const c of cands) {
      if (sha && sha === sha256Of(c)) identHit = true;
      const ratio = lineRatio(nonEmptyLines(f), nonEmptyLines(c));
      if (ratio > best) { best = ratio; bestCand = c; }
    }
    if (identHit) { identical += 1; }
    else {
      const bucket = bucketOf(best, cfg);
      if (bucket === 'near90') near90 += 1;
      else if (bucket === 'mid') mid += 1;
      else low += 1;
    }
    if (collectDetail && !identHit) {
      detail.push({
        file: path.relative(repoPath, f).replace(/\\/g, '/'),
        ratio: Math.round(best * 1000) / 10,
        candidate: path.relative(index.prodRoot, bestCand).replace(/\\/g, '/'),
      });
    }
  }

  const judged = sameName >= (cfg.repo?.minFilesToJudge ?? 1);
  const pct = sameName ? Math.round(((identical + near90 + mid) / sameName) * 100) : 0;
  return {
    repo: repoName,
    repoPath,
    sameName,
    identical,
    near90,
    mid,
    low,
    pct,
    asOfPct: pct,
    verdict: judged ? verdictFor(pct, cfg) : { label: 'not-judgeable', zh: '判不了（同名件为 0）' },
    judged,
    filesScanned: files.length,
    newestMtimeMs: newest,
    detail: collectDetail ? detail.sort((a, b) => b.ratio - a.ratio) : [],
  };
}

export function gitDirtyCount(repoPath) {
  const r = spawnSync('git', ['-C', repoPath, 'status', '--porcelain'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).filter(Boolean).length;
}

export function gitCommitsSince(repoPath, isoTime) {
  const r = spawnSync('git', ['-C', repoPath, 'log', `--since=${isoTime}`, '--format=%h %ad %s', '--date=format:%m-%d %H:%M'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * 列仓根下的候选目录。
 * 缺省只收 `dsh-` 开头的目录（备份目录 `_xxx` / 发布暂存 `_publish` 不是仓，混进来会污染分母）；
 * 需要别的命名就在 config 里给 `repoRoot.include`（正则）。
 */
export function listRepos(repoRoot, cfg = {}) {
  const include = cfg.repoRoot?.include ? new RegExp(cfg.repoRoot.include) : /^dsh-/;
  return fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && include.test(e.name))
    .map((e) => path.join(repoRoot, e.name))
    .sort();
}

export function scanAll({ repoRoot, index, cfg, collectDetail = false }) {
  const rows = listRepos(repoRoot, cfg).map((d) => {
    const row = scanRepo({ repoPath: d, index, cfg, collectDetail });
    row.dirty = gitDirtyCount(d);
    return row;
  });
  rows.sort((a, b) => b.sameName - a.sameName || a.repo.localeCompare(b.repo));
  return rows;
}

/** 表头：口径 + 时点 + 各仓脏项数（脏项数必须打出来，否则读者会把读数当"干净时的"）。 */
export function renderHeader({ cfg, prodRoot, rows, at }) {
  const L = [];
  L.push(`口径：${cfg.caliber ?? 'basename-lineset-v1'} ｜ ${caliberFingerprint(cfg)}`);
  L.push(`生产面：${prodRoot}（${(cfg.production?.roots ?? []).map((r) => `${r.path || '.'}·${r.mode}`).join(' + ')}）`);
  L.push(`扫描时点：${at}`);
  const dirty = rows.map((r) => `${r.repo} ${r.dirty === null ? '非 git' : r.dirty}`).join(' · ');
  L.push(`扫描时各仓脏项数：${dirty}`);
  return L.join('\n');
}

export function renderTable(rows) {
  const L = [];
  L.push('| 仓 | 同名件 | 逐字节同 | ≥90% | 50–90% | <50% | **≥50%行同占比** | 判定 | 脏项 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    L.push(
      `| \`${r.repo}\` | ${r.sameName} | ${r.identical} | ${r.near90} | ${r.mid} | ${r.low} | **${r.pct}%** | ${r.verdict.zh} | ${r.dirty === null ? '非 git' : r.dirty} |`,
    );
  }
  return L.join('\n');
}

/** 与基线表逐行对比。原因只许三种（取数时点不同 / 该仓已变版 / 口径差异），归不上就明说。 */
export function compareBaseline({ rows, baseline, cfg, prodRoot }) {
  const diffs = [];
  const caliberSame = baseline.caliber === caliberFingerprint(cfg)
    && (baseline.prodRoot === undefined || path.resolve(baseline.prodRoot) === path.resolve(prodRoot));
  const byRepo = new Map(rows.map((r) => [r.repo, r]));
  const cols = ['sameName', 'identical', 'near90', 'mid', 'low', 'pct'];
  const baseByRepo = new Map((baseline.rows ?? []).map((r) => [r.repo, r]));

  for (const [repo, base] of baseByRepo) {
    const now = byRepo.get(repo);
    if (!now) {
      diffs.push({ repo, reason: 'unattributed', zh: '无法归因', detail: '基线里有这个仓，本次扫描面里没有', cols: [] });
      continue;
    }
    const changed = cols.filter((c) => base[c] !== now[c]);
    if (!changed.length) continue;
    let reason;
    let detail = '';
    let evidence = [];
    if (!caliberSame) {
      reason = 'caliber';
      detail = `基线口径 ${baseline.caliber ?? '未声明'} ≠ 本次 ${caliberFingerprint(cfg)}`;
    } else {
      const commits = baseline.at ? gitCommitsSince(now.repoPath, baseline.at) : [];
      if (commits.length) {
        reason = 'repo-changed';
        detail = `${baseline.at} 之后有 ${commits.length} 次提交：${commits[0]}`;
        evidence = commits;
      } else if (now.dirty > 0) {
        reason = 'time-point';
        detail = `无新提交，但工作树有 ${now.dirty} 项未提交改动`;
      } else if (baseline.at && now.newestMtimeMs > Date.parse(baseline.at)) {
        reason = 'time-point';
        detail = `无新提交，但有文件的修改时间晚于基线时点 ${baseline.at}`;
      } else {
        reason = 'unattributed';
        detail = '口径相同、无新提交、工作树干净、文件未更新 —— 归不上三种原因之一';
      }
    }
    diffs.push({
      repo,
      reason,
      zh: reason === 'caliber' ? '口径差异' : reason === 'repo-changed' ? '该仓已变版' : reason === 'time-point' ? '取数时点不同' : '无法归因',
      detail,
      cols: changed.map((c) => ({ col: c, baseline: base[c], now: now[c] })),
      evidence,
    });
  }
  return { diffs, caliberSame, diffRows: diffs.length };
}
