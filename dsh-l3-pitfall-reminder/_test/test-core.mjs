// dsh-l3-pitfall-reminder / _test/test-core.mjs
//
// 真测试（不是速读）：口径一致性 + result 提取 + 匹配 + 开关语义 + 端到端夹具 home。
// 隔离铁律：所有写路径都落在临时 DSH_HOME 下，**绝不碰生产 home**（只读生产坑库做对照）。
//
// 跑法：node _test\test-core.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { signatureOf, normalizeErrorText } from '../lib/normalize.mjs';
import { extractError, collectText, buildIndex, matchPitfall, renderReminder, createNoticeMessage, hostSlug, prependContext, REMINDER_TEXT_MAX } from '../lib/core.mjs';
import { createRuntime, switchPath, defaultStorePath, defaultLogPath, DEFAULT_SWITCH } from '../lib/store.mjs';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}\n        ${e?.message ?? String(e)}`);
  }
}

const HOME = path.join(os.homedir(), '.dsh');
const PROD_STORE = path.join(HOME, 'butler-pitfalls.json');
const BUTLER_SIGN = process.env.DSH_BUTLER_SIGN
  || path.join(process.env.DSH_ROOT || path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'tools', 'dsh-butler', 'lib', 'pitfall-sign.mjs');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'l3-test-'));

console.log('# dsh-l3-pitfall-reminder core tests');
console.log(`  prod store  = ${PROD_STORE} (read-only)`);
console.log(`  butler sign = ${BUTLER_SIGN} (read-only, 对照基准)`);
console.log(`  temp home   = ${tmpHome}`);

// ------------------------------------------------------- ① 归一化口径一致性（对 dsh-butler 原版）
await testAsync('口径一致性：移植件 vs dsh-butler 原版 —— 生产坑库全部样本逐字节零差异', async () => {
  if (!fs.existsSync(PROD_STORE)) return console.log('        (skip: 生产坑库不存在)');
  const orig = await import(pathToFileURL(BUTLER_SIGN).href);
  const store = JSON.parse(fs.readFileSync(PROD_STORE, 'utf8'));
  let samples = 0;
  const diffs = [];
  for (const p of store.pitfalls ?? []) {
    for (const s of p.samples ?? []) {
      samples++;
      const a = normalizeErrorText(s.text);
      const b = orig.normalizeErrorText(s.text);
      if (a !== b) diffs.push({ id: p.id, a: a.slice(0, 80), b: b.slice(0, 80) });
    }
  }
  assert.ok(samples > 100, `样本太少：${samples}`);
  assert.equal(diffs.length, 0, `口径漂移 ${diffs.length} 处：${JSON.stringify(diffs.slice(0, 2))}`);
  console.log(`        samples=${samples} 零差异`);
});

await testAsync('口径一致性：签名派生规则与 dsh-butler 原版一致（sigKey/id）', async () => {
  if (!fs.existsSync(PROD_STORE)) return;
  const orig = await import(pathToFileURL(BUTLER_SIGN).href);
  const store = JSON.parse(fs.readFileSync(PROD_STORE, 'utf8'));
  let n = 0;
  for (const p of store.pitfalls ?? []) {
    for (const s of (p.samples ?? []).slice(0, 1)) {
      const mine = signatureOf({ name: p.name, code: p.code, text: s.text });
      const theirs = orig.signatureOf({ name: p.name, code: p.code, text: s.text });
      assert.equal(mine.sigKey, theirs.sigKey);
      assert.equal(mine.id, theirs.id);
      n++;
    }
  }
  console.log(`        checked=${n} entries`);
});

test('口径一致性（已知偏差归因）：条目 normText 与样本复算不可逐字节复现的根因 = 样本入库截断 300 字符', async () => {
  if (!fs.existsSync(PROD_STORE)) return;
  const store = JSON.parse(fs.readFileSync(PROD_STORE, 'utf8'));
  let truncated = 0;
  let mismatch = 0;
  for (const p of store.pitfalls ?? []) {
    const ss = p.samples ?? [];
    if (ss.length === 0) continue;
    if (ss.some((s) => String(s.text).length >= 300)) truncated++;
    if (!ss.some((s) => normalizeErrorText(s.text) === p.normText)) mismatch++;
  }
  console.log(`        样本被截到 300 字符的条目=${truncated}；normText 无法由样本复现的条目=${mismatch}（预期 ≥ 后者，归因见交付报告）`);
  assert.ok(truncated > 0, '若无截断样本，说明归因不成立，需重新分析');
});

test('口径一致性：路径/时间/会话 id 归一化（AUDIT_HASH_MISMATCH 样本）', () => {
  const raw = 'Error: AUDIT_HASH_MISMATCH: 待写入内容与审计通过的内容不一致（「X:\\Users\\alice\\.dsh\\x.yml」）。';
  const norm = normalizeErrorText(raw);
  assert.ok(norm.includes('<PATH>'), `路径未归一化：${norm}`);
  assert.ok(!norm.includes('alice'), '用户名残留');
});

// ------------------------------------------------------- ② result 提取（口径 = 扫描侧）
test('collectText：递归收集 + 换行连接（复刻 pitfall-scan）', () => {
  const t = collectText([
    { type: 'tool-result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
  ]);
  assert.equal(t, 'a\nb');
});

test('extractError：成功结果 → null', () => {
  assert.equal(extractError({ isError: false, content: [{ type: 'text', text: 'ok' }] }), null);
  assert.equal(extractError(null), null);
  assert.equal(extractError(undefined), null);
});

test('extractError：name/code 取自 error.info（= 日志投影同源，dsh-agent-loop:707）', () => {
  const e = extractError({
    isError: true,
    content: [{ type: 'text', text: 'Error: boom' }],
    error: { message: 'boom', info: { name: 'FsError', code: 'FS_STALE_VERSION' } },
  });
  assert.equal(e.text, 'Error: boom');
  assert.equal(e.name, 'FsError');
  assert.equal(e.code, 'FS_STALE_VERSION');
});

test('extractError：无 info（非 HarnessError）时 name/code 为空 ⇒ 走 Error|NO_CODE 候选', () => {
  const e = extractError({ isError: true, content: [{ type: 'text', text: 'boom' }], error: { message: 'boom' } });
  assert.equal(e.name, '');
  assert.equal(e.code, '');
});

test('extractError：content 无文本块时回落 error.message', () => {
  const e = extractError({ isError: true, content: [], error: { message: 'fallback msg' } });
  assert.equal(e.text, 'fallback msg');
});

// ------------------------------------------------------- ③ 索引与匹配（fixture 用真实口径生成）
const mk = (text, { category = '其他', count = 5, tools = { pwsh: 5 }, name = '', code = '' } = {}) => {
  const s = signatureOf({ name, code, text });
  return { id: s.id, sigKey: s.sigKey, normText: s.normText, name: s.name, code: s.code, category, count, lastSeen: Date.now(), tools, sessions: ['session-1', 'session-2'] };
};
const P_A = mk('Error: cannot read "X:\\DSH\\fixtures\\alpha.yml": not found', { category: 'pwsh', count: 9, tools: { pwsh: 9 } });
const P_B = mk('Error: 前缀一样但尾部漂移的坑 —— 这是用于前缀桶回退测试的一条足够长的中文错误文本 ABCDEFGHIJKLMN', { category: '插件', count: 3, tools: { edit: 3 } });
const P_C = mk('Error: boom from edit', { category: '插件', count: 4, tools: { edit: 4 }, name: 'FsError', code: 'FS_STALE_VERSION' });
/** 与 P_C 同文本但**无 info** 的版本（模拟扫描侧历史条目 Error|NO_CODE|…）。 */
const P_D = mk('Error: boom from edit', { category: '插件', count: 4, tools: { edit: 4 } });
const fixture = { updatedAt: '2026-01-01T00:00:00.000Z', pitfalls: [P_A, P_B, P_C] };

test('buildIndex：索引数量与跳过口径', () => {
  const ix = buildIndex(fixture);
  assert.equal(ix.size, 3);
  assert.equal(ix.skipped, 0);
  const bad = buildIndex({ pitfalls: [null, {}, { sigKey: 'x' }, ...fixture.pitfalls] });
  assert.equal(bad.size, 3);
  assert.equal(bad.skipped, 3);
});

test('matchPitfall：精确 sigKey 命中（路径不同也算同一坑）', () => {
  const ix = buildIndex(fixture);
  const m = matchPitfall({ name: '', code: '', text: 'Error: cannot read "X:\\Users\\alice\\other.yml": not found' }, ix);
  assert.equal(m.how, 'sigKey');
  assert.equal(m.hit.id, P_A.id);
});

test('matchPitfall：info 齐全时走 sigKey；库中只有「无 info」版本时回退 no-info 候选', () => {
  const ix = buildIndex(fixture);
  const withInfo = matchPitfall({ name: 'FsError', code: 'FS_STALE_VERSION', text: 'Error: boom from edit' }, ix);
  assert.equal(withInfo.how, 'sigKey');
  assert.equal(withInfo.hit.id, P_C.id);

  // 库里只有无 info 版本（扫描侧历史条目多为 Error|NO_CODE|…）⇒ 带 info 的运行时输入要能回退命中
  const onlyNoInfo = buildIndex({ pitfalls: [P_D] });
  const fallback = matchPitfall({ name: 'FsError', code: 'FS_STALE_VERSION', text: 'Error: boom from edit' }, onlyNoInfo);
  assert.equal(fallback.how, 'sigKey-nofinfo');
  assert.equal(fallback.hit.id, P_D.id);

  // 反向：库里只有带 info 版本时，无 info 的输入不该误命中（前缀桶长度不足）
  const noInfoIn = matchPitfall({ name: '', code: '', text: 'Error: boom from edit' }, ix);
  assert.equal(noInfoIn.hit, null);
  assert.equal(noInfoIn.how, null);
});

test('matchPitfall：未命中 → hit=null 且带出签名', () => {
  const ix = buildIndex(fixture);
  const m = matchPitfall({ name: '', code: '', text: 'Error: 完全没见过的东西 zzz qqq 12345' }, ix);
  assert.equal(m.hit, null);
  assert.equal(m.how, null);
  assert.ok(m.sig.sigKey.startsWith('Error|NO_CODE|'));
});

test('matchPitfall：前缀桶回退（尾部漂移仍能命中）', () => {
  const ix = buildIndex(fixture);
  const drifted = `${P_B.normText}-加了个尾巴`;
  const m = matchPitfall({ name: '', code: '', text: drifted }, ix);
  assert.equal(m.how, 'prefix');
  assert.equal(m.hit.id, P_B.id);
});

test('matchPitfall：前缀桶冲突时用 120 字符二级判据消歧', () => {
  const pre = `Error: ${'B'.repeat(50)}`;
  const p3 = mk(`${pre}${'X'.repeat(120)}TAIL-ONE`, { count: 5 });
  const p4 = mk(`${pre}${'Y'.repeat(120)}TAIL-TWO`, { count: 5 });
  const ix = buildIndex({ pitfalls: [p3, p4] });
  const m = matchPitfall({ name: '', code: '', text: `${pre}${'X'.repeat(120)}TAIL-DRIFTED` }, ix);
  assert.equal(m.how, 'prefix-long');
  assert.equal(m.hit.id, p3.id);
});

test('matchPitfall：前 120 字符也冲突 ⇒ 保守不提醒（绝不提醒错的坑）', () => {
  const same = `Error: ${'A'.repeat(200)}`;
  const p1 = mk(`${same}尾巴一`, { count: 5 });
  const p2 = mk(`${same}尾巴二`, { count: 9 });
  const ix = buildIndex({ pitfalls: [p1, p2] });
  const m = matchPitfall({ name: '', code: '', text: `${same}完全不同的结尾` }, ix);
  assert.equal(m.hit, null);
  assert.equal(m.how, null);
});

// ------------------------------------------------------- ④ 渲染与消息
test('renderReminder：含坑 id/主题绝对路径/计数，长度受限，dry-run 有标记', () => {
  const ix = buildIndex(fixture);
  const m = matchPitfall({ name: '', code: '', text: 'Error: cannot read "X:\\DSH\\fixtures\\alpha.yml": not found' }, ix);
  const r = renderReminder(m.hit, m, { tool: 'pwsh', host: 'HOSTA', dryRun: false, pitDir: 'X:\\DSH\\docs\\坑库', pitFileExists: true });
  assert.ok(r.text.includes(`#${P_A.id}`));
  assert.ok(r.text.includes('X:\\DSH\\docs\\坑库\\pwsh-hosta.md'), `必须给绝对路径（相对路径模型按会话工作区解析不到）：${r.text}`);
  assert.ok(r.text.length <= REMINDER_TEXT_MAX);
  assert.ok(r.summary.length <= 120);
  const dr = renderReminder(m.hit, m, { tool: 'pwsh', host: 'HOSTA', dryRun: true, pitDir: 'X:\\DSH\\docs\\坑库', pitFileExists: true });
  assert.ok(dr.text.includes('DRY-RUN'));
});

