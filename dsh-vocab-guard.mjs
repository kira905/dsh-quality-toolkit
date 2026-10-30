#!/usr/bin/env node
/**
 * dsh-vocab-guard.mjs —— 会话事件词表守卫（跨主包线词表差异 + 升级后静默失效检测）
 *
 * 为什么存在（补的是哪两个洞）：
 *   ① **审计盲区（升级方案 §8.1 T7）**：L0 审计只比"插件 import 的符号"，且样本从不含
 *      `dsh-session`；运行时 API 面靠 `dsh-upgrade-audit.mjs` 的 **unpkg 在线探针 + 硬编码符号表**——
 *      既依赖网络，又把"老事件名"写死在脚本里（探针把 `'assistant/chunk'` 报成 🔴 缺失，
 *      而正确语义是「**已改名**」，需要人工读报告才知道）。
 *   ② **升级后静默失效（升级方案 §9.4 表 2）**：文档自认「直到有人看 GUI（无自动检测）❌ 不可接受」。
 *      `check-decoupling.mjs` 的 R4 只能回答「**谁写死了宿主字面量**」（位置），
 *      **回答不了**「我登记/写死的这个名字，在目标主包线上**还在不在**」（跨线语义）。
 *      两者合起来才是完整的静默失效判据。
 *
 * 本工具的判据（两份输入相乘）：
 *   输入 A · 两线词表 = `@deepseek-ai/dsh-session/lib/types/known-event-types.js` 的
 *            `KNOWN_SESSION_EVENT_TYPES`（0.1.1-rc.2 现网线 vs 0.1.5-rc.x 目标线）
 *   输入 B · 我方登记集合 = 宿主适配层唯一源 `tools/lib/host-adapter.mjs`（EV 表 + 各 Set 成员）
 *            ∪ `check-decoupling.hostVocabulary()`（含 R4 补充项）
 *   判定：登记名在新线是否有替代路径 —— 有映射（`legacyName`）→ 🟡 已登记；有族判定兜底
 *         （`isTurnInterior`）→ 🟡 族覆盖；都没有却跨线消失 → 🔴 **静默失准**。
 *
 * 三条硬纪律（照 §5.2 R1 + 既有工具惯例）：
 *   1. **离线优先、零第三方依赖**：默认只读本地样本，不联网；样本缺失即退出码 3，绝不用"猜"
 *      的旧词表兜底（猜出来的差异表会变成假证据）。
 *   2. **判定唯一源**：绝不复制 `check-decoupling.mjs` 的扫描/词表判定；需要 R4 位置清单时
 *      **动态 import 它的导出**（`runChecks` / `hostVocabulary`），导入失败就降级并写明。
 *   3. **输出路径可注入**（`--out` / `--json` / `--baseline`）：单测与演练一律写沙箱，
 *      绝不默认往生产报告路径写（本仓库既有纪律）。
 *
 * 用法：
 *   node dsh-vocab-guard.mjs                 # 词表差异 + 静默失效判定（默认写报告）
 *   node dsh-vocab-guard.mjs --no-out         # 只看控制台摘要
 *   node dsh-vocab-guard.mjs --no-scan        # 跳过裸字面量扫描（快）
 *   node dsh-vocab-guard.mjs --old <path> --new <path>
 *   node dsh-vocab-guard.mjs --scan-root <DSH_ROOT>\tools --scan-root <另一个根>
 *   node dsh-vocab-guard.mjs --out <file> --json <file> --quiet
 *   # 升级前后对比（#12「升级后静默失效自动检测」的落点）：
 *   node dsh-vocab-guard.mjs --save-baseline <DSH_ROOT>\_tmp\vocab-baseline.json   # 升级前
 *   node dsh-vocab-guard.mjs --baseline <DSH_ROOT>\_tmp\vocab-baseline.json        # 升级后
 *   node dsh-vocab-guard.mjs --help
 *
 * 退出码（默认口径与 R4 的 D2 决策一致：首版只提醒不拦）：
 *   0 = 无 🔴 ／ 1 = 登记名跨线消失且无替代（GONE）或 `--strict-scan` 下有写死位置
 *   2 = 用法错误 ／ 3 = 词表样本缺失
 *   ⚠️ 裸字面量命中默认**只报不拦**（文案表/诊断工具属低风险）；`--strict-scan` 才计入退出码。
 *
 * 处置出口（怎么让一个命中"合法化"）：
 *   ① 收敛进宿主适配层（`EV` / `legacyName`）——正解；
 *   ② 改前缀族判定（`isTurnInterior` 式）；
 *   ③ 确认无害的，在命中行（或上一行）加注释标记 `vocab-guard: allow <原因>` → 计入"已声明豁免"。
 *
 * v1.1.0 · 2026-09-15（升级 T7：新增静默失效检测）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// DSH home 解析（口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh，与 check-decoupling / 部署脚本同源）
import { webProfileDir } from './lib/dsh-home.mjs';

export const VERSION = '1.1.1';

/** 工具自身目录（realpath 后为物理路径；**仅用于拼同仓相对路径**，输出路径一律绝对常量）。 */
const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));

/** 词表文件在 `dsh-session` 包内的相对路径。 */
export const VOCAB_FILE_REL = 'lib/types/known-event-types.js';

/** 默认报告输出（绝对路径常量：junction 场景下不按 __dirname 推导）。 */
export const DEFAULT_OUT = path.join(os.tmpdir(), 'dsh-vocab-guard-report.md');

/** 默认扫描根（自研工具链源码树）。 */
export const DEFAULT_SCAN_ROOTS = [process.cwd()];

/**
 * 自研插件实体副本（只在 profile 里、没有 tools 源码目录的那类）。
 * 与 `check-decoupling.mjs` 的 `PROFILE_SELF_PKGS` 同口径（覆盖缺口实测：dsh-task-control
 * 即"源码只在 profile 实体里"型）。
 */
