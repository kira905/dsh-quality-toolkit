#!/usr/bin/env node
// dsh-sim-scan —— 同源度扫描（只读 + 可选落报告）
//
// 给一个仓（--repo）或一整个仓根（--all）⇒ 对**同名可比件**算：
//   同名件数 / 逐字节同 / ≥90% / 50–90% / <50% / **≥50% 行同占比**（主结论列）
//
// 口径写死在 config/sim-scan.json（6 类扩展名 + 8 个 skip 目录 + 生产面），脚本入仓、可复跑。
// 行级用**多重集扣减**，同名候选取**行同度最高者**。
//
// 与历史基线表对比（--baseline）时，**不许**把"逐格一致"当硬闸：
// 仓是活体，取数时点不同、仓已变版都是正常的。本工具改为：
//   差异行数写清楚 + 每行给可复现的原因（取数时点不同 / 该仓已变版 / 口径差异），
//   归不上这三种的，明确打"无法归因"并 rc=3 —— 不许蒙。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliGuard, parseArgs } from './lib/cli-args.mjs';
import {
  loadSimConfig, caliberFingerprint, buildProductionIndex, scanAll, scanRepo, gitDirtyCount,
  renderHeader, renderTable, compareBaseline, defaultProdRoot,
} from './lib/sim-scan-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, 'config', 'sim-scan.json');
const DEFAULT_BASELINE = path.join(HERE, 'config', 'baseline-sim-v3o.json');

const SPEC = {
  cmd: 'dsh-sim-scan',
  summary: '算一个仓（或整个仓根）与生产源的「行级同源度」：同名件 / 逐字节同 / ≥90% / 50–90% / <50% / ≥50% 行同占比。',
  usage: 'dsh-sim-scan (--repo <仓路径> | --all <仓根>) [选项]',
  flags: [
    { name: '--repo', arg: 'dir', desc: '只扫一个仓（不含其子目录的其它仓）' },
    { name: '--all', arg: 'dir', desc: '扫这个目录下的每一个子目录（当仓处理）' },
    { name: '--prod-root', arg: 'dir', desc: '生产源根（缺省：$DSH_ROOT，再缺省 ~/DSH）' },
    { name: '--config', arg: 'file', desc: '口径配置（缺省：本仓 config/sim-scan.json）' },
    { name: '--baseline', arg: 'file|none', desc: '与历史基线表对比差异（缺省：本仓 config/baseline-sim-v3o.json；传 none 关闭）' },
    { name: '--detail', arg: 'repo', desc: '额外打印某个仓的逐件行同度（只对 --all 生效）' },
    { name: '--out', arg: 'file', desc: '把表写成 Markdown（**唯一写点**；缺省只打印）' },
    { name: '--json', desc: '以 JSON 输出，便于别的脚本消费' },
  ],
  writes: '默认**不写任何文件**，只读扫描并打印。只有给了 --out <file> 才写那一份 Markdown；报告请落在被扫目录之外。',
  dryRun: '没有 --dry-run：本命令本身就不写（--out 是唯一写点）。',
  exits: '0 = 正常（差异都能归因到三种原因之一） · 3 = 有「无法归因」的差异行或缺基线仓（需人看） · 2 = 用法错误 · 1 = 运行错误',
  examples: [
    'dsh-sim-scan --repo ~/oss/my-lib --prod-root ~/DSH',
    'dsh-sim-scan --all ~/oss --detail my-lib --out /tmp/sim.md',
    'dsh-sim-scan --all ~/oss --baseline none   # 不对比基线，纯现读',
  ],
  notes: [
    '口径 = 同名件（按 basename）+ 行级多重集扣减 + 三档；主结论列是「≥50% 行同占比」。',
    '逐字节同比例会低估同源度（删几行注释就判"不同源"）—— 所以主结论不用它。',
    '表头一定打印「扫描时各仓脏项数」：拿读数当"干净时的读数"是最常见的误读。',
  ],
};

const argv = cliGuard(SPEC);
const { flags } = parseArgs(argv, SPEC);
if (!flags.repo && !flags.all) {
  process.stderr.write('错误：--repo 与 --all 必须给一个。\n（运行 `dsh-sim-scan --help` 看用法）\n');
  process.exit(2);
}
if (flags.repo && flags.all) {
  process.stderr.write('错误：--repo 与 --all 只能给一个。\n');
  process.exit(2);
}