test('renderReminder：坑库文档不存在时不提路径（免得把模型引到不存在的文件）', () => {
  const ix = buildIndex(fixture);
  const m = matchPitfall({ name: '', code: '', text: 'Error: cannot read "X:\\DSH\\fixtures\\alpha.yml": not found' }, ix);
  const r = renderReminder(m.hit, m, { tool: 'pwsh', host: 'HOSTA', dryRun: false, pitDir: 'Z:\\nope', pitFileExists: false });
  assert.ok(!r.text.includes('.md'), `不该出现路径：${r.text}`);
  assert.ok(r.text.includes('已归档坑'));
});

test('hostSlug：两机映射 + 未知回落', () => {
  assert.equal(hostSlug('HOSTA'), 'hosta');
  assert.equal(hostSlug('HOSTB'), 'hostb');
  assert.equal(hostSlug('OTHER-BOX'), 'other-box');
});

test('createNoticeMessage：role/source/id 齐备且冻结', () => {
  const msg = createNoticeMessage({ text: 'hello', summary: 's' });
  assert.equal(msg.role, 'user');
  assert.equal(msg.source.kind, 'l3-pitfall-reminder');
  assert.equal(msg.source.plugin, undefined, 'v4 producer-owned 形态不再写 plugin 字段');
  assert.equal(msg.source.form, 'notice');
  assert.equal(typeof msg.id, 'string');
  assert.ok(msg.id.length >= 8);
  assert.ok(Object.isFrozen(msg), '消息必须冻结（上游 createMessage 会 deepFreeze）');
});

