#!/usr/bin/env node
// selfcheck-rerun.mjs —— ⑤失败环复跑（自核产物 vs 复跑产物逐条比对）
//
// 用法：
//   # 回修方（交付前）：跑自核并留产物
//   node selfcheck-rerun.mjs --record --doc <送审件> --manifest <清单.json> --out <产物目录>
//   # 审核方（收尾）：复跑核验
//   node selfcheck-rerun.mjs --replay --doc <送审件> --manifest <清单.json> --artifacts <产物目录>
//   node selfcheck-rerun.mjs --self-test
//
// 判据（写死 · 解第 9 轮 M1 / 第 8 轮 M3）：
//   ① **比对前先校验产物记录的送审件 sha = 当前送审件 sha**（不符 ⇒ 判"自核未执行"，不用过期读数做基准）；
//   ② **计数类产物（class=count，如体量核 / 轮次数）不作数值基准**，只比判定（PASS/FAIL）；
//   ③ 非计数类（class=exact）逐条比 **判定 + 计数 n**；
//   ④ 复跑基准 = 清单里的 `args`（与自核时逐字相同的参数），`--stage1` 只作留痕、不作数值基准。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, argParse, helpBlock, isMain, meta, newResults, assertEq, assertTrue, finishSelfTest, makeTmp, rmrf, writeTmp } from './lib/common.mjs';
import { runTool } from './lib/dispatch.mjs';

function loadManifest(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const items = Array.isArray(j) ? j : j.items;
  return items;
}

function resolveArgs(args, base) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = (typeof v === 'string' && /\.(md|json|txt|diff)$/i.test(v) && !path.isAbsolute(v)) ? path.join(base, v) : v;
  }
  return out;
}

