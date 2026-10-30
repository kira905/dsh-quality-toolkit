#!/usr/bin/env node
// dsh-ref-scan —— 引用面扫描（只读 + 可选落报告）
//
// 给一个关键词（可多个）⇒ 扫四类载体（文档 / 技能 / 人设 / 工具）⇒ 输出四类处置表：
//   A 就地订正 · B 加头指针 · C 判定不改 + 理由 · D 待主人
//
// 机器只做机械事：把该看的都列出来（文件、行号、命中原文片段）；判 A/B/C/D 留空给人填。
//
// 三条空态纪律（这是本工具最容易退化成形式主义的地方）：
//   ① 0 命中 ⇒ 判黄（不是 pass、也不是红），并要求人工确认扫描面；
//   ② 每次扫描都必须打印"扫描面证据"：载体清单 + 每类扫了多少文件 + 命中数（空表也要有这行）；
//   ③ 配阴性对照（`dsh-self-audit --negctl`）证明扫描器不是死的。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliGuard, parseArgs } from './lib/cli-args.mjs';
import { loadRefConfig, scanRefs, evidenceLine, renderTable, dispositionLegend, defaultRoot } from './lib/ref-scan-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, 'config', 'ref-scan.json');

const SPEC = {
  cmd: 'dsh-ref-scan',
  summary: '给一个关键词，扫四类载体（文档 / 技能 / 人设 / 工具），输出一张四类处置表（A/B/C/D 留空给人填）。',
  usage: 'dsh-ref-scan <关键词> [<关键词2> ...] [选项]',
  positional: [{ name: '<关键词>', desc: '要扫的词（可给多个；任一命中即列入表）' }],
  flags: [
    { name: '--root', arg: 'dir', desc: '扫描根（缺省：$DSH_ROOT，再缺省 ~/DSH）' },
    { name: '--config', arg: 'file', desc: `载体与排除配置（缺省：${path.relative(process.cwd(), DEFAULT_CONFIG) || '本仓 config/ref-scan.json'}）` },
    { name: '--out', arg: 'file', desc: '把表写成 Markdown 报告（**唯一写点**；缺省只打印到标准输出）' },
    { name: '--json', desc: '以 JSON 输出（表 + 扫描面证据），便于别的脚本消费' },
    { name: '--case-sensitive', desc: '区分大小写（缺省不区分）' },
    { name: '--snippet', arg: 'N', desc: '命中片段截断到 N 个字符（缺省 120）' },
  ],
  writes: '默认**不写任何文件**，只读扫描并打印。只有给了 --out <file> 才写那一份 Markdown 报告；报告请落在被扫目录之外。',
  dryRun: '没有 --dry-run：本命令本身就不写（--out 是唯一写点，去掉它即为纯只读）。',
  exits: '0 = 有命中（表已出，处置列待人填） · 3 = 0 命中 ⇒ 判黄（需人工确认扫描面） · 2 = 用法错误 · 1 = 运行错误',
  examples: [
    'dsh-ref-scan plan-gate --root ~/DSH',
    'dsh-ref-scan 六包 plan-gate --out /tmp/ref-scan.md',
    'dsh-ref-scan __no_such_keyword__ --root ~/DSH   # 应判黄（rc=3）',
  ],
  notes: [
    '0 命中不是"没问题"，只代表"这次的关键词没找到" —— 所以判黄，并要求人工确认扫描面（载体/根/排除目录）。',
    '机制上不搬任何家规名字：对外只说「引用面扫描 + 四类处置」。',
  ],
};

const argv = cliGuard(SPEC);
const { flags, positional } = parseArgs(argv, SPEC);
const keywords = positional.filter(Boolean);
if (!keywords.length) {
  process.stderr.write('错误：至少要给一个关键词。\n（运行 `dsh-ref-scan --help` 看用法）\n');
  process.exit(2);
}

const configFile = flags.config ? path.resolve(flags.config) : DEFAULT_CONFIG;
if (!fs.existsSync(configFile)) {
  process.stderr.write(`错误：配置文件不存在 ${configFile}\n`);
  process.exit(1);
}
let config;
try {
  config = loadRefConfig(configFile);
} catch (e) {
  process.stderr.write(`错误：配置读取失败 ${e.message}\n`);
  process.exit(1);
}

const root = flags.root ? path.resolve(flags.root) : defaultRoot();
if (!fs.existsSync(root)) {
  process.stderr.write(`错误：扫描根不存在 ${root}\n（用 --root 指定，或设 $DSH_ROOT）\n`);
  process.exit(1);
}

const snippetMax = flags.snippet ? Number(flags.snippet) : (config.snippetMax ?? 120);
const result = scanRefs({
  root,
  config,
  keywords,
  caseSensitive: Boolean(flags['case-sensitive']),
  snippetMax,
});

const ev = evidenceLine(result.evidence);
const verdict = result.verdict === 'yellow'
  ? '黄 —— 0 命中：不是 pass，也不是红。请先人工确认扫描面（载体/根/排除目录）是否选对。'
  : `有命中：${result.evidence.hitLines} 行 / ${result.evidence.totalHits} 次。处置列（A/B/C/D）待人工填写。`;

if (flags.json) {
  const payload = {
    tool: 'dsh-ref-scan',
    root,
    keywords,
    verdict: result.verdict,
    evidence: result.evidence,
    evidenceLine: ev,
    dispositions: dispositionLegend(),
    rows: result.rows,
  };
  const out = JSON.stringify(payload, null, 2);
  if (flags.out) fs.writeFileSync(path.resolve(flags.out), `${out}\n`, 'utf8');
  process.stdout.write(`${out}\n`);
  process.exitCode = result.verdict === 'yellow' ? 3 : 0;
} else {
  const L = [];
  L.push('引用面扫描');
  L.push(`关键词：${keywords.join(' · ')}`);
  L.push(ev);
  L.push('');
  L.push(`四类处置：${dispositionLegend()}`);
  L.push('');
  L.push(renderTable(result, { snippetMax }));
  L.push('');
  L.push(`判定：${verdict}`);
  const text = L.join('\n') + '\n';
  if (flags.out) {
    fs.writeFileSync(path.resolve(flags.out), text, 'utf8');
    process.stdout.write(`${text}\n（报告已写入 ${path.resolve(flags.out)}）\n`);
  } else {
    process.stdout.write(text);
  }
  process.exitCode = result.verdict === 'yellow' ? 3 : 0;
}
