// dsh-l3-pitfall-reminder / lib/normalize.mjs
//
// 坑签名归一化 —— **口径移植件**，来源 = <DSH_ROOT>\tools\dsh-butler\lib\pitfall-sign.mjs
// （PITFALL_SIGN_VERSION 0.1.0，NORM_TEXT_MAX=220，规则顺序敏感：先路径 → 再时间/ID → 最后行号）。
//
// 为什么不直接 import 那个文件：本插件要被 dsh 以「零外部依赖」方式加载（实体在 <DSH_ROOT>\tools\ 下，
// 不在 profile 的 node_modules 解析链内），跨目录 import 会把插件绑死在 dsh-butler 的目录布局上。
// 代价是口径可能漂移 ⇒ 由 `_test/test-core.mjs` 的「生产坑库逐条对照」把漂移咬死：
// 拿生产 butler-pitfalls.json 里每个条目的 samples[].text（未归一化原文）重算签名，
// 必须与该条目的 normText / sigKey / id 逐字节一致。
//
// ⚠️ 改动同步铁律：pitfall-sign.mjs 的 NORMALIZERS 一改，本文件必须同步改，并重跑对照测试。
import crypto from 'node:crypto';

export const NORMALIZE_VERSION = '0.1.0';
/** 归一化后保留的文本长度（与 pitfall-sign.mjs NORM_TEXT_MAX 一致）。 */
export const NORM_TEXT_MAX = 220;

const NORMALIZERS = [
  // Windows 绝对路径（含空格外的常见字符；盘符开头）
  [/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, '<PATH>'],
  // UNC / 双反斜杠路径
  [/\\\\[^\s"']+/g, '<PATH>'],
  // 正斜杠盘符路径 <DSH_ROOT>/...
  [/\b[A-Za-z]:\/[^\s"']+/g, '<PATH>'],
  // ISO / 常见日期时间
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TIME>'],
  [/\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/g, '<TIME>'],
  // 13 位毫秒 epoch（会话时间戳）
  [/\b1\d{12}\b/g, '<TS>'],
  // 工具 callId / UUID / 会话 id / 长 hex
  [/call_\d+_[A-Za-z0-9]+/g, '<CALL>'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>'],
  [/session-[0-9a-f-]{8,}/gi, '<SID>'],
  [/\b[0-9a-f]{16,}\b/gi, '<HEX>'],
  // PID
  [/\bpid[=: ]+\d+/gi, 'pid=<PID>'],
  [/\bProcessId\s*[:=]\s*\d+/gi, 'ProcessId=<PID>'],
  // rg 的行列号 path:12:34:
  [/:\d+:\d+(?=:)/g, ':<LINE>'],
  // 绝对路径被吃掉后残留的裸盘符
  [/\b[A-Za-z]:\\/g, '<PATH>\\'],
];

function collapse(s) {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n+/g, ' \\n ').trim();
}

/**
 * 归一化错误文本（与 pitfall-sign.normalizeErrorText 逐字节等价）。
 * @param {string} text
 * @returns {string}
 */
export function normalizeErrorText(text) {
  let s = String(text ?? '');
  for (const [rx, rep] of NORMALIZERS) s = s.replace(rx, rep);
  s = collapse(s);
  return s.length > NORM_TEXT_MAX ? s.slice(0, NORM_TEXT_MAX) : s;
}

/**
 * 坑签名（与 pitfall-sign.signatureOf 逐字节等价）。
 * @param {{name?:string, code?:string, text?:string}} err
 * @returns {{sigKey:string, id:string, normText:string, name:string, code:string}}
 */
export function signatureOf(err = {}) {
  const name = String(err.name ?? '').trim() || 'Error';
  const code = String(err.code ?? '').trim() || 'NO_CODE';
  const normText = normalizeErrorText(err.text);
  const sigKey = `${name}|${code}|${normText}`;
  const id = crypto.createHash('sha1').update(sigKey, 'utf8').digest('hex').slice(0, 16);
  return { sigKey, id, normText, name, code };
}
