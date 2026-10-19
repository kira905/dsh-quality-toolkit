#!/usr/bin/env node
// docs-consistency-scan.mjs —— 长文档「一致性四扫」（方案冻结前的机器自检）
//
// 由来：2026-09-20 会话接力方案经过"审核 → 复评 → 三次窄口径复核"四轮，仍反复暴露
//   「跨节引用死链 / 字段用了却没定义处 / 阈值互相推 / 机制没进任何清单」这类**跨节交叉缺陷**。
//   整体重审的结论是：窄口径复核天然看不到交叉面，而每轮回修又会引入 2~5 条新的
//   ⇒ 文档层的正确收敛方式是「一次性回修 + 机器四扫 + 抽样人工核」，而不是继续人肉逐条核。
//   本工具就是那"四扫"的固化实现：把只能靠人眼扫的交叉面变成一条命令。
//
// 用法：
//   node docs-consistency-scan.mjs <doc.md> [--json] [--quiet]
//   node docs-consistency-scan.mjs <doc.md> --defs 4.4,5,8 --lists 5,8,12
//   node docs-consistency-scan.mjs <doc.md> --ignore-own-headings
//   node docs-consistency-scan.mjs <doc.md> --allow-doc-prefix <N>
// 退出码：0 = 四扫零命中 / 3 = 有命中（**供人工诊断，不得当门**）/ 2 = 用法错 / 1 = 读文件失败
//
// 档位（家规《审核与回修文档纪律》第 9 条① · 2026-09-24 落地② 接线）：**恒 `report`（只报不拦）**
//   —— 见下方 DOC_SCAN_MODE 常量；本脚本**不设**任何升级到 `enforce` / 硬拦的路径。
// 两个容差开关（2026-09-24 落地② 新增 · **只放宽、不更严**）：
//   `--ignore-own-headings`   节标题行自指引用（结构性命中）不计入 ①
//   `--allow-doc-prefix <N>`  未写档名的跨档引用按**前 N 处**容差（阈值显式给；默认 0 = 不豁免）
//
// 口径说明（重要）：本工具的命中是**候选清单，不是结论**——②③④ 三扫带启发式，
//   需人工抽样确认；① 是确定性判据（节号是否存在）。
import fs from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────
// 档位（家规《审核与回修文档纪律》第 9 条① · 2026-09-24 落地② 接线）：**恒 `report`（只报不拦）**。
//   · 显式常量 = 全脚本唯一档位来源；**不设**任何升级到 `enforce` / 硬拦的路径。
//   · 本脚本只读文件 + 只打印：**不得**阻断任何写入、**不得**回滚任何文件。
//   · 末尾 `process.exitCode = hits > 0 ? 3 : 0` 保留（3 = 有命中，供人工诊断）；
//     **接线处不得据它拦写入**（第 9 条① + 细则①「脚本不得比本条更严」）。
// ─────────────────────────────────────────────────────────────────────────────
export const DOC_SCAN_MODE = 'report';

