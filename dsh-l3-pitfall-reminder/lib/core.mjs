// dsh-l3-pitfall-reminder / lib/core.mjs
//
// L3「实时提醒」纯逻辑层：无 IO、无 cordis、无外部依赖 ⇒ 可被单测直接驱动。
//   ① extractError(result)  —— 从 tools/post-execute 的 result 提取 {name, code, text}
//   ② buildIndex(pitfalls)  —— 坑库 → 三级索引（sigKey / id / normText 前缀桶）
//   ③ matchPitfall(err, ix) —— 命中判定
//   ④ renderReminder(...)   —— 模型可见提醒文本
//   ⑤ createNoticeMessage() —— 复刻 @deepseek-ai/dsh-llm 的 createUserMessage 最小形态
import { randomUUID } from 'node:crypto';
import { signatureOf } from './normalize.mjs';

export const L3_CORE_VERSION = '0.1.0';

/** 与 @deepseek-ai/dsh-llm `CONTEXT_SUMMARY_MAX_CHARS` 一致（notice summary 上限）。 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120;
/** 单个提醒正文上限（模型可见文本，进 KV 前缀，别啰嗦）。 */
export const REMINDER_TEXT_MAX = 480;
/** 前缀回退匹配用的最小公共前缀长度（太短会误命中）。 */
export const PREFIX_MATCH_MIN = 48;
/** 前缀桶冲突时的二级判据长度（仍不唯一 ⇒ 放弃提醒）。 */
export const PREFIX_MATCH_LONG = 120;

const PLUGIN_ID = 'l3-pitfall-reminder';

function boundText(s, max) {
  const t = String(s ?? '');
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * 递归收集结果 content 里的文本块（复刻 pitfall-scan.mjs:127-138 的 `collectText`：
 * 文本块用 `'\n'` 连接，并钻进嵌套的 `content` 数组）。
 * @param {any[]} blocks
 * @returns {string}
 */
export function collectText(blocks) {
  const out = [];
  const walk = (arr) => {
    for (const b of arr ?? []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
      if (Array.isArray(b.content)) walk(b.content);
    }
  };
  walk(blocks);
  return out.join('\n');
}

/**
 * 从 `tools/post-execute` 的 result 提取错误三要素（口径与扫描侧逐字段对齐）。
 *
 * 两侧真源：
 *   · 扫描侧 `pitfall-scan.mjs:170-196`：
 *       text = collectText(日志 event.data.message.content) || event.data.error.message
 *       name = event.data.error.name ?? ''  · code = event.data.error.code ?? ''
 *   · 日志投影 `dsh-agent-loop/lib/index.js:697-712`：`error: result.error.info`
 *     ⇒ 日志里的 `data.error` **就是**运行时 `result.error.info`
 *     ⇒ 运行时取 `result.error.info.name / .code`，与扫描侧同源。
 *   · text 侧运行时直接给 `result.content`（就是被投影进日志的那份 content）✅
 *
 * @param {{isError?:boolean, content?:any[], error?:{message?:string, info?:{name?:string,code?:string}}}} result
 * @returns {{name:string, code:string, text:string}|null} 非错误结果返回 null
 */
export function extractError(result) {
  if (!result || result.isError !== true) return null;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = collectText(blocks) || String(result.error?.message ?? '');
  const info = result.error?.info;
  return {
    name: String(info?.name ?? ''),
    code: String(info?.code ?? ''),
    text,
  };
}

/**
 * 坑库 → 索引。三级：精确 sigKey、精确 id、归一化文本前缀桶（容忍轻微口径漂移）。
 * @param {{pitfalls?:any[]}} store
 */
export function buildIndex(store) {
  const list = Array.isArray(store?.pitfalls) ? store.pitfalls : [];
  const bySigKey = new Map();
  const byId = new Map();
  const byPrefix = new Map();
  let skipped = 0;
  for (const p of list) {
    if (!p || typeof p.sigKey !== 'string' || typeof p.normText !== 'string') {
      skipped++;
      continue;
    }
    bySigKey.set(p.sigKey, p);
    if (typeof p.id === 'string') byId.set(p.id, p);
    const pre = p.normText.slice(0, PREFIX_MATCH_MIN);
    if (pre.length >= PREFIX_MATCH_MIN) {
      const arr = byPrefix.get(pre);
      if (arr) arr.push(p);
      else byPrefix.set(pre, [p]);
    }
  }
  return { bySigKey, byId, byPrefix, size: bySigKey.size, skipped, updatedAt: store?.updatedAt ?? null };
}

/**
 * 命中判定。多候选 + 三级回退（顺序 = 从最精确到最宽容）：
 *   ① {name, code} 精确 sigKey      —— 两侧 info 齐全时的正常路径
 *   ② {name:'', code:''} 精确 sigKey —— 上游未带 info 时（扫描侧当年就是这样落库的条目：Error|NO_CODE|…）
 *   ③ 实际候选的 id / 空候选的 id
 *   ④ 归一化文本前 48 字符桶（容忍尾部漂移），取 count 最大的一条
 * @param {{name:string,code:string,text:string}} err
 * @param {ReturnType<typeof buildIndex>} index
 * @returns {{sig:ReturnType<typeof signatureOf>, hit:any|null, how:string|null}}
 */
export function matchPitfall(err, index) {
  const sig = signatureOf(err);
  const candidates = [sig];
  if (sig.name !== 'Error' || sig.code !== 'NO_CODE') {
    candidates.push(signatureOf({ ...err, name: '', code: '' }));
  }
  for (const [i, c] of candidates.entries()) {
    const byKey = index.bySigKey.get(c.sigKey);
    if (byKey) return { sig, hit: byKey, how: i === 0 ? 'sigKey' : 'sigKey-nofinfo' };
    const byId = index.byId.get(c.id);
    if (byId) return { sig, hit: byId, how: i === 0 ? 'id' : 'id-nofinfo' };
  }
  const bucket = index.byPrefix.get(sig.normText.slice(0, PREFIX_MATCH_MIN)) ?? null;
  if (bucket && bucket.length === 1) {
    return { sig, hit: bucket[0], how: 'prefix' };
  }
  if (bucket && bucket.length > 1) {
    // 桶内冲突 ⇒ 用更长前缀消歧；仍不唯一就**不提醒**（宁可漏报，绝不提醒错的坑）
    const long = sig.normText.slice(0, PREFIX_MATCH_LONG);
    const refined = bucket.filter((p) => p.normText.slice(0, PREFIX_MATCH_LONG) === long);
    if (refined.length === 1) return { sig, hit: refined[0], how: 'prefix-long' };
    return { sig, hit: null, how: null, ambiguous: refined.length };
  }
  return { sig, hit: null, how: null };
}

/** 主机名 → 坑库文件后缀（docs\坑库\<主题>-<host>.md）。 */
export function hostSlug(hostname = '') {
  const slug = String(hostname || 'unknown-host').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'unknown-host';
}

function fmtDay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '?';
  return new Date(n).toISOString().slice(0, 10);
}

