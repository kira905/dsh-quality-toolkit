#!/usr/bin/env node
// tools/sync-host-adapter.mjs —— 宿主适配层「唯一源 → 各包派生副本」幂等同步器
//
// 方案：docs\大管家adapter能力-方案-20260914.md §3.7（唯一源 + 派生副本 + R5 校验）/ §9.2 I2（ESM/CJS 双产物）
// 守门：tools\check-decoupling.mjs R5 校验「副本 sha == 唯一源」，不一致 → 🔴 且**计入退出码**。
//
// 为什么不是"一个文件被 7 包共同 import"：
//   插件实体（面板 / 看板 / 归档）可能被单独拷到别的机器，`state.js` 明写"刻意内联而不 import"
//   ⇒ 适配层必须"每包一份可用副本"。唯一源防分叉，同步器防手改，R5 防静默过期。
//
// 产物形态：
//   - ESM 副本：`lib/host-adapter.mjs`（头 + 源内容原样）
//   - CJS 副本：`lib/host-adapter.js`（头 + 受限转译 `export const/function` → 顶层声明 + `module.exports`）
//   头里带 `sourceSha256` —— R5 用「头里的 sha」与「去头内容的 sha」双重比对（改头也逃不过）。
//
// 幂等（重要设计）：头里**不含任何时间戳/随机值**，产物完全由唯一源决定
//   ⇒ 同一源反复同步 = 逐字节相同 = 直接跳过；R5 才能做精确比对。
//
// 用法：
//   node tools\sync-host-adapter.mjs               # 同步全部 enabled 目标（幂等，内容相同即跳过）
//   node tools\sync-host-adapter.mjs --verify      # 只校验不写；任一不一致 → exit 1
//   node tools\sync-host-adapter.mjs --dry-run     # 预览（不写）
//   node tools\sync-host-adapter.mjs --all         # 连 enabled:false 的目标也处理（P1 启用前手动预演）
//   node tools\sync-host-adapter.mjs --json <p>    # 额外落 JSON（默认 _tmp\sync-host-adapter.json）
//   node tools\sync-host-adapter.mjs --self-test   # 自检：转译器 / 头往返 / 幂等（临时目录，零生产写入）
// 退出码：0 = 同步完成 / 校验一致；1 = 校验不一致或转译失败；2 = 用法错误
//
// 只读唯一源 + 只写目标副本；零第三方依赖（node >= 18）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 工作区根：tools/ 的父目录（junction 安全 —— 若解析不到 tools\dsh-butler 则回退 <DSH_ROOT>）。 */
const ROOT = (() => {
  const guess = path.resolve(HERE, '..');
  if (fs.existsSync(path.join(guess, 'tools', 'dsh-butler'))) return guess;
  return process.env.DSH_ROOT || path.resolve(HERE, '..');
})();

/** 唯一源（唯一真相；副本一律由它派生）。 */
export const SOURCE = path.join(ROOT, 'tools', 'lib', 'host-adapter.mjs');
/** 源标识（写进副本头，跨机可读）。 */
export const SOURCE_LABEL = 'tools/lib/host-adapter.mjs';

/**
 * 派生副本目标表。
 * `enabled:false` = 登记但本卡不生成（`--all` / 指定 DSH_HOME 时可手动处理）。
 * `prodRel`（可选 · 2026-10-14 新增）= 该目标在**生产 profile 包目录内**的相对位置；缺省 `lib/<basename(file)>`。
 *   只有「一个包多条目标、生产里只有其中一种形态」才需要配（先例 `dsh-memory-local`：src 与 lib 两条
 *   的 basename 同名，缺省拼法会让两条指向**同一个生产文件** ⇒ 必有一行假红）。
 */