test('prependContext：本插件消息排在最前', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  assert.deepEqual(prependContext(b, [a]).map((x) => x.id), ['b', 'a']);
  assert.deepEqual(prependContext(b, undefined).map((x) => x.id), ['b']);
});

// ------------------------------------------------------- ⑤ 开关语义（默认关 / dry-run / 端到端）
test('默认开关值 = 关（DEFAULT_SWITCH.enabled === false）', () => {
  assert.equal(DEFAULT_SWITCH.enabled, false);
  assert.equal(DEFAULT_SWITCH.dryRun, false);
});

const errResult = (text) => ({ isError: true, content: [{ type: 'text', text }], error: { message: text } });
const A_TEXT = 'Error: cannot read "X:\\DSH\\fixtures\\alpha.yml": not found';

test('端到端：无开关文件 ⇒ disabled（零动作、不写日志）', () => {
  const home = path.join(tmpHome, 'h1');
  fs.mkdirSync(home, { recursive: true });
  const rt = createRuntime({}, { DSH_HOME: home });
  const d = rt.observe({ name: 'pwsh', agent: {} }, errResult(A_TEXT));
  assert.equal(d.action, 'disabled');
  assert.equal(d.message, null);
  assert.equal(fs.existsSync(defaultLogPath(home)), false, '关着时不该落任何日志');
});

