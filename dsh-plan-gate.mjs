#!/usr/bin/env node
// dsh-plan-gate —— 方案过审闸（机器凭证 · 零联网 · 只碰一个文件）
//
// 解决什么：「方案没过审就建卡」以前只能靠人自觉。本命令把「这份方案过了审、而且过审之后
// 正文没被改过」变成一次可复跑的读数（正文字节 sha + 四态 + 一条幂等锚点）。
//
// 四态（--check 只读）：
//   pass    有 pass 锚点，且锚点里的 sha 与当前正文一致                     → rc 0
//   stale   有 pass 锚点，但正文变了（锚点里没 sha 也算）                  → rc 1
//   missing 档读不到 / 没有锚点 / （要求独立签署时）签署方不独立           → rc 3
//   fail    有 fail 锚点（审核没过 ⇒ 同样不能建卡）                        → rc 4
//
// 两个动作（--pass / --fail）：**缺省 dry-run**，只打印"会写哪一行、落在第几行"；
// 加 --apply 才落盘。写完立刻回读自检（pass 必须判 pass）。
//
// 职责分离（本命令与"老式过审闸"的区别就在这一条）：
//   锚点里带 `actor=`（谁签的，人/角色）与 `independent=yes|no`（签署方是否独立于作者）。
//   `--check --require-independent` 在"有 pass 锚点但 independent≠yes"时判 **missing**（rc 3），
//   **不是 pass**。⚠️ **缺省不校验立场**：不带 --require-independent 时，作者自己签的也判 pass ——
//   那时 pass 只代表"有人签过"，不代表"签署方独立于作者"。
//
// 并发/权限：写前比对正文 sha（可带 --expect-sha 用外部快照做 CAS），写后回读比对锚点行与正文 sha；
//   写失败 / 文件只读 / 两个会话同时写 ⇒ 判 stale（rc 1）并**不覆盖**，把原因如实打出来。
//
// 退出码：
//   --check  0 = pass · 1 = stale · 2 = 用法错 · 3 = missing · 4 = fail
//   --pass / --fail
//            0 = 已写入 / 幂等跳过 / dry-run 打印完毕 · 1 = stale（并发冲突 / 写失败，未覆盖）
//            2 = 用法错 · 3 = 档读不到（不建锚点） · 4 = 策略拒绝（actor 不在白名单 / independent 值域非法）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliGuard, parseArgs } from './lib/cli-args.mjs';
import {
  STATE, planWrite, evaluate, writeAnchor, loadGateConfig, normalizeConfig,
} from './lib/plan-gate-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, 'config', 'plan-gate.json');

const EXIT = Object.freeze({ OK: 0, STALE: 1, USAGE: 2, MISSING: 3, FAIL: 4 });

const SPEC = {
  cmd: 'dsh-plan-gate',
  summary: '方案过审闸：给方案档算正文字节 sha，判四态（pass / stale / missing / fail），并可写一条幂等锚点。',
  usage: 'dsh-plan-gate (--check | --pass | --fail) --file <方案档> [选项]',
  flags: [
    { name: '--file', alias: ['-f'], arg: 'file', desc: '方案档路径（必填）' },
    { name: '--check', desc: '只读评估四态（pass / stale / missing / fail），不写任何文件' },
    { name: '--pass', desc: '写 pass 锚点（**缺省 dry-run**，加 --apply 才落盘）' },
    { name: '--fail', desc: '写 fail 锚点（同上）' },
    { name: '--require-independent', desc: '--check 时要求 independent=yes；不满足判 missing（rc 3）。带此标志会改变判定' },
    { name: '--round', arg: 'N', desc: '审核轮次（正整数，缺省取配置 cli.defaultRound）' },
    { name: '--actor', arg: 'who', desc: '谁签的（人名或角色名；缺省 unspecified）' },
    { name: '--independent', arg: 'yes|no', desc: '签署方是否独立于作者（缺省取配置，出厂 no）' },
    { name: '--apply', desc: '真写盘。不给就是 dry-run：只打印"会写哪一行 / 落在哪"' },
    { name: '--expect-sha', arg: 'hex', desc: 'CAS：只在与这个正文 sha 前缀一致时才写（两个会话同写的保护）' },
    { name: '--config', arg: 'file', desc: '口径配置（缺省本仓 config/plan-gate.json）' },
    { name: '--json', desc: '以 JSON 输出（check 的状态对象 / 写入的计划或结果）' },
  ],
  writes: '只有 --pass|--fail **且** 带 --apply 时才写：只改那一个方案档的档头（写一行锚点，摘掉旧锚点行），其余字节不动。'
    + '--check 一律只读。',
  dryRun: '--pass / --fail 缺省就是 dry-run（只打印会写哪一行、落在第几行）；落盘必须显式 --apply。',
  exits: '--check：0 pass · 1 stale · 2 用法错 · 3 missing · 4 fail ｜ --pass/--fail：0 已写入/幂等跳过/dry-run · 1 stale（未覆盖） · 2 用法错 · 3 档读不到 · 4 策略拒绝',
  examples: [
    'dsh-plan-gate --check --file plan.md',
    'dsh-plan-gate --check --file plan.md --require-independent',
    'dsh-plan-gate --pass --file plan.md --round 2 --actor reviewer-a --independent yes',
    'dsh-plan-gate --pass --file plan.md --actor reviewer-a --independent yes --apply',
    'dsh-plan-gate --fail --file plan.md --round 2 --actor reviewer-a --apply',
  ],
  notes: [
    '⚠️ 缺省不校验立场：不加 --require-independent 时，作者自己签的锚点也判 pass —— 那时 pass 只说明"有人签过"。',
    '锚点永远只有一行：重写时先摘旧锚点再插新行；同 kind / round / actor / independent / 正文 sha 全一致时连写都不写。',
    '正文 = 去掉锚点行 + 去 BOM + CRLF→LF，其余逐字节参与 sha256 ⇒ 改行尾或加 BOM 不算改正文，改一个字立刻 stale。',
    '写前写后都比对正文 sha：两个会话同时签时，后一个判 stale 且不覆盖（用 --expect-sha 可以把"你看到的版本"钉死）。',
  ],
};