export const TARGETS = [
  {
    id: 'butler-lib-esm',
    label: '大管家底座 lib（ESM）',
    pkg: 'dsh-butler',
    file: path.join(ROOT, 'tools', 'dsh-butler', 'lib', 'host-adapter.mjs'),
    format: 'esm',
    enabled: true,
    consumers: 'lib/restart.mjs · lib/watch-collect.mjs · lib/token-usage.mjs · lib/pitfall-scan.mjs · lib/shell-session-watch.mjs',
  },
  {
    id: 'butler-panel-esm',
    label: '大管家面板 lib（ESM）',
    pkg: 'dsh-butler-panel',
    file: path.join(ROOT, 'tools', 'dsh-butler-panel', 'lib', 'host-adapter.mjs'),
    format: 'esm',
    enabled: true,
    consumers: 'lib/state.js（被打断会话判定 + 尾部文案）· lib/audit-guard.js（P5 写入守门人事件名）· lib/index.js（inject 声明）',
  },
  // ── P1 扩面（2026-09-15）：以下包原先各自写裸字面量，现消费同一唯一源的副本 ──
  {
    id: 'archive-sessions-lib-esm',
    label: '归档会话 lib（ESM）',
    pkg: 'dsh-archive-sessions',
    file: path.join(ROOT, 'tools', 'dsh-archive-sessions', 'lib', 'host-adapter.js'),
    format: 'esm',
    enabled: true,
    consumers: 'lib/index.js · 包根一次性脚本 clean-empty-shells.mjs / scan-empty.mjs / scan-small.mjs',
  },
  // ── 归档元数据库共享件（2026-09-28 · M2 卡）：**第二个唯一源**
  //    唯一源 tools\lib\archive-meta-store.mjs → 归档插件 lib 副本。
  //    走同一目标表 = 自动进 R5（check-decoupling 的 verifySummary）+ 生产实体核对
  //    （PROD_PROFILE_DIRS 已有 dsh-archive-sessions）。方案 §5.2「甲案」。
  {
    id: 'archive-sessions-meta-store-esm',
    label: '归档元数据库共享件（ESM · 唯一源 tools/lib/archive-meta-store.mjs）',
    pkg: 'dsh-archive-sessions',
    file: path.join(ROOT, 'tools', 'dsh-archive-sessions', 'lib', 'archive-meta-store.js'),
    format: 'esm',
    enabled: true,
    source: path.join(ROOT, 'tools', 'lib', 'archive-meta-store.mjs'),
    sourceLabel: 'tools/lib/archive-meta-store.mjs',
    consumers: 'lib/index.js（库读写：读侧四级 / 轮末批量写 / 状态迁移 / 惰性补写）· tools\\archive-meta-backfill.mjs（回填）· 两条旁路搬移脚本',
  },
  {
    id: 'ecosystem-panel-lib-esm',
    label: '生态面板 lib（ESM）',
    pkg: 'dsh-ecosystem-panel',
    file: path.join(ROOT, 'tools', 'dsh-ecosystem-panel', 'lib', 'host-adapter.js'),
    format: 'esm',
    enabled: true,
    consumers: 'lib/index.js（inject 声明）',
  },
  {
    id: 'task-board-local-lib-esm',
    label: '任务看板 lib（ESM + .d.ts）',
    pkg: 'dsh-task-board-local',
    file: path.join(ROOT, 'tools', 'dsh-task-board-local', 'lib', 'host-adapter.js'),
    format: 'esm',
    enabled: true,
    dts: true, // TS 源码要 import 它（`../lib/host-adapter.js`）→ 需伴随类型声明（由本脚本生成）
    consumers: 'src/index.ts · src/host-runner.ts · src/settings-compat.ts（node 半；client 半引用不到，见报告余项）',
  },
  {
    id: 'session-title-live-lib-esm',
    label: '会话标题 lib（ESM）',
    pkg: 'dsh-session-title-live',
    file: path.join(ROOT, 'tools', 'session-title-live', 'lib', 'host-adapter.js'),
    format: 'esm',
    enabled: true,
    consumers: 'lib/index.js（inject 声明 + 事件判定）',
  },
  // ── U3 扩面（2026-09-22）：记忆引擎 fork（G24 建设期新增包，P1 时还不存在） ──
  {
    id: 'memory-local-src-esm',
    label: '记忆引擎 fork src（ESM · 源码与测试消费）',
    pkg: 'dsh-memory-local',
    file: path.join(ROOT, 'tools', 'dsh-memory-local', 'src', 'host-adapter.js'),
    format: 'esm',
    enabled: true,
    // 生产 profile 的 dsh-memory 包**只有 lib 构建产物、没有 src 目录**（build.mjs 把 src/*.js 拷进 lib/）
    // ⇒ 本行如实指到 `src/host-adapter.js`：生产里不存在 ⇒ 记 `missing`（现有语义：不算失败）。
    // 不配它的话，本条与下面 lib 那条会拼出**同一个生产文件**（basename 同名）⇒ 必有一行假红。
    prodRel: path.join('src', 'host-adapter.js'),
    consumers: 'src/index.js（inject 声明）· src/injector.mjs（事件族判定）· test/fixtures-s2b.mjs · test/probe-entity.mjs',
  },
  {
    id: 'memory-local-lib-esm',
    label: '记忆引擎 fork lib（ESM · 运行时实体）',
    pkg: 'dsh-memory-local',
    file: path.join(ROOT, 'tools', 'dsh-memory-local', 'lib', 'host-adapter.js'),
    format: 'esm',
    enabled: true,
    // build.mjs 会把 src/*.js 拷进 lib/ ⇒ 本目标与 src 目标是**同一唯一源**（正文逐字节相同），
    // 但两份产物头里的 `// target:` id 不同 ⇒ 两份文件**并非**逐字节相同（2026-10-14 订正旧注释）。
    // 单独登记是为了让 R5 也守住「build 没跑 / 产物过期」这一形态（只守 src 会漏）；
    // 生产 profile 里的运行时实体就是这一份（src 那条在生产里不存在 ⇒ 记 missing）。
    consumers: 'lib/index.js · lib/injector.mjs（= src 的构建产物）',
  },
  {
    id: 'task-control-profile-esm',
    label: '任务控制（profile 实体 · 无源码目录）',
    pkg: 'dsh-task-control',
    // 口径与 check-decoupling 一致：BUTLER_DSH_HOME > DSH_HOME > ~/.dsh
    file: path.join(process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      'profiles', 'web', 'node_modules', 'dsh-task-control', 'lib', 'host-adapter.js'),
    format: 'esm',
    // ⚠️ 默认不生成：该包只在生产 profile 里有实体（无 tools\ 源码目录），写它 = 直接改生产。
    //    需要时显式 `DSH_HOME=<目标 home> node sync-host-adapter.mjs --all`（隔离环境流程）。
    enabled: false,
    consumers: 'lib/index.js（inject 声明 + 事件判定）',
  },
];