test('端到端：dry-run 命中 ⇒ 不注入但落日志', () => {
  const home = path.join(tmpHome, 'h2');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(defaultStorePath(home), JSON.stringify(fixture), 'utf8');
  fs.writeFileSync(switchPath(home), JSON.stringify({ enabled: true, dryRun: true }), 'utf8');
  const rt = createRuntime({}, { DSH_HOME: home });
  const d = rt.observe({ name: 'pwsh', agent: {} }, errResult(A_TEXT));
  assert.equal(d.action, 'dry-run-hit');
  assert.equal(d.message, null, 'dry-run 绝不能注入');
  const log = fs.readFileSync(defaultLogPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.at(-1).event, 'dry-run-hit');
});

test('端到端：开启 ⇒ 命中投递一次，同坑第二次被去重', () => {
  const home = path.join(tmpHome, 'h3');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(defaultStorePath(home), JSON.stringify(fixture), 'utf8');
  fs.writeFileSync(switchPath(home), JSON.stringify({ enabled: true, dryRun: false, cooldownMs: 0 }), 'utf8');
  const rt = createRuntime({ cooldownMs: 0 }, { DSH_HOME: home });
  const exec = { name: 'pwsh', agent: {} };
  const d1 = rt.observe(exec, errResult(A_TEXT));
  assert.equal(d1.action, 'delivered');
  assert.ok(d1.message, '开启且命中时必须产出消息');
  assert.equal(d1.message.source.kind, 'l3-pitfall-reminder');
  const d2 = rt.observe(exec, errResult(A_TEXT));
  assert.equal(d2.action, 'dup-suppressed');
  assert.equal(d2.message, null);
});

