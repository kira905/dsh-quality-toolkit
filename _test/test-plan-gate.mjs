#!/usr/bin/env node
// _test/test-plan-gate.mjs —— 方案过审闸单测
//
// 盯六件事：
//   ① 四态（pass / stale / missing / fail）逐条判得对，且 stale 优先于"立场不独立"；
//   ② 正文归一：改行尾 CRLF↔LF 不算改、加 BOM 不算改、锚点行自身不参与哈希；改一个字就 stale；
//   ③ 幂等：连写 3 次只有 1 行锚点、文件字节不变；换 round / 换 actor 会重写但仍 1 行；
//   ④ 职责分离：independent=no ⇒ 带 --require-independent 判 missing（rc 3）；独立才 pass；
//      不带该标志时两者都 pass（这是「缺省不校验立场」的可执行证据）；
//   ⑤ 并发/权限三态：写后正文被改 ⇒ stale 且不覆盖；--expect-sha 不匹配 ⇒ 不写；只读文件 ⇒ 报错不静默；
//   ⑥ CLI 退出码矩阵 + --help 不落盘 + dry-run 不落盘。
//
// 最后跑三条**变异**（关掉独立校验 / 把幂等改成追加 / 关掉写后回读），每条都必须让指定断言变红 ——
// 否则说明夹具在空转。变异 = 把核心库复制到临时目录做文本替换后动态 import，不碰仓内文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newResults, assertEq, assertTrue, finishSelfTest, rmrf } from '../docs-discipline/lib/common.mjs';
import * as realCore from '../lib/plan-gate-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'dsh-plan-gate.mjs');
const CORE = path.join(ROOT, 'lib', 'plan-gate-core.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gate-test-'));
const res = newResults();

const BASE = '# 方案 · 夹具\n\n导语一行。\n\n## §1 背景\n\n正文一。\n\n## §2 结论\n\n正文二。\n';

function put(dir, name, text) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

const read = (p) => fs.readFileSync(p, 'utf8');

