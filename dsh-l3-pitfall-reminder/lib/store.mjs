// dsh-l3-pitfall-reminder / lib/store.mjs
//
// IO 层：开关热读 + 坑库缓存 + 命中日志。全部 fail-safe（任何异常都降级成「不提醒」，
// 绝不把异常抛回 tools/post-execute waterfall —— 那会把好端端的工具调用变成 isError）。
//
// 落点（DSH home 解析口径 = 显式配置 > $DSH_HOME > ~/.dsh）：
//   <home>/butler-l3-reminder.json   ← 开关（本插件独有，热读，改完**不用重启**）
//   <home>/butler-pitfalls.json      ← 坑库（P4 自动生成，只读）
//   <home>/butler-l3-reminder.log    ← 命中/投递 JSONL（只追加）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, matchPitfall, extractError, renderReminder, createNoticeMessage, hostSlug } from './core.mjs';

export const STORE_VERSION = '0.1.0';

/** 开关文件默认值（**默认关** —— 摘卡不生效是设计，不是缺陷）。 */
export const DEFAULT_SWITCH = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  dryRun: false,
  maxPerSession: 3,
  cooldownMs: 240000,
  storePath: '',
  logPath: '',
  updatedAt: null,
  note: 'P4 L3 实时提醒开关。enabled=false（默认）时插件零动作；改本文件即时生效，无需重启。',
});

export function resolveHome(env = process.env) {
  const explicit = env.DSH_HOME;
  if (typeof explicit === 'string' && explicit.trim()) return path.resolve(explicit.trim());
  return path.join(os.homedir(), '.dsh');
}

export function switchPath(home) {
  return path.join(home, 'butler-l3-reminder.json');
}
export function defaultStorePath(home) {
  return path.join(home, 'butler-pitfalls.json');
}
export function defaultLogPath(home) {
  return path.join(home, 'butler-l3-reminder.log');
}

function readJsonSafe(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (e) {
    return { ok: false, value: null, error: e?.message ?? String(e) };
  }
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 开关读取（带 mtime 缓存：同 mtime 直接复用；改了立刻生效）。
 * @param {string} file
 * @param {{mtimeMs:number|null, value:object}} cache
 */
export function readSwitch(file, cache) {
  const m = statMtime(file);
  if (m === null) return { ...DEFAULT_SWITCH, _exists: false, _file: file };
  if (cache && cache.mtimeMs === m && cache.value) return cache.value;
  const r = readJsonSafe(file);
  const merged = r.ok && r.value && typeof r.value === 'object'
    ? { ...DEFAULT_SWITCH, ...r.value, _exists: true, _file: file, _parseError: null }
    : { ...DEFAULT_SWITCH, _exists: true, _file: file, _parseError: r.error };
  if (cache) {
    cache.mtimeMs = m;
    cache.value = merged;
  }
  return merged;
}

/**
 * 坑库索引读取（带 mtime 缓存 —— 坑库近 400 KB，绝不每轮全量重解析）。
 */
export function readIndex(file, cache) {
  const m = statMtime(file);
  if (m === null) return { ok: false, error: `坑库不存在：${file}`, index: buildIndex(null) };
  if (cache && cache.mtimeMs === m && cache.index) return { ok: true, error: null, index: cache.index };
  const r = readJsonSafe(file);
  if (!r.ok) return { ok: false, error: r.error, index: buildIndex(null) };
  const index = buildIndex(r.value);
  if (cache) {
    cache.mtimeMs = m;
    cache.index = index;
  }
  return { ok: true, error: null, index };
}

/** 追加一行 JSONL（失败静默 —— 日志不是关键路径）。 */
export function appendLog(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), plugin: 'l3-pitfall-reminder', ...record })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 运行时状态机：把「读开关 → 判错误 → 匹配坑库 → 去重限流 → 造消息」串起来。
 * 每条副作用都落在日志里，便于事后取证。
 */
