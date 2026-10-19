#!/usr/bin/env node
// dsh-l3-pitfall-reminder / bin/l3-reminder.mjs
//
// L3 实时提醒的命令行：看开关 / 开关它 / 演练匹配 / 看日志。
//
// 铁律（生态规矩）：**凡写动作默认 dry-run**，必须显式加 --apply 才落盘。
//   node bin\l3-reminder.mjs --status
//   node ... --on --apply          # 打开提醒（改开关文件，**不用重启**）
//   node ... --off --apply         # 关回（默认态）
//   node ... --dry-run on --apply  # 只记录「本该提醒什么」，不真注入
//   node ... --match "Error: cannot read \"<DSH_ROOT>\\x.yml\": not found"
//   node ... --tail 10
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, readSwitch, readIndex, switchPath, defaultStorePath, defaultLogPath, DEFAULT_SWITCH, resolveHome } from '../lib/store.mjs';
import { matchPitfall, renderReminder, hostSlug } from '../lib/core.mjs';
import { signatureOf } from '../lib/normalize.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const home = val('--home') || resolveHome();
const docsRoot = val('--docs-root') || process.env.DSH_L3_PITFALL_DOCS || path.join(process.env.DSH_ROOT || path.join(os.homedir(), 'DSH'), 'docs', '坑库');
const apply = has('--apply');
const json = has('--json');
const swFile = switchPath(home);
const logFile = defaultLogPath(home);

function out(obj, human) {
  if (json) console.log(JSON.stringify(obj, null, 1));
  else console.log(human);
}

function loadSwitch() {
  const cache = { mtimeMs: null, value: null };
  return readSwitch(swFile, cache);
}

function status() {
  const sw = loadSwitch();
  const storeFile = sw.storePath || defaultStorePath(home);
  const idx = readIndex(storeFile, { mtimeMs: null, index: null });
  let logLines = 0;
  let lastEvent = null;
  let delivered = 0;
  let dryHits = 0;
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    logLines = lines.length;
    for (const l of lines) {
      try {
        const j = JSON.parse(l);
        if (j.event === 'delivered') delivered++;
        if (j.event === 'dry-run-hit') dryHits++;
        lastEvent = j;
      } catch { /* 忽略坏行 */ }
    }
  } catch { /* 无日志 */ }
  const human = [
    `L3 实时提醒（P4）—— ${sw.enabled ? '✅ 开着' : '⭕ 关着（默认）'}${sw.dryRun ? ' · DRY-RUN（只记不注入）' : ''}`,
    `  开关文件：${swFile}${sw._exists ? '' : '（不存在 ⇒ 用默认值 = 关）'}`,
    `  坑库：${storeFile}`,
    `       ${idx.ok ? `${idx.index.size} 条坑，更新于 ${idx.index.updatedAt ?? '?'}` : `⚠ 读不到：${idx.error}`}`,
    `  命中日志：${logFile}（${logLines} 行 · 真投递 ${delivered} · dry-run 命中 ${dryHits}）`,
    lastEvent ? `  最近一条：${lastEvent.at} ${lastEvent.event}${lastEvent.pitfallId ? ` #${lastEvent.pitfallId}` : ''}${lastEvent.tool ? ` tool=${lastEvent.tool}` : ''}` : '  最近一条：—',
    `  每会话上限 ${sw.maxPerSession} 条 / 冷却 ${Math.round(Number(sw.cooldownMs) / 1000)} 秒`,
  ].join('\n');
  out({ home, ...sw, storeFile, logLines, delivered, dryHits, lastEvent }, human);
}