export async function record({ doc, manifestPath, outDir, stage1 }) {
  const m = meta(doc);
  const items = loadManifest(manifestPath);
  const base = path.dirname(path.resolve(manifestPath));
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const args = resolveArgs(it.args, base);
    const r = await runTool(it.tool, args);
    const artifact = {
      tool: it.tool, args, class: r.class, docPath: m.path, docSha16: m.sha16,
      hash: m.sha256, at: new Date().toISOString(), verdict: r.verdict, n: r.n, detail: r.detail,
      stage1: stage1 ?? null, stage1Sha16: stage1 ? meta(stage1).sha16 : null,
    };
    const f = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${it.tool}.json`);
    fs.writeFileSync(f, JSON.stringify(artifact, null, 2), 'utf8');
    written.push({ file: f, artifact });
  }
  return { ok: true, doc: m, written, stage1 };
}

export async function replay({ doc, manifestPath, artifactsDir, stage1 }) {
  const m = meta(doc);
  const items = loadManifest(manifestPath);
  const base = path.dirname(path.resolve(manifestPath));
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const f = path.join(artifactsDir, `${String(i + 1).padStart(2, '0')}-${it.tool}.json`);
    let art = null;
    try { art = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 缺产物 */ }
    if (!art) { rows.push({ tool: it.tool, artifact: f, verdict: '❌ 产物缺失（自核未执行）' }); continue; }
    const shaOk = art.docSha16 === m.sha16;
    const rerun = await runTool(it.tool, resolveArgs(it.args, base));
    let verdict;
    if (!shaOk) verdict = `❌ 送审件已变（产物记录 ${art.docSha16} ≠ 当前 ${m.sha16}）⇒ 判自核未执行`;
    else if (rerun.verdict !== art.verdict) verdict = `❌ 判定不一致（自核 ${art.verdict} / 复跑 ${rerun.verdict}）`;
    else if (art.class !== 'count' && rerun.n !== art.n) verdict = `❌ 计数不一致（自核 ${art.n} / 复跑 ${rerun.n}）`;
    else verdict = `✅ 一致（${rerun.verdict}${art.class === 'count' ? ' · 计数类不作基准' : ` · n=${rerun.n}`}）`;
    rows.push({
      tool: it.tool, artifact: f, class: art.class, artSha: art.docSha16, curSha: m.sha16,
      artVerdict: art.verdict, rerunVerdict: rerun.verdict, artN: art.n, rerunN: rerun.n, shaOk, verdict,
    });
  }
  const bad = rows.filter((r) => r.verdict.startsWith('❌'));
  return { ok: true, doc: m, rows, bad, stage1 };
}

export function reportReplay(r) {
  console.log(`送审件：${r.doc.path}  ·  ${r.doc.gc} 行 / ${r.doc.bytes} B · sha16 ${r.doc.sha16}`);
  console.log(`复跑基准：清单 args 逐字复用${r.stage1 ? ` · --stage1 = ${path.basename(r.stage1)}（只留痕，不作数值基准）` : ''}`);
  console.log('');
  console.log('| 判据 | class | 产物记录的送审件 sha16 | 当前 | sha 一致 | 自核判定 | 复跑判定 | n（自核/复跑）| 结论 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) {
    console.log(`| ${x.tool} | ${x.class ?? '—'} | ${x.artSha ?? '—'} | ${x.curSha} | ${x.shaOk === undefined ? '—' : (x.shaOk ? '✅' : '❌')} | ${x.artVerdict ?? '—'} | ${x.rerunVerdict ?? '—'} | ${x.artN ?? '—'}/${x.rerunN ?? '—'} | ${x.verdict} |`);
  }
  console.log('');
  console.log(`[汇总] 产物 ${r.rows.length} 项 · 一致 ${r.rows.length - r.bad.length} · 不一致 ${r.bad.length} ⇒ ${r.bad.length === 0 ? 'PASS' : 'FAIL'}`);
  return r.bad.length === 0 ? EXIT.OK : EXIT.FAIL;
}

export async function selfTest() {
  const res = newResults();
  const dir = makeTmp('dd-rerun-');
  const doc = writeTmp(dir, 'doc.md', ['# 第 1 轮审核 · A', '', '正文', '', '---', '', '# 第 2 轮审核 · B', '', '正文二'].join('\n'));
  const manifest = writeTmp(dir, 'm.json', JSON.stringify({
    items: [
      { tool: 'check-rounds', args: { doc: 'doc.md' } },
      { tool: 'check-volume', args: { doc: 'doc.md', round: 2 } },
    ],
  }, null, 2));
  const out = path.join(dir, 'art');
  await record({ doc, manifestPath: manifest, outDir: out });
  assertTrue(fs.existsSync(path.join(out, '01-check-rounds.json')), 'record 落产物 01-check-rounds.json', res);
  const a1 = JSON.parse(fs.readFileSync(path.join(out, '01-check-rounds.json'), 'utf8'));
  assertEq(a1.docSha16, meta(doc).sha16, '产物记录送审件 sha', res);
  assertEq(a1.class, 'exact', 'check-rounds 归 exact', res);

  const r1 = await replay({ doc, manifestPath: manifest, artifactsDir: out });
  assertEq(r1.bad.length, 0, '同版本复跑 ⇒ 全部一致', res);

  const doc2 = writeTmp(dir, 'doc2.md', fs.readFileSync(doc, 'utf8') + '\n# 第 3 轮审核 · C\n');
  const r2 = await replay({ doc: doc2, manifestPath: manifest, artifactsDir: out });
  assertEq(r2.bad.length, 2, '送审件已变 ⇒ 两项都判"自核未执行"', res);
  assertTrue(r2.rows[0].verdict.includes('送审件已变'), '判据①：sha 不符即判自核未执行', res, r2.rows[0].verdict);

  const empty = path.join(dir, 'nope');
  const r3 = await replay({ doc, manifestPath: manifest, artifactsDir: empty });
  assertEq(r3.bad.length, 2, '产物缺失 ⇒ 判自核未执行（不静默）', res);
  rmrf(dir);
  finishSelfTest('selfcheck-rerun', res);
}

if (isMain(import.meta.url)) {
  const a = argParse(process.argv.slice(2), { values: ['doc', 'manifest', 'out', 'artifacts', 'stage1'], flags: ['record', 'replay'] });
  if (a.error || a.help) {
    console.log(helpBlock({
      title: '⑤失败环复跑（第 7 条⑤ · 自核产物 vs 复跑）',
      usage: 'node selfcheck-rerun.mjs --record --doc <送审件> --manifest <清单.json> --out <产物目录>\n'
        + '  node selfcheck-rerun.mjs --replay --doc <送审件> --manifest <清单.json> --artifacts <产物目录> [--stage1 <改动行集合>]',
      form: ['判据 | class | 产物记录的送审件 sha16 | 当前 sha16 | sha 一致 | 自核判定 | 复跑判定 | n（自核/复跑） | 结论',
        '[汇总] 产物 N 项 · 一致 x · 不一致 y'],
      caliber: ['**比对前先校验产物 sha = 送审件 sha**（不符 ⇒ 判"自核未执行"，绝不用过期读数当基准）',
        '**计数类产物（class=count）不作基准**：只比判定，不比数值；非计数类逐条比判定 + 计数 n',
        '复跑参数 = 清单 args 逐字复用；`--stage1` 只作留痕（第 8 轮 M3：计数类不作基准）',
        '调用走 lib/dispatch.mjs 动态 import（无子进程 / 无管道），与 check-rootcause 同一张调用表'],
      scope: { docs: '方案档（送审件）+ 产物目录', stage: '审核收尾（审核方复跑）', who: '审核方' },
      exits: ['0 = 产物与复跑一致', '3 = 有 sha 不符 / 判定不一致 / 产物缺失', '2 = 用法错'],
      selfTest: 'node selfcheck-rerun.mjs --self-test',
    }));
    process.exitCode = a.error ? EXIT.USAGE : EXIT.OK;
  } else if (a.selfTest) {
    await selfTest();
  } else if (!a.doc || !a.manifest) {
    console.log('✗ 缺 --doc / --manifest（--help 看用法）');
    process.exitCode = EXIT.USAGE;
  } else {
    try {
      if (a.record) {
        if (!a.out) { console.log('✗ --record 需 --out <产物目录>'); process.exitCode = EXIT.USAGE; }
        else {
          const r = await record({ doc: a.doc, manifestPath: a.manifest, outDir: a.out, stage1: a.stage1 });
          for (const w of r.written) console.log(`RECORDED  ${w.file}  [${w.artifact.verdict}] ${w.artifact.detail ?? ''}`);
          console.log(`[汇总] 已落 ${r.written.length} 份产物 · 送审件 sha16 ${r.doc.sha16}`);
          process.exitCode = EXIT.OK;
        }
      } else {
        const r = await replay({ doc: a.doc, manifestPath: a.manifest, artifactsDir: a.artifacts ?? a.out ?? path.dirname(path.resolve(a.manifest)), stage1: a.stage1 });
        process.exitCode = reportReplay(r);
      }
    } catch (e) {
      console.log(`✗ ${e.message}`);
      process.exitCode = EXIT.INTERNAL;
    }
  }
}
