#!/usr/bin/env node
// tools\lib\generated-docs.mjs —— 「自动生成档」判据的**唯一权威源**（SCHEMA_VERSION = 1）
//
// 权威性（方案 §2.5 冲突裁决表）：
//   凡「哪些档是自动生成档 · 某档有没有豁免资格 · 档级标记字面 · 插入点规则」**一律以本模块为准**。
//   —— `tools\docs-index-gen.mjs` 的 AUTO_DIR_RULES 已改为 **import 本模块派生**（不再独立维护）；
//   —— `docs\规划-自动生成档判据清单-20260925.md` §3.1 表 = 本模块的**派生视图**（注 as-of）；
//   —— 三者不一致 ⇒ 以本模块为准；改本模块须同步 SCHEMA_VERSION。
//
// 依据（逐条落点）：<DSH_ROOT>\docs\规划-自动生成档判据清单-20260925.md（v3c · 第五轮判「✅ 构成合格证」）
//   §2.2 档级标记规范 + 插入点统一规则（N-1 索引口径）
//   §2.3 N = 5 的理由（现有各族档头标识行全落在前 4 行内 + 留 1 行余量）
//   §2.4 判据实现形态（字面量 + String.includes + 行首锚定；不给正则）
//   §2.5 唯一权威源与冲突裁决（findFamily 匹配口径 M3-3 写死 · generator 字段口径 M-3 · 命名澄清）
//   §3.1 家族登记表（15 族）· §3.2 反向锚点（watch / external 登记但不豁免）
//   §4.3 豁免只认白名单（逃生舱 env DSH_CITES_EXEMPT=off）· §6.1-8 白名单支路本轮不实现（Non-goal）
//
// 纪律：本模块**纯常量 + 纯函数**（不读文件、不写文件、不碰开关、无副作用）
//   ⇒ 可被 15 个生成器 / 检查器 / 对账脚本 / 单测夹具共用。收尾一律 process.exitCode（禁 process.exit）。
//
// [impl-2 扩展 · 2026-10-08 · 卡 `impl-2`]：新增 **2 个导出** —— `firstH1Index()` / `stampDocMark()`
//   （供 15 个生成器在写盘前盖档级标记；纯函数、幂等、无副作用）。
//   **家族表 / 标记字面 / 既有导出逐字未改** ⇒ 按上方口径 **SCHEMA_VERSION 保持 1**
//   （口径 = 本文件顶部第 21 行：「改家族表或标记字面 = 必须 +1」，本次两者都没改）。

/** 权威源 schema 版本：**改家族表或标记字面 = 必须 +1**（报告里打印，供跨机一致性追溯） */
export const SCHEMA_VERSION = 1;

/** 档级标记的命名空间前缀（§2.2）——**判据只认这一段**，不依赖 `family=<id>` 的具体值 */
export const DOC_MARK_PREFIX = '<!-- dsh-generated-doc:auto';

/** 档级标记扫描窗口 N = 5（§2.2 位置口径 / §2.3 取值理由）——只扫档头前 N 行、且必须行首 */
export const DOC_MARK_SCAN_LINES = 5;

/** 档级标记完整字面（生成器写入用；`<family-id>` 取 §3.1 家族表的 id）
 *  规范字面量：`<!-- dsh-generated-doc:auto family=<family-id> -->`（一字不改） */
export const DOC_MARK_TEMPLATE = '<!-- dsh-generated-doc:auto family=<family-id> -->';

/** 豁免判定总开关（§4.3 逃生舱）——false ⇒ 检查器跳过豁免判定，结果与"豁免上线前"规范化一致。
 *  ⚠️ 与 env 的关系：`isExemptEnabled()` = 本常量 **且** env 未置 off（二者取最严）。 */
export const EXEMPT_ENABLED = true;

// ---------------------------------------------------------------- 判据原语（§2.2 / §2.4）

/** 行首锚定判据（§2.4 字面）：允许前置空白（缩进），**不做全库子串搜索**（防自举 / 误伤）
 *  @param {string} line 单行文本
 *  @returns {boolean} 是否为档级标记行 */
