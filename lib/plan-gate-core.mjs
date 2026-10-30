// plan-gate-core.mjs —— 「方案过审凭证」内核（零依赖 · 纯文件 + sha256）
//
// 它只回答一个问题：这份方案现在能不能当成「过了审，而且审完之后正文没被改过」？
//
// 凭证 = 写在档头的**一行**注释（整行匹配；正文里提到这串字不算锚点）：
//   <!-- PLAN-REVIEW:pass round=2 actor=reviewer-a independent=yes sha=<正文 sha 前 12 位> at=<ISO> runId=<uuid> -->
//
// 「正文」怎么算（哈希必须与锚点自身无关，否则每重写一次锚点就把自己判成过期）：
//   正文 = 原档去掉所有锚点行 → 去掉 BOM → 行尾归一成 LF，其余逐字节进 sha256。
//   行尾归一是有意的：同一份内容存成 CRLF 还是 LF 必须判成"同一份"，否则换个编辑器存一次就全库过期。
//
// 四态（evaluate）：
//   pass    = 有 pass 锚点，且锚点里的 sha 与当前正文一致
//   stale   = 有 pass 锚点，但正文变了 / 锚点里没有 sha
//   missing = 档读不到、没锚点、或（要求独立签署时）签署方不独立
//   fail    = 有 fail 锚点（审核没过 ⇒ 同样不能建卡）
//
// 判定优先级（写死，避免两个理由抢同一个 state）：
//   读不到 → missing ＞ 没锚点 → missing ＞ fail 锚点 → fail ＞ 缺 sha → stale
//   ＞ sha 不符 → stale ＞ 立场不独立 → missing ＞ pass
//   即：**正文变了永远优先报 stale**；stale 比 missing 更紧急，因为"锚点还在、内容已经换了"
//   是最容易被人当成"过了审"的那种假绿。
//
// 两条硬纪律：
//   ① 幂等：永远只留一行锚点；kind/round/actor/independent/正文 sha 全一致时**连写都不写**；
//   ② 并发不覆盖：写前比对正文 sha（可带外部快照 --expect-sha），写后回读比对锚点行与正文 sha。
//      任何一步不符 ⇒ 判 stale、**不写回旧内容**、把原因如实报出来（不静默）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CORE_NAME = 'plan-gate-core';
export const CORE_VERSION = '0.2.0';

/** 四态。字符串就是 CLI 的对外口径，别改名。 */
export const STATE = Object.freeze({
  PASS: 'pass',
  STALE: 'stale',
  MISSING: 'missing',
  FAIL: 'fail',
});

/**
 * 缺省口径（与 config/plan-gate.json 同形，只是扁平化；改口径请改那个 JSON）。
 * 逐条含义：
 *   marker        锚点标记名（`<!-- <marker>:pass … -->`）
 *   placement     锚点落位：`before-first-h2` = 首个 `##` 之前；`top` = 档首
 *   h2Pattern     判定「二级标题」的正则（`##` 后面必须跟空白，`###` 不算）
 *   shaPrefixLength 锚点里存多少位 sha（前缀越短越容易被撞，12 位 = 48 bit，够本地用）
 *   independent   `values` 值域写死；`default` 缺省值；`requireByDefault` 缺省是否要求独立
 *   signer        `mode` = `any`（谁都行）/ `list`（只有 allow 里的人或角色能签）
 *   defaultActor / defaultRound  CLI 缺省
 */
export const DEFAULT_CONFIG = Object.freeze({
  marker: 'PLAN-REVIEW',
  placement: 'before-first-h2',
  h2Pattern: '^##[ \\t]',
  shaPrefixLength: 12,
  independentValues: Object.freeze(['yes', 'no']),
  defaultIndependent: 'no',
  requireIndependentDefault: false,
  signerMode: 'any',
  signerAllow: Object.freeze([]),
  signerDenyEmpty: true,
  defaultActor: 'unspecified',
  defaultRound: 1,
});

const PLACEMENTS = new Set(['before-first-h2', 'top']);
const SIGNER_MODES = new Set(['any', 'list']);

function asArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v == null) return [];
  return [String(v)];
}