/**
 * 渲染模型可见的提醒正文 + notice summary。
 *
 * ⚠️ 路径必须给**绝对路径**：2026-10-09 隔离真跑实测 —— 给相对路径 `docs\坑库\x.md` 时，
 * 模型按**会话工作区**解析（headless/卡会话的工作区不是 <DSH_ROOT>）⇒ 找不到文件、白烧几轮。
 * `opts.pitFileExists === false` 时干脆不提路径（只给主题），免得把模型引到不存在的文件上。
 * @param {object} hit 坑库条目
 * @param {{how:string, sig:object}} m 匹配结果
 * @param {{tool?:string, host?:string, dryRun?:boolean, pitDir?:string, pitFileExists?:boolean}} opts
 */
export function renderReminder(hit, m, opts = {}) {
  const cat = String(hit.category ?? '其他');
  const count = Number(hit.count ?? 0);
  const sessions = Array.isArray(hit.sessions) ? hit.sessions.length : 0;
  const tools = hit.tools && typeof hit.tools === 'object' ? Object.keys(hit.tools) : [];
  const toolLine = tools.length > 0 ? `${tools.slice(0, 4).join('/')}${tools.length > 4 ? '…' : ''}` : String(opts.tool ?? '?');
  const head = opts.dryRun ? '【坑库实时提醒 · L3 · DRY-RUN】' : '【坑库实时提醒 · L3】';
  const fileName = `${cat}-${hostSlug(opts.host)}.md`;
  const pitDir = opts.pitDir ? String(opts.pitDir).replace(/[\\/]+$/, '') : null;
  const pointer = pitDir ? `${pitDir}\\${fileName}` : `docs\\坑库\\${fileName}`;
  const advice = opts.pitFileExists === false
    ? `别照原样重来 —— 这是已归档坑（主题：${cat}，累计 ${count} 次），换做法或用例后再试。`
    : `别照原样重来 —— 先看 ${pointer} 里这一条，换做法或用例后再试。`;
  const text = [
    `${head}刚失败的这次调用命中已归档坑 #${hit.id}（主题：${cat}）。`,
    `- 错误签名：${boundText(hit.normText, 200)}`,
    `- 历史：${count} 次 / ${sessions} 个会话，最近 ${fmtDay(hit.lastSeen)}，相关工具 ${toolLine}`,
    `- 建议：${advice}`,
  ].join('\n');
  return {
    text: boundText(text, REMINDER_TEXT_MAX),
    summary: boundText(`坑库命中 #${hit.id}（${cat} ×${count}）`, CONTEXT_SUMMARY_MAX_CHARS),
  };
}

/**
 * 复刻 `@deepseek-ai/dsh-llm` 的 createUserMessage 最小形态：
 *   createMessage(input) = deepFreeze(structuredClone({...input, id: randomUUID()}))
 * （见主包 dsh-llm/lib/index.js:37-53）。role=user + source.kind='plugin' 是**载荷字段**：
 * 未标注来源的 context 会在派生历史里被渲染成用户提示词（repeat-tool-reminder 同款注释）。
 * @param {{text:string, summary?:string}} ctx
 */
export function createNoticeMessage(ctx) {
  const msg = {
    role: 'user',
    content: [{ type: 'text', text: String(ctx.text) }],
    source: {
      kind: PLUGIN_ID,
      form: 'notice',
      summary: boundText(ctx.summary ?? ctx.text, CONTEXT_SUMMARY_MAX_CHARS),
    },
    id: randomUUID(),
  };
  const frozen = deepFreeze(JSON.parse(JSON.stringify(msg)));
  return frozen;
}

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze(v[k]);
    Object.freeze(v);
  }
  return v;
}

/** 把本插件的 context 放到下游 contexts 之前（与 repeat-tool-reminder 的 prependContext 同序）。 */
export function prependContext(ours, theirs) {
  return [ours, ...(theirs ?? [])];
}
