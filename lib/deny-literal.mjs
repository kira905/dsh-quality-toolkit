// deny-literal.mjs —— 脱敏第三层：字面量表（随仓发布，7 类，缺任一类别判红）
//
// 为什么要有这一层：权威扫描器的规则表刻意不含"机器标识字面量"（读源码可见），
// 所以设备标签 / 内部卡号 / 内部报告名这类残留，机器不拦、人也不被要求看。
// 这一层就是那个洞的补丁。
//
// 三条纪律：
//   1. **每类至少 1 条**，缺任一类别 ⇒ 判红。"非空"不算过：3 个词的合法空表就是漏洞。
//   2. 表**随仓发布**（结构性命中，不含私有真值）；私有词放 <table>.local.txt，不随仓发布。
//   3. 两份表自身在扫描时跳过（SELF_TABLES）—— 否则它们必然命中自己，
//      而唯一的出路就是加白名单，那是墮落路径。
//
// 命中不是一律判红：命中落在"围栏代码块内"或"行内反引号里"时记为 allow，
// 理由分别是「可执行命令原文」「被引用证据原文」—— 这两类是证据，不是泄漏。
// 其余命中记为 review（待复核），review > 0 即不放行。

import fs from 'node:fs';
import path from 'node:path';

export const CATEGORIES = [
  { id: 'device-tag', zh: '设备标签前缀' },
  { id: 'stick-number', zh: '棒号（第 N 棒 式）' },
  { id: 'card-number', zh: '卡号（卡 <数字>）' },
  { id: 'mainline-name', zh: '主线名（书名号包裹的主线称呼）' },
  { id: 'internal-report', zh: '内部交付报告名模式' },
  { id: 'host-name', zh: '主机名与主机别名' },
  { id: 'drive-port', zh: '盘符与私有端口' },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

export const SELF_TABLES = ['deny-words.txt', 'deny-patterns.txt', 'deny-allow.txt'];

export const TABLE_FILES = {
  words: 'deny-words.txt',
  patterns: 'deny-patterns.txt',
  allow: 'deny-allow.txt',
};

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.mjs', '.js', '.cjs', '.mts', '.cts', '.jsx', '.ts', '.tsx',
  '.json', '.css', '.yml', '.yaml', '.html', '.map', '.sh', '.ps1', '.cmd', '.bat', '.toml', '.py',
]);

const TEXT_NAMES = new Set(['license', 'licence', 'notice', 'readme', 'gitignore', 'gitattributes', 'dockerfile', 'makefile']);

const DEFAULT_SKIP_DIRS = [
  'node_modules', '.git', '_archive', '_tmp', 'generated', 'logs', 'backups', 'snapshots', 'dist', 'build', 'coverage',
];

export const ALLOW_REASONS = {
  fence: '可执行命令原文（围栏代码块内）',
  inline: '被引用证据原文（行内反引号里）',
  quote: '引用块（> 开头的原文摘录）',
};

/** 表文件可能不存在（用户自己的仓没带）——缺了就返回空表，由 auditTables 判红。 */
function readTableLines(file) {
  if (!fs.existsSync(file)) return { lines: [], exists: false };
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return { lines: raw.split(/\r?\n/), exists: true };
}

function parseTable(file, kind) {
  const { lines, exists } = readTableLines(file);
  const out = [];
  const errors = [];
  lines.forEach((line, i) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;
    const parts = text.split('\t').map((s) => s.trim());
    if (parts.length < 2) {
      errors.push({ file: path.basename(file), line: i + 1, msg: '缺少 TAB 分隔（格式：<类别><TAB><值>[<TAB><理由>]）' });
      return;
    }
    const [category, value, reason] = parts;
    if (kind === 'allow') {
      if (category !== '*' && !CATEGORY_IDS.includes(category)) {
        errors.push({ file: path.basename(file), line: i + 1, msg: `未知类别 ${category}（允许规则可用 *）` });
        return;
      }
      if (!value) {
        errors.push({ file: path.basename(file), line: i + 1, msg: 'glob 为空' });
        return;
      }
      out.push({ category, glob: value, reason: reason || '（未写理由）', re: globToRegex(value) });
      return;
    }
    if (!CATEGORY_IDS.includes(category)) {
      errors.push({ file: path.basename(file), line: i + 1, msg: `未知类别 ${category}` });
      return;
    }
    if (!value) {
      errors.push({ file: path.basename(file), line: i + 1, msg: '值为空' });
      return;
    }
    if (kind === 'pattern') {
      let re = null;
      try {
        re = new RegExp(value, 'gu');
      } catch (e) {
        errors.push({ file: path.basename(file), line: i + 1, msg: `正则编译失败：${e.message}` });
        return;
      }
      out.push({ category, raw: value, re });
    } else {
      out.push({ category, raw: value, lower: value.toLowerCase() });
    }
  });
  return { entries: out, errors, exists };
}