export function createRuntime(config = {}, env = process.env) {
  const home = resolveHome(env);
  const cfg = {
    maxPerSession: Number.isInteger(config.maxPerSession) ? config.maxPerSession : 3,
    cooldownMs: Number.isFinite(config.cooldownMs) ? config.cooldownMs : DEFAULT_SWITCH.cooldownMs,
    hostname: config.hostname || os.hostname(),
    toolFilter: Array.isArray(config.toolFilter) ? config.toolFilter : [],
    // 坑库文档根（提醒里给绝对路径用；2026-10-09 隔离真跑实测：相对路径模型按会话工作区解析 ⇒ 找不到）
    docsRoot: String(config.docsRoot || env.DSH_L3_PITFALL_DOCS || path.join(env.DSH_ROOT || path.join(os.homedir(), 'DSH'), 'docs', '坑库')),
  };
  const switchCache = { mtimeMs: null, value: null };
  const indexCache = { mtimeMs: null, index: null };
  const perAgent = new WeakMap();
  const docExistsCache = new Map();

  /** 该主题的坑库文档在不在（缓存；提醒里据此决定要不要给路径）。 */
  function pitFileExists(category) {
    const file = path.join(cfg.docsRoot, `${category}-${hostSlug(cfg.hostname)}.md`);
    if (docExistsCache.has(file)) return docExistsCache.get(file);
    let ok = false;
    try { ok = fs.existsSync(file); } catch { ok = false; }
    docExistsCache.set(file, ok);
    return ok;
  }

  function snapshot() {
    const sw = readSwitch(switchPath(home), switchCache);
    const storeFile = sw.storePath || defaultStorePath(home);
    return { sw, storeFile, logFile: sw.logPath || defaultLogPath(home), home };
  }

  /** 统计口径：一次工具调用尝试是否应该提醒。返回 null = 不提醒。 */
  function observe(exec, result) {
    const { sw, storeFile, logFile } = snapshot();
    if (sw.enabled !== true) return { action: 'disabled', message: null };

    const err = extractError(result);
    if (!err) return { action: 'not-error', message: null };

    if (cfg.toolFilter.length > 0 && !cfg.toolFilter.includes(exec?.name)) return { action: 'tool-filtered', message: null };

    const store = readIndex(storeFile, indexCache);
    if (!store.ok) {
      appendLog(logFile, { event: 'store-unreadable', tool: exec?.name ?? null, error: store.error, storeFile });
      return { action: 'store-unreadable', message: null };
    }
    const m = matchPitfall(err, store.index);
    if (!m.hit) return { action: 'no-hit', message: null, sig: m.sig };

    // 会话内去重 + 限流
    const agent = exec?.agent ?? null;
    let st = agent ? perAgent.get(agent) : null;
    if (agent && !st) {
      st = { seen: new Set(), count: 0, lastAt: 0 };
      perAgent.set(agent, st);
    }
    if (st) {
      if (st.seen.has(m.hit.id)) {
        appendLog(logFile, { event: 'dup-suppressed', tool: exec?.name ?? null, pitfallId: m.hit.id, how: m.how });
        return { action: 'dup-suppressed', message: null, hit: m.hit };
      }
      if (st.count >= cfg.maxPerSession) {
        appendLog(logFile, { event: 'quota-suppressed', tool: exec?.name ?? null, pitfallId: m.hit.id, count: st.count, max: cfg.maxPerSession });
        return { action: 'quota-suppressed', message: null, hit: m.hit };
      }
      const now = Date.now();
      if (now - st.lastAt < cfg.cooldownMs) {
        appendLog(logFile, { event: 'cooldown-suppressed', tool: exec?.name ?? null, pitfallId: m.hit.id, sinceMs: now - st.lastAt, cooldownMs: cfg.cooldownMs });
        return { action: 'cooldown-suppressed', message: null, hit: m.hit };
      }
      st.lastAt = now;
    }

    const dryRun = sw.dryRun === true;
    const rendered = renderReminder(m.hit, m, {
      tool: exec?.name,
      host: cfg.hostname,
      dryRun,
      pitDir: cfg.docsRoot,
      pitFileExists: pitFileExists(String(m.hit.category ?? '其他')),
    });
    if (dryRun) {
      appendLog(logFile, {
        event: 'dry-run-hit', tool: exec?.name ?? null, pitfallId: m.hit.id, how: m.how,
        category: m.hit.category, count: m.hit.count, text: rendered.text,
      });
      return { action: 'dry-run-hit', message: null, hit: m.hit, text: rendered.text };
    }
    if (st) {
      st.seen.add(m.hit.id);
      st.count += 1;
    }
    const message = createNoticeMessage(rendered);
    appendLog(logFile, {
      event: 'delivered', tool: exec?.name ?? null, pitfallId: m.hit.id, how: m.how,
      category: m.hit.category, count: m.hit.count, sessionIndex: st ? st.count : null, text: rendered.text,
    });
    return { action: 'delivered', message, hit: m.hit, text: rendered.text };
  }

  function noteError(e) {
    const { logFile } = snapshot();
    appendLog(logFile, { event: 'plugin-error', error: e?.stack ?? String(e) });
  }

  return { observe, noteError, snapshot, home, config: cfg };
}
