#!/usr/bin/env node
/**
 * Linux 适配检查：在临时副本上模拟 Linux 安装目录，验证探测、打补丁、幂等与还原。
 *
 * 用法：
 *   DSH_ROOT=/opt/DeepSeek Harness/resources/dsh node scripts/test-linux.cjs
 *
 * 脚本不改动真实安装；只读取 DSH_ROOT 里的两个原生产物作为样本。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const {patchChat, patchConversation, normalizePackagesDir} = require('./patch-native.cjs');

const root = process.env.DSH_ROOT || '/opt/DeepSeek Harness/resources/dsh';
const packages = ['dsh-client-ui-chat', 'dsh-client-ui-conversation'];
const pristine = path.join(__dirname, '..', 'backups');
const sources = packages.map((p) => {
  const saved = path.join(pristine, `${p}.client.js`);
  return fs.readFileSync(fs.existsSync(saved) ? saved : path.join(root, 'node_modules', '@deepseek-ai', p, 'lib', 'client.js'), 'utf8');
});

// 补丁本身必须语法合法，且包含附件恢复与撤回重放过滤
const patched = [patchChat(sources[0]), patchConversation(sources[1])];
for (const source of patched) new vm.Script(source);
assert(patched[0].includes('stageRestoredAttachments?.(sessionId,result.attachments)'));
assert(patched[0].includes('sessionId, inputActions, retractMessage'));
assert(patched[1].includes('stageRestoredAttachments'));
assert(patched[1].includes('native-retract/attachments-restored'));
assert(patched[1].includes('function nativeRetractVisible('));

// 历史重放过滤：撤回区间与其 command 行必须从界面消失
const filterSource = patched[1].slice(
  patched[1].indexOf('function nativeRetractVisible('),
  patched[1].indexOf('var ConversationNodeAssembler = class'),
);
const visible = new Function(`${filterSource};return nativeRetractVisible`)();
const entries = [
  {seq: 0, type: 'user/message', data: {}},
  {seq: 1, type: 'user/message', data: {}},
  {seq: 2, type: 'command/run', data: {name: 'native-retract', commandId: 'c'}},
  {seq: 3, type: 'user/message', data: {id: 'rewind-native:1:test'}},
  {seq: 4, type: 'command/done', data: {commandId: 'c'}},
  {seq: 5, type: 'user/message', data: {}},
].map((event) => ({event}));
assert.deepEqual(visible(entries).map((r) => r.event.seq), [0, 3, 5]);

// 目录归一化：允许传 node_modules、@deepseek-ai 或安装根
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retract-linux-'));
try {
  const repo = path.join(temp, 'repo');
  const installRoot = path.join(temp, 'opt', 'DeepSeek Harness', 'resources', 'dsh');
  fs.mkdirSync(path.join(repo, 'scripts'), {recursive: true});
  fs.copyFileSync(path.join(__dirname, 'patch-native.cjs'), path.join(repo, 'scripts', 'patch-native.cjs'));
  const targets = packages.map((pkg, index) => {
    const file = path.join(installRoot, 'node_modules', '@deepseek-ai', pkg, 'lib', 'client.js');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, sources[index]);
    return file;
  });
  for (const value of [installRoot, path.join(installRoot, 'node_modules'), path.join(installRoot, 'node_modules', '@deepseek-ai')]) {
    assert.equal(normalizePackagesDir(value), path.join(installRoot, 'node_modules', '@deepseek-ai'));
  }

  const run = (...args) => {
    const result = spawnSync(process.execPath, [path.join(repo, 'scripts', 'patch-native.cjs'), '--dir', installRoot, ...args], {stdio: 'pipe', encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };

  run('--dry-run');
  targets.forEach((file, index) => assert.equal(fs.readFileSync(file, 'utf8'), sources[index]));

  run();
  const installed = targets.map((file) => fs.readFileSync(file, 'utf8'));
  assert(installed[0].startsWith('/* native-retract-v1 */'));
  assert(installed[1].includes('stageRestoredAttachments'));

  const again = run();
  assert(/已是补丁版本/.test(again));
  targets.forEach((file, index) => assert.equal(fs.readFileSync(file, 'utf8'), installed[index]));

  run('--restore', '--dry-run');
  targets.forEach((file, index) => assert.equal(fs.readFileSync(file, 'utf8'), installed[index]));

  run('--restore');
  targets.forEach((file, index) => assert.equal(fs.readFileSync(file, 'utf8'), sources[index]));

  // 备份被修改时不得覆盖（升级保护）
  fs.writeFileSync(path.join(repo, 'backups', `${packages[0]}.client.js`), 'stale');
  const failed = spawnSync(process.execPath, [path.join(repo, 'scripts', 'patch-native.cjs'), '--dir', installRoot], {stdio: 'pipe', encoding: 'utf8'});
  assert.notEqual(failed.status, 0);
  assert(/备份/.test(failed.stdout + failed.stderr));
  targets.forEach((file, index) => assert.equal(fs.readFileSync(file, 'utf8'), sources[index]));
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}

console.log('PASS Linux: bundle syntax, attachment restore, replay filter, path normalization, spaced paths, dry-run, patch, idempotency, restore, backup guard');