export const PROFILE_SELF_PKGS = [
  'dsh-task-control', 'dsh-archive-sessions', 'dsh-butler-panel', 'dsh-ecosystem-panel',
  'dsh-task-board-local', 'dsh-memory', 'dsh-fish-tts', 'whale-on-desk', 'dsh-download-progress',
];

/**
 * 默认扫描根 = 源码树 + profile 自研包实体。
 * ⚠️ profile 里不少自研包是 **junction 指向 `<DSH_ROOT>\tools\<pkg>`** 的镜像 —— 直接加会重复命中，
 * 故 realpath 后落在源码树内的**跳过**（源码树那份已覆盖）。
 */
export function defaultScanRoots() {
  const roots = [...DEFAULT_SCAN_ROOTS];
  const sourceRoot = path.resolve(DEFAULT_SCAN_ROOTS[0]).toLowerCase();
  try {
    const nm = path.join(webProfileDir(), 'node_modules');
    for (const pkg of PROFILE_SELF_PKGS) {
      const dir = path.join(nm, pkg);
      if (!fs.existsSync(dir)) continue;
      let real = dir;
      try { real = fs.realpathSync(dir); } catch { /* 保留原路径 */ }
      if (path.resolve(real).toLowerCase().startsWith(sourceRoot)) continue; // 镜像 → 源码树已覆盖
      roots.push(dir.replace(/\\/g, '/'));
    }
  } catch { /* home 解析失败 → 只用源码树 */ }
  return roots;
}

/** 行内豁免标记（命中行或紧邻上一行含此串即跳过，计入"已声明豁免"）。 */
export const ALLOW_MARK = 'vocab-guard: allow';

/**
 * 词表样本自动探测候选（离线优先）。
 * - 现网线（old）：生产全局 npm 主包闭包里的 dsh-session（0.1.1-rc.2）
 * - 目标线（new）：测试/金丝雀实例的主包副本（0.1.5-rc.x）
 * 任一缺失 → 退出码 3（**不降级猜词表**）；可用 `--old` / `--new` 覆盖。
 */
function defaultOldCandidates() {
  const appData = process.env.APPDATA || '';
  return [
    appData ? path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session') : null,
    process.env.DSH_OLD_PKG || null,
  ].filter(Boolean);
}
function defaultNewCandidates() {
  return [
    process.env.DSH_NEW_PKG || null,
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. 词表解析
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 从 `known-event-types.js` 源码里抽出词表成员。
 * 只认 `KNOWN_SESSION_EVENT_TYPES = new Set([ ... ])` 区块内带引号的字符串
 * —— 区块外是同文件的注释/其它导出，抽进来会污染 diff（假新增）。
 */
export function parseVocabSource(text) {
  const m = /KNOWN_SESSION_EVENT_TYPES\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(String(text ?? ''));
  const body = m ? m[1] : '';
  const out = [];
  for (const mm of body.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9_/-]*)['"]/g)) out.push(mm[1]);
  return [...new Set(out)];
}

/** 把「包目录 / 任意目录 / 词表文件」统一解析到词表文件；找不到返回 null。 */
export function resolveVocabFile(input) {
  if (!input) return null;
  try {
    const st = fs.statSync(input);
    if (st.isFile()) return input;
  } catch {
    return null;
  }
  const direct = path.join(input, VOCAB_FILE_REL);
  if (fs.existsSync(direct)) return direct;
  // 容错：在（有限的）子树里找同名文件（对付 dsh 嵌套 node_modules 的深层形态）
  const stack = [{ dir: input, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 6) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === 'known-event-types.js') return full;
      if (e.isDirectory() && e.name !== 'node_modules') stack.push({ dir: full, depth: depth + 1 });
    }
    // node_modules 只往下钻 2 层（@deepseek-ai/dsh-session 的典型位置）
    if (depth <= 2) {
      const nm = path.join(dir, 'node_modules');
      if (fs.existsSync(nm)) stack.push({ dir: nm, depth: depth + 1 });
    }
  }
  return null;
}

