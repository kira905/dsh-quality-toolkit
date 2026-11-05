#!/usr/bin/env node
/**
 * write-action-check.mjs —— 写动作登记校验器（**只读**：只读盘，不写任何生产状态、不接线）
 *
 * 登记表：`--registry <路径>`（缺省 = cwd 下的 `写动作登记.json`，或 env `DSH_REGISTRY`）；
 * 结构与字段示例见 `_test/写动作登记示例.json`。
 *
 * 三步：
 *   1. 载体在位：carrierPath 存在吗？悬空 ⇒ 🔴（对端载体不在本机判据内，见 outOfScope）
 *   2. 写者枚举：扫源码判「这个模块写不写该载体」⇒ actualWriters。两种粒度（见下）：
 *      · 文件级（默认，`carrierPath` 不带 `#表` 的条目）：解析写调用的**目标表达式**判是不是写该载体
 *      · 表级（`writerScope:'table'` 的条目，carrierKey 带 `#<表>` 段）：按 T1/T2/T3 三条表级信号判
 *        （为什么必须有见下面「表级写者判据」注释）
 *   3. 比对：actualWriters − writers ⇒ 🔴 未登记；writers − actualWriters ⇒ 🟡 登记过期
 *
 * 三处补强（缺一条本器不合格）：
 *   ① 载体唯一键 = `实例|规范化绝对路径`（表 = `实例|db 路径#表名`），由 carrierKeyOf() 现算并与
 *      登记表里的 carrierKey 逐条对拍 ⇒ 三机三份 state.json 不许混味
 *   ② 覆盖边界声明 outOfScope[]：逐条写「不覆盖什么 + 为什么 + 谁监督」，且必须机械覆盖三类
 *      （DSH 内核写 W41 / 跨机写对端 W11·W18 / 运行时动态拼路径）
 *   ③ unjudgeable 硬上限 ≤8，每条必须有 owner；**超限整体判红**（防止"把说明填满就变绿"）
 *
 * 用法：
 *   node write-action-check.mjs                              # 只读干跑，人话输出
 *   node write-action-check.mjs --json                       # 机器可读
 *   node write-action-check.mjs --dump-actual                # 只打印枚举到的 actualWriters（登记表初始化用）
 *   node write-action-check.mjs --selftest                   # 自带用例（含阴性对照）
 *   node write-action-check.mjs --registry <路径>            # 登记表（缺省 ./写动作登记.json）
 *   node write-action-check.mjs --root <目录> [--root <目录>] # 扫描根（可多值；缺省见 defaultScanRoots）
 *   node write-action-check.mjs --self-plugins a,b,c         # 只扫这些顶层插件包（env DSH_SELF_PLUGINS）
 *   node write-action-check.mjs --instance <实例名> --owner <认领人> [--floor-total <n>]
 *
 * 实例名 / 认领人：`--instance` / `--owner` 优先，其次 env `DSH_INSTANCE` / `DSH_OWNER`，
 * 缺省 `local` / `unassigned`（这两个值只影响示例与默认夹具，不影响你登记表里各条自己的 instance）。
 *
 * 退出码：0 全绿 / 3 有红 / 2 参数错
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REGISTRY_BASENAME = '写动作登记.json';
/** 登记表缺省位置：env `DSH_REGISTRY` 优先，其次 cwd 下的 `写动作登记.json` */
function defaultRegistryPath() {
  return process.env.DSH_REGISTRY || path.resolve(process.cwd(), REGISTRY_BASENAME);
}
const UNJUDGEABLE_MAX = 8;      // 补强③：硬上限
// 默认地板 21+9+8+4+7+2 = 51 条（PLAN_FLOOR）是**下限**，不是「实际必须等于」的快照。
// 登记表是**持续契约**、不是一次性快照 ⇒ 增量登记由登记表 meta.baseline 声明，
// 校验器只判「baseline 不低于地板」+「baseline 与实际计数一致」两件事。
// 别的项目条目规模不同 ⇒ 用登记表 `meta.floor` / `--floor-total` 覆盖；本仓不替你定规模。
const PLAN_FLOOR_TOTAL = 51;      // 缺省地板总条数（21+9+8+4+7+2）
const PLAN_FLOOR_CLASSES = { A: 21, B: 9, C: 8, derived: 4, ops: 7, 'out-of-scope': 2 };
const PLAN_FLOOR = { total: PLAN_FLOOR_TOTAL, classes: PLAN_FLOOR_CLASSES };

/**
 * 实例名 / 认领人：CLI 优先（`--instance` / `--owner`），其次 env，最后中性缺省值。
 * 🔴 别在这里写死任何机器名/人格名 —— 开源件不许带出作者的环境。
 */
let CLI_INSTANCE = '';
let CLI_OWNER = '';
function defaultInstance() { return CLI_INSTANCE || process.env.DSH_INSTANCE || 'local'; }
function defaultOwner() { return CLI_OWNER || process.env.DSH_OWNER || 'unassigned'; }

/**
 * 自建插件白名单（`<DSH_HOME>/profiles/web/node_modules` 下只扫这些**顶层包**）。
 * 由 `--self-plugins a,b,c` 或 env `DSH_SELF_PLUGINS` 提供；**缺省为空 ⇒ 该扫描根不启用**：
 * 每台机器装的插件各不相同，硬编码名单对别人只会把真写者全漏掉。
 */
let SELF_PLUGINS = selfPluginList();

function selfPluginList(cliList) {
  if (Array.isArray(cliList) && cliList.length) return cliList.map(String).filter(Boolean);
  return String(process.env.DSH_SELF_PLUGINS || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

/** DSH 家目录：`DSH_HOME` 优先，其次旧名 `DSH_WA_HOME`，再其次 `~/.dsh` */
function dshHome() {
  return process.env.DSH_HOME || process.env.DSH_WA_HOME || path.join(os.homedir(), '.dsh');
}

const CLASSES = new Set(['A', 'B', 'C', 'derived', 'ops', 'out-of-scope']);

/**
 * 表级写者判据用到的形态。
 *
 * 为什么加：文件级判据（「文件里出现载体字面量 + 有写调用」）**到文件、到不了表**，对表级载体
 * （carrierKey 带 `#<表>` 段）同时踩两个坑 —— W13 `vectors.db#vectors` 实测：
 *   假阳性 doc-index-rebuild.mjs（它只 `DELETE FROM doc_index`，只因路径里出现 `memory-vectors` 目录名被认）；
 *   假阴性 真正写它的三路一个都认不出来（sync.mjs 是薄壳 CLI、butler-memory-vectors-tick.mjs 是
 *          spawn 传 `--vectors-db`、pitfall-triage-tick.mjs 是 spawn `sync --source policy`）。
 * ⇒ 表级条目改用下面三条信号（任一成立即认），文件级条目保持原判据不变。
 */
const WRITE_ACTION_RE = /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\s*\(|\.\s*openSync\s*\([^)]*['"]a['"]|\bspawnSync\s*\(|\bspawn\s*\(|execFileSync\s*\(|(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[A-Za-z_][\w.]*\s+SET)\b/i;

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** T1：该表的直接 SQL 写语句（`INSERT [OR …] INTO <表>` / `UPDATE <表>` / `DELETE FROM <表>`） */
function tableSqlWriteRe(table) {
  return new RegExp(`\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|DELETE\\s+FROM|UPDATE)\\s+["\`']?${escapeRe(table)}\\b`, 'i');
}

/** 载体注入词：`vectors.db` ⇒ `vectors-db`（同时认 `MEMORY_ENGINE_VECTORS_DB` 形态的 env 名） */
function injectionTokens(carrierFile) {
  const base = path.basename(String(carrierFile)).replace(/\.[^.]+$/, '');
  const kebab = base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase();
  return [`${kebab}-db`, `MEMORY_ENGINE_${base.replace(/[-\s]+/g, '_').toUpperCase()}_DB`];
}

/** 去掉行内注释（`// …` 之后），避免"注释里提到注入参数"被当成代码里的写意图 */
function stripLineComment(line) {
  const i = line.indexOf('//');
  return i >= 0 ? line.slice(0, i) : line;
}

/** 粗粒度函数块切分（`function f()` / `const f = (…) => {`）：返回 [{name, body, start}] */
function functionBodies(text) {
  const out = [];
  const declRe = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(/g;
  let m;
  while ((m = declRe.exec(text))) {
    const name = m[1] || m[2];
    if (!name) continue;
    const parenAt = text.indexOf('(', m.index + m[0].length - 1);
    let depth = 0, j = parenAt;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') { depth--; if (depth === 0) { j++; break; } }
    }
    while (j < text.length && text[j] !== '{' && text[j] !== ';') j++;
    if (text[j] !== '{') continue;                      // 表达式体箭头函数：不切块
    let d = 0, k = j;
    for (; k < text.length; k++) {
      if (text[k] === '{') d++;
      else if (text[k] === '}') { d--; if (d === 0) { k++; break; } }
    }
    out.push({ name, body: text.slice(j, k), start: m.index });
  }
  return out;
}

/** 具名 import 的 { 符号 → 模块 }（T3 委派写用；`import * as` / require 不参与，宁可漏判不误判） */
function namedImports(text) {
  const out = [];
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    out.push({ names, spec: m[2] });
  }
  return out;
}

/** 相对 import 路径 ⇒ 扫描集里的文件键（找不到返回 null） */
function resolveImportKey(fromFile, spec, keySet) {
  if (!spec.startsWith('.')) return null;
  const p = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [p, `${p}.mjs`, `${p}.js`, `${p}.cjs`, `${p}.jsx`, path.join(p, 'index.mjs'), path.join(p, 'index.js')]) {
    const k = lowerDrive(cand);
    if (keySet.has(k)) return k;
  }
  return null;
}

// ---------------------------------------------------------------- 工具函数

const toPosix = (p) => String(p).replace(/\\/g, '/');
const lowerDrive = (p) => toPosix(p).replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':');

/**
 * 补强①：载体唯一键 = 实例 + 规范化绝对路径（表 = 实例 + db 路径 + #表名）
 * 对端载体用 `peer://<实例>/<路径>` 形态 —— 实例名与 entry.instance 必须一致，
 * 这是「state.json 三机三份不许混味」的机械判据（同路径不同实例 ⇒ 不同键）。
 */
export function carrierKeyOf(instance, carrierPath) {
  const raw = String(carrierPath);
  const hashAt = raw.indexOf('#');
  const filePart = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const tablePart = hashAt >= 0 ? raw.slice(hashAt) : '';
  if (filePart.startsWith('peer://')) return `${instance}|${lowerDrive(filePart)}${tablePart}`;
  let abs;
  if (/^[A-Za-z]:[\\/]/.test(filePart) || filePart.startsWith('/')) abs = lowerDrive(path.resolve(filePart));
  else abs = lowerDrive(filePart);
  return `${instance}|${abs}${tablePart}`;
}

function splitPathForDisplay(p) {
  const raw = toPosix(String(p));
  const hashAt = raw.indexOf('#');
  return { file: hashAt >= 0 ? raw.slice(0, hashAt) : raw, table: hashAt >= 0 ? raw.slice(hashAt + 1) : null };
}

/** `peer://<实例>/<路径>` ⇒ { instance, rest }；非 peer 形态返回 null */
function parsePeer(carrierPath) {
  const m = /^peer:\/\/([^/]+)\/(.*)$/.exec(toPosix(String(carrierPath)));
  return m ? { instance: m[1], rest: m[2] } : null;
}

/**
 * 扫描后缀白名单：旧版每个根只给一个后缀（tools=`.mjs`、插件 / 源码仓=`.js`），
 * 而 `walkFiles` 用 `e.name.endsWith(ext)` 判 ⇒ 插件目录里的 `.mjs` 写者**永远不在扫描面**
 * （实例：`dsh-memory/lib/forget-ledger.mjs` 是 `memory_forget` 的真写者 —— `openSync(p,'a')`+`writeSync`
 * 改留痕台账 —— 却一件都扫不到 ⇒ 旧版只能把它挂进 `meta.unjudgeable` 遮住，不是修好）。
 * 现在三个后缀一起收；`ext` 允许字符串（向后兼容）或数组。
 */
const SCAN_EXTS = ['.js', '.mjs', '.cjs'];

/**
 * 扫描集（缺省）：`<DSH_HOME>/tools/**\*.{js,mjs,cjs}` + 自建插件 `<DSH_HOME>/profiles/web/node_modules/**\*.{js,mjs,cjs}`
 * + `<DSH_HOME>/dsh-*\**\*.{js,mjs,cjs}`。
 * `--root <目录>`（可多值）给了就**只扫这些根**；不给则按上面三条在 `DSH_HOME`（缺省 = `~/.dsh`）下展开。
 * 你的布局不一样 ⇒ 直接用 `--root` 指过去，别改这里。
 */
export function defaultScanRoots(opts = {}) {
  const extra = (Array.isArray(opts.roots) ? opts.roots : []).map(String).filter(Boolean);
  if (extra.length) return extra.map(r => ({ root: toPosix(path.resolve(r)), ext: [...SCAN_EXTS], onlySelf: false }));
  const home = toPosix(opts.home ? String(opts.home) : dshHome());
  const roots = [{ root: toPosix(path.join(home, 'tools')), ext: [...SCAN_EXTS], onlySelf: false }];
  if (SELF_PLUGINS.length) {
    roots.push({ root: toPosix(path.join(home, 'profiles', 'web', 'node_modules')), ext: [...SCAN_EXTS], onlySelf: true });
  }
  // <DSH_HOME>/dsh-* 目录（源码仓 / 插件源）
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (e.isDirectory() && /^dsh-/.test(e.name)) {
        roots.push({ root: `${home}/${e.name}`, ext: [...SCAN_EXTS], onlySelf: false });
      }
    }
  } catch { /* 目录不在就跳过 */ }
  return roots;
}