export function isDocMarkLine(line) {
  return typeof line === 'string' && line.trimStart().startsWith(DOC_MARK_PREFIX);
}

/** 从标记行读家族 id（**供对账用；判定本身不依赖它** —— §2.2）
 *  @param {string} line 单行文本
 *  @returns {string|null} family id，读不到 ⇒ null */
export function readFamilyId(line) {
  const m = /family=([a-z0-9-]+)/.exec(line ?? '');
  return m ? m[1] : null;
}

/** 插入点统一规则（§2.2 · B-1 · v3c/N-1 索引口径）——由生成器调用，保证与预演同口径
 *  @param {number} firstH1 0-based 索引 = `lines.findIndex(l => /^#\s+\S/.test(l))`；**无 H1 传 -1**
 *  @returns {number} 0-based 数组索引（= 行号 - 1）；恒定 ∈ [0, DOC_MARK_SCAN_LINES - 1]
 *  ⚠️ 实现者**不得按 1-based 行号传入**（§2.2 参数语义写死）：H1 在 L1 时传 1 ⇒ 得索引 2 = 第 3 行，
 *     与各族"插 L2"的落点表差 1 行。14 族（H1 索引 0）⇒ L2；`upstream`（无 H1）⇒ L1；
 *     `pitfall`（H1 索引 44）⇒ 夹紧 ⇒ L5。 */
export function insertAtFor(firstH1) {
  const at = firstH1 >= 0 ? firstH1 + 1 : 0;
  return Math.min(Math.max(at, 0), DOC_MARK_SCAN_LINES - 1); // 0-based
}

/** 档全文 → **首个 H1 的 0-based 行索引**（= `insertAtFor()` 的入参口径 · §2.2 参数语义写死）。
 *  判据 = `/^#\s+\S/`（与 §2.2 逐字一致）；**无 H1 ⇒ -1**（⇒ `insertAtFor(-1)` = 0 ⇒ 插第 1 行，
 *  实测 `upstream-*` 就是这种档）。生成器侧**一律走本函数**，禁自造正则（15 处自造 = 口径漂移面）。
 *  @param {string} text 档全文
 *  @returns {number} 0-based 索引；无 H1 ⇒ -1 */
