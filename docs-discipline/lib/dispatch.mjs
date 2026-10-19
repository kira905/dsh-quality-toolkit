// lib/dispatch.mjs —— 判据脚本的**统一调用表**（check-rootcause 与 selfcheck-rerun 共用）
// 设计要点：全部走 **动态 import 同行模块**（同一 .mjs 即函数库），**不起子进程 / 不走管道 stdio**
//   ⇒ 不受"受限模式下 piped stdio EPERM"影响，也不会因为 CLI 参数拼写而在复跑时与自核不一致。
// 本文件是唯一"工具名 → 调用方式"的映射处；新增判据脚本时在这里加一行（并补一条自测）。

import fs from 'node:fs';
import path from 'node:path';

const mods = new Map();

export async function loadTool(name) {
  if (!mods.has(name)) mods.set(name, await import(new URL(`../${name}.mjs`, import.meta.url).href));
  return mods.get(name);
}

export const TOOLS = {
  'check-cites': {
    class: 'exact',
    call: (m, fx) => {
      const r = m.check({ docPath: fx.doc, reportPath: fx.report, section: fx.section });
      return { verdict: r.hard.length ? 'FAIL' : 'PASS', n: r.hard.length, detail: `引用 ${r.rows.length} 处 / 错配 ${r.hard.length}` };
    },
  },
  'check-promises': {
    class: 'exact',
    call: (m, fx) => {
      const r = m.check({ doc: fx.doc, claims: m.parseClaims(fx.claims) });
      return { verdict: r.bad.length ? 'FAIL' : 'PASS', n: r.bad.length, detail: `承诺 ${r.rows.length} 项 / 失败 ${r.bad.length}` };
    },
  },
  'check-caliber': {
    class: 'exact',
    call: (m, fx) => {
      const r = fx.changed ? m.caliberCheck({ doc: fx.doc, changedPath: fx.changed, oldPath: fx.old }) : m.scopeCheck(fx.doc);
      return { verdict: r.bad.length ? 'FAIL' : 'PASS', n: r.bad.length, detail: `抽查 ${r.rows.length} · 缺项/未重写 ${r.bad.length}` };
    },
  },
  'check-residue': {
    class: 'exact',
    call: (m, fx) => {
      const r = m.run({ doc: fx.doc, report: fx.report, snapshot: fx.snapshot, valuesPath: fx.values });
      return { verdict: r.doc.hits.judge.length ? 'FAIL' : 'PASS', n: r.doc.hits.judge.length, detail: `判定面 ${r.doc.hits.judge.length} · 展示面 ${r.doc.hits.show.length + r.report.hits.show.length}` };
    },
  },
  'check-selfclaim': {
    class: 'exact',
    call: (m, fx) => {
      const r = m.check({ reportPath: fx.report, diffPath: fx.diff, section: fx.section });
      return { verdict: r.bad.length ? 'FAIL' : 'PASS', n: r.bad.length, detail: `自述 ${r.rows.length} 行 / 相抵 ${r.bad.length}` };
    },
  },
  'check-volume': {
    // 计数类：复跑时不做数值基准（第 7 条"计数类产物不作基准"）——只比判定，不比读数值
    class: 'count',
    call: (m, fx) => {
      const r = m.run({ doc: fx.doc, round: fx.round });
      return { verdict: r.ok && r.bytesOk ? 'PASS' : 'FAIL', n: r.ok ? r.chapterBytes : -1, detail: r.ok ? `章节 ${r.chapterBytes} B / 全档 ${r.totalGc} 行` : r.error };
    },
  },
  'check-rounds': {
    class: 'exact',
    call: (m, fx) => {
      const r = m.run({ doc: fx.doc });
      return { verdict: (r.gaps.length || (r.decls.length && !r.declOk)) ? 'FAIL' : 'PASS', n: r.gaps.length, detail: `轮次 ${r.seq.length} · 断点 ${r.gaps.length}` };
    },
  },
  'scan-four': {
    // 四扫恒 report：判定恒 PASS（命中数只进展示，不作收敛判据）⇒ class=count（复跑不比数值）
    class: 'count',
    call: (m, fx) => {
      const r = m.runFour({ doc: fx.doc });
      const hits = r.ok ? r.hits.r1 + r.hits.r1b + r.hits.r2 + r.hits.r3 + r.hits.r4 : -1;
      return { verdict: 'PASS', n: hits, detail: r.ok ? `命中 ${hits}（只报不拦）` : r.error };
    },
  },
  'selfcheck-rerun': {
    // 复跑器自己也被复跑（第 8 轮「边改边审 / 送审件漂移」族的回测入口）。
    // 这里只做**同步等价判定**（产物存在性 + 产物记录的送审件 sha vs 当前 sha）；完整 replay 走 CLI。
    class: 'exact',
    call: (m, fx) => {
      const curSha = m.sha16;
      const dir = fx.artifacts;
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
      if (!files.length) return { verdict: 'FAIL', n: -1, detail: '产物缺失 ⇒ 判自核未执行' };
      let bad = 0;
      for (const f of files) {
        try {
          const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (a.docSha16 !== curSha) bad++;
        } catch { bad++; }
      }
      return { verdict: bad ? 'FAIL' : 'PASS', n: bad, detail: `${files.length} 份产物 · sha 不符 / 不可读 ${bad}` };
    },
  },
};

export async function runTool(name, fx) {
  const spec = TOOLS[name];
  if (!spec) throw new Error(`未知判据脚本：${name}（请在 lib/dispatch.mjs 登记）`);
  const m = await loadTool(name);
  const r = spec.call(m, fx ?? {});
  return { tool: name, class: spec.class, ...r };
}

export function toolNames() {
  return Object.keys(TOOLS);
}
