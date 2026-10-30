// ref-scan-core.mjs —— 引用面扫描（给一个关键词，扫四类载体，输出四类处置表）
//
// 只做机械事：机器负责"把该看的都列出来"（文件、行号、命中原文片段），
// 判 A/B/C/D 不是机器能拍的 —— 表里那一列默认留空，由人填。
//
// 四类处置（对外口径，不搬本机家规的名字）：
//   A 就地订正 · B 加头指针 · C 判定不改 + 理由 · D 待主人
//
// 空态写死：0 命中 ⇒ 判黄（不是 pass、也不是红），并要求人工确认扫描面；
// 每次扫描都必须打印"扫描面证据"：载体清单 + 每类扫了多少文件 + 命中数（空表也要有这行）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DISPOSITIONS = [
  { id: 'A', zh: '就地订正' },
  { id: 'B', zh: '加头指针' },
  { id: 'C', zh: '判定不改 + 理由' },
  { id: 'D', zh: '待主人' },
];

export const DEFAULT_SKIP_DIRS = [
  'node_modules', '.git', '_archive', '_tmp', 'generated', 'logs', 'backups', 'snapshots', 'dist', 'build', 'coverage',
];

export function defaultRoot() {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT;
  return path.join(os.homedir(), 'DSH');
}

export function loadRefConfig(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.carriers) || cfg.carriers.length === 0) {
    throw new Error(`配置里没有 carriers：${file}`);
  }
  for (const c of cfg.carriers) {
    if (!c.name || !c.path) throw new Error(`carrier 缺 name/path：${JSON.stringify(c)}`);
  }
  return cfg;
}

export function expandPath(p, root) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

/** 一个载体扫了哪些文件（ext 过滤 + skipDirs 外）。 */
export function listCarrierFiles(base, ext, skipDirs) {
  const exts = new Set((ext ?? []).map((e) => e.toLowerCase()));
  const skip = new Set(skipDirs);
  const out = [];
  const walk = (cur) => {
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      if (exts.size && !exts.has(path.extname(e.name).toLowerCase())) continue;
      out.push(p);
    }
  };
  walkSafe(base, walk);
  return out;
}

// 一个小包装：目录不存在时安静返回（载体缺失要进证据行，不该抛错）
function walkSafe(base, fn) {
  try { if (!fs.statSync(base).isDirectory()) return; } catch { return; }
  fn(base);
}

/** 逐文件逐行找关键词：一行一条结果（同一行的多个关键词合并计次）。 */
function collectHits({ files, carrierName, root, keywords, caseSensitive, snippetMax }) {
  const hits = [];
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const hay = caseSensitive ? line : line.toLowerCase();
      const matched = [];
      for (const kw of keywords) {
        const needle = caseSensitive ? kw : kw.toLowerCase();
        if (!needle) continue;
        let from = 0;
        for (;;) {
          const at = hay.indexOf(needle, from);
          if (at < 0) break;
          matched.push({ kw, column: at + 1 });
          from = at + Math.max(1, needle.length);
        }
      }
      if (!matched.length) return;
      const trimmed = line.trim();
      const snippet = trimmed.length > snippetMax ? `${trimmed.slice(0, snippetMax)}…` : trimmed;
      hits.push({
        carrier: carrierName,
        file,
        rel: path.relative(root, file).replace(/\\/g, '/'),
        line: i + 1,
        count: matched.length,
        keywords: [...new Set(matched.map((m) => m.kw))],
        snippet,
      });
    });
  }
  return hits;
}

/**
 * 扫所有载体。keywords 为一个或多个关键词（任一命中即列）。
 * 返回 { carriers, evidence, rows, verdict }
 *
 * 被排除目录（如历史快照 / 别线产物）里的命中**单独计数并声明**：
 * 既不进处置表、也不进主计数 —— 但读者必须知道"处置表之外还有多少"，
 * 否则"0 漏网"只在一个未声明的面内成立。
 */