/**
 * 允许规则的 glob：`**` 跨目录、`*` 不跨目录；从任意目录层级开始匹配
 * （规则写 `_test/**` 就覆盖任意位置的 _test 目录）。规则表随仓发布，diff 里能看见。
 */
export function globToRegex(glob) {
  const g = glob.replace(/\\/g, '/');
  let out = '(?:^|/)';
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') { out += '.*'; i += 1; } else { out += '[^/]*'; }
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`${out}$`, 'i');
}

/** 载入 config 目录下的三张主表 + 可选的本地表（.local.txt，不随仓发布）。 */
export function loadTables(configDir) {
  const words = [];
  const patterns = [];
  const allows = [];
  const errors = [];
  const files = [];
  for (const [kind, name] of Object.entries(TABLE_FILES)) {
    for (const candidate of [name, name.replace(/\.txt$/, '.local.txt')]) {
      const file = path.join(configDir, candidate);
      if (!fs.existsSync(file) && candidate.endsWith('.local.txt')) continue;
      if (!fs.existsSync(file) && kind === 'allow') continue;
      const parsed = parseTable(file, kind === 'patterns' ? 'pattern' : kind === 'allow' ? 'allow' : 'word');
      if (kind === 'patterns') patterns.push(...parsed.entries);
      else if (kind === 'allow') allows.push(...parsed.entries);
      else words.push(...parsed.entries);
      errors.push(...parsed.errors);
      files.push({ file, exists: parsed.exists, entries: parsed.entries.length, errors: parsed.errors.length });
    }
  }
  // 类别明确的规则排在 `*` 前面：理由写得越具体，越该被先命中（取证时能看出是哪一条放行的）
  allows.sort((a, b) => (a.category === '*' ? 1 : 0) - (b.category === '*' ? 1 : 0));
  return { words, patterns, allows, errors, files, configDir };
}

/** 逐类别统计：每类各几条（words+patterns 合并计）。ok = 7 类都 ≥1 且无解析错误。 */
export function auditTables(tables) {
  const rows = CATEGORIES.map((c) => {
    const w = tables.words.filter((e) => e.category === c.id).length;
    const p = tables.patterns.filter((e) => e.category === c.id).length;
    return { ...c, words: w, patterns: p, total: w + p, ok: w + p > 0 };
  });
  const missing = rows.filter((r) => !r.ok).map((r) => r.id);
  return {
    rows,
    missing,
    parseErrors: tables.errors,
    ok: missing.length === 0 && tables.errors.length === 0,
  };
}

/** 一份配置的指纹：改了口径就要在读数旁边一起记下来，否则两次读数不可比。 */
export function tablesFingerprint(tables) {
  const parts = tables.files.map((f) => {
    if (!f.exists) return `${path.basename(f.file)}:absent`;
    return `${path.basename(f.file)}:${fs.statSync(f.file).size}`;
  });
  return parts.join('|');
}

export function mask(text, keep = 12) {
  const s = String(text ?? '');
  return s.length <= keep ? s : `${s.slice(0, keep)}…`;
}

/** 行内反引号位置判定：index 是否落在某个 `…` 片段内部。 */
function insideInlineCode(line, index) {
  let open = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '`') continue;
    if (open < 0) { open = i; continue; }
    if (index > open && index < i) return true;
    open = -1;
  }
  return false;
}

function allowReasonFor(line, index, inFence) {
  if (inFence) return ALLOW_REASONS.fence;
  if (/^\s*>/.test(line)) return ALLOW_REASONS.quote;
  if (insideInlineCode(line, index)) return ALLOW_REASONS.inline;
  return null;
}

/**
 * 仓内允许规则（config/deny-allow.txt，随仓发布、diff 里能看见）。
 * 只用来放行**结构性误报**（夹具里的合成盘符、探测器自己的样本），不放行真实的私有标识。
 */