const out = (s) => process.stdout.write(`${s}\n`);
const warn = (s) => process.stderr.write(`${s}\n`);

function loadConfig(flags) {
  const file = flags.config ? path.resolve(flags.config) : DEFAULT_CONFIG;
  if (!flags.config && !fs.existsSync(file)) return normalizeConfig({});
  return loadGateConfig(file);
}

function printCheck(result) {
  const label = {
    pass: '✅ pass', stale: '🟠 stale', missing: '⛔ missing', fail: '🔴 fail',
  }[result.state] ?? result.state;
  out(`状态：${label}`);
  out(`档：${result.file}`);
  if (result.bytes != null) {
    out(`正文 sha256（前 ${result.option?.shaPrefixLength ?? 12} 位）：${result.currentShaShort} · 档 ${result.bytes} B（含锚点）`);
  }
  out(`是否要求独立签署：${result.requireIndependent ? '是（--require-independent）' : '否（缺省不校验立场）'}`);
  if (result.anchor) {
    const a = result.anchor.attrs;
    out(`锚点：L${result.anchor.line} · ${result.anchor.kind} · round=${a.round ?? '?'} · actor=${a.actor ?? '(缺字段)'}`
      + ` · independent=${a.independent ?? '(缺字段)'} · sha=${a.sha ?? '?'} · at=${a.at ?? '?'} · runId=${a.runId ?? '?'}`);
  }
  for (const r of result.reasons ?? []) out(`  · ${r.text}`);
}

function printPlan(plan, { apply }) {
  const verb = apply ? '已写入' : '[dry-run] 将写入';
  out(plan.outcome === 'skipped' ? `${verb} · 幂等跳过（一个字都没写）` : `${verb}锚点`);
  if (plan.outcome === 'skipped') {
    out(`  原因：${plan.reason}`);
    out(`  锚点：L${plan.position?.line ?? '?'}「${plan.line}」`);
  } else {
    out(`  锚点：L${plan.position?.line ?? '?'}（档里锚点行数将变为 ${plan.position?.anchorCount ?? '?'}）`);
    out(`  ${plan.line}`);
    if (plan.replaced) out(`  将摘掉旧锚点：L${plan.replaced.line}「${plan.replaced.raw}」`);
    out(`  正文 sha（前 12 位，不含锚点）：${plan.beforeShort}`);
  }
  if (!apply) out('  （dry-run：要落盘请加 --apply；以上内容没有写进档）');
}

function runCheck(flags, config) {
  const result = evaluate(flags.file, { ...config, requireIndependent: Boolean(flags['require-independent']) });
  if (flags.json) {
    out(JSON.stringify({
      tool: 'dsh-plan-gate',
      action: 'check',
      requireIndependent: result.requireIndependent,
      file: result.file,
      state: result.state,
      currentSha: result.currentSha,
      currentShaShort: result.currentShaShort,
      bytes: result.bytes,
      anchor: result.anchor,
      reasons: result.reasons,
    }, null, 2));
  } else {
    printCheck(result);
  }
  if (result.state === STATE.PASS) return EXIT.OK;
  if (result.state === STATE.STALE) return EXIT.STALE;
  if (result.state === STATE.FAIL) return EXIT.FAIL;
  return EXIT.MISSING;
}