/** 读一侧词表（返回 events Set + 版本 + 实际文件路径）。 */
export function loadVocabSide(input) {
  const file = resolveVocabFile(input);
  if (!file) return { ok: false, input, error: `找不到词表文件（${input}）` };
  let events;
  try {
    events = new Set(parseVocabSource(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return { ok: false, input, file, error: `读词表失败：${e?.message ?? e}` };
  }
  if (!events.size) return { ok: false, input, file, error: '词表解析为空（文件形态变了？）' };
  // 包版本：从词表文件往上找 dsh-session 的 package.json
  let version = null;
  let dir = path.dirname(file);
  for (let i = 0; i < 6; i++) {
    const j = path.join(dir, 'package.json');
    if (fs.existsSync(j)) {
      try {
        const json = JSON.parse(fs.readFileSync(j, 'utf8'));
        if (json?.name === '@deepseek-ai/dsh-session') { version = json.version; break; }
      } catch { /* 继续往上 */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { ok: true, input, file, events, version };
}

/** 探测一侧样本：候选里第一个存在的（old 用）。 */
function probeFirst(candidates) {
  for (const c of candidates) {
    const side = loadVocabSide(c);
    if (side.ok) return side;
  }
  return null;
}

/** 探测新线候选里版本最高者（new 用）—— 多份样本时"最高版本"才是目标线。 */
function probeHighest(candidates, compare) {
  let best = null;
  for (const c of candidates) {
    const side = loadVocabSide(c);
    if (!side.ok) continue;
    if (!best) { best = side; continue; }
    if (compare(side.version ?? '0.0.0', best.version ?? '0.0.0') > 0) best = side;
  }
  return best;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. 词表差异（验收①：0.1.5-rc 样本上的"词表差异"报告）
// ══════════════════════════════════════════════════════════════════════════════

/** 最长公共子串长度（改名候选的启发式之一；规模小，直接 O(n·m) DP）。 */
export function longestCommonSubstring(a, b) {
  const s1 = String(a ?? '');
  const s2 = String(b ?? '');
  if (!s1.length || !s2.length) return 0;
  let prev = new Array(s2.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= s1.length; i++) {
    const cur = new Array(s2.length + 1).fill(0);
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 词表差异：新增 / 删除 / 保留。 */
export function diffVocab(oldSet, newSet) {
  const removed = [...oldSet].filter((x) => !newSet.has(x)).sort();
  const added = [...newSet].filter((x) => !oldSet.has(x)).sort();
  const kept = [...oldSet].filter((x) => newSet.has(x)).sort();
  return { removed, added, kept };
}

/**
 * 改名候选配对（**启发式，必须人工确认**）。
 * 打分 = 0.5 × 同族（首个 `/` 之前的段相同） + 0.5 × 末段最长公共子串占比。
 * 实测校准：`tool/code-dispatch` ↔ `tool/ptc-dispatch` ≈ 0.85（同族 + 共有 `-dispatch`）；
 *           `assistant/chunk` ↔ `assistant/attempt` ≈ 0.58（同族但末段几乎无共同子串）
 *           —— 恰好对应官方结论（chunk 的流信息并入 `assistant/message.stream`，**不是** attempt）。
 */
export function renameCandidates(removed, added, { threshold = 0.5 } = {}) {
  const pairs = [];
  const familyOf = (t) => (t.includes('/') ? t.slice(0, t.indexOf('/')) : '');
  for (const r of removed) {
    for (const a of added) {
      const rf = familyOf(r);
      const af = familyOf(a);
      const rt = r.slice(rf.length);
      const at = a.slice(af.length);
      const familyMatch = rf !== '' && rf === af;
      const lcs = longestCommonSubstring(rt, at);
      const denom = Math.max(1, Math.min(rt.length, at.length));
      const ratio = lcs / denom;
      const score = 0.5 * (familyMatch ? 1 : 0) + 0.5 * ratio;
      if (score < threshold) continue;
      pairs.push({
        from: r,
        to: a,
        score: Number(score.toFixed(3)),
        familyMatch,
        tailLcs: lcs,
        confidence: score >= 0.75 ? '高' : score >= 0.6 ? '中' : '低',
        reason: `${familyMatch ? '同族' : '跨族'} + 末段公共子串 ${lcs}（${rt} → ${at}）`,
      });
    }
  }
  // 贪心一比一配对（高分优先），避免"一对多"噪音
  pairs.sort((x, y) => y.score - x.score || x.from.localeCompare(y.from));
  const usedFrom = new Set();
  const usedTo = new Set();
  const out = [];
  for (const p of pairs) {
    if (usedFrom.has(p.from) || usedTo.has(p.to)) continue;
    usedFrom.add(p.from);
    usedTo.add(p.to);
    out.push(p);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. 我方登记集合（宿主适配层唯一源 ∪ R4 补充表）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 动态 import 宿主适配层唯一源，收集"我方登记的会话事件名"。
 * 为什么不自己正则扫：`check-decoupling.hostVocabulary()` 已经这么干（含 R4 补充分），
 * 但它的正则只取 `[a-z-]` 区间、且看不到 EV 表的完整导出面 —— 直接 import 隔离模块拿到的是
 * **真导出面**（EV 值 / Set 成员 / 数组），比正则全且不会因注释里的示例名误收。
 */
export async function loadRegistered(adapterPath = path.join(HERE, 'lib', 'host-adapter.mjs')) {
  try {
    const mod = await import(pathToFileURL(adapterPath).href);
    const events = new Set();
    const collect = (v, depth = 0) => {
      if (depth > 4) return;
      if (typeof v === 'string') {
        if (/^[a-z][a-z0-9-]*\/[a-z0-9/_-]+$/.test(v)) events.add(v);
        return;
      }
      if (v instanceof Set) { for (const x of v) collect(x, depth + 1); return; }
      if (Array.isArray(v)) { for (const x of v) collect(x, depth + 1); return; }
      if (v && typeof v === 'object') {
        const proto = Object.getPrototypeOf(v);
        if (proto === Object.prototype || proto === null) for (const x of Object.values(v)) collect(x, depth + 1);
      }
    };
    for (const v of Object.values(mod)) collect(v);
    return {
      ok: true,
      path: adapterPath,
      version: mod.HOST_ADAPTER_VERSION ?? null,
      events,
      legacyName: typeof mod.legacyName === 'function' ? mod.legacyName : null,
      isTurnInterior: typeof mod.isTurnInterior === 'function' ? mod.isTurnInterior : null,
    };
  } catch (e) {
    return { ok: false, path: adapterPath, events: new Set(), error: String(e?.message ?? e) };
  }
}

/** 并入 `check-decoupling.hostVocabulary()`（R4 补充项；导入失败静默降级）。 */
export async function mergeHostVocabulary(reg) {
  try {
    const mod = await import(pathToFileURL(path.join(HERE, 'check-decoupling.mjs')).href);
    if (typeof mod.hostVocabulary !== 'function') return reg;
    const v = mod.hostVocabulary();
    for (const e of v.events) reg.events.add(e);
    return { ...reg, extraSource: 'check-decoupling.hostVocabulary' };
  } catch {
    return reg;
  }
}

/**
 * 静默失效判定：登记名 × 两线词表。
 * 分档（判定口径的唯一落点，改口径改这里）：
 *   🟢 OK         两线均在
 *   🟢 NEW-ONLY   仅目标线有（登记超前，正常）
 *   🟡 MAPPED     目标线已无，但适配层 `legacyName()` 已登记兼容映射
 *   🟡 FAMILY     目标线已无、无映射，但族判定（`isTurnInterior`）能兜住
 *   🔴 GONE       目标线已无、无映射、无族兜底 → **升级后静默失准**
 *   ⚪ NA         两线均不在会话词表（如 `fs/write-intent`：那是 fs 门不是会话事件）→ 不判定
 */
export function judgeCrossLine({ registered, oldSet, newSet, legacyName, isTurnInterior }) {
  const rows = [];
  for (const type of [...registered].sort()) {
    const inOld = oldSet.has(type);
    const inNew = newSet.has(type);
    let verdict = 'NA';
    let note = '两线均不在会话事件词表（非会话事件，本工具不判定）';
    if (inNew && inOld) { verdict = 'OK'; note = '两线均在'; }
    else if (inNew) { verdict = 'NEW-ONLY'; note = '仅目标线有（登记超前于现网线，正常）'; }
    else if (inOld) {
      const map = legacyName?.(type);
      if (map) {
        verdict = 'MAPPED';
        note = `已登记兼容映射 → \`${map.current}\`${map.note ? `（${map.note}）` : ''}`;
      } else if (isTurnInterior?.(type)) {
        verdict = 'FAMILY';
        note = '无映射，但族判定（前缀族）能兜住 → 不会静默失准';
      } else {
        verdict = 'GONE';
        note = '目标线已删除该事件名，且**无映射、无族兜底** → 升级后静默失准（判定会静默不命中）';
      }
    }
    rows.push({ type, inOld, inNew, verdict, note });
  }
  return rows;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3.5 高层入口（供 dsh-upgrade-audit.mjs / 面板 / 日报复用 —— **口径唯一，不复制判定**）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 跑一次完整判定（词表差异 + 登记名静默失效率），**不写盘、不扫描**（落盘与扫描是 CLI 职责）。
 * @param {{oldPath?:string|null, newPath?:string|null, semverCompare?:Function|null}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, oldSide?:object, newSide?:object,
 *   diff?:object, renames?:Array, judgeRows?:Array, registered?:object}>}
 */
export async function inspectVocab({ oldPath = null, newPath = null, semverCompare = null } = {}) {
  let cmp = semverCompare;
  if (!cmp) {
    try {
      ({ semverCompare: cmp } = await import(pathToFileURL(path.join(HERE, 'dsh-upgrade-watch.mjs')).href));
    } catch { /* 比较函数缺失 → 退化为字符串序 */ }
  }
  cmp = cmp ?? ((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));

  const oldSide = oldPath ? loadVocabSide(oldPath) : probeFirst(defaultOldCandidates());
  if (!oldSide?.ok) {
    return { ok: false, oldSide, reason: `现网线词表不可用：${oldSide?.error ?? `候选路径均不存在：${defaultOldCandidates().join(' / ')}`}` };
  }
  const newSide = newPath ? loadVocabSide(newPath) : probeHighest(defaultNewCandidates(), cmp);
  if (!newSide?.ok) {
    return { ok: false, newSide, reason: `目标线词表不可用：${newSide?.error ?? `候选路径均不存在：${defaultNewCandidates().join(' / ')}`}` };
  }
  const diff = diffVocab(oldSide.events, newSide.events);
  const renames = renameCandidates(diff.removed, diff.added);
  const registered = await mergeHostVocabulary(await loadRegistered());
  const judgeRows = registered.ok
    ? judgeCrossLine({
      registered: registered.events,
      oldSet: oldSide.events,
      newSet: newSide.events,
      legacyName: registered.legacyName,
      isTurnInterior: registered.isTurnInterior,
    })
    : [];
  return { ok: true, oldSide, newSide, diff, renames, judgeRows, registered };
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. 裸字面量扫描（补 R4 的第二道网：写死了"目标线已删"的事件名）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 豁免路径：宿主适配层（唯一合法落点）/ 测试夹具（故意用旧名）/ **本工具自身**（报告文案要举例）。
 * 口径与 check-decoupling R4 一致（多一条"本工具自身" + `fixtures\`）。
 * 【订正 2026-10-10 · <session-id>】check-decoupling 的 `R4_SKIP_PATH` 补了后缀式测试文件
 *   `<name>.test.mjs`（此前只认 `_test\` 与 `test-*.mjs`）⇒ 本表**同步补同一条**，否则两边口径
 *   再次分叉（本条声明的"一致"就成了假话）。只加这一条，其余白名单不动。
 */
export const LITERAL_SKIP_PATH = new RegExp(
  [
    '(^|[\\\\/])host-adapter\\.[cm]?js$',
    '(^|[\\\\/])_test[\\\\/]',
    '(^|[\\\\/])test-[^\\\\/]*\\.mjs$',
    '(^|[\\\\/])[^\\\\/]*\\.test\\.[cm]?js$',
    '(^|[\\\\/])fixtures[\\\\/]',
    '(^|[\\\\/])dsh-vocab-guard\\.mjs$',
  ].join('|'),
  'i',
);
const SKIP_DIRS = new Set(['node_modules', '.git', '_archive', '_tmp', 'dist', '.cache', 'backups', 'logs', 'generated']);
const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx)$/i;

/** 递归收集代码文件。 */
export function collectCodeFiles(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectCodeFiles(full, out, depth + 1);
    } else if (e.isFile() && CODE_EXT.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * 命中行的**线索分类**（不参与退出码，只帮人排队）：
 *   判定     → 同 `===`/`case`/`.type` 这类比较（最可能是真风险）
 *   映射表   → 同行的 `"key": "value"` 键值对（文案/标签表）
 *   文案/诊断 → console / 报告拼接
 *   待确认   → 其余
 */
export function classifyHit(line) {
  const s = String(line ?? '');
  if (/===|!==|case\s|\bswitch\b|\.type\b|\bhas\(|\.includes\(|\.startsWith\(/.test(s)) return '判定';
  if (/['"][^'"]+['"]\s*:\s*['"]/.test(s)) return '映射表';
  if (/console\.|L\.push|\.join\(|label|Label|LABEL|中文|说明/.test(s)) return '文案/诊断';
  return '待确认';
}

/**
 * 扫"目标线已删事件名"的裸字面量。
 * 白名单：①宿主适配层 ②`_test`/`fixtures`/`test-*.mjs` ③本工具自身 ④整行注释 / 行内 `//` 之后
 *         ⑤命中行（或上一行）带 `vocab-guard: allow` 标记 → 计入 allowed 而非 hits。
 * @param {string[]} roots 扫描根
 * @param {Set<string>} removedSet 目标线已删的事件名（来自 diffVocab）
 */
export function scanRemovedLiterals(roots, removedSet, { maxHits = 500 } = {}) {
  const hits = [];
  const allowed = [];
  let skippedCount = 0;
  const seen = new Set(); // realpath+行+名字 去重（junction 镜像会让同一文件被多个根扫到）
  for (const root of roots) {
    for (const file of collectCodeFiles(root)) {
      const rel = file.replace(/\\/g, '/');
      if (LITERAL_SKIP_PATH.test(rel)) { skippedCount += 1; continue; }
      let real = rel;
      try { real = fs.realpathSync(file).replace(/\\/g, '/'); } catch { /* 保留逻辑路径 */ }
      let src;
      try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const t = line.trim();
        if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/')) continue;
        const slash = line.indexOf('//');
        if (slash >= 0) line = line.slice(0, slash);
        for (const m of line.matchAll(/['"`]([A-Za-z0-9][A-Za-z0-9_/-]*)['"`]/g)) {
          if (!removedSet.has(m[1])) continue;
          const key = `${real}:${i + 1}|${m[1]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const allowHere = lines[i].includes(ALLOW_MARK) || (i > 0 && lines[i - 1].includes(ALLOW_MARK));
          const rec = {
            file: rel,
            line: i + 1,
            literal: m[1],
            hint: classifyHit(lines[i]),
          };
          if (allowHere) allowed.push(rec);
          else hits.push(rec);
          if (hits.length >= maxHits) return { hits, allowed, skippedCount, truncated: true };
        }
      }
    }
  }
  return { hits, allowed, skippedCount, truncated: false };
}

/**
 * 对账 `check-decoupling` 的 R4 位置清单（**动态 import 复用其判定，不复制**）。
 * 补的洞：R4 报的是"哪里写死了宿主字面量"，但**不知道那个字面量在目标线还在不在**；
 * 本函数把两边合起来 → 「R4 命中里，哪些会因升级而静默失准」。
 */
export async function crossCheckR4({ root, removedSet }) {
  try {
    const mod = await import(pathToFileURL(path.join(HERE, 'check-decoupling.mjs')).href);
    if (typeof mod.runChecks !== 'function') return { ok: false, error: 'check-decoupling 未导出 runChecks' };
    const res = mod.runChecks({ root, withR4: true });
    const all = (res?.r4?.violations ?? []).map((v) => ({
      pkg: v.pkg,
      file: String(v.file ?? '').replace(/\\/g, '/'),
      line: v.line ?? null,
      literal: v.literal ?? null,
    }));
    const broken = all.filter((v) => v.literal && removedSet.has(v.literal));
    return { ok: true, version: mod.VERSION ?? null, total: all.length, byPkgR4: res?.r4?.byPkg ?? {}, broken };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. 报告
// ══════════════════════════════════════════════════════════════════════════════

const ICON = { OK: '🟢', 'NEW-ONLY': '🟢', MAPPED: '🟡', FAMILY: '🟡', GONE: '🔴', NA: '⚪' };

/** 快照（给 `--save-baseline` / `--baseline` 用；只存判定与位置，不存正文）。 */
export function buildSnapshot({ oldSide, newSide, diff, judgeRows, scan, r4, generatedAt }) {
  return {
    schemaVersion: 1,
    tool: 'dsh-vocab-guard',
    version: VERSION,
    generatedAt,
    old: { version: oldSide.version, count: oldSide.events.size },
    new: { version: newSide.version, count: newSide.events.size },
    diff: { added: diff.added, removed: diff.removed },
    judge: judgeRows.map((r) => ({ type: r.type, verdict: r.verdict })),
    scan: (scan?.hits ?? []).map((h) => `${h.file}:${h.line}|${h.literal}`),
    r4Broken: (r4?.broken ?? []).map((b) => `${b.file}:${b.line}|${b.literal}`),
  };
}

/** 两次快照的差异（升级后跑：只关心"本次升级**新增**了什么断点"）。 */
export function diffSnapshots(prev, cur) {
  if (!prev?.judge || !cur?.judge) return null;
  const prevJudge = new Map(prev.judge.map((x) => [x.type, x.verdict]));
  const curJudge = new Map(cur.judge.map((x) => [x.type, x.verdict]));
  const regressed = [];
  const improved = [];
  for (const [type, verdict] of curJudge) {
    const before = prevJudge.get(type);
    if (before === undefined) { regressed.push({ type, from: '（未登记）', to: verdict }); continue; }
    if (before === verdict) continue;
    const rank = { OK: 0, 'NEW-ONLY': 0, FAMILY: 1, MAPPED: 1, NA: 0, GONE: 3 };
    if ((rank[verdict] ?? 0) > (rank[before] ?? 0)) regressed.push({ type, from: before, to: verdict });
    else improved.push({ type, from: before, to: verdict });
  }
  const prevScan = new Set(prev.scan ?? []);
  const curScan = new Set(cur.scan ?? []);
  const newHits = [...curScan].filter((x) => !prevScan.has(x));
  const goneHits = [...prevScan].filter((x) => !curScan.has(x));
  return {
    oldVersions: `${prev.old?.version ?? '?'} → ${cur.old?.version ?? '?'}`,
    newVersions: `${prev.new?.version ?? '?'} → ${cur.new?.version ?? '?'}`,
    regressed, improved, newHits, goneHits,
  };
}

export function renderReport(ctx) {
  const { oldSide, newSide, diff, renames, judgeRows, scan, r4, generatedAt, scanRoots, baselineDiff } = ctx;
  const L = [];
  const gone = judgeRows.filter((r) => r.verdict === 'GONE');
  const mapped = judgeRows.filter((r) => r.verdict === 'MAPPED');
  const family = judgeRows.filter((r) => r.verdict === 'FAMILY');
  const na = judgeRows.filter((r) => r.verdict === 'NA');
  const scanHits = scan?.hits ?? [];
  const scanAllowed = scan?.allowed ?? [];

  L.push('# 会话事件词表守卫报告（跨线词表差异 + 静默失效检测）');
  L.push('');
  L.push(`生成：${generatedAt}｜工具版本：dsh-vocab-guard v${VERSION}`);
  L.push('');
  L.push(`- 现网线（old）：\`${oldSide.file}\`${oldSide.version ? ` — \`@deepseek-ai/dsh-session@${oldSide.version}\`` : ''}`);
  L.push(`- 目标线（new）：\`${newSide.file}\`${newSide.version ? ` — \`@deepseek-ai/dsh-session@${newSide.version}\`` : ''}`);
  L.push('');
  L.push('> 口径：词表 = `KNOWN_SESSION_EVENT_TYPES`；判定 = 我方登记名（宿主适配层唯一源）× 两线词表。');
  L.push('> 只读、离线、幂等；口径文档 `docs\\升级-词表守卫与静默失效检测-口径-20260915.md`。');
  L.push('');

  L.push('## ① 词表差异');
  L.push('');
  L.push('| 项 | 数量 |');
  L.push('|---|---|');
  L.push(`| 现网线事件名 | ${oldSide.events.size} |`);
  L.push(`| 目标线事件名 | ${newSide.events.size} |`);
  L.push(`| 两线均在 | ${diff.kept.length} |`);
  L.push(`| **目标线新增** | ${diff.added.length} |`);
  L.push(`| **目标线删除** | ${diff.removed.length} |`);
  L.push('');
  L.push(`**目标线删除（${diff.removed.length}）**：${diff.removed.map((x) => `\`${x}\``).join('、') || '（无）'}`);
  L.push('');
  L.push(`**目标线新增（${diff.added.length}）**：${diff.added.map((x) => `\`${x}\``).join('、') || '（无）'}`);
  L.push('');
  L.push(`### 改名候选（启发式 ${renames.length} 对 · **必须人工确认**）`);
  L.push('');
  if (!renames.length) L.push('- （无候选）');
  else {
    L.push('| 旧名 | 新名 | 置信 | 依据 |');
    L.push('|---|---|---|---|');
    for (const r of renames) L.push(`| \`${r.from}\` | \`${r.to}\` | ${r.confidence}（${r.score}） | ${r.reason} |`);
    L.push('');
    L.push('> ⚠️ 启发式**不代表官方语义**：低分对（如 `chunk` ↔ `attempt`）尤其可能只是同族巧合。');
    L.push('> 官方 d.ts 口径：`assistant/chunk` 的增量流信息并入 `assistant/message.stream`，**不要**映射到 `attempt`。');
  }
  L.push('');

  L.push('## ② 静默失效判定（我方登记名 × 两线词表）');
  L.push('');
  L.push(`| 判定 | 含义 | 数量 |`);
  L.push('|---|---|---|');
  L.push(`| 🟢 OK | 两线均在 | ${judgeRows.filter((r) => r.verdict === 'OK').length} |`);
  L.push(`| 🟢 NEW-ONLY | 仅目标线有 | ${judgeRows.filter((r) => r.verdict === 'NEW-ONLY').length} |`);
  L.push(`| 🟡 MAPPED | 已登记兼容映射 | ${mapped.length} |`);
  L.push(`| 🟡 FAMILY | 无映射但族判定兜住 | ${family.length} |`);
  L.push(`| 🔴 GONE | 跨线消失且无替代 | ${gone.length} |`);
  L.push(`| ⚪ NA | 非会话事件，不判定 | ${na.length} |`);
  L.push('');
  const interesting = judgeRows.filter((r) => r.verdict !== 'OK' && r.verdict !== 'NA');
  if (!interesting.length) L.push('- 🟢 无跨线断裂项');
  else {
    L.push('| 我方登记名 | 现网线 | 目标线 | 判定 | 说明 |');
    L.push('|---|---|---|---|---|');
    for (const r of interesting) L.push(`| \`${r.type}\` | ${r.inOld ? '在' : '无'} | ${r.inNew ? '在' : '无'} | ${ICON[r.verdict]} ${r.verdict} | ${r.note} |`);
  }
  L.push('');
  if (na.length) {
    L.push(`> ⚪ NA（${na.length} 项）：${na.map((r) => `\`${r.type}\``).join('、')}`);
    L.push('> —— 这些不是会话事件（如 `fs/*` 是 fs 门、`tools/pre-execute` 是工具门），不在');
    L.push('> `KNOWN_SESSION_EVENT_TYPES` 属正常（词表注释明确"下游插件事件天然不在表内"），**报红就是误报**，故单列不判定。');
    L.push('');
  }

  if (scan) {
    L.push('## ③ 裸字面量扫描（写死了"目标线已删事件名"的代码位置）');
    L.push('');
    L.push(`扫描根：${scanRoots.map((r) => `\`${r}\``).join('、')}｜豁免（适配层 / 测试夹具 / 本工具自身）：${scan.skippedCount} 个文件`);
    L.push('');
    if (!scanHits.length) L.push('- 🟢 未发现写死已删事件名的位置');
    else {
      L.push('| 位置 | 写死的名字 | 线索 |');
      L.push('|---|---|---|');
      for (const h of scanHits.slice(0, 60)) L.push(`| \`${h.file}:${h.line}\` | \`${h.literal}\` | ${h.hint} |`);
      if (scanHits.length > 60) L.push(`| … | 另有 ${scanHits.length - 60} 处（见 JSON） | |`);
      L.push('');
      L.push('> 这些位置在目标线上**不会报错**，只是判定恒不命中（= 静默失准）。');
      L.push('> 线索列仅供参考：`判定` = 该行在做比较（最可能是真风险）；`映射表` = 文案/标签字典（降级不致命）。');
      L.push('> 处置：① 收敛进宿主适配层（`EV`/`legacyName`）② 改前缀族判定 ③ 确认无害的加 `// vocab-guard: allow <原因>`。');
    }
    if (scanAllowed.length) {
      L.push('');
      L.push(`**已声明豁免（\`${ALLOW_MARK}\`）：${scanAllowed.length} 处**`);
      L.push('');
      L.push('| 位置 | 名字 |');
      L.push('|---|---|');
      for (const h of scanAllowed.slice(0, 30)) L.push(`| \`${h.file}:${h.line}\` | \`${h.literal}\` |`);
    }
    L.push('');
    L.push('### 与 R4 对账（`check-decoupling.mjs` 口径）');
    L.push('');
    if (!r4?.ok) L.push(`- ⚠️ 未能复用 R4 判定（${r4?.error ?? '未知原因'}）—— 本节缺省，扫描结果为上表独立网。`);
    else {
      L.push(`- R4 命中合计 **${r4.total}** 处（含服务名与 inject 声明；口径见 \`docs\\大管家adapter能力-方案-20260914.md\` §3.5）`);
      L.push(`- 其中**跨线断裂**（名字在目标线已删）**${r4.broken.length}** 处 ${r4.broken.length ? '🔴' : '🟢'}`);
      if (r4.broken.length) {
        L.push('');
        L.push('| 包 | 位置 | 名字 |');
        L.push('|---|---|---|');
        for (const b of r4.broken.slice(0, 40)) L.push(`| ${b.pkg} | \`${b.file}:${b.line}\` | \`${b.literal}\` |`);
      }
    }
    L.push('');
  }

  if (baselineDiff) {
    L.push('## ④ 与基线快照对比（升级后新增的断点）');
    L.push('');
    L.push(`- 现网线：${baselineDiff.oldVersions}｜目标线：${baselineDiff.newVersions}`);
    L.push(`- 判定档位**恶化**：${baselineDiff.regressed.length} 项｜改善：${baselineDiff.improved.length} 项`);
    L.push(`- 扫描命中**新增**：${baselineDiff.newHits.length} 处｜消失：${baselineDiff.goneHits.length} 处`);
    L.push('');
    if (baselineDiff.regressed.length) {
      L.push('| 名字 | 基线 | 现在 |');
      L.push('|---|---|---|');
      for (const r of baselineDiff.regressed) L.push(`| \`${r.type}\` | ${r.from} | ${r.to} |`);
    }
    for (const h of baselineDiff.newHits.slice(0, 20)) L.push(`- 🆕 新增命中：\`${h}\``);
    L.push('');
  }

  L.push('## 结论');
  L.push('');
  if (gone.length || r4?.broken?.length) {
    L.push(`- 🔴 **存在静默失效风险**：登记名跨线消失无替代 ${gone.length} 项；R4 命中里跨线断裂 ${r4?.broken?.length ?? 0} 处`);
    L.push('- 处置见 `docs\\升级-词表守卫与静默失效检测-口径-20260915.md` §处置矩阵（升级前必须收口）');
  } else {
    L.push('- 🟢 登记名全部有替代路径（映射或族判定）');
  }
  if (scanHits.length) {
    L.push(`- 🟡 另有 ${scanHits.length} 处写死已删事件名的位置（默认只提醒，不拦；\`--strict-scan\` 才计入退出码）`);
  } else if (scan) {
    L.push('- 🟢 未发现写死已删事件名的位置');
  }
  L.push('');
  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. CLI
// ══════════════════════════════════════════════════════════════════════════════

export const HELP = [
  'dsh-vocab-guard.mjs —— 会话事件词表守卫（跨线词表差异 + 静默失效检测）',
  '',
  '用法：node dsh-vocab-guard.mjs [选项]',
  '  --old <path>        现网线 dsh-session 包目录或词表文件（默认自动探测生产全局主包闭包）',
  '  --new <path>        目标线同上（默认探测金丝雀主包副本，取版本最高者）',
  '  --scan-root <dir>   裸字面量扫描根（可重复；默认当前目录 + profile 自研包实体）',
  '  --no-scan           跳过扫描（只做词表差异 + 登记名判定）',
  '  --strict-scan       扫描命中计入退出码（默认只提醒，同 R4 的 D2 决策）',
  '  --out <file>        报告输出（默认 <tmp>/dsh-vocab-guard-report.md）',
  '  --no-out            不写报告文件（只打印摘要）',
  '  --json <file>       额外写机器可读 JSON',
  '  --save-baseline <f> 把本次判定写成基线快照（升级前跑）',
  '  --baseline <f>      与基线快照对比，只报"本次新增的断点"（升级后跑）',
  '  --quiet             只打印结论摘要',
  '  --help / -h         本帮助',
  '',
  '退出码：0 无 🔴 / 1 有 🔴（GONE，或 --strict-scan 下的扫描命中）/ 2 用法错误 / 3 词表样本缺失',
].join('\n');

function parseArgs(argv) {
  const o = {
    old: process.env.DSH_VOCAB_OLD || null,
    new: process.env.DSH_VOCAB_NEW || null,
    scanRoots: [],
    scan: true,
    strictScan: false,
    out: process.env.DSH_VOCAB_OUT || DEFAULT_OUT,
    json: null,
    baseline: null,
    saveBaseline: null,
    quiet: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--old' && argv[i + 1]) o.old = argv[++i];
    else if (a === '--new' && argv[i + 1]) o.new = argv[++i];
    else if (a === '--scan-root' && argv[i + 1]) o.scanRoots.push(argv[++i]);
    else if (a === '--no-scan') o.scan = false;
    else if (a === '--strict-scan') o.strictScan = true;
    else if (a === '--out' && argv[i + 1]) o.out = argv[++i];
    else if (a === '--no-out') o.out = null;
    else if (a === '--json' && argv[i + 1]) o.json = argv[++i];
    else if (a === '--save-baseline' && argv[i + 1]) o.saveBaseline = argv[++i];
    else if (a === '--baseline' && argv[i + 1]) o.baseline = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else return { error: `未知参数：${a}` };
  }
  if (!o.scanRoots.length) o.scanRoots = defaultScanRoots();
  return o;
}

/** 入口守卫：junction 下 import.meta.url（物理）与 argv[1]（逻辑）必须 realpath 后比较。 */
function isMainEntry() {
  try {
    const fromMeta = fs.realpathSync(fileURLToPath(import.meta.url));
    const fromArgv = fs.realpathSync(path.resolve(process.argv[1] ?? ''));
    return fromMeta === fromArgv;
  } catch {
    return false;
  }
}

function writeJsonFile(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`[用法错误] ${args.error}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  // ---- 1) 两线词表 + 登记名判定（口径唯一：走 inspectVocab） ----
  const inspected = await inspectVocab({ oldPath: args.old, newPath: args.new });
  if (!inspected.ok) {
    console.error(`[样本缺失] ${inspected.reason}`);
    console.error('           用 --old / --new <dsh-session 包目录> 显式指定（可 npm pack 目标版本后解压）。');
    return 3;
  }
  const { oldSide, newSide, diff, renames, judgeRows } = inspected;
  const removedSet = new Set(diff.removed);

  // ---- 3) 扫描 ----
  let scan = null;
  let r4 = null;
  if (args.scan) {
    scan = scanRemovedLiterals(args.scanRoots, removedSet);
    r4 = await crossCheckR4({ root: args.scanRoots[0], removedSet });
  }

  const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const snapshot = buildSnapshot({ oldSide, newSide, diff, judgeRows, scan, r4, generatedAt });

  // ---- 4) 基线对比（#12：升级后自动检测"本次新增了什么"） ----
  let baselineDiff = null;
  let baselineNote = null;
  if (args.baseline) {
    const prev = readJsonFile(args.baseline);
    if (!prev) baselineNote = `基线快照读不到 / 非法 JSON：${args.baseline}`;
    else baselineDiff = diffSnapshots(prev, snapshot);
  }

  const report = renderReport({
    oldSide, newSide, diff, renames, judgeRows, scan, r4, generatedAt,
    scanRoots: args.scanRoots, baselineDiff,
  });

  // ---- 5) 退出码 ----
  const gone = judgeRows.filter((r) => r.verdict === 'GONE');
  const hits = scan?.hits ?? [];
  const r4Broken = r4?.broken?.length ?? 0;
  let code = 0;
  if (gone.length || r4Broken) code = 1;
  else if (args.strictScan && hits.length) code = 1;

  // ---- 6) 落盘 ----
  const writeErrors = [];
  if (args.out) {
    const err = (() => {
      try {
        fs.mkdirSync(path.dirname(args.out), { recursive: true });
        fs.writeFileSync(args.out, report, 'utf8');
        return null;
      } catch (e) { return String(e?.message ?? e); }
    })();
    if (err) writeErrors.push(`报告：[警告] 写入失败 ${err}`);
  }
  if (args.json) {
    const payload = { ...snapshot, exitCode: code, baselineDiff };
    const err = writeJsonFile(args.json, payload);
    if (err) writeErrors.push(`JSON：[警告] 写入失败 ${err}`);
  }
  if (args.saveBaseline) {
    const err = writeJsonFile(args.saveBaseline, snapshot);
    if (err) writeErrors.push(`基线：[警告] 写入失败 ${err}`);
  }

  // ---- 7) 输出 ----
  const summary = `vocab-guard：词表差异 删${diff.removed.length}/增${diff.added.length}/改名候选${renames.length}`
    + `｜登记名 🔴GONE ${gone.length} · 🟡${judgeRows.filter((r) => r.verdict === 'MAPPED' || r.verdict === 'FAMILY').length}`
    + `｜写死已删名字 ${hits.length} 处（豁免 ${scan?.allowed?.length ?? 0}）`
    + `｜R4 跨线断裂 ${r4Broken}`
    + (baselineDiff ? `｜对比基线：恶化 ${baselineDiff.regressed.length} / 新增命中 ${baselineDiff.newHits.length}` : '')
    + ` → exit ${code}`;
  if (args.quiet) console.log(summary);
  else {
    console.log(report);
    console.log(`\n${summary}`);
    if (args.out) console.log(`[报告] ${args.out}`);
    if (args.json) console.log(`[json] ${args.json}`);
    if (args.saveBaseline) console.log(`[基线] ${args.saveBaseline}`);
    if (baselineNote) console.log(`[基线] ⚠️ ${baselineNote}`);
  }
  for (const w of writeErrors) console.error(w);
  return code;
}

if (isMainEntry()) {
  // ⚠️ 不用 process.exit()：Windows 上强退有概率崩 libuv（nodejs/node#56645）
  process.exitCode = await main();
}
