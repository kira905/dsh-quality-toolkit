#!/usr/bin/env node
// dsh-l3-pitfall-reminder / install.mjs
//
// 把 L3 实时提醒插件挂到某个 DSH profile（默认：生产 home 的 web profile）。
//
// 两步（都幂等）：
//   ① 部署插件实体到 <home>\profiles\<profile>\node_modules\dsh-l3-pitfall-reminder
//      （默认 copy 副本 —— 避开 ROG 上 360 企业 EDR 拦「创建文件链接」的弹窗；--mode link 可建 junction）
//   ② 在 <home>\profiles\<profile>\cordis.patch.yml 里插入带标记的一段 insert
//
// 铁律：**默认 dry-run**，必须显式 --apply 才动盘；改动前自动备份 cordis.patch.yml。
//
//   node install.mjs                 # 预览（dry-run）
//   node install.mjs --apply         # 落盘（重启后生效）
//   node ...\install.mjs --apply --home <OFFSYNC_ROOT>\DSH-test\.dsh      # 隔离实例
//   node ...\install.mjs --rollback --apply                               # 一键卸掉
//
// 注：开关默认关 ⇒ 挂上也不改行为；开关文件热读，**开/关都不用重启**，只有挂载/卸载要重启。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = 'dsh-l3-pitfall-reminder';
const BEGIN = '# >>> l3-pitfall-reminder (P4 L3 实时提醒 · 默认关)';
const END = '# <<< l3-pitfall-reminder';
const PATCH_BLOCK = `${BEGIN}
# 命中坑库时向当前会话投递一条提醒（挂点 tools/post-execute，官方同款先例 = dsh-repeat-tool-reminder）。
# 开关：~/.dsh/butler-l3-reminder.json（不存在或 enabled!=true ⇒ 零动作）。开关热读，**改开关不用重启**。
# 交付与判据见 docs\\交付报告-冲刺600-P4-L3提醒-20261009.md；卸载：本段整段删掉（或跑 install.mjs --rollback --apply）。
- insert:
    - id: ${PKG_NAME}
      name: '${PKG_NAME}'
      config:
        maxPerSession: 3
        cooldownMs: 240000
${END}
`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const apply = has('--apply');
const rollback = has('--rollback');
const mode = val('--mode', 'copy');
const profile = val('--profile', 'web');
const home = path.resolve(val('--home') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const profileDir = path.join(home, 'profiles', profile);
const destDir = path.join(profileDir, 'node_modules', PKG_NAME);
const patchFile = path.join(profileDir, 'cordis.patch.yml');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(process.env.DSH_ROOT || path.join(os.homedir(), 'DSH'), '_archive', `l3-pitfall-reminder-${stamp}`);

function log(...a) { console.log(...a); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function walkFiles(root, base = root, out = []) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '_tmp') continue;
      walkFiles(full, base, out);
    } else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

function planDeploy() {
  const wanted = walkFiles(HERE);
  const diffs = [];
  for (const rel of wanted) {
    const src = fs.readFileSync(path.join(HERE, rel));
    const dst = path.join(destDir, rel);
    let same = false;
    try { same = sha256(fs.readFileSync(dst)) === sha256(src); } catch { same = false; }
    diffs.push({ rel, same, bytes: src.length });
  }
  return { wanted, diffs, toWrite: diffs.filter((d) => !d.same).length };
}

function planPatch() {
  const exists = fs.existsSync(patchFile);
  const text = exists ? fs.readFileSync(patchFile, 'utf8') : '';
  const hasBlock = text.includes(BEGIN);
  return { exists, text, hasBlock };
}

// ------------------------------------------------------------------ 主流程
log(`# dsh-l3-pitfall-reminder install ${apply ? '[APPLY]' : '[DRY-RUN]'}${rollback ? ' [ROLLBACK]' : ''}`);
log(`  home        = ${home}`);
log(`  profile     = ${profile}  (${profileDir})`);
log(`  plugin src  = ${HERE}`);
log(`  deploy mode = ${mode}`);
log('');

if (!fs.existsSync(profileDir)) {
  log(`❌ profile 目录不存在：${profileDir}`);
  process.exitCode = 2;
  process.exit();
}