function parseArgs(argv) {
  const o = {
    doc: null, json: false, quiet: false,
    defs: ['4.4', '5', '5.1', '8'], lists: ['5', '5.1', '8', '12', '13.2'],
    ignoreOwnHeadings: false, allowDocPrefix: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--ignore-own-headings') o.ignoreOwnHeadings = true;
    else if (a === '--allow-doc-prefix') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        return { error: `--allow-doc-prefix 需要 ≥0 的整数（收到：${raw === undefined ? '缺值' : raw}）` };
      }
      o.allowDocPrefix = n;
    }
    else if (a === '--defs') o.defs = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--lists') o.lists = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (!o.doc) o.doc = a;
    else return { error: `unknown arg: ${a}` };
  }
  if (!o.doc) return { error: 'missing <doc.md>' };
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  process.stderr.write(`✗ ${args.error}\nusage: node docs-consistency-scan.mjs <doc.md> [--json] [--defs a,b] [--lists a,b] [--ignore-own-headings] [--allow-doc-prefix N]\n`);
  process.exitCode = 2;
} else {
  const text = fs.readFileSync(args.doc, 'utf8');
  const lines = text.split(/\r?\n/);

  // ---------- 章节解析 ----------
  // 两种体例都认（2026-09-24 落地② 修：原先只认裸序号 ⇒ 家规 / 方案档惯用的 `§N` 标题
  //   一律解析不到，节号集合为空 ⇒ 跨节引用被整片误判成死链）：
  //   ① 裸序号标题  `## 4.1 标题` / `### 7.4 标题`
  //   ② § 前缀标题 `## §4 标题` / `#### §7.4.1 标题`
  const SEC_HEAD_RE = /^#{1,6}\s+§?\s*(\d+(?:\.\d+)*)(?:[.、\s]|$)/;
  const secs = [];
  lines.forEach((l, i) => {
    const m = l.match(SEC_HEAD_RE);
    if (m) secs.push({ num: m[1], title: l.replace(/^#+\s*/, '').slice(0, 60), line: i + 1 });
  });
  secs.forEach((s, k) => { s.end = k + 1 < secs.length ? secs[k + 1].line - 1 : lines.length; });
  const hasSection = (num) => secs.some((s) => s.num === num);
  const inSec = (lineNo, nums) => secs.some((s) => nums.includes(s.num) && lineNo >= s.line && lineNo <= s.end);
  const secRange = (num) => secs.find((s) => s.num === num);

  const out = { doc: args.doc, lines: lines.length, bytes: Buffer.byteLength(text, 'utf8'), sections: secs.length, r1: [], r1b: [], r1c: [], r1d: [], r2: [], r3: [], r4: [] };

  // ---------- 扫描① 跨节引用有效性（确定性） ----------
  const refRe = /§\s*(\d+(?:\.\d+)*)/g;
  const crossDocWords = ['报告', '审核报告', '复评报告', '启动包', '交接包', '规程'];
  lines.forEach((l, i) => {
    const isHeading = /^#{1,6}\s/.test(l);
    for (const m of l.matchAll(refRe)) {
      const ref = m[1];
      if (hasSection(ref) || secs.some((s) => s.num.startsWith(ref + '.'))) continue;
      const before = l.slice(Math.max(0, (m.index ?? 0) - 18), m.index ?? 0);
      const cross = crossDocWords.some((w) => before.includes(w));
      const rec = { ref, line: i + 1, text: l.trim().slice(0, 110) };
      // 口径：**带文档前缀的跨文档引用是合法的**（如"复评报告 §12.5"）⇒ 只作信息项（r1b），不计命中；
      //       只有"既不是本文档的节、又没写清是哪份文档"的引用才算死引用（命中 r1）。
      if (cross) { out.r1b.push(rec); continue; }
      // 容差②（`--ignore-own-headings` · 2026-09-24 落地②）：**节标题行**里的引用是结构性自指
      //   （标题在指"本节"）⇒ 开开关时改记 r1c、不计命中；默认关（= 旧行为，不更严也不更松）。
      if (args.ignoreOwnHeadings && isHeading) { out.r1c.push(rec); continue; }
      out.r1.push(rec);
    }
  });
  // 容差①（`--allow-doc-prefix <N>` · 2026-09-24 落地②）："该写档名而没写"的跨档引用按**前 N 处**放行
  //   （阈值显式给；语义 = 报数精度容差，不是把判据废掉 —— 第 N+1 处起照旧命中）。
  if (args.allowDocPrefix > 0 && out.r1.length) out.r1d.push(...out.r1.splice(0, args.allowDocPrefix));

  // ---------- 扫描② 字段/键定义处比对 ----------
  const idRe = /^[A-Za-z_][A-Za-z0-9_.\-{}\[\]()]*$/;
  const EXT_RE = /\.(mjs|cjs|js|json|ps1|psm1|yml|yaml|md|db|ts|cmd|bat|log|zstd)$/i;
  const API_RE = /^(session|workspace|ctx|fs|os|path|process|butler|git)\.[a-zA-Z]/;
  const ENUM_IGNORE = new Set(['read-only', 'workspace-write', 'danger-full-access', 'ask', 'steer', 'queue', 'auto', 'manual', 'cron']);
  // 归一化：`pendingHandoff{sourceSessionId, step}` 与 `pendingHandoff` 指同一个键 ⇒ 必须归一，
  // 否则"定义处写带参形式、使用处写裸名"会被误报成"用了但没定义"。
  const norm = (t) => t.replace(/\{[^}]*\}/g, '').replace(/\(\s*\)$/, '').trim();
  const shapeOf = (t) => {
    if (EXT_RE.test(t)) return 'file';
    if (API_RE.test(t)) return 'api';
    if (t.includes('(')) return 'call';
    if (t.includes('.')) return 'nested';
    if (ENUM_IGNORE.has(t)) return 'enum';
    if (t.includes('-')) return 'hyphen';
    if (/[A-Z]/.test(t)) return 'camel';
    return 'plain';
  };
  // 只把 nested / camel / hyphen 视为"应进定义区"的候选（file/api/call/enum/plain 不进②，file 由④或人工管）
  const tokens = new Map();   // token -> {total:[lines], def:[lines]}
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/`([^`\n]{2,60})`/g)) {
      const raw = m[1].trim();
      // v10 修复（审4 · V9-18）：准入判据改为「raw 或归一化 token 任一匹配」——
      //   带参写法（`llmText({system, user, maxTokens})` / `pendingHandoff{...}`）含空格与逗号，
      //   只按 raw 判会被整条 continue 掉、归一化形同虚设 ⇒ 扫描②对 §5.1「新增物清单」零鉴别力。
      const t = norm(raw);
      if (!idRe.test(raw) && !idRe.test(t)) continue;
      if (!t || !idRe.test(t)) continue;
      const shape = shapeOf(t);
      if (!['nested', 'camel', 'hyphen'].includes(shape)) continue;
      if (!tokens.has(t)) tokens.set(t, { total: [], def: [], shape });
      const rec = tokens.get(t);
      rec.total.push(i + 1);
      if (inSec(i + 1, args.defs)) rec.def.push(i + 1);
    }
  });
  for (const [t, rec] of tokens) {
    if (rec.total.length >= 2 && rec.def.length === 0) {
      out.r2.push({ token: t, shape: rec.shape, uses: rec.total.length, firstLines: rec.total.slice(0, 5) });
    }
  }
  out.r2.sort((a, b) => b.uses - a.uses);

  // ---------- 扫描③ 阈值一致性（时序 + 同词多值） ----------
  const numRe = /(\d+(?:\.\d+)?)\s*(K|B|MB|GB|毫秒|ms|秒|分钟|小时|天|个|次|条|档|个会话|%)/g;
  const buckets = new Map();   // 关键词 -> Map(值 -> [行])
  lines.forEach((l, i) => {
    for (const m of l.matchAll(numRe)) {
      const val = `${m[1]}${m[2]}`;
      const ctx = l.replace(/[`*|]/g, '').trim();
      const kw = (ctx.match(/[\u4e00-\u9fa5]{2,6}(?=（|\(|:|\s|，|,|。|$)/g) ?? []).slice(0, 2).join('/') || '(无关键词)';
      if (!buckets.has(kw)) buckets.set(kw, new Map());
      const b = buckets.get(kw);
      if (!b.has(val)) b.set(val, []);
      b.get(val).push(i + 1);
    }
  });
  for (const [kw, m] of buckets) {
    if (m.size >= 2) {
      const vals = [...m.entries()].map(([v, ls]) => `${v}(行 ${ls.slice(0, 4).join(',')})`);
      out.r3.push({ keyword: kw, values: vals });
    }
  }
  out.r3.sort((a, b) => b.values.length - a.values.length);

  // ---------- 扫描④ 清单覆盖（机制名是否进清单） ----------
  const mech = new Map();   // token -> {body:[lines], list:[lines]}
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/`([^`\n]{3,60})`/g)) {
      const raw = m[1].trim();
      if (!idRe.test(raw)) continue;
      const t = norm(raw);
      if (!t || !idRe.test(t) || t.length < 3) continue;
      if (!mech.has(t)) mech.set(t, { body: [], list: [] });
      const rec = mech.get(t);
      if (inSec(i + 1, args.lists)) rec.list.push(i + 1);
      else rec.body.push(i + 1);
    }
  });
  for (const [t, rec] of mech) {
    if (rec.body.length >= 3 && rec.list.length === 0) {
      out.r4.push({ token: t, bodyUses: rec.body.length, firstLines: rec.body.slice(0, 5) });
    }
  }
  out.r4.sort((a, b) => b.bodyUses - a.bodyUses);

  // ---------- 输出 ----------
  const hits = out.r1.length + out.r2.length + out.r3.length + out.r4.length;
  if (args.json) {
    process.stdout.write(JSON.stringify({ ...out, hits }, null, 2) + '\n');
  } else {
    process.stdout.write(`=== 文档一致性四扫（只读）===\n`);
    process.stdout.write(`文档: ${args.doc}\n行/字节: ${out.lines} / ${out.bytes} · 解析到节 ${out.sections} 个\n`);
    process.stdout.write(`定义区(--defs): ${args.defs.join(',')} · 清单区(--lists): ${args.lists.join(',')}\n\n`);
    if (!args.quiet) {
      process.stdout.write(`【扫描① 跨节引用有效性】命中 ${out.r1.length} 处（确定性判据；另有 ${out.r1b.length} 处**带文档前缀的跨文档引用**，合法、不计命中）\n`);
      if (out.r1c.length) process.stdout.write(`  （--ignore-own-headings：${out.r1c.length} 处节标题行自指引用按容差跳过）\n`);
      if (out.r1d.length) process.stdout.write(`  （--allow-doc-prefix ${args.allowDocPrefix}：${out.r1d.length} 处未写档名的跨档引用按容差跳过）\n`);
      for (const h of out.r1) process.stdout.write(`  §${h.ref}  行 ${h.line}  ⚠ 既非本文档节号、也未写明哪份文档 ⇒ 建议加前缀\n      ${h.text}\n`);
      process.stdout.write(`\n【扫描② 字段/键定义处比对】命中 ${out.r2.length} 个 token（启发式，需抽样核）\n`);
      for (const h of out.r2.slice(0, 25)) process.stdout.write(`  ${h.token}  用了 ${h.uses} 次，定义区 0 次（行 ${h.firstLines.join(',')}）\n`);
      if (out.r2.length > 25) process.stdout.write(`  … 另有 ${out.r2.length - 25} 个\n`);
      process.stdout.write(`\n【扫描③ 阈值一致性】命中 ${out.r3.length} 组同关键词多值（启发式，需人工核）\n`);
      for (const h of out.r3.slice(0, 20)) process.stdout.write(`  「${h.keyword}」→ ${h.values.join(' | ')}\n`);
      if (out.r3.length > 20) process.stdout.write(`  … 另有 ${out.r3.length - 20} 组\n`);
      process.stdout.write(`\n【扫描④ 清单覆盖】命中 ${out.r4.length} 个 token（正文频繁出现但没进任何清单）\n`);
      for (const h of out.r4.slice(0, 25)) process.stdout.write(`  ${h.token}  正文 ${h.bodyUses} 次（行 ${h.firstLines.join(',')}），清单区 0 次\n`);
      if (out.r4.length > 25) process.stdout.write(`  … 另有 ${out.r4.length - 25} 个\n`);
    }
    process.stdout.write(`\n[汇总] 四扫命中合计 ${hits} 条候选：①${out.r1.length} ②${out.r2.length} ③${out.r3.length} ④${out.r4.length}\n`);
    process.stdout.write(`[口径] ①为确定性判据；②③④为启发式候选清单，须人工抽样确认后才算缺陷\n`);
  }
  // ⚠️ 档位恒 `report`（见顶部 DOC_SCAN_MODE）：本行**只供人工诊断**（3 = 有命中），
  //    接线处**不得**据它阻断写入 / 回滚文件（家规第 9 条①）。
  process.exitCode = hits > 0 ? 3 : 0;
}
