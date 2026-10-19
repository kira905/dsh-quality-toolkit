// lib/common.mjs —— docs-discipline 判据脚本共用底座
// 纪律：只读优先 · 写入动作须显式 --apply · 收尾 process.exitCode（禁 process.exit）· 绝对路径 · 无硬编码行号
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const EXIT = { OK: 0, USAGE: 2, READ: 1, FAIL: 3, INTERNAL: 1 };

export function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

export function splitLines(text) {
  return text.split(/\r?\n/);
}

/** 两套行数口径：gc = PowerShell Get-Content 口径；split = 工具 split(/\r?\n/) 口径 */
export function counts(text) {
  const l = splitLines(text);
  return { gc: text.endsWith('\n') ? l.length - 1 : l.length, split: l.length };
}

export function sha256(x) {
  return crypto.createHash('sha256').update(x).digest('hex');
}

export function sha16(x) {
  return sha256(x).slice(0, 16);
}

export function meta(p) {
  const buf = fs.readFileSync(p);
  const text = buf.toString('utf8');
  const c = counts(text);
  return {
    path: p,
    bytes: buf.length,
    gc: c.gc,
    split: c.split,
    sha256: sha256(buf),
    sha16: sha256(buf).slice(0, 16),
    mtime: fs.statSync(p).mtime.toISOString(),
    text,
    lines: splitLines(text),
  };
}

/** junction 安全的 main 入口守卫：双方 realpathSync 后再比 */
export function isMain(metaUrl) {
  const self = fileURLToPath(metaUrl);
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(self);
  } catch {
    return path.resolve(argv1) === path.resolve(self);
  }
}

export function argParse(argv, { values = [], flags = [] } = {}) {
  const vset = new Set(values);
  const fset = new Set(flags);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--self-test') { out.selfTest = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (vset.has(key)) { out[key] = argv[++i]; continue; }
      if (fset.has(key)) { out[key] = true; continue; }
      return { error: `unknown arg: ${a}` };
    }
    out._.push(a);
  }
  return out;
}

/** 文字归一：去 markdown 粗体 / 反引号 / 全角引号 / 折叠空白；用于"串在不在"的比较 */
export function norm(s) {
  return String(s ?? '')
    .replace(/\*\*/g, '')
    .replace(/[`「」『』“”"]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 忽略列宽填充空格的比较（第 8 轮 A2 口径） */
export function normLoose(s) {
  return norm(s).replace(/\u3000/g, '');
}

export function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

export function writeTmp(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ---- 自测脚手架 ----
export function newResults() {
  return [];
}

export function assertEq(actual, expected, label, results) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ ok, label, detail: ok ? '' : `期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}` });
  return ok;
}

export function assertTrue(cond, label, results, detail = '') {
  const ok = !!cond;
  results.push({ ok, label, detail: ok ? '' : detail });
  return ok;
}

export function finishSelfTest(name, results) {
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `   ← ${r.detail}` : ''}`);
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`[self-test] ${name} · 通过 ${pass}/${results.length}${pass === results.length ? ' ⇒ PASS' : ' ⇒ FAIL'}`);
  process.exitCode = pass === results.length ? EXIT.OK : EXIT.INTERNAL;
}

export function printHelp(name, lines) {
  console.log(lines.join('\n'));
}

/** 通用 --help 模板：产物形态 / 取值口径 / 射程（三段式）全部写在本目录（不进方案文档） */
export function helpBlock({
  title, usage, form, caliber, scope, exits, selfTest,
}) {
  return [
    `判据名：${title}`,
    '',
    '命令：',
    `  ${usage}`,
    '',
    '产物形态（= 脚本 stdout）：',
    ...form.map((x) => `  ${x}`),
    '',
    '取值口径：',
    ...caliber.map((x) => `  ${x}`),
    '',
    '射程（三段式）：',
    `  管哪类档：${scope.docs}`,
    `  管哪个阶段：${scope.stage}`,
    `  谁执行：${scope.who}`,
    '',
    `退出码：${exits.join(' / ')}`,
    `自测：${selfTest}`,
  ].join('\n');
}

export function mdTable(rows, headers) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\n/g, ' ')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/** 取 [start, end) 之间的行（0-based，end 不含） */
export function slice(lines, start, end) {
  return lines.slice(start, end);
}

/** 旧值扫描 / 口径自核共用的**豁免行判据**（= 展示面）：
 *  含「订正注 / 订正说明」· 位于 §8 修订记录 或 §9.1 版本保全自证内 · 含「快照 / before / STAMP」·
 *  位于档头引述块内（首个 `## ` 之前）· 含「送审件 / 上一版 / 旧值 / 历史 / 实测」 */
export const RESIDUE_EXEMPT_RE = /订正注|订正说明|快照|before|STAMP|送审件|上一版|旧值|历史|实测/;

export function makeExemptFn(lines) {
  const headEnd = (() => {
    const i = lines.findIndex((l) => /^##\s/.test(l));
    return i < 0 ? 0 : i;
  })();
  const sec = (token) => {
    const idx = lines.findIndex((l) => /^#{2,3}\s/.test(l) && l.includes(token));
    if (idx < 0) return null;
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
    return [idx + 1, end];
  };
  const s8 = sec('§8 修订记录');
  const s91 = sec('§9.1');
  const inR = (i, r) => r && i + 1 >= r[0] && i + 1 <= r[1];
  return (i) => RESIDUE_EXEMPT_RE.test(lines[i]) || i < headEnd || inR(i, s8) || inR(i, s91);
}