const configFile = flags.config ? path.resolve(flags.config) : DEFAULT_CONFIG;
const cfg = loadSimConfig(configFile);
const prodRoot = flags['prod-root'] ? path.resolve(flags['prod-root']) : defaultProdRoot();
if (!fs.existsSync(prodRoot)) {
  process.stderr.write(`错误：生产源根不存在 ${prodRoot}\n（用 --prod-root 指定，或设 $DSH_ROOT）\n`);
  process.exit(1);
}

const at = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const atStr = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}（本机时区）`;
const index = buildProductionIndex({ prodRoot, cfg });

let rows;
if (flags.repo) {
  const repoPath = path.resolve(flags.repo);
  if (!fs.existsSync(repoPath)) {
    process.stderr.write(`错误：仓路径不存在 ${repoPath}\n`);
    process.exit(1);
  }
  const row = scanRepo({ repoPath, index, cfg, collectDetail: true });
  row.dirty = gitDirtyCount(repoPath);
  rows = [row];
} else {
  rows = scanAll({ repoRoot: path.resolve(flags.all), index, cfg, collectDetail: Boolean(flags.detail) });
}

const header = renderHeader({ cfg, prodRoot, rows, at: atStr });
const table = renderTable(rows);

const L = [];
L.push('同源度扫描');
L.push(header);
L.push('');
L.push(table);
L.push('');
const near = rows.filter((r) => r.verdict.label === 'near-source-copy').length;
const partial = rows.filter((r) => r.verdict.label === 'partial-rewrite').length;
const rewrite = rows.filter((r) => r.verdict.label === 'rewrite-first').length;
const unjudged = rows.filter((r) => !r.judged).length;
L.push(`主结论（「≥50% 行同占比」列）：近源副本 ${near} · 部分重写 ${partial} · 重写为主 ${rewrite}${unjudged ? ` · 判不了 ${unjudged}` : ''}`);

let rc = 0;
let baselineResult = null;
if (flags.detail) {
  const target = rows.find((r) => r.repo === String(flags.detail));
  if (target) {
    L.push('');
    L.push(`逐件行同度 · ${target.repo}（只列非逐字节相同的近源件，按行同度降序）`);
    for (const d of target.detail.slice(0, 40)) L.push(`  ${String(d.ratio).padStart(5)}%  ${d.file}  ↔ ${d.candidate}`);
    if (!target.detail.length) L.push('  （没有非逐字节相同的同名件）');
  }
}

const baselinePath = flags.baseline === 'none'
  ? null
  : flags.baseline ? path.resolve(flags.baseline) : (fs.existsSync(DEFAULT_BASELINE) ? DEFAULT_BASELINE : null);

if (baselinePath) {
  if (!fs.existsSync(baselinePath)) {
    L.push('');
    L.push(`⚠️ 基线表不存在：${baselinePath}（本次不对比）`);
    rc = 0;
  } else {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8').replace(/^\uFEFF/, ''));
    baselineResult = compareBaseline({ rows, baseline, cfg, prodRoot });
    L.push('');
    L.push(`与基线对比（基线：${baseline.at ?? '未声明时点'} · ${baseline.caliber ?? '未声明口径'}）`);
    L.push(`差异行数：${baselineResult.diffRows} / ${rows.length}`);
    if (!baselineResult.diffRows) L.push('  逐格一致（这次时点相同、口径相同、仓也没动）');
    for (const d of baselineResult.diffs) {
      const cols = d.cols.map((c) => `${c.col} ${c.baseline}→${c.now}`).join(' · ');
      L.push(`  ${d.repo}：${d.zh} —— ${d.detail}${cols ? ` ｜ ${cols}` : ''}`);
      if (d.evidence?.length) for (const e of d.evidence.slice(0, 3)) L.push(`      证据：${e}`);
    }
    if (baselineResult.diffs.some((d) => d.reason === 'unattributed')) {
      L.push('  🔴 有「无法归因」的差异行：口径未变、无新提交、工作树干净 ⇒ 不许拿"时点不同"糊过去，请人看。');
      rc = 3;
    }
  }
}
if (unjudged) rc = rc || 3;
L.push('');
L.push(`口径指纹：${caliberFingerprint(cfg)}`);

const text = L.join('\n') + '\n';
if (flags.json) {
  const payload = {
    tool: 'dsh-sim-scan',
    at: at.toISOString(),
    prodRoot,
    caliber: caliberFingerprint(cfg),
    rows,
    baseline: baselineResult,
    header,
    table,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (flags.out) fs.writeFileSync(path.resolve(flags.out), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
} else if (flags.out) {
  fs.writeFileSync(path.resolve(flags.out), text, 'utf8');
  process.stdout.write(`${text}\n（报告已写入 ${path.resolve(flags.out)}）\n`);
} else {
  process.stdout.write(text);
}
process.exitCode = rc;
