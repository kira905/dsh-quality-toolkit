#!/usr/bin/env node
// dsh-self-audit —— 交付前自批（只读 + 可选落报告）
//
// 输入一份交付报告（＋可选卡号 / 件名）⇒ 出六条机械判据结论：
//   ① DoD 块在不在   ② 有没有带当次命令原文   ③ 有没有「待拍板」段（有未决项时）
//   ④ 报告里有没有内部标识（三层：机器层 + 证伪层 + 字面量层）
//   ⑤ 报告路径真实存在   ⑥ 正文引用的文件真实存在
//
// 第 ④ 条是这把尺子里最容易骗人的一条：**不许只调扫描器的 rc**。
// 不注入 P0 词表时扫描器照样 hits=0 —— 所以这一条判的是"扫描器有没有说它不完整"，
// 以及"它会不会红"（阴性对照，--negctl 跑四步时序）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliGuard, parseArgs } from './lib/cli-args.mjs';
import { loadTables } from './lib/deny-literal.mjs';
import { auditReport, renderChecks, verdictOf, guessRoot } from './lib/self-audit-core.mjs';
import { runNegativeControl, renderNegativeControl } from './lib/negctl.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, 'config');

const SPEC = {
  cmd: 'dsh-self-audit',
  summary: '交付报告的自批闸：六条机械判据（DoD 块 / 当次命令原文 / 待拍板段 / 内部标识三层 / 报告存在 / 引用文件存在）。',
  usage: 'dsh-self-audit <报告.md> [选项]',
  positional: [{ name: '<报告.md>', desc: '要自批的交付报告（Markdown）' }],
  flags: [
    { name: '--root', arg: 'dir', desc: '解析正文引用路径的根（缺省：报告在 <X>/docs/ 下则取 <X>，否则当前目录）' },
    { name: '--card', arg: 'id', desc: '卡号（只写进报告头，不参与判据）' },
    { name: '--item', arg: 'name', desc: '件名（只写进报告头，不参与判据）' },
    { name: '--config', arg: 'dir', desc: '字面量表目录（缺省：本仓 config/）' },
    { name: '--machine-report', arg: 'file', desc: '机器层（权威脱敏扫描器）的输出/报告文件；里面若有「P0 段未启用」⇒ 机器层不过' },
    { name: '--negctl', desc: '顺便跑阴性对照四步时序（证伪层），结果计入第 ④ 条' },
    { name: '--dir', arg: 'dir', desc: '--negctl 的被扫目录（缺省：当前目录）' },
    { name: '--keep-sample', desc: '--negctl 跑完保留仓外样本（调试用；缺省即删）' },
    { name: '--out', arg: 'file', desc: '把结论写成 Markdown（**唯一写点**；缺省只打印）' },
    { name: '--json', desc: '以 JSON 输出，便于别的脚本消费' },
  ],
  writes: '默认**不写任何文件**。给了 --out 才写那一份 Markdown；--negctl 会在 %TEMP%/oss-negative-control/ 生成样本并在被扫目录里放一个临时哨兵文件，**跑完必删**（finally 保证）。',
  dryRun: '没有 --dry-run：前五条判据纯只读；只有 --negctl 会短暂落一个哨兵文件，四步时序里自己清理。',
  exits: '0 = 六条全绿 · 3 = 有"证据不足"（黄，需补证据再发） · 4 = 有不通过（红，停止发布） · 2 = 用法错误 · 1 = 运行错误',
  examples: [
    'dsh-self-audit docs/report.md',
    'dsh-self-audit report.md --machine-report /tmp/scan.txt --negctl --dir .',
    'dsh-self-audit report.md --json --out /tmp/self-audit.md',
  ],
  notes: [
    '「证据不足」不是通过：机器层没注入词表、证伪层没跑阴性对照，都只能判黄。',
    '命中落在围栏代码块内 / 行内反引号里 / 引用块里 ⇒ 记为 allow（命令原文 / 被引用证据 / 原文摘录），不阻断；其余命中算待复核。',
  ],
};

const argv = cliGuard(SPEC);
const { flags, positional } = parseArgs(argv, SPEC);
const reportFile = positional[0];
if (!reportFile) {
  process.stderr.write('错误：要给一份报告文件。\n（运行 `dsh-self-audit --help` 看用法）\n');
  process.exit(2);
}

const configDir = flags.config ? path.resolve(flags.config) : CONFIG_DIR;
const tables = loadTables(configDir);

let negctl = null;
let negctlText = '';
if (flags.negctl) {
  const dir = flags.dir ? path.resolve(flags.dir) : process.cwd();
  if (!fs.existsSync(dir)) {
    process.stderr.write(`错误：--negctl 的被扫目录不存在 ${dir}\n`);
    process.exit(1);
  }
  negctl = runNegativeControl({ dir, tables, keepSample: Boolean(flags['keep-sample']) });
  negctlText = renderNegativeControl(negctl);
}

const result = auditReport({
  file: reportFile,
  root: flags.root ? path.resolve(flags.root) : guessRoot(reportFile),
  tables,
  machineReport: flags['machine-report'] ? path.resolve(flags['machine-report']) : null,
  negctl,
  card: flags.card ?? null,
  item: flags.item ?? null,
});

const verdict = verdictOf(result.tally);
const L = [];
L.push('交付前自批');
if (flags.card) L.push(`卡号：${flags.card}`);
if (flags.item) L.push(`件名：${flags.item}`);
L.push(`报告：${result.meta?.file ?? path.resolve(reportFile)}`);
L.push(`引用路径解析根：${result.meta?.root ?? '（报告不存在）'}`);
L.push('');
if (negctlText) { L.push(negctlText); L.push(''); }
L.push(renderChecks(result));
const text = L.join('\n') + '\n';

if (flags.json) {
  const payload = { tool: 'dsh-self-audit', verdict: verdict.id, rc: verdict.rc, ...result, negctl };
  const out = `${JSON.stringify(payload, null, 2)}\n`;
  if (flags.out) fs.writeFileSync(path.resolve(flags.out), out, 'utf8');
  process.stdout.write(out);
} else if (flags.out) {
  fs.writeFileSync(path.resolve(flags.out), text, 'utf8');
  process.stdout.write(`${text}\n（结论已写入 ${path.resolve(flags.out)}）\n`);
} else {
  process.stdout.write(text);
}
process.exitCode = verdict.rc;