const HEAD_MARK = 'GENERATED FILE — DO NOT EDIT';
const HEAD_END = '══ END HEADER ══';
const JSON_DEFAULT = path.join(ROOT, '_tmp', 'sync-host-adapter.json');

// ---------------------------------------------------------------- 头 / 摘要

/** sha256（hex，utf8）。 */
function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 头部文本 —— **以单个 '\n' 结尾**（末尾空项负责），保证 `header + src` 不粘连正文。
 * ⚠️ 头里不得出现时间戳/随机值：产物必须完全由唯一源决定（幂等 + R5 可精确比对）。
 */
export function renderHeader({ sha, version, format, targetId, sourceLabel }) {
  return [
    `// ══ ${HEAD_MARK} ══`,
    '// 本文件由 tools/sync-host-adapter.mjs 生成 —— 手工修改会在下一次同步时被覆盖，',
    '// 且会被 tools/check-decoupling.mjs 的 R5 判为违规（副本 sha ≠ 唯一源）。改接口请改唯一源。',
    `// source: ${sourceLabel ?? SOURCE_LABEL}`,
    `// sourceSha256: ${sha}`,
    `// sourceVersion: ${version ?? 'unknown'}`,
    `// format: ${format}`,
    `// target: ${targetId}`,
    `// ${HEAD_END}`,
    '',
  ].join('\n');
}

/**
 * 从产物文本剥掉头。
 * @returns {{sha:string|null, version:string|null, body:string, hasHeader:boolean}}
 */
export function stripHeader(text) {
  const src = String(text ?? '');
  const idx = src.indexOf(HEAD_END);
  if (idx < 0) return { sha: null, version: null, body: src, hasHeader: false };
  const head = src.slice(0, idx);
  const nl = src.indexOf('\n', idx);
  const body = nl < 0 ? '' : src.slice(nl + 1);
  const m = /sourceSha256:\s*([0-9a-f]{64})/.exec(head);
  const v = /sourceVersion:\s*([^\s]+)/.exec(head);
  return { sha: m ? m[1] : null, version: v ? v[1] : null, body, hasHeader: true };
}

/**
 * 源文件里的语义版本。
 *  · host-adapter 系唯一源：`export const HOST_ADAPTER_VERSION = 'x.y.z'`
 *  · 其它唯一源（如 archive-meta-store）：`export const VERSION = 'x.y.z'`
 * 两条都不命中 ⇒ 'unknown'（不阻断同步，只让头里少一个可读字段）。
 */
export function sourceVersionOf(src) {
  const text = String(src ?? '');
  const m = /HOST_ADAPTER_VERSION\s*=\s*'([^']+)'/.exec(text)
    ?? /^export\s+const\s+VERSION\s*=\s*'([^']+)'/m.exec(text);
  return m ? m[1] : 'unknown';
}

// ---------------------------------------------------------------- 转译（ESM → CJS）

/**
 * 受限 ESM → CJS 转译（**只支持唯一源实际使用的形态**）：
 *   `export const X = …` / `export function f(…){}` / `export { a, b }`；
 *   出现 `export default` 或无法识别的 `export` 形态 → **显式抛错**（宁可失败，也不静默产坏产物）。
 * 末尾追加 `module.exports = { …全部导出名 }`；导出键集合由 selfTest 与 ESM 侧逐一比对。
 */
export function toCjs(src) {
  const text = String(src ?? '');
  if (/^\s*export\s+default\b/m.test(text)) throw new Error('toCjs: 唯一源出现 export default（不受支持）');
  const names = new Set();
  let out = text;
  out = out.replace(/^export\s+const\s+([A-Za-z0-9_$]+)/gm, (_m, n) => { names.add(n); return `const ${n}`; });
  out = out.replace(/^export\s+function\s+([A-Za-z0-9_$]+)/gm, (_m, n) => { names.add(n); return `function ${n}`; });
  out = out.replace(/^export\s+\{([^}]*)\}\s*;?\s*$/gm, (_m, group) => {
    for (const part of group.slice(1, -1).split(',')) {
      const t = part.trim();
      if (!t) continue;
      names.add(t.split(/\s+as\s+/).pop().trim());
    }
    return '';
  });
  if (/^\s*export\s/m.test(out)) throw new Error('toCjs: 仍有未处理的 `export` 形态，转译规则需扩展');
  const list = [...names].sort();
  out += `\n// ── CJS 导出尾（由 sync-host-adapter.mjs 生成）──\nmodule.exports = {\n${list.map((n) => `  ${n},`).join('\n')}\n};\n`;
  return { code: out, names: list };
}