/** `ext` 归一化：数组原样返回；字符串按 `|` 拆（`.js|.mjs` 与单值 `.mjs` 都认）——单值写法向后兼容 */
function extList(ext) {
  if (Array.isArray(ext)) return ext.map(x => String(x)).filter(Boolean);
  return String(ext || '').split('|').map(s => s.trim()).filter(Boolean);
}

function* walkFiles(root, ext, onlySelf) {
  const exts = extList(ext);
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.isSymbolicLink()) continue;         // junction 不跟（防跨盘重复扫）
        if (e.name === 'node_modules') continue;
        if (onlySelf) {
          const rel = path.relative(root, fp);
          const top = rel.split(path.sep)[0];
          if (path.dirname(rel) === '.' && !SELF_PLUGINS.includes(top)) continue;
        }
        stack.push(fp);
      } else if (exts.some(x => e.name.endsWith(x))) {
        yield fp;
      }
    }
  }
}

export function loadSources(roots = defaultScanRoots()) {
  const files = [];
  for (const r of roots) for (const f of walkFiles(r.root, r.ext, r.onlySelf)) files.push(f);
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    out.push({ file: toPosix(f), text, lines: text.split(/\r?\n/) });
  }
  return out;
}

/**
 * 写者枚举：**解析写调用的目标表达式**，判定"写的是不是这个载体"。
 *
 * 为什么不用"文件里出现载体名"：实测会把所有提到 `memory.db` 的 60+ 个模块全算成写者（噪声不可用）。
 * 为什么不用"写调用 ±N 行窗口"：路径常量常定义在文件头部、写调用在中部（实测 life-append.mjs 的
 * target 定义与 appendFileSync 相隔 70 行），窄窗口会漏掉真写者（假绿比假红危险）。
 *
 * 现在的判据：
 *   ① 取写调用的**第一个参数**（writeFileSync / appendFileSync / writeFile / createWriteStream / openSync /
 *      writeSync / 委派写入口 `updateJson()` 一族 —— 见 WRITE_FN）
 *   ② 目标里直接出现载体特征串 ⇒ 命中
 *   ③ 目标是标识符（如 `target` / `PROD` / `tmp`）⇒ 回查其赋值行（最多 2 层）再判
 *   ④ SQL（`INSERT [OR …] INTO <表>` / `UPDATE <表> … SET` / `DELETE FROM <表>`）⇒ 用载体 `#表名` 判。
 *      ⚠️ 必须**语句形**：`.update(` / `update:` / `AFTER UPDATE ON x` 这类「出现 UPDATE 这个词」不算
 *      （收紧后见 SQL_WRITE_RE 注释）
 * 测试/夹具模块跳过（它们写沙箱 home，不是生产载体）。
 */
/**
 * 表级写者枚举（`writerScope:'table'` 的条目走这里）。
 *
 * 三条信号（任一成立即认「这个模块写这张表」）：
 *   T1 直接 SQL 写：模块里有 `INSERT INTO|UPDATE|DELETE FROM <表>`
 *   T2 注入 + 写能力：**非注释行**出现该载体的注入词（`vectors-db` / `MEMORY_ENGINE_VECTORS_DB`）
 *      且模块内有写动作（写文件 / 追加 / SQL 写 / spawn 子进程）
 *   T3 委派写：模块 import 了「写入口函数」—— 该函数在被导入模块里（一层间接）调用了 T1 写函数。
 *      薄壳 CLI 的写其实在 lib 里（cli/sync.mjs → lib/sync.mjs#runIncrementalSync → upsertVectors），
 *      只看本文件有没有 SQL 会把真写者判成只读。
 *
 * 会误认的情况（已实测排除）：只 import 写者模块的**打开/计数**函数（openVectorsStore / countVectors）
 * ⇒ T3 不命中；只在注释里提 `--vectors-db` ⇒ T2 不命中。
 */
export function enumerateTableWriters(entry, sources, stat) {
  const { file: carrierFile, table } = splitPathForDisplay(entry.carrierPath);
  const sqlRe = tableSqlWriteRe(table);
  const tokens = injectionTokens(carrierFile);
  // 注入词按**词边界**匹配：`sample-db` 不许命中 `sample-db-dir` 这种目录名（阴性对照就测这个）
  const tokenRe = new RegExp(`(?:^|[^\\w$])(?:${tokens.map(escapeRe).join('|')})(?![\\w-])`);
  const require = (entry.require || []).filter(Boolean);
  const exclude = (entry.exclude || []).filter(Boolean);
  const excludePrefixes = (entry.excludePathPrefixes || []).map(p => lowerDrive(p));
  const excludeFiles = (entry.excludeFiles || []).map(p => lowerDrive(p));

  const keyOf = (s) => lowerDrive(s.file);
  const byKey = new Map();
  for (const s of sources) byKey.set(keyOf(s), s);
  const keySet = new Set(byKey.keys());

  // ① T1：直接写这张表的函数名（`upsertVectors` / `deleteSource` …）
  const writerFnNames = new Set();
  const sqlModules = new Map();          // moduleKey -> { line }
  for (const s of sources) {
    const m = sqlRe.exec(s.text);
    if (!m) continue;
    const line = s.text.slice(0, m.index).split(/\r?\n/).length;
    sqlModules.set(keyOf(s), { line });
    for (const b of functionBodies(s.text)) if (sqlRe.test(b.body)) writerFnNames.add(b.name);
  }
  const writerFnRe = writerFnNames.size
    ? new RegExp(`\\b(?:${[...writerFnNames].map(escapeRe).join('|')})\\b`)
    : null;

  // ② 写入口函数：函数体里出现写函数名（一层间接）
  const blocksCache = new Map();
  const blocksOf = (src) => {
    const k = keyOf(src);
    if (!blocksCache.has(k)) blocksCache.set(k, functionBodies(src.text));
    return blocksCache.get(k);
  };
  const isWriterBody = (body) => !!(writerFnRe && writerFnRe.test(body));
  /** 写入口 = 它本身是 T1 写函数，或它函数体里调用了 T1 写函数（一层间接） */
  const isWriterEntry = (name, body) => writerFnNames.has(name) || isWriterBody(body);

  const hits = [];
  for (const s of sources) {
    if (isTestPath(s.file)) { if (stat) stat.skippedTest++; continue; }
    if (excludePrefixes.some(p => keyOf(s).startsWith(p))) { if (stat) stat.skippedExcluded = (stat.skippedExcluded || 0) + 1; continue; }
    if (excludeFiles.includes(keyOf(s))) { if (stat) stat.skippedExcluded = (stat.skippedExcluded || 0) + 1; continue; }
    if (require.length && !require.every(r => s.text.includes(r))) continue;
    if (exclude.length && exclude.some(x => s.text.includes(x))) continue;

    let hit = null;
    // T1
    if (sqlModules.has(keyOf(s))) {
      hit = { line: sqlModules.get(keyOf(s)).line, call: `T1 直接 SQL 写 ${table}`, signal: 'T1' };
    }
    // T2
    if (!hit && WRITE_ACTION_RE.test(s.text)) {
      for (let i = 0; i < s.lines.length; i++) {
        const line = s.lines[i];
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;            // 整行注释
        const code = stripLineComment(line);                       // 行尾注释不算
        if (!tokenRe.test(code)) continue;
        hit = { line: i + 1, call: `T2 注入词 ${tokens[0]} + 有写动作`, signal: 'T2' };
        break;
      }
    }
    // T3
    if (!hit) {
      for (const imp of namedImports(s.text)) {
        const mk = resolveImportKey(s.file, imp.spec, keySet);
        if (!mk) continue;
        const mod = byKey.get(mk);
        const at = s.lines.findIndex(l => l.includes(imp.spec));
        for (const b of blocksOf(mod)) {
          if (!imp.names.includes(b.name) || !isWriterEntry(b.name, b.body)) continue;
          hit = { line: at + 1, call: `T3 委派写 ${b.name}() → ${toPosix(mk).split('/').slice(-2).join('/')}`, signal: 'T3' };
          break;
        }
        if (hit) break;
      }
    }
    if (hit) hits.push({ file: s.file, ...hit });
  }
  return hits;
}