export function configuredAllow(file, category, tables) {
  if (!tables?.allows?.length) return null;
  const norm = String(file ?? '').replace(/\\/g, '/');
  for (const r of tables.allows) {
    if (r.category !== '*' && r.category !== category) continue;
    if (r.re.test(norm)) return `配置允许：${r.reason}`;
  }
  return null;
}

/**
 * 扫一段文本。返回逐条命中：{ line, column, category, source, masked, allow, allowReason }
 * opts.maskKeep 默认 12；opts.fenceAware 默认 true（围栏内的命中记为 allow）。
 */
export function scanText(text, tables, { file = '<text>', maskKeep = 12 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const hits = [];
  let inFence = false;
  let fenceMarker = null;
  lines.forEach((line, li) => {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMarker = fence[1][0]; } else if (fence[1][0] === fenceMarker) { inFence = false; }
      // 围栏行本身也照扫（有人会把标识写在 ``` 同一行）
    }
    const lower = line.toLowerCase();
    for (const w of tables.words) {
      if (!w.lower) continue;
      let from = 0;
      for (;;) {
        const at = lower.indexOf(w.lower, from);
        if (at < 0) break;
        const reason = allowReasonFor(line, at, inFence) ?? configuredAllow(file, w.category, tables);
        hits.push({
          file, line: li + 1, column: at + 1, category: w.category, source: 'word',
          masked: mask(line.slice(at, at + Math.max(w.raw.length, maskKeep)), maskKeep),
          allow: Boolean(reason), allowReason: reason ?? '',
        });
        from = at + Math.max(1, w.lower.length);
      }
    }
    for (const p of tables.patterns) {
      p.re.lastIndex = 0;
      for (;;) {
        const m = p.re.exec(line);
        if (!m) break;
        const reason = allowReasonFor(line, m.index, inFence) ?? configuredAllow(file, p.category, tables);
        hits.push({
          file, line: li + 1, column: m.index + 1, category: p.category, source: 'pattern',
          masked: mask(m[0], maskKeep), allow: Boolean(reason), allowReason: reason ?? '',
        });
        if (m[0].length === 0) p.re.lastIndex += 1;
      }
    }
  });
  return hits;
}

export function isTextFile(name) {
  const lower = name.toLowerCase();
  if (TEXT_EXT.has(path.extname(lower))) return true;
  return TEXT_NAMES.has(lower.replace(/^\./, ''));
}

/**
 * 扫一棵目录树。opts：
 *   skipDirs     额外跳过的目录名（并进默认那组）
 *   skipAbs      绝对路径前缀黑名单（阴性对照的 %TEMP% 样本就靠它被排除）
 *   skipFiles    跳过的文件名（两份表自身）
 */
export function scanDir(dir, tables, opts = {}) {
  const skip = new Set([...DEFAULT_SKIP_DIRS, ...(opts.skipDirs ?? [])]);
  const skipAbs = (opts.skipAbs ?? []).map((p) => path.resolve(p).toLowerCase());
  const skipFiles = new Set([...(opts.skipFiles ?? []), ...SELF_TABLES]);
  const files = [];
  const hits = [];
  const skipped = { dirs: [], files: 0 };

  const shouldSkipAbs = (p) => {
    const low = path.resolve(p).toLowerCase();
    return skipAbs.some((pre) => low === pre || low.startsWith(pre + path.sep));
  };

  const walk = (cur) => {
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (shouldSkipAbs(p)) { skipped.files += 1; continue; }
      if (e.isDirectory()) {
        if (skip.has(e.name)) { skipped.dirs.push(path.relative(dir, p).replace(/\\/g, '/')); continue; }
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      if (skipFiles.has(e.name)) { skipped.files += 1; continue; }
      if (!isTextFile(e.name)) { skipped.files += 1; continue; }
      let stat;
      try { stat = fs.statSync(p); } catch { continue; }
      if (stat.size > 4 * 1024 * 1024) { skipped.files += 1; continue; }
      files.push(p);
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      hits.push(...scanText(text, tables, { file: p }));
    }
  };
  walk(dir);
  return {
    files,
    hits,
    skipped,
    summary: {
      scanned: files.length,
      hits: hits.length,
      allow: hits.filter((h) => h.allow).length,
      review: hits.filter((h) => !h.allow).length,
    },
  };
}