/**
 * 把「分节形状的 JSON」拍平成内部口径对象。分节只是为了让人读配置时不用猜，
 * 内部一律用扁平键（少一层 `opts.anchor.marker` 这种噪音）。
 */
export function normalizeConfig(raw = {}) {
  const anchor = raw.anchor ?? {};
  const ind = raw.independent ?? {};
  const sg = raw.signer ?? {};
  const cli = raw.cli ?? {};
  const values = asArray(ind.values ?? DEFAULT_CONFIG.independentValues);
  return withDefaults({
    marker: anchor.marker ?? DEFAULT_CONFIG.marker,
    placement: anchor.placement ?? DEFAULT_CONFIG.placement,
    h2Pattern: anchor.h2Pattern ?? DEFAULT_CONFIG.h2Pattern,
    shaPrefixLength: anchor.shaPrefixLength ?? DEFAULT_CONFIG.shaPrefixLength,
    independentValues: values,
    defaultIndependent: ind.default ?? DEFAULT_CONFIG.defaultIndependent,
    requireIndependentDefault: ind.requireByDefault ?? DEFAULT_CONFIG.requireIndependentDefault,
    signerMode: sg.mode ?? DEFAULT_CONFIG.signerMode,
    signerAllow: asArray(sg.allowed ?? DEFAULT_CONFIG.signerAllow),
    signerDenyEmpty: sg.denyEmpty ?? DEFAULT_CONFIG.signerDenyEmpty,
    defaultActor: sg.defaultActor ?? DEFAULT_CONFIG.defaultActor,
    defaultRound: cli.defaultRound ?? DEFAULT_CONFIG.defaultRound,
  });
}

/** 合并缺省值并校验；口径非法就抛（不猜、不静默降级）。 */
export function withDefaults(partial = {}) {
  const out = { ...DEFAULT_CONFIG, ...partial };
  out.independentValues = asArray(out.independentValues);
  out.signerAllow = asArray(out.signerAllow);
  if (!String(out.marker).trim()) throw new Error('口径错误：marker 不能为空');
  if (!PLACEMENTS.has(out.placement)) {
    throw new Error(`口径错误：placement 只能是 ${[...PLACEMENTS].join(' / ')}（拿到 ${out.placement}）`);
  }
  if (!SIGNER_MODES.has(out.signerMode)) {
    throw new Error(`口径错误：signer.mode 只能是 ${[...SIGNER_MODES].join(' / ')}（拿到 ${out.signerMode}）`);
  }
  const n = Number(out.shaPrefixLength);
  if (!Number.isInteger(n) || n < 6 || n > 64) {
    throw new Error(`口径错误：shaPrefixLength 必须是 6~64 的整数（拿到 ${out.shaPrefixLength}）`);
  }
  out.shaPrefixLength = n;
  if (!out.independentValues.includes('yes') || !out.independentValues.includes('no')) {
    throw new Error(`口径错误：independent.values 必须同时含 yes 与 no（拿到 ${out.independentValues.join(',')}）`);
  }
  if (!out.independentValues.includes(out.defaultIndependent)) {
    throw new Error(`口径错误：independent.default=${out.defaultIndependent} 不在值域内`);
  }
  if (out.signerMode === 'list' && !out.signerAllow.length) {
    throw new Error('口径错误：signer.mode=list 但 signer.allowed 为空 ⇒ 谁都签不了');
  }
  out.h2Pattern = String(out.h2Pattern);
  new RegExp(out.h2Pattern); // 正则写坏就当场炸，别拖到扫描一半
  return out;
}

/** 读一份口径配置（JSON）。文件不存在就抛 —— 调用方决定是否回落缺省。 */
export function loadGateConfig(file) {
  const abs = path.resolve(String(file));
  const text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  return normalizeConfig(JSON.parse(text));
}

// ---------------------------------------------------------------------------
//  正文归一与哈希
// ---------------------------------------------------------------------------