function writeSwitch(patch) {
  const cur = fs.existsSync(swFile) ? JSON.parse(fs.readFileSync(swFile, 'utf8')) : {};
  const next = { ...DEFAULT_SWITCH, ...cur, ...patch, schemaVersion: 1, updatedAt: new Date().toISOString() };
  delete next._exists;
  delete next._file;
  delete next._parseError;
  if (!apply) {
    out({ wouldWrite: swFile, next }, `[DRY-RUN] 将写入 ${swFile}：\n${JSON.stringify(next, null, 1)}\n（确认无误后加 --apply 落盘；改完**不用重启**，下一轮工具调用即生效）`);
    return;
  }
  const dir = path.dirname(swFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${swFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
  fs.renameSync(tmp, swFile);
  out({ wrote: swFile, next }, `[OK] 已写入 ${swFile}\n${JSON.stringify(next, null, 1)}\n（即时生效，无需重启）`);
}

function matchDemo() {
  const text = val('--match');
  if (!text) {
    console.log('用法：--match "<一条工具失败的文本>"');
    process.exitCode = 2;
    return;
  }
  const name = val('--name', '');
  const code = val('--code', '');
  const sw = loadSwitch();
  const storeFile = sw.storePath || defaultStorePath(home);
  const idx = readIndex(storeFile, { mtimeMs: null, index: null });
  if (!idx.ok) {
    console.log(`坑库读不到：${idx.error}`);
    process.exitCode = 2;
    return;
  }
  const err = { name, code, text };
  const m = matchPitfall(err, idx.index);
  const sig = signatureOf(err);
  if (!m.hit) {
    out({ hit: false, sig }, `[未命中] 签名 ${sig.sigKey.slice(0, 160)}\n  坑库 ${idx.index.size} 条里没有这一条 ⇒ 不会提醒（属正常：坑库只收 ≥2 次的坑、且排除业务性失败）`);
    return;
  }
  const rendered = renderReminder(m.hit, m, {
    tool: val('--tool', '?'),
    host: os.hostname(),
    dryRun: true,
    pitDir: docsRoot,
    pitFileExists: fs.existsSync(path.join(docsRoot, `${m.hit.category}-${hostSlug(os.hostname())}.md`)),
  });
  out(
    { hit: true, how: m.how, pitfallId: m.hit.id, category: m.hit.category, count: m.hit.count, text: rendered.text, summary: rendered.summary },
    `[命中 · 方式=${m.how}] 坑 #${m.hit.id}（${m.hit.category}，历史 ${m.hit.count} 次）\n\n--- 若开着会注入模型的提醒 ---\n${rendered.text}\n-------------------------------\n(本次是演练，未写入会话，也未落日志)`,
  );
}

function tail() {
  const n = Number(val('--tail', '10')) || 10;
  if (!fs.existsSync(logFile)) {
    console.log(`暂无日志：${logFile}`);
    return;
  }
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
  if (json) console.log(JSON.stringify(lines.map((l) => { try { return JSON.parse(l); } catch { return l; } }), null, 1));
  else for (const l of lines) console.log(l);
}

function help() {
  console.log(`dsh-l3-pitfall-reminder CLI

  --status                     看开关 / 坑库 / 日志概况（默认动作）
  --on | --off                 开 / 关 实时提醒     （写动作，需 --apply）
  --dry-run on|off             只记不注入           （写动作，需 --apply）
  --match "<失败文本>"          演练匹配（只读）：[--name X] [--code Y] [--tool Z]
  --tail N                     看最近 N 条命中日志
  --home <dir>                 指定 DSH home（默认 $DSH_HOME 或 ~/.dsh）
  --json                       机器可读输出
  --apply                      显式落盘（默认全部只预览/dry-run）

开关文件：${swFile}
改开关**不用重启**（插件每轮热读）。`);
}

const dryRunArg = val('--dry-run');
if (has('--help') || has('-h')) help();
else if (has('--status')) status();
else if (has('--on')) writeSwitch({ enabled: true });
else if (has('--off')) writeSwitch({ enabled: false });
else if (dryRunArg !== null && ['on', 'off', 'true', 'false'].includes(dryRunArg)) writeSwitch({ dryRun: dryRunArg === 'on' || dryRunArg === 'true' });
else if (has('--match')) matchDemo();
else if (has('--tail')) tail();
else status();