export function firstH1Index(text) {
  return String(text ?? '').split(/\r?\n/).findIndex((l) => /^#\s+\S/.test(l));
}

/** **生成器侧**：给档全文盖上档级标记（§2.2 唯一形态）—— 15 个生成器在写盘前调用。
 *  · **插入点由调用方 `insertAtFor(firstH1Index(text))` 算好传入**（§2.2：由生成器调用权威源定位，
 *    不许各写一份 clamp —— §3.3-2b 的静态断言 A 核的就是生成器里的 `insertAtFor(` 调用点）；
 *  · **幂等**：档头前 N 行内已有档级标记 ⇒ **原位替换**（绝不重复插入；家族写错也在原位纠正）；
 *  · 纯函数（不读文件、不写文件、无副作用）；**行尾跟随文档**（CRLF 档插入的标记行也带 `\r`，
 *    避免同一文件混用 LF/CRLF）。
 *  @param {string} text 档全文
 *  @param {string} familyId §3.1 家族 id（写入 `family=<id>`；判定只认前缀，此值供对账）
 *  @param {number} at 0-based 插入索引（**必须** = `insertAtFor(...)` 的返回值）
 *  @returns {string} 盖好标记的档全文 */
export function stampDocMark(text, familyId, at) {
  const src = String(text ?? '');
  const crlf = /\r\n/.test(src);                            // 行尾风格跟随文档（不混 LF/CRLF）
  const lines = src.split('\n');
  const mark = DOC_MARK_TEMPLATE.replace('<family-id>', String(familyId)) + (crlf ? '\r' : '');
  const win = Math.min(DOC_MARK_SCAN_LINES, lines.length);
  for (let i = 0; i < win; i++) {
    if (isDocMarkLine(lines[i])) { lines[i] = mark; return lines.join('\n'); } // 幂等：原位替换
  }
  const n = Number.isInteger(at) ? at : 0;
  const idx = Math.min(Math.max(n, 0), DOC_MARK_SCAN_LINES - 1, lines.length);
  lines.splice(idx, 0, mark);
  return lines.join('\n');
}

/** 档头前 N 行（§2.4 检查器侧口径）。**唯一权威源**：检查器 / 对账脚本 / 夹具一律走这里，禁自造。 */
export function headLinesOf(text, n = DOC_MARK_SCAN_LINES) {
  return String(text ?? '').split(/\r?\n/, n);
}

/** 文本 → 「是不是自动生成档」（§2.4 检查器侧字面：`head.some(isDocMarkLine)`） */
export function isGeneratedDocText(text) {
  return headLinesOf(text).some(isDocMarkLine);
}

// ---------------------------------------------------------------- 路径归一化 + 家族匹配（§2.5）

/** 路径归一化（§2.5-1 写死三步）：① `/` ⇒ `\`；② 去盘符前缀 `^[a-zA-Z]:\DSH\`；③ 全小写
 *  ⇒ 统一成「**反斜杠 + 无盘符 + 全小写**」的相对路径。
 *  @param {string} file 相对或绝对路径（清单 `rel` 形态 = 反斜杠 + 无盘符）
 *  @returns {string} 归一化路径；非字符串 ⇒ 空串（调用方据此判 null） */
export function normalizePath(file) {
  if (typeof file !== 'string') return '';
  let s = file.replace(/\//g, '\\');
  s = s.replace(/^[a-zA-Z]:\\DSH\\/i, '');
  s = s.replace(/^\\+/, '');
  return s.toLowerCase();
}

/** 家族表 `match` 模式 → **锚定正则**（§2.5-2 写死）：
 *  `*` ⇒ `[^\\]*`（不跨目录分隔符）· `<host>` ⇒ `(hosta|hostb)` · `<日期>` ⇒ `\d{4}-\d{2}-\d{2}`
 *  · `<月>` ⇒ `\d{4}-\d{2}` · `<设备>` ⇒ `[^\\]+`；其余字符**按字面**（正则元字符一律转义）。
 *  返回 `^…$` 锚定的 RegExp（大小写不敏感；输入通常已归一化） */
export function familyMatchToRe(match) {
  if (typeof match !== 'string' || match === '') return null;
  let src = match.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); // 先转义元字符（`*` 与 `<>` 故意不转义）
  src = src.replace(/\*/g, '[^\\\\]*');
  src = src.replace(/<日期>/g, '\\d{4}-\\d{2}-\\d{2}');
  src = src.replace(/<月>/g, '\\d{4}-\\d{2}');
  src = src.replace(/<host>/g, '([a-z][a-z0-9-]*)');
  src = src.replace(/<设备>/g, '[^\\\\]+');
  return new RegExp(`^${src}$`, 'i');
}

/** 多族命中裁决（§2.5-3）：**按登记表顺序取第一个命中族**；未命中任何族 ⇒ `null`
 *  （**绝不是"未登记即默认豁免"** —— null ⇒ `isExemptEligible` = false ⇒ 不豁免）
 *  ⚠️ 登记表把 `progress` 排在 `daily` 之前 = §2.5 冲突裁决表 M-6 的落地形态
 *     （`daily` 的 `<日期>-<host>.md` 形态本身不含 `-progress-`，两条口径等价，双保险）。
 *  @param {string} file 清单 `rel` 形态（反斜杠 + 无盘符）或带盘符的绝对路径
 *  @returns {object|null} 家族对象（GENERATED_DOC_FAMILIES 的元素） */
export function findFamily(file) {
  const hits = findFamilies(file);
  return hits.length ? hits[0].family : null;
}

/** 全部命中族（诊断 / 歧义检测用；判定只取 `findFamily()` 的第一个）
 *  @returns {Array<{id:string, family:object, dirLen:number}>} */
export function findFamilies(file) {
  const rel = normalizePath(file);
  if (!rel) return [];
  const base = rel.slice(rel.lastIndexOf('\\') + 1);
  const out = [];
  for (const family of GENERATED_DOC_FAMILIES) {
    const dir = normalizePath(family.dir);
    if (dir !== '' && !rel.startsWith(dir + '\\')) continue; // §2.5-2：dir 必须是归一化路径的目录前缀
    const re = familyMatchToRe(family.match);
    if (re && !re.test(base)) continue;                     // §2.5-2：只看最后一段文件名，不看中间层级
    out.push({ id: family.id, family, dirLen: dir.length });
  }
  return out;
}

/** 豁免资格（M-1 接线点 · §4.2）：**只"有标记"不够，还必须"有资格"**
 *  @param {string} file 清单 `rel` 形态的路径
 *  @returns {boolean} 家族表 `exemptEligible`；未命中族 / 命中 `watch`·`external` ⇒ false */
export function isExemptEligible(file) {
  const fam = findFamily(file);                              // 查 GENERATED_DOC_FAMILIES
  return fam?.exemptEligible === true;                       // 未命中 ⇒ null ⇒ false（= 不豁免）
}

/** 逃生舱总开关（§4.3 · M-5）：env `DSH_CITES_EXEMPT=off`（or 0/false）⇒ 关；常量 false ⇒ 关（取最严） */
export function isExemptEnabled(env = process.env) {
  const v = String(env?.DSH_CITES_EXEMPT ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false;
  return EXEMPT_ENABLED === true;
}

/** 例外白名单支路（§4.3-2）——**v3c 占位骨架 · 本轮不实现**（§6.1 Non-goal 第 8 条）
 *  口径：本轮只实现主路径（生成器写在档头的档级标记）；P4 定案后按 §4.3-2 的白名单口径补实现
 *  （结构 = `generated-docs-whitelist.json` 的 `{ path, reason, expiresAt }`，到期未复核即失效，默认 90 天）。
 *  ⚠️ 检查器侧判据字面已写成 `（isGeneratedDoc(file) || isListedExempt(file)）`（§4.2-1）
 *     ⇒ 若删掉本函数，检查器会 ReferenceError（第三轮残留-b）。**保留占位、恒 false、行为等价。** */
export function isListedExempt() {
  return false; // v3c 占位：白名单支路本轮不实现（§6.1-8）
}

// ---------------------------------------------------------------- 家族登记表（§3.1 全 15 族）

/**
 * 家族登记表（权威源）。字段口径：
 *  · `id`              家族 id（= 档级标记 `family=<id>` 的取值；只供对账，判定只认前缀）
 *  · `dir`             归一化目录前缀（`docs` / `docs\管家报告` …；`docs` 段含子目录）
 *  · `match`           文件名模式（`*` / `<host>` / `<日期>` / `<月>` / `<设备>` 占位符，见 familyMatchToRe）
 *  · `label`           人类标签（对账报告用）
 *  · `generator`       **「路径#符号名」**（§2.5 M-3：**只存路径 + 符号名，不承载行号** —— 行号会无声腐化；
 *                      顶层脚本写 `#(顶层)`；符号名供 R5 轻量自检 grep，不核行号）
 *  · `driftMode`       漂移强度（§3.1 第 4 列）
 *  · `exemptEligible`  **豁免资格**（§3.1 第 5 列 / §3.2 反向锚点）
 *                      ⚠️ **命名空间澄清（§2.5）**：本字段与 `tools\dsh-nurse\lib\nurse-profile-report.mjs`
 *                      中的**同名字段无语义关系**（后者 = 护士档案的豁免资格）；两模块无任何调用关系，
 *                      判定为「C 类不改」。此处改字段名会与方案 §2.5/§3.1 的字面口径脱钩 ⇒ **保持同名 + 注释区分**。
 *  · `sample`          该族样本路径（§2.5-5 构造性断言的输入：形态 = 清单 `rel`，反斜杠 + 无盘符）
 */
export const GENERATED_DOC_FAMILIES = [
  {
    id: 'todo',
    dir: 'docs',
    match: '待你操作-<设备>.md',
    label: 'docs\\待你操作-<设备>.md',
    generator: 'tools\\owner-todo-scan.mjs#(顶层)',
    driftMode: '全量重写',
    exemptEligible: true,
    sample: 'docs\\待你操作-ROG.md',
  },
  {
    id: 'index',
    dir: 'docs',
    match: '文档总索引.md',
    label: 'docs\\文档总索引.md',
    generator: 'tools\\docs-index-gen.mjs#buildIndexContent',
    driftMode: '自动段全量重写',
    exemptEligible: true,
    sample: 'docs\\文档总索引.md',
  },
  {
    // ⚠️ M-6 冲突裁决：`progress` 排在 `daily` 之前（`<日期>-progress-<host>.md` 是独立家族）
    id: 'progress',
    dir: 'docs\\管家报告',
    match: '<日期>-progress-<host>.md',
    label: 'docs\\管家报告\\<日期>-progress-<host>.md',
    generator: 'tools\\dsh-butler\\progress-status.mjs#writeReport',
    driftMode: '全量重写',
    exemptEligible: true,
    sample: 'docs\\管家报告\\2026-09-28-progress-hosta.md',
  },
  {
    // daily 的 `<日期>-<host>.md` 形态**本身不含** `-progress-`（锚定 + host 紧跟）
    // ⇒ 与 §2.5 裁决表的 `daily = (?!-progress-)` 等价，双保险
    id: 'daily',
    dir: 'docs\\管家报告',
    match: '<日期>-<host>.md',
    label: 'docs\\管家报告\\<日期>-<Host>.md',
    generator: 'tools\\dsh-butler-panel\\report.mjs#(顶层)',
    driftMode: '全量重写（历史档只读）',
    exemptEligible: true,
    sample: 'docs\\管家报告\\2026-10-08-HostA.md',
  },
  {
    // §3.2 反向锚点②：登记但**明确不豁免**（纯追加型，已发布行不会移动 ⇒ 不需要豁免）
    id: 'watch',
    dir: 'docs\\管家报告',
    match: 'watch-*.md',
    label: 'docs\\管家报告\\watch-*.md',
    generator: 'tools\\dsh-butler\\lib\\watch-notify.mjs#writeReport',
    driftMode: '纯追加（仅在有事件时写）',
    exemptEligible: false,
    sample: 'docs\\管家报告\\watch-2026-10-08-hosta.md',
  },
  {
    // §3.2 反向锚点②：登记但**明确不豁免**
    id: 'external',
    dir: 'docs\\管家报告',
    match: 'external-*.md',
    label: 'docs\\管家报告\\external-*.md',
    generator: 'tools\\dsh-butler\\butler-external.mjs#writeExternalReport',
    driftMode: '纯追加（按源节流）',
    exemptEligible: false,
    sample: 'docs\\管家报告\\external-2026-10-08-HostA.md',
  },
  {
    id: 'upstream',
    dir: 'docs\\管家报告',
    match: 'upstream-<日期>.md',
    label: 'docs\\管家报告\\upstream-<日期>.md',
    generator: 'tools\\dsh-upstream-watch.mjs#main',
    driftMode: '全量重写',
    exemptEligible: true,
    sample: 'docs\\管家报告\\upstream-2026-10-08.md',
  },
  {
    id: 'shadow48h',
    dir: 'docs\\管家报告',
    match: 'shadow48h-*.md',
    label: 'docs\\管家报告\\shadow48h-*.md',
    generator: 'tools\\dsh-butler\\lib\\shadow-contrast.mjs#renderConclusion',
    driftMode: '一次性产物（生成后不改）',
    exemptEligible: true,
    sample: 'docs\\管家报告\\shadow48h-queue-wake-20260920.md',
  },
  {
    id: 'ledger',
    dir: 'docs\\管家报告',
    match: '会话台账-<日期>.md',
    label: 'docs\\管家报告\\会话台账-<日期>.md',
    generator: 'tools\\dsh-butler\\session-ledger.mjs#writeReportFile',
    driftMode: '全量重写',
    exemptEligible: true,
    sample: 'docs\\管家报告\\会话台账-2026-10-08.md',
  },
  {
    id: 'weekly',
    dir: 'docs\\管家报告',
    match: '周报-*.md',
    label: 'docs\\管家报告\\周报-*.md',
    generator: 'tools\\dsh-butler-panel\\report-weekly.mjs#(顶层)',
    driftMode: '全量重写',
    exemptEligible: true,
    sample: 'docs\\管家报告\\周报-2026-09-21-HostA.md',
  },
  {
    id: 'relaywatch',
    dir: 'docs\\管家报告',
    match: 'relay-handoff-watch-<日期>.md',
    label: 'docs\\管家报告\\relay-handoff-watch-<日期>.md',
    generator: 'tools\\dsh-butler\\lib\\relay-handoff-watch.mjs#renderObserveDoc',
    driftMode: '全量重写（每 1 分钟）',
    exemptEligible: true,
    sample: 'docs\\管家报告\\relay-handoff-watch-2026-10-08.md',
  },
  {
    id: 'patrol',
    dir: 'docs\\管家报告',
    match: 'upgrade-patrol-*.md',
    label: 'docs\\管家报告\\upgrade-patrol-*.md',
    generator: 'tools\\dsh-upgrade-orchestrator.mjs#renderPatrolReport',
    driftMode: '全量重写',
    exemptEligible: true,
    sample: 'docs\\管家报告\\upgrade-patrol-2026-09-17.md',
  },
  {
    id: 'pitfall',
    dir: 'docs',
    match: '踩坑大全-<host>.md',
    label: 'docs\\踩坑大全-<host>.md',
    generator: 'tools\\dsh-butler\\pitfall-tick.mjs#runTick',
    driftMode: '全量重写（每轮）',
    exemptEligible: true,
    sample: 'docs\\踩坑大全-hosta.md',
  },
  {
    // §3.2 反向锚点①：`坑库\` 下的人工档（P4候选分类…/P4待办合并…）**必须排除** ⇒ match 收窄到 host 后缀形态
    id: 'pitlibrary',
    dir: 'docs\\坑库',
    match: '*-<host>.md',
    label: 'docs\\坑库\\*-<host>.md + README-<host>.md',
    generator: 'tools\\dsh-butler\\lib\\pitfall-render.mjs#renderAll',
    driftMode: '段内重写',
    exemptEligible: true,
    sample: 'docs\\坑库\\守护鱼-hosta.md',
  },
  {
    id: 'changelog',
    dir: 'docs\\变更流水',
    match: '<月>.md',
    label: 'docs\\变更流水\\<月>.md',
    generator: 'tools\\dsh-butler\\changelog-add.mjs#renderChangelog',
    driftMode: '段内插入 + 整档重渲染',
    exemptEligible: true,
    sample: 'docs\\变更流水\\2026-10.md',
  },
];

// ---------------------------------------------------------------- 构造性断言辅助（§2.5-5 / §4.5-5）

/** 每族样本 + 三种等价变体（`/` 分隔 · 带盘符 · 带盘符且 `/`）——归一化后必须落同一族 */
export function familySampleVariants(family) {
  const s = family.sample;
  return [s, s.replace(/\\/g, '/'), `X:\\DSH\\${s}`, `x:/DSH/${s.replace(/\\/g, '/')}`];
}

/** 全族样本清单（对账脚本 §4.1-6② / 第 5 类夹具 / 单测共用） */
export function familySamples() {
  return GENERATED_DOC_FAMILIES.map((f) => ({
    id: f.id,
    dir: f.dir,
    match: f.match,
    exemptEligible: f.exemptEligible === true,
    sample: f.sample,
    variants: familySampleVariants(f),
  }));
}

/** 家族表指纹（报告里打印，供跨机 / 跨版本一致性追溯） */
export function familyTableDigest() {
  return GENERATED_DOC_FAMILIES
    .map((f) => `${f.id}|${f.dir}|${f.match}|${f.exemptEligible ? 'Y' : 'N'}`)
    .join('\n');
}