export function enumerateEntry(entry, sources, stat) {
  const { file: carrierFile, table } = splitPathForDisplay(entry.carrierPath);
  // 表级载体且条目显式声明 writerScope:'table' ⇒ 走表级判据（文件级载体不受影响）
  if (table && entry.writerScope === 'table') return enumerateTableWriters(entry, sources, stat);
  const patterns = (entry.patterns && entry.patterns.length ? entry.patterns : [path.basename(carrierFile)]).filter(Boolean);
  const require = (entry.require || []).filter(Boolean);
  const exclude = (entry.exclude || []).filter(Boolean);
  const tableRe = table ? new RegExp(`\\b${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) : null;
  const hits = [];

  for (const src of sources) {
    const { file, text, lines } = src;
    if (isTestPath(file)) { if (stat) stat.skippedTest++; continue; }
    if (require.length && !require.every(r => text.includes(r))) continue;
    if (exclude.length && exclude.some(x => text.includes(x))) continue;
    if (!patterns.some(p => text.includes(p)) && !(tableRe && tableRe.test(text))) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;                 // 注释不算写调用
      const call = extractWriteTarget(line);
      if (!call) continue;
      const expr = resolveExpr(call.expr, text);
      const ok = patterns.some(p => expr.includes(p))
        || (tableRe && call.kind === 'sql' && tableRe.test(expr))
        // 受控回退：路径藏在辅助函数（defaultHitsDir 之类）里时，退回"本模块含该载体特征串 + 有写调用"。
        // 只对登记表显式标 fallbackFileLevel:true 的条目启用 —— 不全局放宽。
        || (entry.fallbackFileLevel === true && patterns.some(p => text.includes(p)));
      if (!ok) continue;
      hits.push({ file, line: i + 1, call: line.trim().slice(0, 120) });
      break;                                                          // 每文件只记首个
    }
  }
  return hits;
}

/**
 * SQL **写语句**形态（收紧；旧版 `/(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\b/i`）。
 *
 * 旧版为什么必须改：`\b` 在 `UPDATE` 的 `E` 与 `(` 之间同样成立 ⇒ **方法调用被当成 SQL 写**：
 *   `crypto.createHash('sha256').update(buf)` / `h.update(…)` / `update: '同主题…'` 全命中，
 *   于是「唯一 SQL 形命中就是哈希行」的纯只读模块被错认成载体写者（实测踩到 W01 · W09-12 · W44 五处）。
 *
 * 现判据 = 三条都要「语句形」而不是「出现关键字」：
 *   ① `INSERT [OR …] INTO <表名>` / `DELETE FROM <表名>`：关键字后**紧跟一个标识符**（表名，允许引号包裹），
 *      方法调用（`.update(`）与属性名（`update:`）关键字后不是「空白 + 标识符」⇒ 结构上进不来；
 *   ② `UPDATE [OR …] <表名> … SET`：标识符之外还要求**同行有 `SET`** —— 光有标识符不够，
 *      `AFTER UPDATE ON memories`（触发器 DDL）、`update patch 不允许的键`（中文提示）、`UPDATE 影响行数`（日志）
 *      这类"提到 UPDATE 这个词"的行全会假命中（实测 755 行，逐条看过：全是话术/DDL，无真写）；
 *   ③ 表名不许是模板变量：`${table}` / `%s` 不认（宁可这条不命中，也不让它拿整行当目标蒙对）。
 *      实测全扫描面「关键字后是模板占位」的行 = 0 行，所以这条不会丢真写者。
 *
 * 🔴 收敛靠**判据本身**，不是文件名白名单 —— selftest ㉑ 的阴性/阳性对就是拿它当标的。
 */
const SQL_WRITE_RE = /\b(?:(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM)\s+["`']?[A-Za-z_][\w.\[\]]*|UPDATE(?:\s+OR\s+\w+)?\s+["`']?[A-Za-z_][\w.\[\]]*(?=[^\n]*\bSET\b))/i;

/**
 * 委派写入口（RMW 家族）——读-改-写也算写调用。
 *
 * 为什么必须有：坑库 / 台账这类载体常由 `updateJson()` 这种「读-改-写」入口落盘（锁 + 原子替换都在
 * `lib/store.mjs` 里），调用方文件里**一个裸写调用都没有**（`seed-pitfalls.mjs` 实测：只有 L196
 * `updateJson(file, …)`）；只认裸写会把真写者判成只读 ⇒ 收紧后直接变「登记过期」。
 * 反向口径：`readJson()` / `loadJson()` / `readJsonAtomic()` 是**读**入口，绝不许进这张表
 * （selftest ㉒ 拿 `readJson(` 当阴性对照）。
 */
const DELEGATED_WRITE_NAMES = ['updateJson', 'updateJsonAtomic', 'writeJson', 'writeJsonAtomic',
  'saveJson', 'saveJsonAtomic', 'appendJsonl', 'appendJsonlSync', 'writeTextAtomic'];

/**
 * 写调用取样点。前三段 = 裸写（writeFileSync / appendFileSync / createWriteStream / writeFile）；
 * 第四、五段 = `openSync(` / `writeSync(`（追加写形态：`openSync(p,'a')` + `writeSync(fd,…)`）；
 * 末段 = 委派写入口（见上）。
 */
const WRITE_FN = new RegExp('(?:\\b(?:writeFileSync|appendFileSync|createWriteStream|writeFile)\\s*\\('
  + '|\\.\\s*writeFile\\s*\\(|\\.\\s*openSync\\s*\\(|\\.\\s*writeSync\\s*\\('
  + '|\\b(?:' + DELEGATED_WRITE_NAMES.join('|') + ')\\s*\\()');

function extractWriteTarget(line) {
  const sql = SQL_WRITE_RE.test(line);
  const m = WRITE_FN.exec(line);
  if (sql && !m) return { expr: line, kind: 'sql' };
  if (!m) return null;
  const rest = line.slice(m.index + m[0].length);
  return { expr: depthSlice(rest), kind: sql ? 'sql' : 'file' };
}

/** 从 `(` 之后取出第一参数（按括号深度切到顶层逗号；单行里够用） */
function depthSlice(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return s.slice(0, i); depth--; }
    else if (ch === ',' && depth === 0) return s.slice(0, i);
  }
  return s;
}

const NOT_IDS = new Set(['path', 'join', 'resolve', 'fs', 'process', 'require', 'import', 'node', 'os', 'homedir', 'env', 'const', 'let', 'var', 'true', 'false', 'null', 'undefined', 'function', 'return', 'await', 'async']);

/** 把目标表达式里的标识符替换成它们的赋值右侧（最多 3 层）；并回查 `obj.prop` 的属性值
 *  —— 覆盖「路径藏在状态文件 schema 常量里」的封装写法（writeState(SCHEMA, …) → SCHEMA.file） */
function resolveExpr(expr, fileText) {
  let out = expr;
  for (let depth = 0; depth < 3; depth++) {
    let changed = false;
    const ids = new Set([...out.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map(m => m[1]).filter(id => !NOT_IDS.has(id) && !/^\d+$/.test(id)));
    for (const id of ids) {
      const m = new RegExp(`(?:^|[\\s;])(?:const|let|var)?\\s*${id.replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]+)`).exec(fileText);
      if (!m) continue;
      const rhs = m[1];
      if (!rhs || out.includes(rhs)) continue;
      out += ' ' + rhs;
      changed = true;
    }
    // obj.prop ⇒ 取该 prop 在文件里的首个字面量赋值（`prop: 'x.json'` 或 `prop = 'x.json'`）
    const props = new Set([...out.matchAll(/\b[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
    for (const prop of props) {
      if (NOT_IDS.has(prop)) continue;
      const re = new RegExp(`\\b${prop}\\s*[:=]\\s*(['"\`][^'"\`]{1,120}['"\`])`);
      const pm = re.exec(fileText);
      if (pm && !out.includes(pm[1])) { out += ' ' + pm[1]; changed = true; }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * 测试/夹具路径不算生产写者（它们写沙箱 home，不是生产载体）。
 * 依据：DSH 夹具约定「探针隔离生产路径」—— 这些模块的写入目标由夹具变量决定，静态判不出是生产。
 */
export function isTestPath(p) {
  const f = toPosix(p).toLowerCase();
  return /\/(test|tests|_test|fixtures|__tests__)\//.test(f)
    || /\.(test|drill)\.(mjs|js|cjs)$/.test(f)
    || /-test\.(mjs|js|cjs)$/.test(f)
    || /(^|\/)(test|_e2e|drill)[-_]/.test(f)
    || /(^|\/)fixtures?[-_]/.test(f)
    || /(^|\/)sandbox[-_]/.test(f);
}

// ---------------------------------------------------------------- 核心评估

function normalizeWriter(w) {
  // 登记表里 writers 允许写 "待补"（会出现在 pendingWriters 里，不算写者）
  if (!w || typeof w !== 'string') return null;
  const t = w.trim();
  if (!t || t === '待补' || t === 'TODO') return null;
  return lowerDrive(t);
}

export function evaluate({ registry, sources, scanRoots, floor }) {
  const red = [];
  const yellow = [];
  const info = [];

  // 地板：调用方没传 floor ⇒ 用常量 PLAN_FLOOR（51 条 / A21·B9·C8·derived4·ops7·out-of-scope2）。
  // 登记表 `meta.floor` 或 `--floor-total` 可以覆盖它。
  // 合并语义 = 只许抬、漏给的 class 不落到 0（selftest 传的是更小的夹具地板）。
  const fl = { total: Number(floor && floor.total != null ? floor.total : PLAN_FLOOR.total),
               classes: { ...PLAN_FLOOR.classes, ...((floor && floor.classes) || {}) } };

  const entries = registry.entries || [];
  const meta = registry.meta || {};

  // ---- A. 结构自检
  const ids = new Map();
  for (const e of entries) {
    if (!e.id) red.push({ kind: '结构', text: '有条目缺 id' });
    if (ids.has(e.id)) red.push({ kind: '结构', text: `id 重复：${e.id}` });
    ids.set(e.id, e);
    if (!CLASSES.has(e.class)) red.push({ kind: '结构', text: `${e.id} 的 class 非法：${e.class}` });
    if (!e.carrierPath) red.push({ kind: '结构', text: `${e.id} 缺 carrierPath` });
    if (!e.instance) red.push({ kind: '结构', text: `${e.id} 缺 instance` });
    // 补强①：carrierKey 必须与现算一致
    if (e.carrierPath && e.instance) {
      const want = carrierKeyOf(e.instance, e.carrierPath);
      if (toPosix(e.carrierKey || '') !== want) {
        red.push({ kind: '结构', text: `${e.id} 的 carrierKey 与现算不一致：登记「${e.carrierKey}」vs 现算「${want}」` });
      }
    }
    // 派生类：必须有可执行重建命令；其余必须为 null
    if (e.class === 'derived') {
      if (!e.rebuildCommand || !String(e.rebuildCommand).trim()) {
        red.push({ kind: '结构', text: `${e.id} 是 derived 但没有 rebuildCommand` });
      }
    } else if (e.rebuildCommand != null) {
      red.push({ kind: '结构', text: `${e.id} 不是 derived，rebuildCommand 必须为 null` });
    }
  }

  const keySeen = new Map();
  for (const e of entries) {
    const k = toPosix(e.carrierKey || '');
    if (!k) continue;
    // 补强①的混味判据：对端载体的 peer:// 前缀里写的实例名，必须与本条 instance 一致
    const pr = parsePeer(e.carrierPath || '');
    if (pr && pr.instance !== e.instance) {
      red.push({ kind: '结构', text: `${e.id} 载体混味：peer:// 前缀写的是「${pr.instance}」，条目 instance 是「${e.instance}」` });
    }
    // 同一载体被多个写动作写是**合法的**（C 类就是一张表 8 个写动作）—— 只登记，不判红
    if (keySeen.has(k)) keySeen.get(k).push(e.id);
    else keySeen.set(k, [e.id]);
  }
  for (const [k, ids] of keySeen) {
    if (ids.length > 1) info.push({ kind: '同载体多写动作', text: `${k} ← ${ids.join(' / ')}（按载体聚合比对）` });
  }

  const classCount = {};
  for (const e of entries) classCount[e.class] = (classCount[e.class] || 0) + 1;

  // ---- 条目总数 / class 计数：**持续契约**口径
  // 旧版拿「实际 === 地板 51/8」当判据 ⇒ 每加一条合法登记就恒红，等于把持续契约钉成快照，
  // 与「登记表是持续契约」自相矛盾。现改成三处判红（一条都不许删）：
  //   ① meta.baseline 缺字段 ⇒ 红（没声明现值 = 结构判据失去标的）
  //   ② baseline 低于地板 ⇒ 红（**地板只许往上**，不许靠调低 baseline 换绿）
  //   ③ baseline ≠ 实际计数 ⇒ 红（改了登记表却没同步 baseline，两套数并存）
  const bl = meta.baseline;
  const floorTotal = Number(fl.total);
  const floorClasses = fl.classes || {};
  if (!bl || typeof bl !== 'object' || Array.isArray(bl) || bl.total == null || !bl.classes || typeof bl.classes !== 'object' || Array.isArray(bl.classes)) {
    red.push({ kind: '结构', text: 'meta.baseline 缺字段（必须是 { total:<n>, classes:{ A,B,C,derived,ops,out-of-scope } }）—— 结构判据不许靠「实际等于地板」这类快照口径' });
  } else {
    const blTotal = Number(bl.total);
    if (!Number.isInteger(blTotal)) {
      red.push({ kind: '结构', text: `meta.baseline.total 不是整数：${JSON.stringify(bl.total)}` });
    } else if (blTotal < floorTotal) {
      red.push({ kind: '结构', text: `meta.baseline.total ${blTotal} < 地板 ${floorTotal}（地板只许往上，不许调低）` });
    }
    for (const [c, n] of Object.entries(floorClasses)) {
      const v = bl.classes[c];
      if (v == null) {
        red.push({ kind: '结构', text: `meta.baseline.classes 缺 class ${c}（地板 ${n}）` });
      } else if (!Number.isInteger(Number(v))) {
        red.push({ kind: '结构', text: `meta.baseline.classes.${c} 不是整数：${JSON.stringify(v)}` });
      } else if (Number(v) < n) {
        red.push({ kind: '结构', text: `meta.baseline.classes.${c} ${Number(v)} < 地板 ${n}（地板只许往上，不许调低）` });
      }
    }
    if (Number.isInteger(blTotal) && entries.length !== blTotal) {
      red.push({ kind: '结构', text: `条目总数 ${entries.length} ≠ 登记表 meta.baseline.total ${blTotal}（改了登记表就要同步 baseline）` });
    }
    for (const [c, n] of Object.entries(bl.classes)) {
      if (!(c in classCount)) {
        red.push({ kind: '结构', text: `meta.baseline.classes 声明了 class ${c}，但实际没有任何条目` });
        continue;
      }
      if ((classCount[c] || 0) !== Number(n)) {
        red.push({ kind: '结构', text: `class ${c} 实际计数 ${classCount[c] || 0} ≠ 登记表 meta.baseline.classes.${c} ${n}` });
      }
    }
    for (const c of Object.keys(classCount)) {
      if (!(c in bl.classes)) {
        red.push({ kind: '结构', text: `class ${c} 实际有 ${classCount[c]} 条，但 meta.baseline.classes 没声明它（漏登记 class）` });
      }
    }
  }

  // ---- B. 载体在位（补强①：只判本机；对端载体归 outOfScope）
  let absentOkCount = 0;
  for (const e of entries) {
    if (e.host === 'peer' || e.class === 'out-of-scope') continue;   // 对端 / 边界外：不在本机在位判据内
    const { file } = splitPathForDisplay(e.carrierPath);
    let exists = false;
    try { exists = fs.existsSync(file); } catch { exists = false; }
    if (exists) continue;
    if (e.carrierAbsentOk && String(e.carrierAbsentOk.reason || '').trim()) {
      absentOkCount++;
      info.push({ kind: '载体未建（已声明）', text: `${e.id} ${file} —— ${e.carrierAbsentOk.reason}（owner: ${e.carrierAbsentOk.owner || '未填'}）` });
    } else {
      red.push({ kind: '载体悬空', text: `${e.id} ${file} 不存在（登记了但盘上没有）` });
    }
  }

  // ---- C. 写者枚举与比对（按**载体**聚合：C 类 = 一张表多个写动作，条目级比对会互相误报）
  const pendingWriters = [];
  const unregistered = [];
  const stale = [];
  const actualByEntry = {};
  const byCarrier = new Map();
  const stat = { skippedTest: 0 };

  for (const e of entries) {
    const declaredRaw = Array.isArray(e.writers) ? e.writers : [];
    if (declaredRaw.some(w => String(w).trim() === '待补')) pendingWriters.push(e.id);
    const k = toPosix(e.carrierKey || e.id);
    if (!byCarrier.has(k)) byCarrier.set(k, { ids: [], entries: [], declared: new Set(), enumerable: false });
    const bucket = byCarrier.get(k);
    bucket.ids.push(e.id);
    bucket.entries.push(e);
    for (const w of declaredRaw.map(normalizeWriter).filter(Boolean)) bucket.declared.add(w);
    if (e.enumerate !== false && e.host !== 'peer' && e.class !== 'out-of-scope') bucket.enumerable = true;
  }

  for (const [, bucket] of byCarrier) {
    if (!bucket.enumerable) {
      for (const id of bucket.ids) actualByEntry[id] = [];
      continue;
    }
    // 单条 ⇒ 用原条目（保留 require/exclude 收紧）。
    // 多条同载体（C 类 = 一张表多个写动作）⇒ 继承 entries[0] 的其余字段，**require 显式丢掉、exclude 取并集**：
    //   · require 是**收紧**（多一条要求 ⇒ 更可能漏判真写者）⇒ 不继承，保持原「不收紧（防漏）」口径；
    //   · exclude 是**放宽**（声明「这文件对本载体不是写者」，对同载体的其它条目同样成立）⇒ 必须并集。
    //   🔴 修正：旧版只并了 patterns、其余字段一概不继承 ⇒ 条目上的 exclude 在
    //   memory.db#memories（W09/W10/W11/W12 四条共用）这种必然进多条分支的载体上结构性地不生效，
    //   已写对的 5 个 exclude 全被无视（只放 W09 一条 ⇒ 未登记 0；四条同放 ⇒ 未登记 5）。
    const probe = bucket.entries.length === 1
      ? bucket.entries[0]
      : { ...bucket.entries[0],
          require: undefined,
          patterns: [...new Set(bucket.entries.flatMap(x => x.patterns || []))].filter(Boolean),
          exclude: [...new Set(bucket.entries.flatMap(x => x.exclude || []))].filter(Boolean) };
    const actual = enumerateEntry(probe, sources, stat);
    for (const id of bucket.ids) actualByEntry[id] = actual;
    const actualSet = new Set(actual.map(a => lowerDrive(a.file)));
    const label = bucket.ids.join('/');
    for (const a of actual) {
      if (!bucket.declared.has(lowerDrive(a.file))) {
        unregistered.push({ ids: bucket.ids, id: label, file: toPosix(a.file), line: a.line, call: a.call });
      }
    }
    for (const w of bucket.declared) {
      if (!actualSet.has(w)) stale.push({ id: label, writer: w });
    }
  }

  // ---- D. 补强②：覆盖边界声明
  const outOfScope = Array.isArray(meta.outOfScope) ? meta.outOfScope : [];
  const covered = new Set();
  for (const o of outOfScope) {
    if (!o.what || !String(o.what).trim()) red.push({ kind: '越界声明', text: `outOfScope 有条目缺「不覆盖什么」` });
    if (!o.why || !String(o.why).trim()) red.push({ kind: '越界声明', text: `outOfScope 有条目缺「为什么」` });
    if (!o.owner || !String(o.owner).trim()) red.push({ kind: '越界声明', text: `outOfScope 有条目缺「谁监督」` });
    for (const c of (o.covers || [])) covered.add(String(c));
  }
  if (outOfScope.length === 0) red.push({ kind: '越界声明', text: 'outOfScope 为空（必须声明覆盖边界）' });
  // 三类硬要求
  if (!covered.has('W41')) red.push({ kind: '越界声明', text: '未覆盖「DSH 内核写会话日志 W41」' });
  if (!(covered.has('W11') || covered.has('W18'))) red.push({ kind: '越界声明', text: '未覆盖「跨机脚本写对端 W11/W18」' });
  const hasDynamic = outOfScope.some(o => /动态/.test(String(o.what) + String(o.why)));
  if (!hasDynamic) red.push({ kind: '越界声明', text: '未覆盖「运行时动态拼路径」' });
  // 不进本机判据的条目（对端 / 边界外）必须逐条被 outOfScope 认领，否则等于静默不覆盖
  for (const e of entries) {
    if ((e.host === 'peer' || e.class === 'out-of-scope') && !covered.has(e.id)) {
      red.push({ kind: '越界声明', text: `${e.id} 不在本机判据内（对端/边界外），但 outOfScope 没有认领它` });
    }
  }

  // ---- E. 补强③：unjudgeable 上限 + owner
  const unjudgeable = Array.isArray(meta.unjudgeable) ? meta.unjudgeable : [];
  if (unjudgeable.length > UNJUDGEABLE_MAX) {
    red.push({ kind: '判不了超限', text: `unjudgeable ${unjudgeable.length} 条 > 硬上限 ${UNJUDGEABLE_MAX}（超限即整体判红）` });
  }
  for (const u of unjudgeable) {
    if (!u.id) red.push({ kind: '判不了', text: 'unjudgeable 有条目缺 id' });
    if (!u.owner || !String(u.owner).trim()) red.push({ kind: '判不了', text: `unjudgeable ${u.id || '?'} 缺 owner（谁认领）` });
    if (!u.reason || !String(u.reason).trim()) red.push({ kind: '判不了', text: `unjudgeable ${u.id || '?'} 缺 reason` });
  }

  for (const u of unregistered) red.push({ kind: '未登记写动作', text: `${u.id} ← ${u.file}:${u.line}  ${u.call}` });
  for (const s of stale) yellow.push({ kind: '登记过期', text: `${s.id} 登记的写者已不再写它：${s.writer}` });
  if (pendingWriters.length) info.push({ kind: '写者待补', text: `writers 为空/待补的条目：${pendingWriters.join(' ')}` });

  const counts = {
    entries: entries.length,
    unregistered: unregistered.length,
    stale: stale.length,
    outOfScope: outOfScope.length,
    unjudgeable: unjudgeable.length,
    absentOk: absentOkCount,
    skippedTest: stat.skippedTest,
    red: red.length,
    yellow: yellow.length,
    classCount,
    // 持续契约口径：登记表声明的现值 + 地板，供人话输出/JSON 一次看全
    baseline: (meta.baseline && typeof meta.baseline === 'object')
      ? { total: meta.baseline.total, classes: meta.baseline.classes }
      : null,
    floor: { total: floorTotal, classes: floorClasses },
  };
  return { red, yellow, info, counts, unregistered, stale, outOfScope, unjudgeable, actualByEntry };
}

// ---------------------------------------------------------------- selftest

function mkFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-selftest-'));
  const src = path.join(dir, 'tools');
  fs.mkdirSync(src, { recursive: true });
  const carrierDir = path.join(dir, 'data');
  fs.mkdirSync(carrierDir, { recursive: true });
  const carrier = path.join(carrierDir, 'sample.json');
  fs.writeFileSync(carrier, '{}\n', 'utf8');
  const files = [];
  lines.forEach((body, i) => {
    const f = path.join(src, `w${i}.mjs`);
    fs.writeFileSync(f, body, 'utf8');
    files.push(toPosix(f));
  });
  const sources = files.map(f => { const text = fs.readFileSync(f, 'utf8'); return { file: toPosix(f), text, lines: text.split(/\r?\n/) }; });
  return { dir, carrier: toPosix(carrier), files, sources, roots: [{ root: toPosix(src), ext: '.mjs', onlySelf: false }] };
}

function baseEntry(carrier, instance = defaultInstance()) {
  return {
    id: 'S01', carrierPath: carrier, instance,
    carrierKey: carrierKeyOf(instance, carrier),
    class: 'A', authority: '测试', writers: [], rebuildCommand: null,
    patterns: ['sample.json'], enumerate: true, note: 'selftest',
  };
}

/** 表级夹具：carrier = `<dir>/data/sample.db#rows`；files 为 {相对路径: 内容} */
function mkTableFixture(fileBodies, table = 'rows') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-table-'));
  const src = path.join(dir, 'tools');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const carrierFile = path.join(dataDir, 'sample.db');
  fs.writeFileSync(carrierFile, '', 'utf8');
  const files = [];
  for (const [rel, body] of Object.entries(fileBodies)) {
    const f = path.join(src, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, 'utf8');
    files.push(toPosix(f));
  }
  const sources = files.map(f => { const text = fs.readFileSync(f, 'utf8'); return { file: toPosix(f), text, lines: text.split(/\r?\n/) }; });
  return { dir, carrier: `${toPosix(carrierFile)}#${table}`, carrierFile: toPosix(carrierFile), files, sources };
}

function tableEntry(carrier, over = {}) {
  return {
    id: 'S02', carrierPath: carrier, instance: defaultInstance(),
    carrierKey: carrierKeyOf(defaultInstance(), carrier),
    class: 'A', authority: '测试', writers: [], rebuildCommand: null,
    patterns: [], writerScope: 'table', enumerate: true, note: 'selftest-table',
    ...over,
  };
}

/** 覆盖边界声明样例：三类硬要求各一条 + owner 走 defaultOwner()（不写死任何人名） */
const oosOk = () => [
  { what: '内核写会话日志', why: '非本仓源码', owner: 'upstream-release-window', covers: ['W41'] },
  { what: '跨机脚本写对端', why: '本机不可读对端盘', owner: 'cross-host-owner', covers: ['W11', 'W18'] },
  { what: '运行时动态拼路径', why: '路径运行时才定', owner: defaultOwner(), covers: [] },
];

/** 用例里只看「真问题」（条目总数 / class 计数 / baseline 这三类结构红是夹具必然产物） */
const realRed = (r) => r.red.filter(x => !(x.kind === '结构' && /条目总数|class |baseline/.test(x.text)));

// 夹具地板：夹具只有 1~2 条条目，凑不出缺省地板的 21 条 A 类 ⇒
// 生产地板（PLAN_FLOOR）由 evaluate 默认值保证，夹具这块显式声明"夹具规模的地板"。
const FX_FLOOR = { total: 1, classes: { A: 1, B: 0, C: 0, derived: 0, ops: 0, 'out-of-scope': 0 } };
/** 夹具 baseline：必须与夹具实际条目计数一致（默认 1 条 A 类） */
const FX_BASELINE = { total: 1, classes: { A: 1, B: 0, C: 0, derived: 0, ops: 0, 'out-of-scope': 0 } };
const fxBaseline = (over = {}) => ({ ...JSON.parse(JSON.stringify(FX_BASELINE)), ...over });

const evalTable = (entry, fx, extra = {}) => evaluate({
  registry: { meta: { outOfScope: oosOk(), unjudgeable: [], baseline: fxBaseline(), ...(extra.meta || {}) }, entries: [entry] },
  sources: fx.sources,
  floor: FX_FLOOR,
});

function mkRegistry(entryOver = {}, metaOver = {}) {
  const fx = mkFixture([]);
  const merged = { ...baseEntry(fx.carrier), ...entryOver };
  // 除用例⑦ 显式要测"抄错的 key"外，carrierKey 一律按现状重算
  if (!('carrierKey' in entryOver)) merged.carrierKey = carrierKeyOf(merged.instance, merged.carrierPath);
  return {
    fx,
    registry: {
      meta: { total: 1, outOfScope: oosOk(), unjudgeable: [], baseline: fxBaseline(), ...metaOver },
      entries: [merged],
    },
  };
}

function runSelftest() {
  const cases = [];
  const check = (name, fn) => {
    try { const r = fn(); cases.push({ name, ok: !!r.ok, detail: r.detail }); }
    catch (e) { cases.push({ name, ok: false, detail: '抛错：' + e.message }); }
  };

  // 用例 1（**阴性对照**）：合法登记 + 已登记写者 ⇒ 0 红
  check('① 阴性对照：合法登记（写者已登记）⇒ 0 红', () => {
    const body = "import fs from 'node:fs'\nconst P = 'sample.json'\nfs.writeFileSync(P, '{}')\n";
    const fx = mkFixture([body]);
    const entry = { ...baseEntry(fx.carrier), writers: [fx.files[0]] };
    const r = evaluate({ registry: { meta: { outOfScope: oosOk(), unjudgeable: [], baseline: fxBaseline() }, entries: [entry] }, sources: fx.sources, floor: FX_FLOOR });
    // 该夹具只有 1 条 entry，总数判据会红；故按"除总数/class 计数外"判
    const structOnly = r.red.filter(x => x.kind === '结构' && /条目总数|class /.test(x.text));
    const real = r.red.filter(x => !structOnly.includes(x));
    return { ok: real.length === 0 && r.counts.unregistered === 0, detail: `红 ${real.length}（未登记 ${r.counts.unregistered}）` };
  });

  // 用例 2（阳性）：源码新增一个未登记写者 ⇒ 未登记 1 且红
  check('② 阳性：出现未登记写者 ⇒ 红 + 未登记 1', () => {
    const a = "import fs from 'node:fs'\nconst P = 'sample.json'\nfs.writeFileSync(P, '{}')\n";
    const b = "import fs from 'node:fs'\nconst Q = 'sample.json'\nfs.appendFileSync(Q, 'x')\n";
    const fx = mkFixture([a, b]);
    const entry = { ...baseEntry(fx.carrier), writers: [fx.files[0]] };
    const r = evaluate({ registry: { meta: { outOfScope: oosOk(), unjudgeable: [], baseline: fxBaseline() }, entries: [entry] }, sources: fx.sources, floor: FX_FLOOR });
    const hit = r.unregistered.some(u => u.file === fx.files[1]);
    return { ok: r.counts.unregistered === 1 && hit && r.red.some(x => x.kind === '未登记写动作'), detail: `未登记 ${r.counts.unregistered}` };
  });

  // 用例 3：登记过期（writers 里有个不再写的模块）⇒ 黄 1、红 0（黄不改退出码）
  check('③ 登记过期：登记的写者已不写 ⇒ 黄 1、红 0', () => {
    const a = "import fs from 'node:fs'\nconst P = 'sample.json'\nfs.writeFileSync(P, '{}')\n";
    const b = "export const x = 1\n";
    const fx = mkFixture([a, b]);
    const entry = { ...baseEntry(fx.carrier), writers: [fx.files[0], fx.files[1]] };
    const r = evaluate({ registry: { meta: { outOfScope: oosOk(), unjudgeable: [], baseline: fxBaseline() }, entries: [entry] }, sources: fx.sources, floor: FX_FLOOR });
    const real = r.red.filter(x => !(x.kind === '结构' && /条目总数|class /.test(x.text)));
    return { ok: real.length === 0 && r.counts.stale === 1, detail: `黄 ${r.counts.stale} · 红 ${real.length}` };
  });

  // 用例 4：载体悬空 ⇒ 红
  check('④ 载体悬空 ⇒ 红', () => {
    const { registry, fx } = mkRegistry({ carrierPath: toPosix(path.join(os.tmpdir(), 'wa-nope', 'gone.json')) });
    const r = evaluate({ registry, sources: fx.sources, floor: FX_FLOOR });
    return { ok: r.red.some(x => x.kind === '载体悬空'), detail: `红 ${r.red.length}` };
  });

  // 用例 5：unjudgeable 超限（9 条）⇒ 整体红
  check('⑤ 判不了 9 条 > 上限 8 ⇒ 整体红', () => {
    const { registry, fx } = mkRegistry({}, {
      unjudgeable: Array.from({ length: 9 }, (_, i) => ({ id: `W${i}`, reason: 'x', owner: 'y' })),
    });
    const r = evaluate({ registry, sources: fx.sources, floor: FX_FLOOR });
    return { ok: r.red.some(x => x.kind === '判不了超限'), detail: `红 ${r.red.length}` };
  });

  // 用例 6：派生缺 rebuildCommand ⇒ 结构红
  check('⑥ derived 缺 rebuildCommand ⇒ 结构红', () => {
    const { registry, fx } = mkRegistry({ class: 'derived', rebuildCommand: null });
    const r = evaluate({ registry, sources: fx.sources, floor: FX_FLOOR });
    return { ok: r.red.some(x => /rebuildCommand/.test(x.text)), detail: `红 ${r.red.length}` };
  });

  // 用例 7：对端载体混味（peer:// 里的实例名 ≠ 条目 instance）⇒ 结构红
  check('⑦ 对端载体 peer:// 实例名与 instance 不符 ⇒ 结构红（防 state.json 三份混味）', () => {
    const { registry, fx } = mkRegistry({ carrierPath: 'peer://remote-node/agent/state.json', instance: defaultInstance() });
    const r = evaluate({ registry, sources: fx.sources, floor: FX_FLOOR });
    return { ok: r.red.some(x => /载体混味/.test(x.text)), detail: `红 ${r.red.length}` };
  });

  // 用例 8：unjudgeable 缺 owner ⇒ 红
  check('⑧ 判不了条目缺 owner ⇒ 红', () => {
    const { registry, fx } = mkRegistry({}, { unjudgeable: [{ id: 'W09', reason: '动态拼', owner: '' }] });
    const r = evaluate({ registry, sources: fx.sources, floor: FX_FLOOR });
    return { ok: r.red.some(x => x.kind === '判不了' && /owner/.test(x.text)), detail: `红 ${r.red.length}` };
  });

  // 用例 9：carrierKey 与现算不一致（手写错/抄旧键）⇒ 结构红
  check('⑨ carrierKey 与现算不一致 ⇒ 结构红', () => {
    const { registry, fx } = mkRegistry({ carrierKey: defaultInstance() + '|/wrong/path.json' });
    const r = evaluate({ registry, sources: fx.sources, floor: FX_FLOOR });
    return { ok: r.red.some(x => /carrierKey/.test(x.text)), detail: `红 ${r.red.length}` };
  });

  // 用例 10：对端条目没被 outOfScope 认领 ⇒ 红（静默不覆盖）
  check('⑩ 对端条目未被 outOfScope 认领 ⇒ 红', () => {
    const { registry, fx } = mkRegistry({ carrierPath: 'peer://remote-node/agent/state.json', instance: 'remote-node', host: 'peer' });
    const r = evaluate({ registry, sources: fx.sources, floor: FX_FLOOR });
    return { ok: r.red.some(x => /outOfScope 没有认领它/.test(x.text)), detail: `红 ${r.red.length}` };
  });

  // ---------- 表级判据：正例 3 条 + 反例 1 条 + 阴性对照 1 条 ----------

  // 用例 11（表级正例 / T1）：源码里有 `INSERT INTO <表>` ⇒ 认（W13 之前的文件级判据认得出，表级也要认）
  check('⑪ 表级 T1：源码有 `INSERT INTO <表>` ⇒ 认作该表写者', () => {
    const body = "import { DatabaseSync } from 'node:sqlite'\nconst db = new DatabaseSync('sample.db')\ndb.prepare('INSERT INTO rows (a) VALUES (?)').run(1)\n";
    const fx = mkTableFixture({ 'a-writer.mjs': body });
    const r = evalTable(tableEntry(fx.carrier, { writers: [fx.files[0]] }), fx);
    return { ok: realRed(r).length === 0 && r.counts.unregistered === 0 && r.counts.stale === 0, detail: `红 ${realRed(r).length} · 未登记 ${r.counts.unregistered} · 过期 ${r.counts.stale}` };
  });

  // 用例 12（表级正例 / T2）：只在子进程里传 --<载体>-db 写 ⇒ 旧判据认不出，表级要认（butler-memory-vectors-tick 形态）
  check('⑫ 表级 T2：spawn 传 `--<载体>-db` ⇒ 认作该表写者', () => {
    const body = "import { spawnSync } from 'node:child_process'\nconst args = ['--sample-db', db, '--apply']\nspawnSync(process.execPath, [cli, ...args])\n";
    const fx = mkTableFixture({ 'b-tick.mjs': body });
    const r = evalTable(tableEntry(fx.carrier, { writers: [fx.files[0]] }), fx);
    return { ok: realRed(r).length === 0 && r.counts.unregistered === 0 && r.counts.stale === 0, detail: `红 ${realRed(r).length} · 未登记 ${r.counts.unregistered} · 过期 ${r.counts.stale}` };
  });

  // 用例 13（表级正例 / T3）：薄壳 CLI 自己没 SQL，import 的写入口函数里有 ⇒ 要认（cli/sync.mjs 形态）
  check('⑬ 表级 T3：薄壳 CLI import 写入口函数（写实际在 lib 里）⇒ 认作写者', () => {
    const fx = mkTableFixture({
      'cli/run.mjs': "import { runWrite } from '../lib/store.mjs'\nimport { isMainEntry } from '../lib/util.mjs'\nif (isMainEntry(import.meta.url)) runWrite()\n",
      'lib/util.mjs': 'export const isMainEntry = (u) => Boolean(u);\n',
      'lib/store.mjs': "export function upsertRows(db, rows) {\n  db.prepare('INSERT INTO rows (a) VALUES (?)').run(rows)\n}\nexport function runWrite(db) {\n  return upsertRows(db, 1)\n}\n",
    });
    const [cli, , store] = fx.files;
    const r = evalTable(tableEntry(fx.carrier, { writers: [cli, store] }), fx);
    return { ok: realRed(r).length === 0 && r.counts.unregistered === 0 && r.counts.stale === 0, detail: `红 ${realRed(r).length} · 未登记 ${r.counts.unregistered} · 过期 ${r.counts.stale}` };
  });

  // 用例 14（表级反例）：只 import 打开/计数函数（不是写入口）⇒ **不许认**（否则所有只读工具都被算成写者）
  check('⑭ 表级反例：只 import 打开/计数函数 ⇒ 不许认作写者', () => {
    const fx = mkTableFixture({
      'cli/read.mjs': "import { countRows } from '../lib/store.mjs'\nconsole.log(countRows())\n",
      'lib/store.mjs': "export function upsertRows(db, rows) {\n  db.prepare('INSERT INTO rows (a) VALUES (?)').run(rows)\n}\nexport function countRows(db) {\n  return db.prepare('SELECT count(*) AS n FROM rows').get()\n}\n",
    });
    const r = evalTable(tableEntry(fx.carrier, { writers: [fx.files[1]] }), fx);
    return { ok: r.counts.unregistered === 0 && realRed(r).length === 0, detail: `未登记 ${r.counts.unregistered} · 红 ${realRed(r).length}` };
  });

  // 用例 15（**表级阴性对照**）：文件里有「目录名字面量 + 写别的表/别的文件」⇒ 不许认（doc-index-rebuild 的真实形态）
  check('⑮ 表级阴性对照：只有目录名字面量（`sample-db-dir`）+ 写别的表 ⇒ 不许认', () => {
    const body = "const dir = 'sample-db-dir'\nconst other = path.join(dir, 'other.db')\nfs.writeFileSync(other, '{}')\ndb.prepare('DELETE FROM other_rows').run()\n";
    const fx = mkTableFixture({ 'c-index.mjs': body });
    const r = evalTable(tableEntry(fx.carrier, { writers: [] }), fx);
    return { ok: r.counts.unregistered === 0 && r.counts.stale === 0, detail: `未登记 ${r.counts.unregistered}（必须 0）· 过期 ${r.counts.stale}` };
  });

  // ---------- 结构判据「持续契约」口径：① 缺字段 ② 低于地板 ③ 与实际不符，三条都必须能翻红 ----------

  // 用例 16：meta.baseline 缺字段 ⇒ 结构红（没声明现值 = 判据失去标的）
  check('⑯ 持续契约：meta.baseline 缺字段 ⇒ 结构红', () => {
    const { registry, fx } = mkRegistry({}, { baseline: undefined });
    const r = evaluate({ registry, sources: fx.sources, floor: FX_FLOOR });
    const hit = r.red.some(x => x.kind === '结构' && /meta\.baseline 缺字段/.test(x.text));
    return { ok: hit, detail: `红 ${r.red.length}（含缺字段红 ${hit}）` };
  });

  // 用例 17：baseline.total 低于地板 ⇒ 红（**不许靠调低 baseline 换绿**，地板只许往上）
  check('⑰ 持续契约：baseline.total 低于地板 ⇒ 结构红', () => {
    const { registry, fx } = mkRegistry({}, { baseline: fxBaseline({ total: 0 }) });
    const r = evaluate({ registry, sources: fx.sources, floor: FX_FLOOR });
    const hit = r.red.some(x => x.kind === '结构' && /baseline\.total/.test(x.text) && /地板/.test(x.text));
    return { ok: hit, detail: `红 ${r.red.length}（含地板红 ${hit}）` };
  });

  // 用例 18：baseline.classes 某一类低于地板 ⇒ 红（class 维度同样不许调低）
  check('⑱ 持续契约：baseline.classes.C 低于地板 ⇒ 结构红', () => {
    const { registry, fx } = mkRegistry();
    const r = evaluate({ registry, sources: fx.sources, floor: { total: 1, classes: { C: 2 } } });
    const hit = r.red.some(x => x.kind === '结构' && /classes\.C/.test(x.text) && /地板/.test(x.text));
    return { ok: hit, detail: `红 ${r.red.length}（含地板红 ${hit}）` };
  });

  // 用例 19（**修 1 回归**）：同载体多条条目 ⇒ exclude 必须取并集
  //   旧版多条分支只并 patterns、其余字段一概不继承 ⇒ memory.db#memories（W09/W10/W11/W12 共用）上的
  //   exclude 结构性失效。本用例要求：带 exclude ⇒ 未登记 0；撤掉 exclude ⇒ 未登记 1（证明不是天生绿）。
  check('⑲ 同载体多条：exclude 取并集（撤掉必须翻红）', () => {
    const a = "import fs from 'node:fs'\nconst P = 'sample.json'\nfs.writeFileSync(P, '{}')  // MARK_PAYLOAD_ONLY\n";
    const b = "import fs from 'node:fs'\nconst Q = 'sample.json'\nfs.appendFileSync(Q, 'x')\n";
    const fx = mkFixture([a, b]);
    const key = carrierKeyOf(defaultInstance(), fx.carrier);
    const mk = (id, over) => ({ ...baseEntry(fx.carrier), id, carrierKey: key, writers: [fx.files[1]], ...over });
    const bl = { total: 2, classes: { A: 2, B: 0, C: 0, derived: 0, ops: 0, 'out-of-scope': 0 } };
    const run = (entries) => evaluate({
      registry: { meta: { outOfScope: oosOk(), unjudgeable: [], baseline: bl }, entries },
      sources: fx.sources, floor: FX_FLOOR,
    });
    const withEx = run([mk('S01', { exclude: ['MARK_PAYLOAD_ONLY'] }), mk('S01b', {})]);
    const noEx = run([mk('S01', {}), mk('S01b', {})]);
    return {
      ok: withEx.counts.unregistered === 0 && noEx.counts.unregistered === 1,
      detail: `带 exclude ⇒ 未登记 ${withEx.counts.unregistered}（必须 0）· 撤掉 ⇒ 未登记 ${noEx.counts.unregistered}（必须 1）`,
    };
  });

  // 用例 20：扫描面只认**后缀名单**，且名单必须收 `.mjs` / `.cjs`
  //   洞的原样：插件根旧版只给 `ext:'.js'`，而 `walkFiles` 用 `endsWith(ext)` 判 ⇒ `<pkg>/lib/index.mjs`
  //   这种真写者**一件都进不了扫描面**（登记了也只会说"登记过期"）。本用例三段，全走真实 `loadSources`：
  //     ① 多后缀根 ⇒ `.mjs` 里的真写者被认出（扫描 1 件 / 未登记 1）；
  //     ② 同一份内容改名 `.mjsx` ⇒ 不被认（0 / 0，证明认的是名单，不是"凡是文件都扫"）；
  //     ③ 退回旧的单后缀 `'.js'` ⇒ 也不认（0 / 0，证明①测的正是那个洞，不是天生绿）。
  check('⑳ 扫描面：.mjs 真写者必须进扫描面（改名 .mjsx / 退回 .js 都必须不被认）', () => {
    const body = "import fs from 'node:fs'\nconst P = 'sample.json'\nfs.writeFileSync(P, '{}')\n";
    const scan = (name, ext) => {
      const fx = mkFixture([]);
      fs.writeFileSync(path.join(fx.roots[0].root, name), body, 'utf8');
      const sources = loadSources([{ root: fx.roots[0].root, ext, onlySelf: false }]);
      const r = evaluate({
        registry: { meta: { outOfScope: oosOk(), unjudgeable: [], baseline: fxBaseline() }, entries: [baseEntry(fx.carrier)] },
        sources, floor: FX_FLOOR,
      });
      return { scanned: sources.length, unreg: r.counts.unregistered };
    };
    const wide = scan('index.mjs', ['.js', '.mjs', '.cjs']);
    const wrongSuffix = scan('index.mjsx', ['.js', '.mjs', '.cjs']);
    const oldExt = scan('index.mjs', '.js');
    return {
      ok: wide.scanned === 1 && wide.unreg === 1
        && wrongSuffix.scanned === 0 && wrongSuffix.unreg === 0
        && oldExt.scanned === 0 && oldExt.unreg === 0,
      detail: `多后缀 ⇒ 扫描 ${wide.scanned} 件 / 未登记 ${wide.unreg}（必须 1/1）· 改名 .mjsx ⇒ ${wrongSuffix.scanned}/${wrongSuffix.unreg}（必须 0/0）· 旧单后缀 .js ⇒ ${oldExt.scanned}/${oldExt.unreg}（必须 0/0）`,
    };
  });

  // 用例 21（判据收紧）：SQL 判据必须是**语句形** —— `crypto…update(` 不是 SQL UPDATE
  //   旧判据 `/(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\b/i` 对 `.update(` 成立（`\b` 夹在 `e` 与 `(` 之间）
  //   ⇒ 纯哈希 / 纯只读模块被认成写者（撤掉的 W01 · W09-12 · W44 全是这一类）。
  //   两段同测：① 只有 `createHash(...).update(…)` 的文件 ⇒ **不许**被认（未登记 0）；
  //            ② 阴性对照：真 `UPDATE <表> … SET` 必须被认（未登记 1）——
  //               证明①不是"把 SQL 判据整个关掉"（那样①也绿，但②会红）。
  check('㉑ SQL 判据收紧：`crypto…update(` 不许算 SQL UPDATE；真 `UPDATE <表> … SET` 必须算', () => {
    const fileEntry = (fx) => ({
      id: 'S03', carrierPath: fx.carrier, instance: defaultInstance(), carrierKey: carrierKeyOf(defaultInstance(), fx.carrier),
      class: 'A', authority: '测试', writers: [], rebuildCommand: null,
      patterns: ['sample.db'], enumerate: true, note: 'selftest-sql',
    });
    const runOn = (fx) => evaluate({
      registry: { meta: { outOfScope: oosOk(), unjudgeable: [], baseline: fxBaseline() }, entries: [fileEntry(fx)] },
      sources: fx.sources, floor: FX_FLOOR,
    });
    // ① 只有哈希行（把表名当普通字符串喂进哈希 —— 旧判据会拿整行当写目标，恰好命中 `\brows\b`）
    const hashOnly = runOn(mkTableFixture({
      'hash.mjs': "import crypto from 'node:crypto'\nconst sha = crypto.createHash('sha256').update('rows', 'utf8').digest('hex')\n",
    }));
    // ② 阴性对照：真 SQL 写语句
    const realSql = runOn(mkTableFixture({
      'write.mjs': "import { DatabaseSync } from 'node:sqlite'\nconst db = new DatabaseSync('sample.db')\ndb.prepare('UPDATE rows SET a = 1 WHERE id = 2').run()\n",
    }));
    // ③ 属性形态（`update: '…'`）与方法调用（`h.update(…)`）同样不许算
    const propOnly = runOn(mkTableFixture({
      'kv.mjs': "const m = { update: 'rows 被新事实取代' }\nconst h = crypto.createHash('sha1')\nh.update('rows')\n",
    }));
    const hitLine = realSql.unregistered.length ? realSql.unregistered[0].line : -1;
    return {
      ok: hashOnly.counts.unregistered === 0 && hashOnly.counts.stale === 0
        && realSql.counts.unregistered === 1 && hitLine === 3
        && propOnly.counts.unregistered === 0,
      detail: `哈希行 ⇒ 未登记 ${hashOnly.counts.unregistered}（必须 0）· 真 UPDATE rows SET ⇒ 未登记 ${realSql.counts.unregistered}（必须 1，命中 L${hitLine} 必须 3）· 属性/方法形态 ⇒ 未登记 ${propOnly.counts.unregistered}（必须 0）`,
    };
  });

  // 用例 22（补信号）：委派写入口（RMW 家族）算写调用，读入口绝不算
  //   坑库 / 台账这类载体由 `updateJson()` 落盘（锁 + 原子替换都在 lib/store.mjs），调用方文件里一个
  //   裸写调用都没有（seed-pitfalls.mjs 实测）⇒ 不认委派写就会把真写者判成只读（收紧后直接变登记过期）。
  //   反向必须挡住：`readJson()` / `loadJson()` 是**读**入口，认了它们等于把"读"算成"写"（假红泛滥）。
  check('㉒ 委派写：`updateJson(` 认作写调用；`readJson(` / `loadJson(` 不许认', () => {
    const fx = mkFixture([
      "import { updateJson } from './lib/store.mjs'\nconst P = 'sample.json'\nconst next = updateJson(P, (cur) => cur)\n",
      "import { readJson, loadJson } from './lib/store.mjs'\nconst P = 'sample.json'\nconst cur = readJson(P)\nconst old = loadJson(P)\n",
    ]);
    const r = evaluate({
      registry: { meta: { outOfScope: oosOk(), unjudgeable: [], baseline: fxBaseline() }, entries: [baseEntry(fx.carrier)] },
      sources: fx.sources, floor: FX_FLOOR,
    });
    const files = r.unregistered.map(u => u.file.split('/').pop()).sort();
    return {
      ok: r.counts.unregistered === 1 && files.length === 1 && files[0] === 'w0.mjs',
      detail: `未登记 ${r.counts.unregistered}（必须 1）· 命中的是 ${JSON.stringify(files)}（必须是 ["w0.mjs"]，即 updateJson 那个；readJson/loadJson 那个必须不被认）`,
    };
  });

  const pass = cases.filter(c => c.ok).length;
  console.log(`🧪 write-action-check --selftest · ${pass}/${cases.length}`);
  for (const c of cases) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}  —— ${c.detail}`);
  console.log(pass === cases.length ? '\n全部通过（含 1 条阴性对照：用例①合法登记必须 0 红，证明本器不是恒绿）' : '\n有失败用例');
  return pass === cases.length ? 0 : 3;
}

// ---------------------------------------------------------------- main

function printHuman(r, { dumpActual } = {}) {
  const { counts, red, yellow, info } = r;
  if (dumpActual) {
    for (const [id, hits] of Object.entries(r.actualByEntry)) {
      if (!hits.length) { console.log(`${id}\t(none)`); continue; }
      for (const h of hits) console.log(`${id}\t${h.file}\tL${h.line}\t${h.call}`);
    }
    return;
  }
  console.log('🐋 写动作登记校验（只读干跑）');
  console.log(`   登记 ${counts.entries} 条 · class 分布 ${JSON.stringify(counts.classCount)}`);
  console.log(`   ${counts.baseline ? `baseline ${counts.baseline.total} 条（登记表 meta.baseline 声明）` : 'baseline 缺（meta.baseline 未声明）'} · 地板 ${counts.floor.total} 条（地板只许往上）`);
  console.log(`   扫描源码 ${r.__scanned ?? '(见 --json)'} 件\n`);

  if (red.length) {
    console.log(`🔴 红 ${red.length} 条`);
    for (const x of red) console.log(`   [${x.kind}] ${x.text}`);
  } else {
    console.log('🔴 红 0 条');
  }
  if (yellow.length) {
    console.log(`\n🟡 黄 ${yellow.length} 条（不阻塞退出码）`);
    for (const y of yellow.slice(0, 40)) console.log(`   [${y.kind}] ${y.text}`);
    if (yellow.length > 40) console.log(`   …另有 ${yellow.length - 40} 条`);
  }
  if (info.length) {
    console.log(`\nℹ️ 说明 ${info.length} 条`);
    for (const i of info) console.log(`   [${i.kind}] ${i.text}`);
  }
  console.log(`\n📊 未登记 ${counts.unregistered} · 登记过期 ${counts.stale} · 越界(outOfScope) ${counts.outOfScope} · 判不了 ${counts.unjudgeable}`);
  console.log(`   附带：测试夹具模块跳过 ${counts.skippedTest} 次（夹具写沙箱，不算生产写者）· 载体未建已声明 ${counts.absentOk}`);
  console.log(`   退出码：${red.length ? 3 : 0}（0 全绿 / 3 有红 / 2 参数错）`);
}

const USAGE = [
  '用法: node write-action-check.mjs [选项]',
  '',
  '  --json                     机器可读输出',
  '  --dump-actual              只打印枚举到的 actualWriters（登记表初始化用）',
  '  --selftest                 自带用例（含阴性对照）',
  '  --registry <路径>          登记表（缺省 ./写动作登记.json；env DSH_REGISTRY）',
  '  --root <目录>              扫描根，可重复给多个（缺省见 defaultScanRoots）',
  '  --self-plugins a,b,c       只扫这些顶层插件包（env DSH_SELF_PLUGINS）',
  '  --instance <实例名>        实例名（env DSH_INSTANCE；缺省 local）',
  '  --owner <认领人>           认领人（env DSH_OWNER；缺省 unassigned）',
  '  --floor-total <n>          覆盖地板总条数（缺省 51）',
  '  --help, -h                 这段帮助',
].join('\n');

/** 取值型 flag 的**全部**取值（`--root` 可重复） */
function valuesOf(args, name) {
  const out = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== name) continue;
    const v = args[i + 1];
    if (v == null || String(v).startsWith('--')) continue;
    out.push(String(v));
  }
  return out;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const VALUE_FLAGS = ['--registry', '--root', '--self-plugins', '--instance', '--owner', '--floor-total'];
  const BOOL_FLAGS = ['--json', '--dump-actual', '--selftest', '--help', '-h'];
  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;                 // 上一轮已把它当值跳过 / 位置参数
    if (BOOL_FLAGS.includes(a)) continue;
    if (VALUE_FLAGS.includes(a)) { i++; continue; }
    unknown.push(a);
  }
  if (unknown.length) { console.error(`✗ 未知参数：${unknown.join(' ')}`); return 2; }
  for (const name of VALUE_FLAGS) {
    if (args.includes(name) && !valuesOf(args, name).length) { console.error(`✗ ${name} 缺值`); return 2; }
  }

  // 实例名 / 认领人 / 自建插件名单：**先定下来**，selftest 与默认夹具都用它
  CLI_INSTANCE = valuesOf(args, '--instance')[0] || '';
  CLI_OWNER = valuesOf(args, '--owner')[0] || '';
  const selfPlugins = valuesOf(args, '--self-plugins').flatMap(v => v.split(/[,;]/)).map(s => s.trim()).filter(Boolean);
  if (selfPlugins.length) SELF_PLUGINS = selfPluginList(selfPlugins);

  if (args.includes('--selftest')) return runSelftest();

  const json = args.includes('--json');
  const dumpActual = args.includes('--dump-actual');
  const registryPath = valuesOf(args, '--registry')[0] || defaultRegistryPath();

  let registry;
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
  catch (e) { console.error(`✗ 读不到登记表 ${registryPath}：${e.message}`); return 2; }

  // 地板：登记表 `meta.floor` 优先（含 --floor-total 覆盖 total），否则用常量 PLAN_FLOOR
  const meta = (registry && registry.meta) || {};
  const floorTotal = valuesOf(args, '--floor-total')[0];
  let floor;
  if ((meta.floor && typeof meta.floor === 'object') || floorTotal) {
    floor = { ...(meta.floor && typeof meta.floor === 'object' ? meta.floor : {}) };
    if (floorTotal) floor.total = Number(floorTotal);
  }
  if (floor && floor.total != null && !Number.isInteger(Number(floor.total))) {
    console.error(`✗ --floor-total 不是整数：${floor.total}`);
    return 2;
  }

  const sources = loadSources(defaultScanRoots({ roots: valuesOf(args, '--root') }));
  const r = evaluate({ registry, sources, floor });
  r.__scanned = sources.length;

  if (json) {
    const out = {
      registry: toPosix(registryPath),
      instance: defaultInstance(),
      scanned: sources.length,
      counts: r.counts,
      red: r.red, yellow: r.yellow, info: r.info,
      outOfScope: r.outOfScope,
      unjudgeable: r.unjudgeable,
      // 明细（未登记/过期）按条目聚合，便于二次处理
      unregistered: r.unregistered,
      stale: r.stale,
    };
    if (dumpActual) out.actualByEntry = r.actualByEntry;
    console.log(JSON.stringify(out, null, 2));
  } else {
    printHuman(r, { dumpActual });
  }
  return r.red.length ? 3 : 0;
}

// junction 安全的主守卫（import.meta.url 是物理路径、argv[1] 是逻辑路径）
function isMain() {
  try {
    const a = fs.realpathSync(process.argv[1]);
    const b = fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return a.toLowerCase() === b.toLowerCase();
  } catch { return false; }
}
if (isMain()) process.exitCode = main(process.argv);