export function scanRefs({ root, config, keywords, caseSensitive = false, snippetMax = 120, extraSkipDirs = [] }) {
  const skipDirs = [...new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs ?? []), ...extraSkipDirs])];
  const carriers = [];
  const rows = [];
  const excluded = [];

  for (const c of config.carriers) {
    const base = expandPath(c.path, root);
    const carrierSkip = [...skipDirs, ...(c.extraSkipDirs ?? [])];
    let exists = false;
    try { exists = fs.statSync(base).isDirectory(); } catch { exists = false; }
    const files = exists ? listCarrierFiles(base, c.ext, carrierSkip) : [];
    const hits = collectHits({ files, carrierName: c.name, root, keywords, caseSensitive, snippetMax });
    carriers.push({ name: c.name, desc: c.desc ?? '', base, exists, files: files.length, hits: hits.length, hitRows: hits });
    for (const h of hits) rows.push(h);

    for (const dirName of c.extraSkipDirs ?? []) {
      const sub = path.join(base, dirName);
      let isDir = false;
      try { isDir = fs.statSync(sub).isDirectory(); } catch { isDir = false; }
      if (!isDir) continue;
      const subFiles = listCarrierFiles(sub, c.ext, skipDirs);
      const subHits = collectHits({ files: subFiles, carrierName: c.name, root, keywords, caseSensitive, snippetMax });
      excluded.push({
        carrier: c.name,
        dir: path.relative(root, sub).replace(/\\/g, '/'),
        files: subFiles.length,
        hits: subHits.length,
        hitLines: subHits.map((h) => `L${h.line} ${h.rel}`),
      });
    }
  }

  const totalFiles = carriers.reduce((n, c) => n + c.files, 0);
  const totalHits = rows.reduce((n, r) => n + r.count, 0);
  const excludedHits = excluded.reduce((n, e) => n + e.hits, 0);
  const evidence = {
    root,
    keywords,
    carriers: carriers.map((c) => ({ name: c.name, base: c.base, exists: c.exists, files: c.files, hits: c.hits })),
    totalFiles,
    totalHits,
    hitLines: rows.length,
    excludedDirs: skipDirs,
    excluded,
    excludedHits,
  };
  // 0 命中 ⇒ 判黄
  const verdict = totalHits > 0 ? 'hits' : 'yellow';
  return { carriers, evidence, rows, verdict };

}

/** 扫描面证据行：空表也必须有这行。排除目录里的命中单独声明（否则"漏网 0"只在未声明的面内成立）。 */
export function evidenceLine(ev) {
  const parts = ev.carriers.map((c) => `${c.name} ${c.exists ? `${c.files} 文件` : '目录不存在'} / 命中 ${c.hits}`);
  const excl = ev.excluded?.length
    ? `｜ 排除目录内另有 ${ev.excludedHits} 处命中（${ev.excluded.map((e) => `${e.dir} ${e.hits}`).join(' · ')}）：不进处置表，也不进上面的计数`
    : '';
  return `扫描面证据：载体 ${ev.carriers.length} 类 ｜ ${parts.join(' · ')} ｜ 合计 ${ev.totalFiles} 文件 · ${ev.hitLines} 行 / ${ev.totalHits} 次 ｜ 根 ${ev.root} ｜ 排除 ${ev.excludedDirs.join(' ')}${excl}`;
}

/** Markdown 表：四类处置列留空给人填。 */
export function renderTable(result, { snippetMax = 120 } = {}) {
  const L = [];
  L.push('| # | 载体 | 文件 | 行 | 命中原文片段 | 处置（A/B/C/D） | 理由 |');
  L.push('|---|---|---|---|---|---|---|');
  result.rows.forEach((r, i) => {
    const snip = r.snippet.replace(/\|/g, '\\|');
    L.push(`| ${i + 1} | ${r.carrier} | \`${r.rel.replace(/\|/g, '\\|')}\` | ${r.line} | ${snip} |  |  |`);
  });
  if (!result.rows.length) L.push('| — | — | —（0 命中：判黄，请先人工确认扫描面） | — | — |  |  |');
  return L.join('\n');
}

export function dispositionLegend() {
  return DISPOSITIONS.map((d) => `${d.id} ${d.zh}`).join(' · ');
}