/** 唯一源的导出名（正则抓取；与 CJS 转译用同一套规则）。 */
function sourceExportNames(src) {
  const keys = new Set();
  for (const m of String(src ?? '').matchAll(/^export\s+const\s+([A-Za-z0-9_$]+)/gm)) keys.add(m[1]);
  for (const m of String(src ?? '').matchAll(/^export\s+function\s+([A-Za-z0-9_$]+)/gm)) keys.add(m[1]);
  for (const m of String(src ?? '').matchAll(/^export\s+\{([^}]*)\}\s*;?\s*$/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (t) keys.add(t.split(/\s+as\s+/).pop().trim());
    }
  }
  return keys;
}

// ---------------------------------------------------------------- 同步 / 校验

/** 某目标的唯一源（默认 host-adapter；目标可带 `source` 指向另一个唯一源）。 */
export function sourceOf(target = {}) {
  return target.source ?? SOURCE;
}

function readPlanFor(target = {}) {
  const file = sourceOf(target);
  if (!fs.existsSync(file)) return { error: `唯一源不存在: ${file}`, file };
  const source = fs.readFileSync(file, 'utf8');
  return { source, sha: sha256(source), version: sourceVersionOf(source), file, label: target.sourceLabel ?? SOURCE_LABEL };
}

function readPlan() {
  return readPlanFor({});
}

/** 目标文件的伴随类型声明路径（`.js` → `.d.ts`；`.mjs` → `.d.mts`）。 */
export function dtsPathOf(file) {
  if (file.endsWith('.mjs')) return `${file.slice(0, -4)}.d.mts`;
  if (file.endsWith('.js')) return `${file.slice(0, -3)}.d.ts`;
  return `${file}.d.ts`;
}

/** 唯一源里每种导出形态的名字（`export const` / `export function`）。 */
export function exportKinds(src) {
  const consts = new Set();
  const fns = new Set();
  for (const m of String(src ?? '').matchAll(/^export\s+const\s+([A-Za-z0-9_$]+)/gm)) consts.add(m[1]);
  for (const m of String(src ?? '').matchAll(/^export\s+function\s+([A-Za-z0-9_$]+)/gm)) fns.add(m[1]);
  return { consts, fns };
}

/**
 * 伴随 `.d.ts`（**宽松类型**）—— 供 TS 源码 `import … from '../lib/host-adapter.js'` 过类型检查。
 * 只声明导出名与形状（表类给 `Record<string,string>`，其余 `any`）；运行时用的是同名 .js 副本。
 * 口径与主产物一致：完全由唯一源决定（无时间戳），故可幂等 + 可校验。
 */
export function renderDts(src, sha, version, targetId) {
  const { consts, fns } = exportKinds(src);
  const lines = [
    '// ══ GENERATED FILE — DO NOT EDIT ══',
    '// 类型声明（宽松）：由 tools/sync-host-adapter.mjs 从唯一源导出名生成 ——',
    '// 只为让 TS 源码 import 同名 .js 副本时过类型检查；真正实现请看该 .js 副本。',
    `// source: ${SOURCE_LABEL}`,
    `// sourceSha256: ${sha}`,
    `// sourceVersion: ${version ?? 'unknown'}`,
    `// target: ${targetId}`,
    '',
  ];
  for (const n of [...consts].sort()) {
    const type = (n === 'EV' || n === 'SVC') ? 'Record<string, string>' : 'any';
    lines.push(`export declare const ${n}: ${type};`);
  }
  for (const n of [...fns].sort()) lines.push(`export declare function ${n}(...args: any[]): any;`);
  return `${lines.join('\n')}\n`;
}

/** 计算某目标的期望产物（不落盘）。 */
export function expectedArtifact(src, sha, version, target) {
  const header = renderHeader({ sha, version, format: target.format, targetId: target.id, sourceLabel: target.sourceLabel });
  const extra = target.dts === true ? { dtsText: renderDts(src, sha, version, target.id), dtsFile: dtsPathOf(target.file) } : {};
  if (target.format === 'cjs') {
    const { code, names } = toCjs(src);
    return { text: header + code, exportNames: names, ...extra };
  }
  return { text: header + src, exportNames: null, ...extra };
}

/**
 * 同步（幂等）或校验。
 * @param {{mode?:'sync'|'verify', dryRun?:boolean, all?:boolean}} opts
 */