test('端到端：开关热改即时生效（不重启）', () => {
  const home = path.join(tmpHome, 'h4');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(defaultStorePath(home), JSON.stringify(fixture), 'utf8');
  fs.writeFileSync(switchPath(home), JSON.stringify({ enabled: false }), 'utf8');
  const rt = createRuntime({ cooldownMs: 0 }, { DSH_HOME: home });
  const exec = { name: 'pwsh', agent: {} };
  assert.equal(rt.observe(exec, errResult(A_TEXT)).action, 'disabled');
  const later = Date.now() + 1500;
  while (Date.now() < later) { /* 等 mtime 精度，保证热改被识别 */ }
  fs.writeFileSync(switchPath(home), JSON.stringify({ enabled: true, dryRun: false, cooldownMs: 0, note: 'flip' }), 'utf8');
  assert.equal(rt.observe(exec, errResult(A_TEXT)).action, 'delivered', '开关热改后应立即生效');
});

test('端到端：会话配额上限生效', () => {
  const home = path.join(tmpHome, 'h5');
  fs.mkdirSync(home, { recursive: true });
  const many = { updatedAt: null, pitfalls: Array.from({ length: 6 }, (_, i) => mk(`Error: 坑${i} 的独有文本 ${'x'.repeat(i + 1)}`, { count: 5 })) };
  fs.writeFileSync(defaultStorePath(home), JSON.stringify(many), 'utf8');
  fs.writeFileSync(switchPath(home), JSON.stringify({ enabled: true, dryRun: false, cooldownMs: 0, maxPerSession: 2 }), 'utf8');
  const rt = createRuntime({ maxPerSession: 2, cooldownMs: 0 }, { DSH_HOME: home });
  const agent = {};
  assert.equal(rt.observe({ name: 'pwsh', agent }, errResult(many.pitfalls[0].normText)).action, 'delivered');
  assert.equal(rt.observe({ name: 'pwsh', agent }, errResult(many.pitfalls[1].normText)).action, 'delivered');
  assert.equal(rt.observe({ name: 'pwsh', agent }, errResult(many.pitfalls[2].normText)).action, 'quota-suppressed');
});

test('端到端：成功结果不提醒（即使开了且坑库在）', () => {
  const home = path.join(tmpHome, 'h6');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(defaultStorePath(home), JSON.stringify(fixture), 'utf8');
  fs.writeFileSync(switchPath(home), JSON.stringify({ enabled: true, dryRun: false }), 'utf8');
  const rt = createRuntime({}, { DSH_HOME: home });
  const d = rt.observe({ name: 'pwsh', agent: {} }, { isError: false, content: [{ type: 'text', text: A_TEXT }] });
  assert.equal(d.action, 'not-error');
  assert.equal(d.message, null);
});

test('端到端：坑库不可读 ⇒ 降级不提醒（绝不抛错）', () => {
  const home = path.join(tmpHome, 'h7');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(switchPath(home), JSON.stringify({ enabled: true, dryRun: false }), 'utf8');
  const rt = createRuntime({}, { DSH_HOME: home });
  const d = rt.observe({ name: 'pwsh', agent: {} }, errResult(A_TEXT));
  assert.equal(d.action, 'store-unreadable');
  assert.equal(d.message, null);
});

// ------------------------------------------------------- ⑥ 插件导出面
await testAsync('插件导出面：apply 注册 tools/post-execute 且异常不逃逸', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(mod.name, 'l3-pitfall-reminder');
  assert.equal(typeof mod.apply, 'function');
  const registered = [];
  let listener = null;
  const ctx = { on: (evt, fn) => { registered.push(evt); listener = fn; return () => {}; } };
  mod.apply(ctx, {});
  assert.deepEqual(registered, ['tools/post-execute']);
  // 开关关着时：listener 必须原样透传 downstream（零动作）
  const downstream = { kind: 'accept' };
  const out = await listener({ name: 'pwsh', agent: {} }, { isError: true, content: [{ type: 'text', text: A_TEXT }] }, async () => downstream);
  assert.equal(out, downstream, '关闭时必须原样返回 downstream');
});

// ------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);
console.log(`\n# ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
}
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exitCode = failed.length === 0 ? 0 : 1;