function anchorRegex(marker) {
  const esc = String(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 整行匹配：行首可有缩进，行尾可有空白；中间不许有别的文字。
  return new RegExp(`^[\\t ]*<!--\\s*${esc}\\s*:\\s*(pass|fail)\\b([^>]*)-->[\\t ]*$`);
}

function regexOf(opts) {
  return anchorRegex(opts.marker);
}

/** 按行拆（CRLF / CR / LF 都算换行，归一交给调用方）。 */
function splitEol(text) {
  return String(text ?? '').split(/\r\n|\r|\n/);
}

/**
 * 正文归一：去锚点行 → 去 BOM → 行尾归一 LF。**所有 sha 都必须走它。**
 * @param {string} text
 * @param {object} [options] 只用到 marker
 * @returns {string}
 */
export function normalizeBody(text, options = {}) {
  const re = regexOf(withDefaults(options));
  const rows = splitEol(text).filter((line) => !re.test(line));
  return rows.join('\n').replace(/^\uFEFF/, '');
}

/** 正文 sha256（64 位十六进制）；锚点里只存前 shaPrefixLength 位。 */
export function bodySha(text, options = {}) {
  const opts = withDefaults(options);
  return crypto.createHash('sha256').update(normalizeBody(text, opts), 'utf8').digest('hex');
}

/** 取正文 sha 的前缀（锚点里那个短值）。 */
export function bodyShaShort(text, options = {}) {
  const opts = withDefaults(options);
  return bodySha(text, opts).slice(0, opts.shaPrefixLength);
}

// ---------------------------------------------------------------------------
//  锚点解析
// ---------------------------------------------------------------------------

/** 把 `a=b c=d` 拆成属性表；畸形 token 直接丢（不猜、不抛）。 */
function splitAttrs(raw) {
  const attrs = {};
  for (const tok of String(raw ?? '').trim().split(/\s+/)) {
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) continue;
    attrs[key] = tok.slice(eq + 1);
  }
  return attrs;
}

/** 列出档内全部锚点（按出现顺序）。 */
export function listAnchors(text, options = {}) {
  const re = regexOf(withDefaults(options));
  const rows = splitEol(text);
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const hit = re.exec(rows[i]);
    if (!hit) continue;
    out.push({
      kind: hit[1],
      attrs: splitAttrs(hit[2]),
      line: i + 1,
      raw: rows[i].trim(),
      body: String(hit[2] ?? '').trim(),
    });
  }
  return out;
}

/** 档内第一个锚点；没有返回 null。 */
export function parseAnchor(text, options = {}) {
  return listAnchors(text, options)[0] ?? null;
}