export function run(opts = {}) {
  const mode = opts.mode ?? 'sync';
  const dryRun = opts.dryRun === true || mode === 'verify';
  const p = readPlan();
  if (p.error) return { ok: false, error: p.error, mode, results: [], violations: [], source: SOURCE, sha: null, version: null };
  const results = [];
  for (const t of TARGETS) {
    if (!t.enabled && opts.all !== true) { results.push({ id: t.id, file: t.file, status: 'skipped-disabled', changed: false, format: t.format }); continue; }
    // 每个目标可有自己的唯一源（缺省 = host-adapter）；非默认源的目标独立取 plan。
    const tp = sourceOf(t) === SOURCE ? p : readPlanFor(t);
    if (tp.error) {
      results.push({ id: t.id, file: t.file, status: 'source-missing', error: tp.error, changed: false, format: t.format });
      continue;
    }
    let artifact;
    try {
      artifact = expectedArtifact(tp.source, tp.sha, tp.version, t);
      if (t.format === 'cjs') new vm.Script(artifact.text, { filename: t.file }); // 转译产物必须语法可解析
    } catch (e) {
      results.push({ id: t.id, file: t.file, status: 'translate-failed', error: e?.message ?? String(e), changed: false, format: t.format });
      continue;
    }
    let current = null;
    try { current = fs.existsSync(t.file) ? fs.readFileSync(t.file, 'utf8') : null; } catch { current = null; }
    // 伴随 .d.ts（仅 `dts:true` 目标）：与主产物一起判状态，任一不一致都要重写
    let dtsCurrent = null;
    if (artifact.dtsText !== undefined) {
      try { dtsCurrent = fs.existsSync(artifact.dtsFile) ? fs.readFileSync(artifact.dtsFile, 'utf8') : null; } catch { dtsCurrent = null; }
    }
    const dtsOk = artifact.dtsText === undefined || dtsCurrent === artifact.dtsText;
    if (current === artifact.text && dtsOk) {
      results.push({ id: t.id, file: t.file, status: 'in-sync', changed: false, format: t.format, dts: artifact.dtsFile ?? null, source: tp.label });
      continue;
    }
    const problem = current === null
      ? 'missing'
      : (current === artifact.text ? 'dts-diverged'
        : (stripHeader(current).body === tp.source ? 'header-only-diff' : 'diverged'));
    if (dryRun) { results.push({ id: t.id, file: t.file, status: problem, changed: true, wouldWrite: true, format: t.format, dts: artifact.dtsFile ?? null, source: tp.label }); continue; }
    try {
      fs.mkdirSync(path.dirname(t.file), { recursive: true });
      fs.writeFileSync(t.file, artifact.text, 'utf8');
      if (artifact.dtsText !== undefined) fs.writeFileSync(artifact.dtsFile, artifact.dtsText, 'utf8');
      results.push({ id: t.id, file: t.file, status: current === null ? 'created' : 'updated', changed: true, format: t.format, dts: artifact.dtsFile ?? null, source: tp.label });
    } catch (e) {
      results.push({ id: t.id, file: t.file, status: 'write-failed', error: e?.message ?? String(e), changed: false, format: t.format });
    }
  }
  const BAD = new Set(['missing', 'diverged', 'header-only-diff', 'translate-failed', 'write-failed', 'dts-diverged', 'source-missing']);
  const violations = results.filter((r) => BAD.has(r.status));
  return { ok: violations.length === 0, mode, dryRun, source: SOURCE, sha: p.sha, version: p.version, results, violations };
}

// ------------------------------------------------ 生产 profile 实体核对（Q3 · 2026-09-23）

/**
 * 生产 profile 里"本工具已覆盖"的插件（`TARGETS.pkg` → profile `node_modules` 下的目录名）。
 * ⚠️ **本表是判据的一部分**：新增受管插件时必须同步加一行，否则该插件的生产实体会**悄悄退出校验面** ——
 *    这正是 D15/L-12 被掩盖的机制（`--verify` 只比源码树副本、从来看不到生产实体）。
 */
export const PROD_PROFILE_DIRS = {
  'dsh-archive-sessions': 'dsh-archive-sessions',
  'dsh-ecosystem-panel': 'dsh-ecosystem-panel',
  'dsh-task-board-local': 'dsh-task-board-local',
  'dsh-session-title-live': 'dsh-session-title-live',
  'dsh-butler-panel': 'dsh-butler-panel',
  'dsh-memory-local': 'dsh-memory',
};