if (rollback) {
  const pp = planPatch();
  log('① 卸载 patch 段：');
  log(`   ${pp.hasBlock ? '找到标记段 ⇒ 会删除' : '未找到标记段 ⇒ 跳过'}`);
  log('② 删除部署副本/链接：');
  let destKind = '不存在';
  try {
    const st = fs.lstatSync(destDir);
    destKind = st.isSymbolicLink() ? 'junction/链接' : '实体目录';
  } catch { /* 不存在 */ }
  log(`   ${destDir}  → ${destKind}`);
  if (!apply) {
    log('\n[DRY-RUN] 未做任何改动。确认后加 --apply。');
    process.exit();
  }
  fs.mkdirSync(backupRoot, { recursive: true });
  if (fs.existsSync(patchFile)) {
    fs.copyFileSync(patchFile, path.join(backupRoot, 'cordis.patch.yml.bak'));
    const t = fs.readFileSync(patchFile, 'utf8');
    const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'm');
    fs.writeFileSync(patchFile, t.replace(re, ''), 'utf8');
    log(`   ✅ patch 段已删除（备份 ${backupRoot}\\cordis.patch.yml.bak）`);
  }
  if (destKind === 'junction/链接') {
    // ⚠️ 含链接的目录绝不用 Remove-Item -Recurse / fs.rmSync（会跟删目标）⇒ 只摘链接本体
    try { fs.unlinkSync(destDir); log('   ✅ junction 已摘除（只删链接，未动目标）'); } catch (e) { log(`   ⚠ 摘除失败：${e.message}`); }
  } else if (destKind === '实体目录') {
    fs.rmSync(destDir, { recursive: true, force: true });
    log('   ✅ 实体副本已删除');
  } else {
    log('   （本就没有部署物）');
  }
  log('\n[OK] 卸载完成 —— 重启 dsh 后生效（走 P0 闸门）。');
  process.exit();
}

// —— 挂载
const dp = planDeploy();
const pp = planPatch();
log('① 部署插件实体：');
log(`   源文件 ${dp.wanted.length} 个，其中 ${dp.toWrite} 个需要写入/更新`);
for (const d of dp.diffs) log(`     ${d.same ? '=' : '+'} ${d.rel}${d.same ? '（一致，跳过）' : `（${d.bytes} B）`}`);
log('② cordis.patch.yml：');
log(`   ${patchFile}`);
log(`   ${pp.exists ? '存在' : '不存在（会新建）'}；${pp.hasBlock ? '已含标记段（幂等：跳过）' : '将插入标记段'}`);
log('\n--- 将插入的段 ---');
log(PATCH_BLOCK.trimEnd());
log('--------------------');

if (!apply) {
  log('\n[DRY-RUN] 未做任何改动。确认后加 --apply 落盘（落盘后需重启 dsh 生效，重启走 P0 闸门）。');
  process.exit();
}

// 备份
fs.mkdirSync(backupRoot, { recursive: true });
if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, path.join(backupRoot, 'cordis.patch.yml.bak'));
fs.writeFileSync(path.join(backupRoot, 'manifest.json'), JSON.stringify({
  at: new Date().toISOString(), home, profile, mode,
  destDir, patchFile, pluginSrc: HERE,
  rollback: `node install.mjs --rollback --apply --home "${home}" --profile ${profile}`,
}, null, 1), 'utf8');

// ① 部署
if (fs.existsSync(destDir)) {
  const st = fs.lstatSync(destDir);
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(destDir); } catch { /* 忽略 */ }
  } else {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
}
if (mode === 'link') {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(HERE, destDir, type);
  log(`   ✅ junction 建好：${destDir} → ${HERE}`);
} else {
  fs.mkdirSync(destDir, { recursive: true });
  for (const rel of dp.wanted) {
    const src = path.join(HERE, rel);
    const dst = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  log(`   ✅ 副本已就位：${destDir}（${dp.wanted.length} 个文件）`);
}

// ② patch
{
  let text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  if (!text.includes(BEGIN)) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    text += `${text.trim().length > 0 ? '\n' : ''}${PATCH_BLOCK}`;
    fs.writeFileSync(patchFile, text, 'utf8');
    log(`   ✅ patch 段已插入（原文件备份 ${backupRoot}\\cordis.patch.yml.bak）`);
  } else {
    log('   = 已含标记段，跳过（幂等）');
  }
}

// ③ 开关文件（保持默认关；只在不存在时写一份默认关的，便于主人找到它）
const swFile = path.join(home, 'butler-l3-reminder.json');
if (!fs.existsSync(swFile)) {
  fs.writeFileSync(swFile, JSON.stringify({
    schemaVersion: 1, enabled: false, dryRun: false, maxPerSession: 3, cooldownMs: 240000,
    storePath: '', logPath: '', updatedAt: new Date().toISOString(),
    note: 'P4 L3 实时提醒开关。enabled=false（默认）时插件零动作；改本文件即时生效，无需重启。',
  }, null, 1), 'utf8');
  log(`   ✅ 开关文件已写（默认关）：${swFile}`);
} else {
  log(`   = 开关文件已存在，未动：${swFile}`);
}

log(`\n[OK] 挂载完成。备份/回滚清单：${backupRoot}\\manifest.json`);
log('下一步：重启 dsh（走 P0 闸门）后插件才会加载；开关默认关 ⇒ 重启不改任何行为。');
log(`开提醒： node ${path.join(HERE, 'bin', 'l3-reminder.mjs')} --on --apply`);
