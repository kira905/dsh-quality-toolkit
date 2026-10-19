# dsh-l3-pitfall-reminder

P4「会学习」L3 层 —— **实时提醒**：干活过程中工具调用失败、且这次失败命中已归档坑库时，
向**当前会话**投递一条提醒（附上坑的签名、历史次数、坑库文档绝对路径）。

> 交付与全部取证：`<DSH_ROOT>\docs\交付报告-冲刺600-P4-L3提醒-20261009.md`
> **默认关**（开关文件不存在 ⇒ 零动作）。

## 挂点（为什么这么挂）

`ctx.on('tools/post-execute', (exec, result, next))` —— 失败结果同样流经该 waterfall：

- 发射点：`@deepseek-ai/dsh-tools/lib/index.js:3377-3378`（`postExecute` → `ctx.waterfall(..., 'tools/post-execute', exec, result, …)`）
- 失败也走：同文件 `:3202-3204`（注释）+ `:3392`（`failed result cannot replace the value` 反证）
- 注入：决策体返回 `additionalContexts`，在 `:3390` 合并；消费于 `dsh-agent-loop/lib/index.js:576-578`
- 官方同款先例：`@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js:1495-1508`

**零外部依赖**（只 import 同目录 `.mjs` + `node:` 内置），所以插件实体放哪都不会被 profile 的解析链绑死。

## 开关（热读，改完不用重启）

`%USERPROFILE%\.dsh\butler-l3-reminder.json`

```json
{
  "enabled": false,      // 默认关；关着时插件零动作、不落日志
  "dryRun": false,       // true = 命中只记日志、不注入
  "maxPerSession": 3,    // 每会话最多提醒几条
  "cooldownMs": 240000,  // 两条提醒之间的最小间隔
  "storePath": "",       // 留空 = <home>/butler-pitfalls.json
  "logPath": ""          // 留空 = <home>/butler-l3-reminder.log
}
```

## 用法

```powershell
$cli = '<DSH_ROOT>\tools\dsh-l3-pitfall-reminder\bin\l3-reminder.mjs'
node $cli --status                  # 看开关/坑库/日志
node $cli --on --apply              # 打开（即时生效，不用重启）
node $cli --off --apply             # 关回
node $cli --dry-run on --apply      # 只记不注入
node $cli --tail 20                 # 看最近命中
node $cli --match 'Error: old_string was not found in "<path>\x.txt"' --name FsError --code FS_EDIT_NOT_FOUND --tool edit
```

## 挂载 / 卸载（生产 profile）

```powershell
node install.mjs                 # 预览（默认 dry-run）
node install.mjs --apply         # 落盘（**重启后**才加载）
node install.mjs --rollback --apply   # 一键卸掉
```

挂载 = ① 插件副本 → `<home>\profiles\<profile>\node_modules\` ② `cordis.patch.yml` 插一段带标记的 `insert`。
**只能是 `insert`，不能进 `dsh.profile.bundles`** —— 后者要求包声明 `dsh.bundle`（实测报错：`declares no dsh.bundle`）。

## 测试

```powershell
node _test\test-core.mjs   # 30 条，含生产坑库口径对照
```

## 口径对齐（改代码前必读）

运行时算出的签名必须与 `dsh-butler` 的 P4 扫描侧一致，否则永不命中：

| 要素 | 扫描侧 | 运行时 | 桥接证据 |
|---|---|---|---|
| 错误文本 | `pitfall-scan.mjs:127-138` `collectText`（递归、`'\n'` 连接） | 复刻同款 | `dsh-agent-loop:700`（日志 content ≡ 运行时 content） |
| name/code | 日志 `data.error.name/.code` | `result.error.info.name/.code` | **`dsh-agent-loop:707`：`error: result.error.info`** |
| 签名规则 | `pitfall-sign.mjs:65-83` | `lib/normalize.mjs`（移植件，254 样本零差异） | 单测咬死 |

⚠️ `lib/normalize.mjs` 是移植件：`dsh-butler/lib/pitfall-sign.mjs` 的 `NORMALIZERS` 一改，这里必须同步改并重跑对照测试。