/** 净化一个 token：空白 / `>` / `=` / 连续 `-` 都会破坏锚点解析，连字符替换掉。 */
export function sanitizeToken(value, fallback = '') {
  const s = String(value ?? '')
    .trim()
    .replace(/[\s>]+/g, '-')
    .replace(/=+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function normalizeRound(round, opts) {
  const n = Number(round ?? opts.defaultRound);
  return Number.isInteger(n) && n > 0 ? n : opts.defaultRound;
}

function assertKind(kind) {
  if (kind !== 'pass' && kind !== 'fail') throw new Error(`kind 只能是 pass / fail（拿到 ${kind}）`);
}

/**
 * 生成一行锚点。
 * @param {{kind:'pass'|'fail', round?:number, sha:string, at?:string, runId?:string,
 *          actor?:string, independent?:string}} fields
 * @returns {string}
 */
export function makeAnchorLine(fields = {}, options = {}) {
  const opts = withDefaults(options);
  const { kind } = fields;
  assertKind(kind);
  const sha = String(fields.sha ?? '').trim();
  if (!/^[0-9a-fA-F]{6,64}$/.test(sha)) {
    throw new Error(`sha 必须是十六进制前缀（6~64 位，拿到 ${JSON.stringify(fields.sha)}）`);
  }
  const independent = String(fields.independent ?? opts.defaultIndependent);
  if (!opts.independentValues.includes(independent)) {
    throw new Error(`independent 只能取 ${opts.independentValues.join(' / ')}（拿到 ${independent}）`);
  }
  const actor = sanitizeToken(fields.actor, '') || opts.defaultActor;
  const at = String(fields.at ?? new Date().toISOString());
  const runId = String(fields.runId ?? crypto.randomUUID());
  const round = normalizeRound(fields.round, opts);
  return `<!-- ${opts.marker}:${kind} round=${round} actor=${actor} independent=${independent}`
    + ` sha=${sha.slice(0, opts.shaPrefixLength)} at=${at} runId=${runId} -->`;
}

/**
 * 把锚点放回档头：先摘掉**所有**旧锚点，再插一行 —— 所以永远只有一行。
 * 落位 = 首个 `##` 之前（`placement: top` 则档首）；档里没有 `##` 就档首。
 *
 * ⚠️ 这一行不许额外配空行：`normalizeBody()` 摘掉锚点行后要能逐字节还原原文，
 *   否则"写完自己判 stale"（每重写一次还会再叠一个空行）。
 *
 * @returns {string} LF 行尾的新全文（BOM 保留）；调用方用 restoreEol 转回原行尾
 */
export function placeAnchor(text, anchorLine, options = {}) {
  const opts = withDefaults(options);
  const raw = String(text ?? '');
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = normalizeBody(raw, opts);
  const rows = body.split('\n');
  const h2 = rows.findIndex((line) => new RegExp(opts.h2Pattern).test(line));
  const at = opts.placement === 'top' ? 0 : (h2 >= 0 ? h2 : 0);
  rows.splice(at, 0, anchorLine);
  return `${bom}${rows.join('\n')}`;
}

/** 原文是 CRLF 就还回去（行尾是原档的属性，不该被本工具改掉）。 */
export function restoreEol(original, planned) {
  return /\r\n/.test(String(original ?? '')) ? String(planned).replace(/\r?\n/g, '\r\n') : String(planned);
}

// ---------------------------------------------------------------------------
//  评估（四态）
// ---------------------------------------------------------------------------

function reason(code, text, extra = {}) {
  return { code, text, ...extra };
}

function independentOf(anchor) {
  return String(anchor?.attrs?.independent ?? '').toLowerCase();
}

/**
 * 评估一段文本。`evaluate()` 读文件后走这里 —— 拆开是为了让夹具与 dry-run
 * 能评估"还没落盘的候选文本"，不必先写再读。
 */
export function evaluateText(text, context = {}) {
  const opts = withDefaults(context);
  const requireIndependent = context.requireIndependent ?? opts.requireIndependentDefault;
  const source = String(text ?? '');
  const currentSha = bodySha(source, opts);
  const anchors = listAnchors(source, opts);
  const anchor = anchors[0] ?? null;
  const base = {
    option: { requireIndependent, marker: opts.marker, shaPrefixLength: opts.shaPrefixLength },
    currentSha,
    currentShaShort: currentSha.slice(0, opts.shaPrefixLength),
    anchor,
    anchors,
    bytes: Buffer.byteLength(source, 'utf8'),
    requireIndependent,
    reasons: [],
  };

  if (!anchor) {
    return {
      ...base,
      ok: false,
      state: STATE.MISSING,
      reasons: [reason('no-anchor', `没有 \`<!-- ${opts.marker}:… -->\` 锚点（这份方案没留过审凭证）`)],
    };
  }

  if (anchor.kind === 'fail') {
    const r = [`锚点是 fail（审核没过 · round=${anchor.attrs.round ?? '?'} · actor=${anchor.attrs.actor ?? '?'}）`];
    if (anchors.length > 1) r.push(`档里有 ${anchors.length} 行锚点（只认第一行）`);
    return { ...base, ok: false, state: STATE.FAIL, reasons: [reason('fail-anchor', r[0]), ...r.slice(1).map((t) => reason('multi-anchor', t))] };
  }

  if (!anchor.attrs.sha) {
    return {
      ...base,
      ok: false,
      state: STATE.STALE,
      reasons: [reason('no-sha', 'pass 锚点里没有 sha 字段 ⇒ 判不了正文是不是同一份（按过期处理）')],
    };
  }

  if (anchor.attrs.sha.toLowerCase() !== base.currentShaShort.toLowerCase()) {
    return {
      ...base,
      ok: false,
      state: STATE.STALE,
      reasons: [reason(
        'body-changed',
        `正文已变：锚点 sha=${anchor.attrs.sha}（过审时）≠ 现值 ${base.currentShaShort} ⇒ 必须重新过审`,
      )],
    };
  }

  const ind = independentOf(anchor);
  if (requireIndependent && ind !== 'yes') {
    return {
      ...base,
      ok: false,
      state: STATE.MISSING,
      reasons: [reason(
        'not-independent',
        `有 pass 锚点，但 independent=${anchor.attrs.independent ?? '(缺字段)'} —— `
        + '这一次要求「签署方独立于作者」，所以这份凭证**不成立**（不是 pass）',
      )],
    };
  }

  const notes = [`pass · round=${anchor.attrs.round ?? '?'} · actor=${anchor.attrs.actor ?? '?'}`
    + ` · independent=${anchor.attrs.independent ?? '(缺字段)'} · runId=${anchor.attrs.runId ?? '?'}`];
  if (!requireIndependent && ind !== 'yes') {
    notes.push('注意：本次未要求独立签署 ⇒ 只证明"有人签过"，不证明"签署方独立于作者"');
  }
  if (anchors.length > 1) notes.push(`档里有 ${anchors.length} 行锚点（只认第一行；重写一次就会收成一行）`);
  return { ...base, ok: true, state: STATE.PASS, reasons: [reason('pass', notes[0]), ...notes.slice(1).map((t) => reason('note', t))] };
}

/** 读文件并评估（只读）。 */
export function evaluate(file, options = {}) {
  const opts = withDefaults(options);
  const abs = path.resolve(String(file ?? ''));
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return {
      ok: false,
      state: STATE.MISSING,
      file: abs,
      option: { requireIndependent: options.requireIndependent ?? opts.requireIndependentDefault },
      currentSha: '',
      currentShaShort: '',
      anchor: null,
      anchors: [],
      bytes: null,
      requireIndependent: options.requireIndependent ?? opts.requireIndependentDefault,
      reasons: [reason('unreadable', `档读不到：${e.code || e.message}`)],
    };
  }
  return { ...evaluateText(text, { ...options, ...opts }), file: abs };
}

// ---------------------------------------------------------------------------
//  写入（幂等 · 并发三态）
// ---------------------------------------------------------------------------

/** 写失败归类（不猜根因，只把 errno 翻成一句人话）。 */
export function classifyWriteError(err) {
  const code = String(err?.code ?? '');
  if (code === 'EACCES' || code === 'EPERM') return 'readonly-or-permission';
  if (code === 'EROFS') return 'readonly-fs';
  if (code === 'ENOENT') return 'path-missing';
  if (code === 'EISDIR' || code === 'ENOTDIR') return 'not-a-file';
  if (code === 'EBUSY') return 'busy';
  return 'write-failed';
}

/** 签署方是否被允许（`signer.mode=list` 时按白名单比，大小写不敏感）。 */
export function signerAllowed(actor, options = {}) {
  const opts = withDefaults(options);
  const who = sanitizeToken(actor, '');
  if (!who) {
    return opts.signerDenyEmpty
      ? { allowed: false, actor: '', reason: 'actor 为空（口径要求签署方必须留名）' }
      : { allowed: true, actor: opts.defaultActor, reason: '' };
  }
  if (opts.signerMode === 'any') return { allowed: true, actor: who, reason: '' };
  const pool = opts.signerAllow.map((x) => x.toLowerCase());
  if (pool.includes(who.toLowerCase())) return { allowed: true, actor: who, reason: '' };
  return {
    allowed: false,
    actor: who,
    reason: `actor=${who} 不在签署白名单里（${opts.signerAllow.join(' / ')}）`,
  };
}

/** 读完一份档 + 算出"要写的那一行"（**不落盘**）。dry-run 与 commit 共用这一份计划。 */
export function planWrite(file, fields = {}) {
  const opts = withDefaults(fields);
  const kind = fields.kind;
  assertKind(kind);
  const abs = path.resolve(String(file ?? ''));
  let before;
  try {
    before = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return {
      ok: false,
      file: abs,
      outcome: 'missing',
      state: STATE.MISSING,
      code: 'unreadable',
      reason: `档读不到：${e.code || e.message}（不建锚点，不猜）`,
      before: null,
    };
  }

  const beforeSha = bodySha(before, opts);
  const short = beforeSha.slice(0, opts.shaPrefixLength);
  const round = normalizeRound(fields.round, opts);
  const base = {
    file: abs, before, beforeSha, beforeShort: short, round,
  };

  // 外部快照 CAS：调用方拿"它看到的那一版"来钉住写入（两个会话同写的保护）
  const expect = fields.expectSha ? String(fields.expectSha).trim().toLowerCase() : '';
  if (expect && !beforeSha.toLowerCase().startsWith(expect)) {
    return {
      ...base,
      ok: false,
      outcome: 'stale',
      state: STATE.STALE,
      code: 'expect-sha-mismatch',
      reason: `--expect-sha=${expect} 与当前正文 ${short} 不符 ⇒ 这份档在你看过之后已经被改过（未写入）`,
      written: false,
    };
  }

  const signer = signerAllowed(fields.actor ?? opts.defaultActor, opts);
  if (!signer.allowed) {
    return {
      ...base,
      ok: false,
      outcome: 'denied',
      state: STATE.MISSING,
      code: 'signer-denied',
      reason: signer.reason,
    };
  }
  const independent = String(fields.independent ?? opts.defaultIndependent);
  if (!opts.independentValues.includes(independent)) {
    return {
      ...base,
      ok: false,
      outcome: 'denied',
      state: STATE.MISSING,
      code: 'bad-independent',
      reason: `independent 只能取 ${opts.independentValues.join(' / ')}（拿到 ${independent}）`,
    };
  }

  const current = parseAnchor(before, opts);
  const same = Boolean(
    current
    && current.kind === kind
    && String(current.attrs.sha ?? '').toLowerCase() === short.toLowerCase()
    && String(current.attrs.round ?? '') === String(round)
    && String(current.attrs.actor ?? '') === signer.actor
    && String(current.attrs.independent ?? '') === independent,
  );
  if (same) {
    return {
      ...base,
      ok: true,
      outcome: 'skipped',
      state: kind === STATE.PASS ? STATE.PASS : STATE.FAIL,
      code: 'idempotent',
      reason: '正文没变，kind / round / actor / independent 全都一样 ⇒ 不重复写（幂等）',
      line: current.raw,
      position: { line: current.line, anchorCount: listAnchors(before, opts).length },
      independent,
      actor: signer.actor,
    };
  }

  const plannedLine = makeAnchorLine({
    kind,
    round,
    sha: short,
    at: fields.at,
    runId: fields.runId,
    actor: signer.actor,
    independent,
  }, opts);
  const plannedText = restoreEol(before, placeAnchor(before, plannedLine, opts));
  const after = listAnchors(plannedText, opts);
  return {
    ...base,
    ok: true,
    outcome: 'write',
    state: kind === STATE.PASS ? STATE.PASS : STATE.FAIL,
    code: '',
    reason: '',
    line: plannedLine,
    plannedText,
    position: { line: after[0]?.line ?? 0, anchorCount: after.length },
    replaced: current ? { kind: current.kind, line: current.line, raw: current.raw } : null,
    actor: signer.actor,
    independent,
  };
}

/**
 * 写锚点（CLI 的 `--apply` 才调）。三道门：
 *   ① 外部快照 CAS（在 planWrite 里做）：给了 `expectSha` 且与当前正文前缀不符 ⇒ stale，**一个字节都不写**；
 *   ② 写前 CAS：计划算完后再读一次，正文变了 ⇒ stale，**不写**；
 *   ③ 写后回读：锚点行不在 / 正文 sha 变了 ⇒ stale，**不把旧内容写回去**（回滚会盖掉别人的改动）。
 *
 * @param {string} file
 * @param {{kind:'pass'|'fail', round?:number, actor?:string, independent?:string,
 *          expectSha?:string, at?:string, runId?:string,
 *          hooks?:{afterWrite?:Function}}} fields
 */
export function writeAnchor(file, fields = {}) {
  const opts = withDefaults(fields);
  const plan = planWrite(file, fields);
  if (!plan.ok) return plan;
  const base = {
    file: plan.file,
    beforeSha: plan.beforeSha,
    beforeShort: plan.beforeShort,
    line: plan.line,
    position: plan.position,
    actor: plan.actor,
    independent: plan.independent,
    round: plan.round,
  };
  if (plan.outcome === 'skipped') {
    return { ...base, ok: true, outcome: 'skipped', state: plan.state, code: 'idempotent', reason: plan.reason, written: false };
  }

  // ② 写前 CAS：计划算完之后、真正落盘之前，再读一次
  let second;
  try {
    second = fs.readFileSync(plan.file, 'utf8');
  } catch (e) {
    return {
      ...base,
      ok: false,
      outcome: 'stale',
      state: STATE.STALE,
      code: 'readback-failed',
      reason: `写前重读失败：${e.code || e.message}（未写入）`,
      written: false,
    };
  }
  if (bodySha(second, opts) !== plan.beforeSha) {
    return {
      ...base,
      ok: false,
      outcome: 'stale',
      state: STATE.STALE,
      code: 'body-moved-before-write',
      reason: '正文在"读完到写盘"之间被改过 ⇒ 判 stale，**不覆盖**（请重跑 --check 后再决定）',
      written: false,
    };
  }

  // ③ 落盘
  try {
    fs.writeFileSync(plan.file, plan.plannedText, 'utf8');
  } catch (e) {
    return {
      ...base,
      ok: false,
      outcome: 'stale',
      state: STATE.STALE,
      code: classifyWriteError(e),
      reason: `写入失败：${e.code || e.message} —— 原档未被改动（不静默）`,
      error: e.message,
      written: false,
    };
  }

  // 夹具注入点：模拟"另一个会话在写完之后又改了正文"。生产调用不传 hooks。
  if (typeof fields.hooks?.afterWrite === 'function') fields.hooks.afterWrite({ file: plan.file, line: plan.line });

  // ④ 写后回读
  let back;
  try {
    back = fs.readFileSync(plan.file, 'utf8');
  } catch (e) {
    return {
      ...base,
      ok: false,
      outcome: 'stale',
      state: STATE.STALE,
      code: 'readback-failed',
      reason: `写后回读失败：${e.code || e.message}`,
      written: true,
    };
  }
  const backAnchor = parseAnchor(back, opts);
  if (!backAnchor || backAnchor.raw !== plan.line) {
    return {
      ...base,
      ok: false,
      outcome: 'stale',
      state: STATE.STALE,
      code: 'anchor-clobbered',
      reason: '回读发现锚点行不是刚写的那一行 ⇒ 被另一个写入者覆盖了（未把旧内容写回）',
      written: true,
    };
  }
  const backSha = bodySha(back, opts);
  if (backSha !== plan.beforeSha) {
    return {
      ...base,
      ok: false,
      outcome: 'stale',
      state: STATE.STALE,
      code: 'body-moved-after-write',
      reason: `回读发现正文 sha=${backSha.slice(0, opts.shaPrefixLength)} ≠ 写前 ${plan.beforeShort}`
        + ' ⇒ 有别的写入者改了正文；锚点保留原 sha（未覆盖、未回滚）',
      written: true,
    };
  }

  // ⑤ 写完自己判一遍：pass 锚点必须让 evaluate 判 pass（这是"写完自己判 stale"那个坑的兜底）
  const self = evaluateText(back, opts);
  const expected = fields.kind === 'pass' ? STATE.PASS : STATE.FAIL;
  if (self.state !== expected) {
    return {
      ...base,
      ok: false,
      outcome: 'stale',
      state: self.state,
      code: 'self-check-failed',
      reason: `写完自检判 ${self.state}（期望 ${expected}）：${self.reasons[0]?.text ?? ''}`,
      written: true,
    };
  }
  return {
    ...base,
    ok: true,
    outcome: 'written',
    state: self.state,
    code: '',
    reason: '',
    written: true,
    selfCheck: self.state,
    bytesBefore: Buffer.byteLength(plan.before ?? '', 'utf8'),
    bytesAfter: Buffer.byteLength(back, 'utf8'),
  };
}
