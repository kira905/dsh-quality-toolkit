// dsh-l3-pitfall-reminder / lib/index.js
//
// P4 L3「实时提醒」插件 —— 干活过程中命中坑库时，向**当前会话**投递一条提醒。
//
// 挂点（源码级判据见交付报告 §2）：
//   ctx.on('tools/post-execute', (exec, result, next))
//     └ emit 点 @deepseek-ai/dsh-tools/lib/index.js:3377-3378（`postExecute` 跑 waterfall），
//       失败结果同样流经此点（同文件 :3202-3204 注释 + :3392「failed result 不能替换 value」），
//       决策体的 `additionalContexts` 在 :3390 被合并、最终注入模型上下文。
//       官方同款先例：@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js:1495-1508。
//
// 设计约束：
//   · **默认关** —— 开关文件 ~/.dsh/butler-l3-reminder.json 缺失或 enabled!=true ⇒ 零动作。
//   · 任何内部异常都不得抛回 waterfall（throw 会被上层转成工具 isError）。
//   · 零外部依赖（只 import 同目录 .mjs + node: 内置），避免被 profile 解析链绑死。
import { createRuntime } from './store.mjs';
import { prependContext } from './core.mjs';

export const name = 'l3-pitfall-reminder';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{maxPerSession?:number, cooldownMs?:number, hostname?:string, toolFilter?:string[]}} [config]
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime(config);
  const disable = ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next(); // 下游（含 block 决策）先跑完；它的异常照常向上抛，不归我们吞
    let decision = null;
    try {
      decision = runtime.observe(exec, result);
    } catch (e) {
      runtime.noteError(e);
      return downstream;
    }
    if (!decision || !decision.message) return downstream;
    if (downstream && downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: prependContext(decision.message, downstream.additionalContexts),
      };
    }
    return {
      ...downstream,
      additionalContexts: prependContext(decision.message, downstream?.additionalContexts),
    };
  });
  // 便于热重载/测试时显式摘除（cordis 也会随 fiber dispose 自动摘）
  return disable;
}