function runCli(args, cwd = TMP) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------------------------------------------------------------------------
//  模块级断言（对真件跑一次；对三个变异件各跑一次）
// ---------------------------------------------------------------------------
function runCoreSuite(api, out, tag) {
  const dir = path.join(TMP, `suite-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  const L = (s) => `${s}`;

  try {
    // ---------- A 正文归一 ----------
    const crlf = BASE.replace(/\n/g, '\r\n');
    const bom = `\uFEFF${BASE}`;
    assertEq(api.bodySha(BASE), api.bodySha(crlf), L('A1 归一：CRLF 与 LF 是同一份正文'), out);
    assertEq(api.bodySha(BASE), api.bodySha(bom), L('A2 归一：加 BOM 不算改正文'), out);
    assertTrue(api.bodySha(BASE) !== api.bodySha(BASE.replace('正文二。', '正文三。')), L('A3 归一：改一个字 sha 就变'), out);

    const sampleLine = api.makeAnchorLine({ kind: 'pass', sha: api.bodyShaShort(BASE), actor: 'r', independent: 'yes' });
    const withAnchor = api.placeAnchor(BASE, sampleLine);
    assertEq(api.bodySha(withAnchor), api.bodySha(BASE), L('A4 归一：锚点行不参与正文哈希（否则写完自己判 stale）'), out);
    assertTrue(withAnchor.includes(sampleLine), L('A5 归一：原文里确实出现了那行锚点'), out);

    // ---------- B 锚点解析（整行匹配）----------
    const inline = '这一行提到 <!-- PLAN-REVIEW:pass round=1 sha=abcdef123456 --> 这种写法，但不是锚点\n';
    assertEq(api.parseAnchor(inline), null, L('B1 整行匹配：行中间提到标记不算锚点'), out);
    const indented = '  <!-- PLAN-REVIEW:pass round=1 sha=abcdef123456 -->  \n';
    assertTrue(api.parseAnchor(indented) !== null, L('B2 整行匹配：前后空白不影响'), out);
    assertEq(api.parseAnchor(indented).attrs.sha, 'abcdef123456', L('B3 属性解析：sha 取得到'), out);
    const two = `${indented}<!-- PLAN-REVIEW:fail round=2 sha=abcdef123456 -->\n`;
    assertEq(api.listAnchors(two).length, 2, L('B4 多锚点都能列出来（写入时收成一行）'), out);
    assertEq(api.parseAnchor(two).kind, 'pass', L('B5 评估只认第一个锚点'), out);

    // ---------- C 四态 ----------
    const noAnchor = put(dir, 'no-anchor.md', BASE);
    assertEq(api.evaluate(noAnchor).state, 'missing', L('C1 四态：档存在但没锚点 ⇒ missing'), out);
    assertEq(api.evaluate(noAnchor).reasons[0].code, 'no-anchor', L('C2 四态：missing 的原因码是 no-anchor'), out);
    const ghost = path.join(dir, 'no-such-file.md');
    assertEq(api.evaluate(ghost).state, 'missing', L('C3 四态：档读不到 ⇒ missing'), out);
    assertEq(api.evaluate(ghost).reasons[0].code, 'unreadable', L('C4 四态：读不到的原因码是 unreadable'), out);

    const passText = api.placeAnchor(BASE, api.makeAnchorLine({ kind: 'pass', round: 2, actor: 'rev-a', independent: 'yes', sha: api.bodyShaShort(BASE) }));
    const passFile = put(dir, 'pass.md', passText);
    const evPass = api.evaluate(passFile);
    assertEq(evPass.state, 'pass', L('C5 四态：pass 锚点 + 正文一致 ⇒ pass'), out);
    assertEq(evPass.ok, true, L('C6 四态：pass 时 ok=true'), out);

    const staleFile = put(dir, 'stale.md', passText.replace('正文一。', '正文一！'));
    const evStale = api.evaluate(staleFile);
    assertEq(evStale.state, 'stale', L('C7 四态：正文改一个字 ⇒ stale'), out);
    assertEq(evStale.reasons[0].code, 'body-changed', L('C8 四态：stale 的原因码是 body-changed'), out);

    const failText = api.placeAnchor(BASE, api.makeAnchorLine({ kind: 'fail', round: 1, actor: 'rev-b', sha: api.bodyShaShort(BASE) }));
    const failFile = put(dir, 'fail.md', failText);
    assertEq(api.evaluate(failFile).state, 'fail', L('C9 四态：fail 锚点 ⇒ fail（哪怕正文没变）'), out);

    const noShaText = api.placeAnchor(BASE, '<!-- PLAN-REVIEW:pass round=1 actor=rev-a independent=yes -->');
    const noShaFile = put(dir, 'no-sha.md', noShaText);
    const evNoSha = api.evaluate(noShaFile);
    assertEq(evNoSha.state, 'stale', L('C10 四态：pass 锚点缺 sha ⇒ stale（判不了就是过期）'), out);
    assertEq(evNoSha.reasons[0].code, 'no-sha', L('C11 四态：缺 sha 的原因码是 no-sha'), out);

    // ---------- D 职责分离 ----------
    const depNo = put(dir, 'dep-no.md', BASE);
    const w1 = api.writeAnchor(depNo, { kind: 'pass', actor: 'the-author', independent: 'no' });
    assertEq(w1.outcome, 'written', L('D1 立场：先写一条 independent=no 的 pass 锚点'), out);
    assertEq(api.evaluate(depNo).state, 'pass', L('D2 立场：不带 requireIndependent ⇒ independent=no 也判 pass（缺省不校验立场）'), out);
    const strictNo = api.evaluate(depNo, { requireIndependent: true });
    assertEq(strictNo.state, 'missing', L('D3 立场：带 requireIndependent ⇒ independent=no 判 missing（不是 pass）'), out);
    assertEq(strictNo.reasons[0].code, 'not-independent', L('D4 立场：原因码是 not-independent'), out);

    const depYes = put(dir, 'dep-yes.md', BASE);
    api.writeAnchor(depYes, { kind: 'pass', actor: 'rev-c', independent: 'yes' });
    assertEq(api.evaluate(depYes, { requireIndependent: true }).state, 'pass', L('D5 立场：independent=yes ⇒ 带 requireIndependent 也 pass'), out);

    const depMissingField = put(dir, 'dep-no-field.md', api.placeAnchor(BASE, `<!-- PLAN-REVIEW:pass round=1 actor=rev-c sha=${api.bodyShaShort(BASE)} -->`));
    assertEq(api.evaluate(depMissingField, { requireIndependent: true }).state, 'missing', L('D6 立场：锚点里没有 independent 字段 ⇒ 带 requireIndependent 判 missing'), out);

    const depStale = put(dir, 'dep-stale.md', BASE);
    api.writeAnchor(depStale, { kind: 'pass', actor: 'the-author', independent: 'no' });
    fs.writeFileSync(depStale, read(depStale).replace('正文二。', '正文二？'), 'utf8');
    const both = api.evaluate(depStale, { requireIndependent: true });
    assertEq(both.state, 'stale', L('D7 立场：正文变了 + 立场不独立 ⇒ 报 stale（正文变化优先，比 missing 更紧急）'), out);
    assertEq(both.reasons[0].code, 'body-changed', L('D8 立场：优先原因码是 body-changed'), out);

    let threw = false;
    try { api.makeAnchorLine({ kind: 'pass', sha: api.bodyShaShort(BASE), independent: 'maybe' }); } catch { threw = true; }
    assertTrue(threw, L('D9 立场：independent 值域写死（maybe 直接抛错，不猜）'), out);

    // ---------- E 幂等 ----------
    const idem = put(dir, 'idem.md', BASE);
    const r1 = api.writeAnchor(idem, { kind: 'pass', round: 2, actor: 'rev-a', independent: 'yes' });
    const firstSha = read(idem);
    const r2 = api.writeAnchor(idem, { kind: 'pass', round: 2, actor: 'rev-a', independent: 'yes' });
    const r3 = api.writeAnchor(idem, { kind: 'pass', round: 2, actor: 'rev-a', independent: 'yes' });
    assertEq([r1.outcome, r1.written], ['written', true], L('E1 幂等：第一次真写'), out);
    assertEq([r2.outcome, r2.written], ['skipped', false], L('E2 幂等：第二次跳过（连写都不写）'), out);
    assertEq([r3.outcome, r3.written], ['skipped', false], L('E3 幂等：第三次跳过'), out);
    assertEq(api.listAnchors(read(idem)).length, 1, L('E4 幂等：连写 3 次仍只有 1 行锚点'), out);
    assertEq(read(idem), firstSha, L('E5 幂等：文件字节一个字都没变'), out);
    assertEq(api.evaluate(idem).state, 'pass', L('E6 幂等：跳过之后仍判 pass'), out);

    const idemRound = put(dir, 'idem-round.md', BASE);
    for (const round of [1, 2, 3]) api.writeAnchor(idemRound, { kind: 'pass', round, actor: 'rev-a', independent: 'yes' });
    assertEq(api.listAnchors(read(idemRound)).length, 1, L('E7 幂等：换 round 连写 3 次仍只有 1 行（旧锚点被摘掉，不是追加）'), out);
    assertTrue(read(idemRound).includes('round=3'), L('E8 幂等：留的是最后一次的 round'), out);

    const idemActor = put(dir, 'idem-actor.md', BASE);
    api.writeAnchor(idemActor, { kind: 'pass', round: 1, actor: 'rev-a', independent: 'yes' });
    const swapActor = api.writeAnchor(idemActor, { kind: 'pass', round: 1, actor: 'rev-b', independent: 'yes' });
    assertEq(swapActor.outcome, 'written', L('E9 幂等：只换 actor ⇒ 重写（凭证换了人）'), out);
    assertEq(api.listAnchors(read(idemActor)).length, 1, L('E10 幂等：重写后仍只有 1 行'), out);

    const flip = put(dir, 'idem-flip.md', BASE);
    api.writeAnchor(flip, { kind: 'fail', actor: 'rev-a' });
    api.writeAnchor(flip, { kind: 'pass', actor: 'rev-a', independent: 'yes' });
    assertEq(api.listAnchors(read(flip)).filter((a) => a.kind === 'pass').length, 1, L('E11 幂等：fail→pass 切换后只剩 1 行 pass 锚点'), out);
    assertEq(api.evaluate(flip).state, 'pass', L('E12 幂等：切换后状态正确'), out);

    // ---------- F 并发 / 权限三态 ----------
    const race = put(dir, 'race-after.md', BASE);
    const shaBeforeRace = api.bodyShaShort(BASE);
    const raceRes = api.writeAnchor(race, {
      kind: 'pass', actor: 'rev-a', independent: 'yes',
      hooks: { afterWrite: ({ file }) => fs.appendFileSync(file, '\n另一个会话补的一句。\n') },
    });
    assertEq(raceRes.outcome, 'stale', L('F1 并发：写后正文被改 ⇒ 判 stale'), out);
    assertEq(raceRes.code, 'body-moved-after-write', L('F2 并发：原因码指向"写后被改"'), out);
    const raceText = read(race);
    assertTrue(raceText.includes('另一个会话补的一句。'), L('F3 并发：不覆盖——对方那段改动还在档里'), out);
    assertEq(api.parseAnchor(raceText).attrs.sha, shaBeforeRace, L('F4 并发：锚点保留写前的 sha（没有偷偷刷成新正文）'), out);
    assertEq(api.evaluate(race).state, 'stale', L('F5 并发：事后 --check 如实判 stale'), out);

    const exp = put(dir, 'expect-sha.md', BASE);
    fs.writeFileSync(exp, BASE.replace('正文二。', '正文二？！'), 'utf8');
    const expRes = api.writeAnchor(exp, { kind: 'pass', actor: 'rev-a', independent: 'yes', expectSha: api.bodyShaShort(BASE) });
    assertEq([expRes.outcome, expRes.code], ['stale', 'expect-sha-mismatch'], L('F6 并发：--expect-sha 不匹配 ⇒ stale'), out);
    assertEq(api.parseAnchor(read(exp)), null, L('F7 并发：CAS 不通过 ⇒ 一个锚点都不写'), out);

    const ro = put(dir, 'readonly.md', BASE);
    let roRes;
    try {
      fs.chmodSync(ro, 0o444);
      roRes = api.writeAnchor(ro, { kind: 'pass', actor: 'rev-a', independent: 'yes' });
    } finally {
      try { fs.chmodSync(ro, 0o666); } catch { /* ignore */ }
    }
    if (roRes.outcome === 'stale' && roRes.code === 'readonly-or-permission') {
      assertTrue(Boolean(roRes.error), L('F8 权限：只读档 ⇒ stale + 把 errno 报出来（不静默）'), out, JSON.stringify(roRes));
      assertEq(read(ro), BASE, L('F9 权限：只读档一个字节都没变'), out);
    } else {
      // 某些文件系统不认只读位（例如容器里以 root 跑）⇒ 如实登记"这条没测到"，不当通过
      assertTrue(false, L('F8 权限：只读档必须判 stale（本机未能制造只读：chmod 未生效）'), out, JSON.stringify(roRes));
    }

    const ghostWrite = path.join(dir, 'ghost.md');
    const gw = api.writeAnchor(ghostWrite, { kind: 'pass', actor: 'rev-a' });
    assertEq([gw.outcome, gw.code], ['missing', 'unreadable'], L('F10 不猜：档不存在 ⇒ missing（不替它建一份新档）'), out);
    assertTrue(!fs.existsSync(ghostWrite), L('F11 不猜：确实没建出文件'), out);

    // ---------- G 锚点落位 ----------
    const place = put(dir, 'place.md', BASE);
    const placed = api.writeAnchor(place, { kind: 'pass', actor: 'rev-a', independent: 'yes' });
    assertEq(placed.position.line, 5, L('G1 落位：插在首个 ## 之前（本夹具 ## §1 原在 L5）'), out);
    assertEq(read(place).split(/\r?\n/)[placed.position.line - 1], placed.line, L('G2 落位：那一行就是锚点'), out);
    assertEq(api.evaluate(place).state, 'pass', L('G3 落位：写完自己 --check 必须 pass（"写完自己判 stale"= 锚点加空行）'), out);
    assertEq(api.listAnchors(read(place)).length, 1, L('G4 落位：档里锚点行数 = 1'), out);

    const noH2 = put(dir, 'no-h2.md', '# 只有一级标题\n\n正文。\n');
    const nh = api.writeAnchor(noH2, { kind: 'pass', actor: 'rev-a', independent: 'yes' });
    assertEq(nh.position.line, 1, L('G5 落位：档里没有 ## ⇒ 放档首'), out);

    const crlfFile = put(dir, 'crlf.md', BASE.replace(/\n/g, '\r\n'));
    api.writeAnchor(crlfFile, { kind: 'pass', actor: 'rev-a', independent: 'yes' });
    const crlfAfter = read(crlfFile);
    assertTrue(!crlfAfter.split('\r\n').join('').includes('\n'), L('G6 落位：CRLF 档写完仍是 CRLF（行尾不被工具改掉）'), out);
    assertTrue(crlfAfter.includes('\r\n'), L('G7 落位：确实是 CRLF'), out);

    const bomFile = put(dir, 'bom.md', `\uFEFF${BASE}`);
    api.writeAnchor(bomFile, { kind: 'pass', actor: 'rev-a', independent: 'yes' });
    assertTrue(read(bomFile).startsWith('\uFEFF'), L('G8 落位：BOM 保留'), out);
    assertEq(api.listAnchors(read(bomFile)).length, 1, L('G9 落位：带 BOM 也只写一行锚点'), out);

    // ---------- H 口径配置 ----------
    const cfgDefault = api.normalizeConfig({});
    assertEq(cfgDefault.marker, 'PLAN-REVIEW', L('H1 配置：缺省标记名'), out);
    assertEq(cfgDefault.requireIndependentDefault, false, L('H2 配置：缺省不要求独立签署'), out);
    assertEq(cfgDefault.defaultIndependent, 'no', L('H3 配置：缺省写 independent=no'), out);
    let badCfg = false;
    try { api.normalizeConfig({ anchor: { placement: 'middle' } }); } catch { badCfg = true; }
    assertTrue(badCfg, L('H4 配置：非法 placement 直接抛错（不静默回退）'), out);

    const customMarker = api.withDefaults({ marker: 'SIGNOFF' });
    const cm = put(dir, 'custom-marker.md', BASE);
    api.writeAnchor(cm, { kind: 'pass', actor: 'rev-a', independent: 'yes', ...customMarker });
    assertTrue(read(cm).includes('<!-- SIGNOFF:pass'), L('H5 配置：自定义标记名生效'), out);
    assertEq(api.evaluate(cm, customMarker).state, 'pass', L('H6 配置：自定义标记名下也能读回来'), out);
    assertEq(api.evaluate(cm).state, 'missing', L('H7 配置：用错标记名 ⇒ 读不到锚点（协议是写死的）'), out);

    const signerCfg = api.withDefaults({ signerMode: 'list', signerAllow: ['review-bot', 'Owner'] });
    const sg = put(dir, 'signer.md', BASE);
    const denied = api.writeAnchor(sg, { kind: 'pass', actor: 'stranger', independent: 'yes', ...signerCfg });
    assertEq([denied.outcome, denied.code], ['denied', 'signer-denied'], L('H8 谁能签：白名单外 ⇒ 拒绝写入'), out);
    assertEq(read(sg), BASE, L('H9 谁能签：拒绝时一个字节都没改'), out);
    const allowed = api.writeAnchor(sg, { kind: 'pass', actor: 'OWNER', independent: 'yes', ...signerCfg });
    assertEq(allowed.outcome, 'written', L('H10 谁能签：白名单内（大小写不敏感）⇒ 写成功'), out);

    const shortCfg = api.withDefaults({ shaPrefixLength: 8 });
    const sc = put(dir, 'short-sha.md', BASE);
    api.writeAnchor(sc, { kind: 'pass', actor: 'rev-a', independent: 'yes', ...shortCfg });
    assertEq(api.parseAnchor(read(sc), shortCfg).attrs.sha.length, 8, L('H11 配置：shaPrefixLength=8 ⇒ 锚点里是 8 位'), out);

    // ---------- I 其它边界 ----------
    const sanitized = api.sanitizeToken('a b>c=d--e', 'fallback');
    assertEq(sanitized, 'a-b-c-d-e', L('I1 净化：空白 / > / = / 连续 - 都被替换掉（不破坏锚点解析）'), out);
    assertEq(api.sanitizeToken('   ', 'fallback'), 'fallback', L('I2 净化：空值回落 fallback'), out);
    assertEq(api.classifyWriteError({ code: 'EPERM' }), 'readonly-or-permission', L('I3 写失败归类：EPERM ⇒ 权限'), out);
    assertEq(api.classifyWriteError({ code: 'ENOSPC' }), 'write-failed', L('I4 写失败归类：不认识的 errno ⇒ write-failed（不猜）'), out);
  } catch (e) {
    assertTrue(false, `整套崩溃（${tag}）：${e.message}`, out, e.stack ?? '');
  }
}

// ---------------------------------------------------------------------------
//  CLI 断言（只对真件跑）
// ---------------------------------------------------------------------------
function runCliSuite(out) {
  const dir = path.join(TMP, 'cli');
  fs.mkdirSync(dir, { recursive: true });
  const base = BASE;
  const passFile = put(dir, 'pass.md', base);
  runCli(['--pass', '--file', passFile, '--actor', 'rev-cli', '--independent', 'yes', '--round', '2', '--apply']);
  const staleFile = put(dir, 'stale.md', read(passFile).replace('正文一。', '正文一！'));
  const missingFile = put(dir, 'missing.md', base);
  const failFile = put(dir, 'fail.md', base);
  runCli(['--fail', '--file', failFile, '--actor', 'rev-cli', '--apply']);

  const c1 = runCli(['--check', '--file', passFile]);
  assertEq(c1.status, 0, 'J1 CLI：--check 判 pass ⇒ rc 0', out);
  assertTrue(c1.stdout.includes('✅ pass'), 'J2 CLI：pass 打勾', out, c1.stdout);
  const c2 = runCli(['--check', '--file', staleFile]);
  assertEq(c2.status, 1, 'J3 CLI：--check 判 stale ⇒ rc 1', out);
  assertTrue(c2.stdout.includes('🟠 stale'), 'J4 CLI：stale 打对标签', out, c2.stdout);
  const c3 = runCli(['--check', '--file', missingFile]);
  assertEq(c3.status, 3, 'J5 CLI：--check 判 missing ⇒ rc 3', out);
  const c4 = runCli(['--check', '--file', failFile]);
  assertEq(c4.status, 4, 'J6 CLI：--check 判 fail ⇒ rc 4', out);

  const c5 = runCli(['--check']);
  assertEq(c5.status, 2, 'J7 CLI：缺 --file ⇒ rc 2（用法错）', out);
  const c6 = runCli(['--check', '--file', passFile, '--no-such-flag']);
  assertEq(c6.status, 2, 'J8 CLI：未知参数 ⇒ rc 2', out);

  const helpBefore = read(passFile);
  const c7 = runCli(['--help']);
  assertEq(c7.status, 0, 'J9 CLI：--help ⇒ rc 0', out);
  assertTrue(c7.stdout.includes('缺省不校验立场'), 'J10 CLI：--help 里写清「缺省不校验立场」', out, c7.stdout.slice(0, 200));
  assertEq(read(passFile), helpBefore, 'J11 CLI：--help 一行都不写（不执行动作）', out);

  const dryBefore = read(missingFile);
  const dry = runCli(['--pass', '--file', missingFile, '--actor', 'rev-cli', '--independent', 'yes']);
  assertEq(dry.status, 0, 'J12 CLI：dry-run rc 0', out);
  assertTrue(dry.stdout.includes('[dry-run]'), 'J13 CLI：dry-run 明确标出来', out, dry.stdout);
  assertEq(read(missingFile), dryBefore, 'J14 CLI：dry-run 不落盘', out);
  const applied = runCli(['--pass', '--file', missingFile, '--actor', 'rev-cli', '--independent', 'yes', '--apply']);
  assertEq(applied.status, 0, 'J15 CLI：--apply rc 0', out);
  assertTrue(read(missingFile).includes('actor=rev-cli'), 'J16 CLI：--actor 写进锚点', out, read(missingFile));
  const afterApply = runCli(['--check', '--file', missingFile]);
  assertEq(afterApply.status, 0, 'J17 CLI：写完自己 --check 判 pass', out);

  const noIndep = put(dir, 'no-indep.md', base);
  runCli(['--pass', '--file', noIndep, '--actor', 'the-author', '--independent', 'no', '--apply']);
  assertEq(runCli(['--check', '--file', noIndep]).status, 0, 'J18 CLI：不带 --require-independent ⇒ independent=no 也 rc 0', out);
  assertEq(runCli(['--check', '--file', noIndep, '--require-independent']).status, 3, 'J19 CLI：带 --require-independent ⇒ rc 3', out);

  const json = runCli(['--check', '--file', passFile, '--json']);
  let payload = null;
  try { payload = JSON.parse(json.stdout); } catch { payload = null; }
  assertTrue(payload !== null, 'J20 CLI：--json 输出是合法 JSON', out, json.stdout.slice(0, 120));
  if (payload) {
    assertEq(payload.state, 'pass', 'J21 CLI：--json 里 state=pass', out);
    assertEq(payload.requireIndependent, false, 'J22 CLI：--json 里如实写「本次没要求独立签署」', out);
    assertTrue(Array.isArray(payload.reasons) && payload.reasons.length > 0, 'J23 CLI：--json 带 reasons', out);
  }

  const raceFile = put(dir, 'race.md', base);
  const seen = runCli(['--check', '--file', raceFile, '--json']);
  const seenSha = JSON.parse(seen.stdout).currentShaShort;
  fs.writeFileSync(raceFile, base.replace('正文二。', '正文二？？'), 'utf8');
  const race = runCli(['--pass', '--file', raceFile, '--actor', 'rev-cli', '--expect-sha', seenSha, '--apply']);
  assertEq(race.status, 1, 'J24 CLI：--expect-sha 不匹配 ⇒ rc 1', out);
  assertTrue(race.stderr.includes('expect-sha-mismatch'), 'J25 CLI：并把原因码打出来', out, race.stderr);
  assertEq(read(raceFile), base.replace('正文二。', '正文二？？'), 'J26 CLI：CAS 不通过 ⇒ 档一个字节没改', out);

  const cfgFile = put(dir, 'cfg-signer.json', JSON.stringify({
    signer: { mode: 'list', allowed: ['review-bot'], denyEmpty: true },
  }, null, 2));
  const deniedFile = put(dir, 'cfg-denied.md', base);
  const denied = runCli(['--pass', '--file', deniedFile, '--actor', 'stranger', '--config', cfgFile, '--apply']);
  assertEq(denied.status, 4, 'J27 CLI：actor 不在白名单 ⇒ rc 4（策略拒绝）', out);
  assertEq(read(deniedFile), base, 'J28 CLI：策略拒绝时档没被改', out);

  const badRound = runCli(['--pass', '--file', deniedFile, '--round', 'abc']);
  assertEq(badRound.status, 2, 'J29 CLI：--round 非数字 ⇒ rc 2', out);
}

runCoreSuite(realCore, res, 'real');
runCliSuite(res);

// ---------------------------------------------------------------------------
//  变异测试：三条变异各自必须让指定断言变红
// ---------------------------------------------------------------------------
const MUTANTS = [
  {
    name: 'no-independent-check',
    // 把「要求独立时判 missing」这道校验整条关掉
    replace: [["if (requireIndependent && ind !== 'yes') {", 'if (false) {']],
    expect: 'D3 立场：带 requireIndependent ⇒ independent=no 判 missing（不是 pass）',
  },
  {
    name: 'append-anchor',
    // 把「先摘旧锚点」改成「直接在原文里插」⇒ 幂等变成追加
    replace: [['const body = normalizeBody(raw, opts);', "const body = String(raw).replace(/^\\uFEFF/, '');"]],
    expect: 'E7 幂等：换 round 连写 3 次仍只有 1 行（旧锚点被摘掉，不是追加）',
  },
  {
    name: 'skip-readback',
    // 把「写后回读比对正文 sha」与「写完自检」两道门一起关掉
    replace: [
      ['if (backSha !== plan.beforeSha) {', 'if (false) {'],
      ['if (self.state !== expected) {', 'if (false) {'],
    ],
    expect: 'F1 并发：写后正文被改 ⇒ 判 stale',
  },
];

const coreSrc = fs.readFileSync(CORE, 'utf8');
for (const m of MUTANTS) {
  let mutated = coreSrc;
  let missing = null;
  for (const [from, to] of m.replace) {
    if (!mutated.includes(from)) { missing = from; break; }
    mutated = mutated.split(from).join(to);
  }
  if (missing) {
    assertTrue(false, `变异 ${m.name}：核心库里找不到要替换的锚点「${missing}」（夹具已失效，必须修）`, res);
    continue;
  }
  const mutantPath = path.join(TMP, `mutant-${m.name}.mjs`);
  fs.writeFileSync(mutantPath, mutated, 'utf8');
  const mutantRes = newResults();
  const api = await import(pathToFileURL(mutantPath).href);
  runCoreSuite(api, mutantRes, m.name);
  const redLabels = mutantRes.filter((r) => !r.ok).map((r) => r.label);
  // 想留证就把变异件跑出的红行打出来（正常跑不刷屏）
  if (process.env.PLAN_GATE_MUTANT_LOG === '1') {
    for (const r of mutantRes.filter((x) => !x.ok)) {
      console.log(`  [${m.name}] FAIL  ${r.label}${r.detail ? `   ← ${r.detail}` : ''}`);
    }
  }
  assertTrue(redLabels.includes(m.expect), `变异 ${m.name}：夹具变红（命中「${m.expect}」）`, res,
    `实际红 ${redLabels.length} 条：${redLabels.slice(0, 6).join(' | ') || '(一条都没红 ⇒ 夹具空转)'}`);
}

rmrf(TMP);
finishSelfTest('test-plan-gate', res);