/** 生产 profile 根（口径与 `task-control-profile-esm` 目标一致：BUTLER_DSH_HOME > DSH_HOME > ~/.dsh）。 */
export function profileRoot(opts = {}) {
  return opts.home ?? process.env.BUTLER_DSH_HOME ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

/** 文件级 sha256（hex）—— 逐字节比对用（文本归一化会掩盖 BOM/行尾差异，故用字节）。 */
function shaFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * **生产实体核对（只读，零写入）**：每个受管插件在 profile 里的 `lib/<同名文件>`（`dts: true` 的另含
 * `lib/host-adapter.d.ts`）必须与**源码树副本逐字节相同**；源码树副本与唯一源是否同源由
 * `run({mode:'verify'})` 的 8/8 段负责 ⇒ **两段同时绿才等价于「生产 == 唯一源」**。
 * 路径不存在（该插件没装/没这个文件）⇒ 记 `missing`（列表可见、**不算失败**，避免在无该插件的机器上误红）。
 * 路径口径 = `<home>\profiles\web\node_modules\<PROD_PROFILE_DIRS[pkg]>\<prodRel ?? lib/basename(file)>`。
 * `prodRel`（2026-10-14 新增）把某条目标指到别处 —— 治 `dsh-memory-local` 的 src/lib 两条撞同一生产文件的
 * **结构性假红**（一个文件不可能同时等于两份内容 ⇒ 必有一行 stale，哪怕生产完全健康）。
 * `collisions` = **同一条生产文件被两条目标命中**（判据表配置缺陷的信号，**只报不判、不进退出码**）；
 * 行状态另有 `rel-invalid`（`prodRel` 写成绝对路径或含 `..`）—— 那是**表配错了**，计入 `bad`。
 * @returns {{home:string, rows:Array<object>, collisions:Array<object>, checked:number, ok:number, bad:number, missing:number}}
 */
export function verifyProduction(opts = {}) {
  const home = profileRoot(opts);
  const rows = [];
  for (const t of TARGETS) {
    const dirName = PROD_PROFILE_DIRS[t.pkg];
    if (!dirName) continue;
    // 生产里该副本的位置：缺省 `lib/<basename(file)>`；目标可用 `prodRel` 覆盖（见 TARGETS 表头注释）。
    const prodRel = t.prodRel ?? path.join('lib', path.basename(t.file));
    // 判据表写错（绝对路径 / 含 `..`）⇒ 记 rel-invalid 并**计入 bad**（是表配错了，必须可见）。
    const badRel = path.isAbsolute(prodRel) || prodRel.split(path.sep).includes('..') || prodRel.split('/').includes('..');
    const prodFile = path.join(home, 'profiles', 'web', 'node_modules', dirName, prodRel);
    const row = { id: t.id, pkg: t.pkg, prodRel, prodFile, status: badRel ? 'rel-invalid' : 'missing', dtsStatus: undefined, sha: null, expect: fs.existsSync(t.file) ? shaFile(t.file) : null };
    if (!badRel && row.expect && fs.existsSync(prodFile)) {
      row.sha = shaFile(prodFile);
      row.status = row.sha === row.expect ? 'in-sync' : 'stale';
    }
    if (t.dts) {
      const srcDts = dtsPathOf(t.file);
      const prodDts = path.join(path.dirname(prodFile), path.basename(srcDts));
      row.dtsFile = prodDts;
      row.dtsStatus = (fs.existsSync(srcDts) && fs.existsSync(prodDts))
        ? (shaFile(prodDts) === shaFile(srcDts) ? 'in-sync' : 'stale')
        : 'missing';
    }
    rows.push(row);
  }
  // 撞路径守卫（2026-10-14）：同一条生产文件被**两条目标**命中 ⇒ 一个文件不可能同时等于两份内容
  // ⇒ 必有一行假红（典型症状 = 一个包有两条 basename 相同的目标，而其中一条没配 `prodRel`）。
  // **只报不判**：它说明判据表配置有误，不是「实体过期」；计退出码会退回「警报恒红」那条路。
  const seen = new Map();
  for (const r of rows) {
    const k = path.resolve(r.prodFile).toLowerCase();
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(r.id);
  }
  const collisions = [...seen.entries()].filter(([, ids]) => ids.length > 1).map(([file, ids]) => ({ file, ids }));
  return {
    home,
    rows,
    collisions,
    checked: rows.length,
    ok: rows.filter((r) => r.status === 'in-sync' && r.dtsStatus !== 'stale').length,
    bad: rows.filter((r) => r.status === 'stale' || r.status === 'rel-invalid' || r.dtsStatus === 'stale').length,
    missing: rows.filter((r) => r.status === 'missing').length,
  };
}

/**
 * 一行摘要（供 `check-decoupling.mjs` R5 与日报段直接复用，**不复制判定逻辑**）。
 *
 * 【Q3 · 2026-09-23 修复校验盲区】改前本函数**只看源码树副本**（`8/8 一致`）⇒ **生产 profile 实体过期
 * 永远不报警**（这正是卡 L-12 / D15 被掩盖两年的机制：源码树一致 ≠ 插件实体是最新版）。改后摘要**合并
 * 生产实体核对**（`verifyProduction()`，只读），任一生产实体（或其 `.d.ts`）与源码树副本不一致 ⇒ `level:'stale'`
 * 且进 `violations`（id 记 `prod-stale` / `prod-dts-stale`）。`production` 字段供消费方细分展示。
 * @returns {{level:'ok'|'stale'|'error', total:number, inSync:number, violations:Array, sha:string|null, note:string,
 *            production?:{home:string, checked:number, ok:number, bad:number, missing:number, rows:Array}}}
 */
export function verifySummary() {
  const r = run({ mode: 'verify' });
  if (!r.ok && r.error) return { level: 'error', total: 0, inSync: 0, violations: [], sha: null, note: r.error };
  const enabled = r.results.filter((x) => x.status !== 'skipped-disabled');
  const inSync = enabled.filter((x) => x.status === 'in-sync').length;
  let prod = { home: profileRoot(), rows: [], checked: 0, ok: 0, bad: 0, missing: 0 };
  try { prod = verifyProduction(); } catch { /* 生产侧读不到 ⇒ 不改源码侧结论（bad 保持 0，rows 空） */ }
  const prodViolations = prod.rows
    .filter((x) => x.status === 'stale' || x.dtsStatus === 'stale')
    .map((x) => ({ id: x.id, file: x.prodFile, status: x.dtsStatus === 'stale' ? 'prod-dts-stale' : 'prod-stale', error: null }));
  const violations = [
    ...r.violations.map((v) => ({ id: v.id, file: v.file, status: v.status, error: v.error ?? null })),
    ...prodViolations,
  ];
  const compared = prod.checked - prod.missing;
  return {
    level: violations.length ? 'stale' : 'ok',
    total: enabled.length,
    inSync,
    violations,
    sha: r.sha,
    note: `${inSync}/${enabled.length} 副本 sha 一致 · 生产实体 ${prod.ok}/${compared} 一致（缺 ${prod.missing}）`
      + (prod.collisions?.length ? ` · ⚠️ 判据撞路径 ${prod.collisions.length} 处` : ''),
    production: { home: prod.home, checked: prod.checked, ok: prod.ok, bad: prod.bad, missing: prod.missing,
      rows: prod.rows.map((x) => ({ id: x.id, pkg: x.pkg, status: x.status, dtsStatus: x.dtsStatus ?? null, prodFile: x.prodFile })) },
  };
}

// ---------------------------------------------------------------- 自检

/** 自检：头往返 / CJS 转译（语法 + 导出键集合）/ 幂等。全在临时目录，零生产写入。 */
export function selfTest() {
  const fails = [];
  const checks = { n: 0 };
  const ck = (cond, msg) => { checks.n++; if (!cond) fails.push(msg); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-host-adapter-'));
  try {
    const p = readPlan();
    if (p.error) return { pass: false, checks: 1, failures: [p.error] };

    // ① 头往返：sha 一致 且 剥头后 == 唯一源（逐字节）
    const esm = expectedArtifact(p.source, p.sha, p.version, { id: 't-esm', format: 'esm' });
    const st = stripHeader(esm.text);
    ck(st.hasHeader === true, 'ESM 产物应带头');
    ck(st.sha === p.sha, `头里 sha ≠ 源 sha（${st.sha} != ${p.sha}）`);
    ck(st.body === p.source, '剥头后内容与唯一源不一致（往返失败）');
    ck(sha256(st.body) === p.sha, '剥头内容 sha ≠ 源 sha');
    ck(esm.text.startsWith('//'), '产物应以注释头起首（正文不得被粘连进注释）');
    ck(esm.text.split('\n').length === p.source.split('\n').length + 9, '头行数应为 9 行（含尾部空行）');

    // ② CJS 转译：语法可解析 + 导出键集合 == ESM 导出键集合
    const cjs = expectedArtifact(p.source, p.sha, p.version, { id: 't-cjs', format: 'cjs' });
    const file = path.join(tmp, 'host-adapter.cjs');
    fs.writeFileSync(file, cjs.text, 'utf8');
    let parseOk = true;
    let parseErr = '';
    try { new vm.Script(cjs.text, { filename: file }); } catch (e) { parseOk = false; parseErr = e?.message ?? String(e); }
    ck(parseOk, `CJS 语法不可解析：${parseErr}`);
    let cjsKeys = [];
    try { cjsKeys = Object.keys(createRequire(pathToFileURL(path.join(tmp, 'noop.cjs')).href)(file)); } catch (e) {
      fails.push(`CJS 加载失败：${e?.message ?? e}`); checks.n++;
    }
    const esmKeys = [...sourceExportNames(p.source)];
    const missing = esmKeys.filter((k) => !cjsKeys.includes(k));
    const extra = cjsKeys.filter((k) => !esmKeys.includes(k));
    ck(missing.length === 0 && extra.length === 0, `导出键不一致：缺 [${missing.join(',')}] 多 [${extra.join(',')}]`);
    ck(cjsKeys.length >= 15, `CJS 导出数过少（${cjsKeys.length}）——转译可能只抓到一部分`);

    // ③ 幂等：同源二次生成逐字节相等
    const again = expectedArtifact(p.source, p.sha, p.version, { id: 't-esm', format: 'esm' });
    ck(again.text === esm.text, '二次生成文本不等（非幂等）');

    // ④ 伴随 .d.ts：生成 + 路径 + 导出名齐全（TS 目标用）
    const withDts = expectedArtifact(p.source, p.sha, p.version, { id: 't-dts', format: 'esm', dts: true, file: path.join(tmp, 'host-adapter.js') });
    ck(typeof withDts.dtsText === 'string' && withDts.dtsText.includes(HEAD_MARK), 'dts 产物缺失');
    ck(String(withDts.dtsFile).endsWith('host-adapter.d.ts'), `dts 路径不正确：${withDts.dtsFile}`);
    ck(dtsPathOf('x/y/host-adapter.mjs').endsWith('host-adapter.d.mts'), 'dtsPathOf(.mjs) 不为 .d.mts');
    const dtsNames = new Set([...String(withDts.dtsText).matchAll(/export declare (?:const|function) ([A-Za-z0-9_$]+)/g)].map((m) => m[1]));
    const missingDts = [...sourceExportNames(p.source)].filter((k) => !dtsNames.has(k));
    ck(missingDts.length === 0, `dts 缺导出名：${missingDts.join(',')}`);
    ck(String(withDts.dtsText).includes('export declare const SVC: Record<string, string>;'), 'dts 未把 SVC 标为 Record<string,string>');
    ck(withDts.dtsText === renderDts(p.source, p.sha, p.version, 't-dts'), 'dts 二次生成不等（非幂等）');

    // ⑤ 分叉可检出：手改正文 → 剥头 sha ≠ 头里 sha
    const tampered = esm.text.replace('HOST_ADAPTER_VERSION = ', 'HOST_ADAPTER_VERSION   = ');
    const st2 = stripHeader(tampered);
    ck(st2.body !== p.source, '被手改的副本未被检出（分叉检测失效）');
    return { pass: fails.length === 0, checks: checks.n, failures: fails, cjsExports: cjsKeys.length, esmExports: esmKeys.length };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- CLI

function isMainEntry() {
  try {
    const fromMeta = fs.realpathSync(fileURLToPath(import.meta.url));
    const fromArgv = fs.realpathSync(path.resolve(process.argv[1] ?? ''));
    return fromMeta === fromArgv;
  } catch {
    return false;
  }
}

function usage() {
  return [
    `usage: node tools\\sync-host-adapter.mjs [--verify] [--dry-run] [--all] [--json <path>] [--self-test] [--quiet]   (v${VERSION})`,
    '',
    '  宿主适配层唯一源 → 各包派生副本 的幂等同步器（含 ESM/CJS 双产物 + 源 sha 头）。',
    '  --verify 除比对源码树副本外，**另核生产 profile 实体**（只读；实体或其 .d.ts 与源码树副本不一致 ⇒ exit 1）。',
    `  唯一源: ${SOURCE_LABEL}`,
    `  目标: ${TARGETS.map((t) => `${t.id}${t.enabled ? '' : '(disabled)'}`).join(' · ')}`,
    '  退出码: 0=一致/同步完成 · 1=不一致或转译失败 · 2=用法错误',
  ].join('\n');
}

function main() {
  const argv = process.argv;
  const o = { mode: 'sync', dryRun: false, all: false, json: JSON_DEFAULT, selfTest: false, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify') o.mode = 'verify';
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--all') o.all = true;
    else if (a === '--json' && argv[i + 1]) o.json = argv[++i];
    else if (a === '--self-test') o.selfTest = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') { console.log(usage()); return 0; }
    else { process.stderr.write(`未知参数: ${a}\n${usage()}\n`); return 2; }
  }

  if (o.selfTest) {
    const r = selfTest();
    for (const f of r.failures) process.stdout.write(`FAIL ${f}\n`);
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} sync-host-adapter self-test ${r.checks - r.failures.length}/${r.checks}（CJS 导出 ${r.cjsExports ?? '?'} / ESM 导出 ${r.esmExports ?? '?'}）\n`);
    return r.pass ? 0 : 1;
  }

  const r = run({ mode: o.mode, dryRun: o.dryRun, all: o.all });
  if (!r.ok && r.error) { process.stderr.write(r.error + '\n'); return 2; }
  // 生产实体核对：只在 --verify 下做（只读；同步模式下不动生产，故不参与）
  let prod = null;
  if (o.mode === 'verify') {
    try { prod = verifyProduction(); } catch (e) { prod = { home: profileRoot(), rows: [], checked: 0, ok: 0, bad: 0, missing: 0, error: String(e?.message ?? e) }; }
  }
  if (!o.quiet) {
    process.stdout.write(`宿主适配层${o.mode === 'verify' ? '校验' : (o.dryRun ? '同步预览' : '同步')}｜唯一源 ${SOURCE_LABEL}｜sha ${String(r.sha).slice(0, 12)}…｜v${r.version}\n`);
    for (const x of r.results) {
      const icon = x.status === 'in-sync' ? '✅' : (x.status === 'skipped-disabled' ? '⏭' : (x.error ? '🔴' : '📝'));
      process.stdout.write(`  ${icon} ${x.id}：${x.status}${x.error ? `（${x.error}）` : ''} → ${x.file}\n`);
    }
    if (prod) {
      process.stdout.write(`生产 profile 实体核对（${prod.home}）｜逐个与源码树副本逐字节比对\n`);
      for (const x of prod.rows) {
        const icon = x.status === 'in-sync' ? '✅' : (x.status === 'missing' ? '⏭' : '🔴');
        process.stdout.write(`  ${icon} ${x.id}：${x.status}${x.dtsStatus ? ` / dts=${x.dtsStatus}` : ''} → ${x.prodFile}\n`);
      }
      process.stdout.write(`  ⇒ 生产实体 ${prod.ok}/${prod.checked - prod.missing} 一致 · 缺 ${prod.missing} · 不一致 ${prod.bad}${prod.error ? `（读取失败：${prod.error}）` : ''}\n`);
      for (const c of (prod.collisions ?? [])) process.stdout.write(`  ⚠️ 判据撞路径：${c.ids.join(' + ')} 命中同一文件 → ${c.file}（必有一行假红；请给其中一条配 prodRel）\n`);
    }
  }
  try {
    fs.mkdirSync(path.dirname(o.json), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify({ generatedAt: new Date().toISOString(), scriptVersion: VERSION, ...r, ...(prod ? { production: prod } : {}) }, null, 2), 'utf8');
  } catch (e) {
    if (!o.quiet) process.stderr.write(`[warn] JSON 写入失败: ${e?.message ?? e}\n`);
  }
  return (r.ok && !(prod && prod.bad)) ? 0 : 1;
}

if (isMainEntry()) {
  process.exitCode = main();
}