function runWrite(flags, config) {
  const kind = flags.pass ? 'pass' : 'fail';
  const fields = {
    ...config,
    kind,
    round: flags.round === undefined ? config.defaultRound : flags.round,
    actor: flags.actor === undefined ? config.defaultActor : flags.actor,
    independent: flags.independent === undefined ? config.defaultIndependent : flags.independent,
    expectSha: flags['expect-sha'],
  };
  if (flags.round !== undefined && !/^\d+$/.test(String(flags.round))) {
    warn('错误：--round 需要正整数');
    return EXIT.USAGE;
  }
  if (flags.independent !== undefined && !String(flags.independent).trim()) {
    warn('错误：--independent 不能为空（取 yes / no）');
    return EXIT.USAGE;
  }

  const apply = Boolean(flags.apply);
  const result = apply ? writeAnchor(flags.file, fields) : planWrite(flags.file, fields);

  if (!result.ok && result.outcome === 'denied') {
    if (flags.json) out(JSON.stringify({ tool: 'dsh-plan-gate', action: kind, ok: false, outcome: result.outcome, code: result.code, reason: result.reason, file: result.file }, null, 2));
    else { warn(`🚫 拒绝写入：${result.reason}`); warn('  （策略拒绝：没有改动任何字节）'); }
    return EXIT.FAIL;
  }
  if (!result.ok && result.outcome === 'missing') {
    if (flags.json) out(JSON.stringify({ tool: 'dsh-plan-gate', action: kind, ok: false, outcome: result.outcome, code: result.code, reason: result.reason, file: result.file }, null, 2));
    else warn(`⛔ ${result.reason}`);
    return EXIT.MISSING;
  }
  if (!result.ok) {
    if (flags.json) out(JSON.stringify({ tool: 'dsh-plan-gate', action: kind, apply, ok: false, outcome: result.outcome, state: result.state, code: result.code, reason: result.reason, file: result.file, line: result.line, written: result.written ?? false }, null, 2));
    else {
      warn(`🟠 stale（${result.code}）：${result.reason}`);
      warn('  未覆盖：档里没有写入本命令的内容。请重跑 --check，看清当前正文再决定。');
    }
    return EXIT.STALE;
  }

  if (flags.json) {
    out(JSON.stringify({
      tool: 'dsh-plan-gate',
      action: kind,
      apply,
      ok: true,
      outcome: result.outcome,
      state: result.state,
      file: result.file,
      line: result.line,
      position: result.position,
      actor: result.actor,
      independent: result.independent,
      round: result.round,
      beforeSha: result.beforeSha,
      selfCheck: result.selfCheck ?? null,
      note: apply ? '已落盘' : 'dry-run（未落盘）',
    }, null, 2));
  } else {
    printPlan(result, { apply });
    if (apply) {
      out(`  actor=${result.actor} · independent=${result.independent} · round=${result.round}`);
      if (result.outcome === 'written') {
        out(`  回读自检：${result.selfCheck}${result.selfCheck === (kind === 'pass' ? 'pass' : 'fail') ? ' ✅' : ' ❌'}`);
      }
      if (result.actor === 'unspecified') {
        out('  ⚠️ actor 是 unspecified：这条凭证只证明"有人签过"，不证明"谁签的"。');
      }
      if (kind === 'pass' && result.independent !== 'yes') {
        out('  ⚠️ independent=no：缺省不校验立场 ⇒ 别人用 --check 不带 --require-independent 时仍会判 pass。');
      }
    }
  }
  return EXIT.OK;
}

function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  let config;
  try {
    config = loadConfig(flags);
  } catch (e) {
    warn(`错误：${e.message}`);
    return EXIT.USAGE;
  }
  const actions = [Boolean(flags.check), Boolean(flags.pass), Boolean(flags.fail)].filter(Boolean).length;
  if (actions !== 1) {
    warn('错误：必须且只能给 --check / --pass / --fail 之一');
    warn('（运行 `dsh-plan-gate --help` 看用法）');
    return EXIT.USAGE;
  }
  if (!flags.file) {
    warn('错误：必须给 --file <方案档>');
    warn('（运行 `dsh-plan-gate --help` 看用法）');
    return EXIT.USAGE;
  }
  if (typeof flags.file !== 'string') {
    warn('错误：--file 需要一个路径');
    return EXIT.USAGE;
  }
  return flags.check ? runCheck(flags, config) : runWrite(flags, config);
}

cliGuard(SPEC);
process.exitCode = main(process.argv.slice(2));
