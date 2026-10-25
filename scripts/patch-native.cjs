#!/usr/bin/env node
/**
 * 给已安装的 DSH 原生客户端产物打撤回按钮补丁（Windows / macOS / Linux）。
 *
 * 用法：
 *   node scripts/patch-native.cjs                 # 自动探测安装目录，从备份还原后再打补丁
 *   node scripts/patch-native.cjs --restore       # 只还原，不打补丁
 *   node scripts/patch-native.cjs --dry-run       # 只报告探测结果与可打性，不写文件
 *   node scripts/patch-native.cjs --dir <path>    # 手动指定 @deepseek-ai 目录
 *
 * 环境变量：
 *   DSH_NODE_MODULES = <.../node_modules/@deepseek-ai>   （最高优先级，等于 --dir）
 *   DSH_HOME         = dsh 安装根目录（其下有 resources/dsh 或 node_modules）
 *
 * 修改对象（安装包内编译后的 client.js，没有源码构建入口）：
 *   - dsh-client-ui-chat         消息操作栏加「撤回」按钮，用户消息节点接上撤回动作
 *   - dsh-client-ui-conversation 历史重放时隐藏被撤回区间的记录与 command 记录
 *
 * 首次修改前把原文件备份到 <repo>/backups/，重复执行不会叠加补丁。
 * 目标文件只读或权限不足时给出明确提示（Windows 通常需要管理员终端）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const PKG_DIR = '@deepseek-ai';
const PACKAGES = ['dsh-client-ui-chat', 'dsh-client-ui-conversation'];
const MARK = '/* native-retract-v1 */';
const backups = path.join(__dirname, '..', 'backups');

const argv = process.argv.slice(2);
const restoreOnly = argv.includes('--restore');
const dryRun = argv.includes('--dry-run');
const dirArg = valueOf('--dir') ?? process.env.DSH_NODE_MODULES ?? '';

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function log(message) {
  console.log(message);
}

function fail(message) {
  console.error('\n[失败] ' + message);
  process.exitCode = 1;
}

/* ---------------------------------------------------------------- 目录探测 */

function normalizePackagesDir(value) {
  if (!value) return undefined;
  let dir = value;
  // 接受安装根、node_modules、@deepseek-ai 或包目录本身
  if (path.basename(dir) === 'node_modules') dir = path.join(dir, PKG_DIR);
  else if (path.basename(dir) !== PKG_DIR) {
    const nested = path.join(dir, 'node_modules', PKG_DIR);
    if (fs.existsSync(nested)) dir = nested;
    else if (fs.existsSync(path.join(path.dirname(dir), PKG_DIR))) dir = path.dirname(dir);
  }
  return fs.existsSync(dir) ? dir : undefined;
}

/** 一个 @deepseek-ai 目录是否真的含有这两个目标包。 */
function isUsable(dir) {
  return PACKAGES.every((pkg) => fs.existsSync(path.join(dir, pkg, 'lib', 'client.js')));
}

/** Linux 桌面壳安装根：/opt、/usr/lib、snap、AppImage 与用户级 .local/share。 */
function linuxRoots(home) {
  const roots = [];
  for (const base of ['/opt', '/usr/lib', '/usr/local/lib', '/usr/share', '/Applications']) {
    for (const name of ['DSH Desktop', 'DeepSeek Harness', 'deepseek-harness', 'DSH', 'dsh']) {
      if (name.startsWith('/')) continue;
      roots.push(path.join(base, name));
    }
  }
  for (const name of ['DSH Desktop', 'DeepSeek Harness', 'deepseek-harness']) {
    roots.push(path.join(home, '.local', 'share', name));
    roots.push(path.join(home, 'Applications', name));
  }
  // snap 与 flatpak 的常见包名
  for (const name of ['deepseek-harness', 'dsh-desktop', 'dsh']) {
    roots.push(path.join(home, 'snap', name, 'current'));
  }
  return roots;
}

/** 读取桌面壳 launcher（.cmd / .sh / .desktop / .AppImage），仅解析路径，不执行。 */
function launcherRoots(found) {
  const push = (value, source) => {
    const dir = normalizePackagesDir(value);
    if (dir && isUsable(dir) && !found.some((item) => item.dir === dir)) found.push({ dir, source });
  };
  const entries = (process.env.PATH || '').split(path.delimiter);
  const launchers = [];
  for (const entry of entries) {
    const dir = entry.replace(/^"|"$/g, '');
    for (const name of ['dsh.cmd', 'dsh', 'dsh-desktop', 'DeepSeek Harness', 'deepseek-harness']) {
      launchers.push(path.join(dir, name));
    }
  }
  const desktop = path.join(process.env.HOME || os.homedir(), '.local', 'share', 'applications');
  try {
    for (const name of fs.readdirSync(desktop)) {
      if (name.endsWith('.desktop')) launchers.push(path.join(desktop, name));
    }
  } catch {}
  for (const launcher of launchers) {
    let text;
    try {
      const stat = fs.statSync(launcher);
      if (!stat.isFile() || stat.size > 1 << 20) continue;
      text = fs.readFileSync(launcher, 'utf8');
    } catch {
      continue;
    }
    // 指向 <install>/resources/app/lib/desktop-cli.js 的任何写法
    for (const match of text.matchAll(/([^\s"'`]+[\\/]resources[\\/]app[\\/]lib[\\/]desktop-cli\.js)/gi)) {
      push(path.dirname(path.dirname(match[1])), 'launcher ' + path.basename(launcher));
    }
    // AppImage / 桌面壳常见的 Exec= 与 --app-path=
    for (const match of text.matchAll(/--app-path[=\s]+"?([^"\s]+)"?/gi)) {
      push(match[1], 'launcher ' + path.basename(launcher));
    }
  }
}

function candidates() {
  const found = [];
  const push = (value, source) => {
    const dir = normalizePackagesDir(value);
    if (dir && isUsable(dir)) found.push({ dir, source });
  };

  // Explicit paths must never fall through to a different installation.
  if (dirArg) {
    push(dirArg, '--dir / DSH_NODE_MODULES');
    return found;
  }

  // Desktop launchers support custom drives, install names, and Linux packages, without executing them.
  launcherRoots(found);

  // 2) DSH_HOME
  if (process.env.DSH_HOME) {
    push(process.env.DSH_HOME, 'DSH_HOME');
    push(path.join(process.env.DSH_HOME, 'resources', 'dsh'), 'DSH_HOME/resources/dsh');
  }

  // 3) 正在运行的 dsh：本机 profile 链接、以及本脚本所在仓库的上级
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir) push(profileDir, 'DSH_PROFILE_DIR');

  // 4) 平台常见安装位置
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    for (const root of [localAppData, path.join(localAppData, 'Programs'), programFiles, programFilesX86]) {
      for (const name of ['DSH Desktop', 'DeepSeek Harness', 'deepseek-harness', 'DSH', 'dsh']) {
        push(path.join(root, name, 'resources', 'app'), path.join(root, name));
        push(path.join(root, name, 'resources', 'dsh'), path.join(root, name));
      }
    }
    push(path.join(home, '.dsh'), '~/.dsh');
  } else {
    for (const root of linuxRoots(home)) {
      push(path.join(root, 'resources', 'app'), 'linux install root');
      push(path.join(root, 'resources', 'dsh'), 'linux install root');
      push(root, 'linux install root');
    }
    push(path.join(home, '.dsh'), '~/.dsh');
  }

  // 5) 从 Desktop 应用的 node_modules 里找该目录（限深度，避免全盘扫描）
  for (const appRoot of appRoots(home)) walk(appRoot, 0, found);

  return found;
}

function appRoots(home) {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(localAppData, 'Programs'), path.join(localAppData, 'DeepSeek Harness')];
  }
  if (process.platform === 'darwin') return ['/Applications', path.join(home, 'Applications')];
  return ['/opt', '/usr/lib', '/usr/local/lib', '/usr/share', path.join(home, '.local', 'share'), path.join(home, 'Applications')];
}

function walk(root, depth, found) {
  if (depth > 4 || !fs.existsSync(root)) return;
  const direct = path.join(root, 'node_modules', PKG_DIR);
  if (isUsable(direct)) {
    found.push({ dir: direct, source: root });
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    walk(path.join(root, entry.name), depth + 1, found);
  }
}

function resolveBase() {
  const found = candidates();
  const seen = new Set();
  const unique = found.filter((item) => {
    const key = path.resolve(item.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    fail('找不到 DSH 安装目录中的两个目标包。\n'
      + '  请用 --dir 指定，例如：\n'
      + '    Windows: node scripts\\patch-native.cjs --dir "%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\dsh\\node_modules\\@deepseek-ai"\n'
      + '    macOS/Linux: node scripts/patch-native.cjs --dir "/opt/DeepSeek Harness/resources/dsh/node_modules/@deepseek-ai"');
    return undefined;
  }
  if (unique.length > 1) {
    log('[提示] 探测到多个候选目录，使用第一个；如需指定请加 --dir：');
    for (const item of unique) log('   - ' + item.dir + '   (' + item.source + ')');
  }
  log('[探测] ' + unique[0].dir + '   (' + unique[0].source + ')');
  return unique[0].dir;
}

/* ---------------------------------------------------------------- 读写与权限 */

function targetPath(base, pkg) {
  return path.join(base, pkg, 'lib', 'client.js');
}

function backupPath(pkg) {
  return path.join(backups, pkg + '.client.js');
}

/** 写文件并把 Windows / 只读属性导致的失败翻译成可执行的提示。 */
function writeFile(file, content, what) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
  } catch {
    if (process.platform === 'win32') {
      try {
        fs.chmodSync(file, 0o666);
      } catch {
        throw new Error(what + ' 只读或被占用：' + file
          + '\n        先关闭 DSH Desktop，用「管理员 PowerShell」重试；'
          + '\n        或在资源管理器里取消该文件的「只读」属性。');
      }
    }
  }
  try {
    fs.writeFileSync(file, content);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY') {
      throw new Error(what + ' 写入被拒绝（' + error.code + '）：' + file
        + '\n        Windows 上请先退出 DSH Desktop，再用管理员终端运行本脚本；'
        + '\n        杀软/Defender 受控文件夹访问也可能拦截，必要时临时放行该目录。');
    }
    throw error;
  }
}

function statLine(base, pkg) {
  const file = targetPath(base, pkg);
  try {
    const stat = fs.statSync(file);
    return pkg + '  ' + (stat.size + ' B').padEnd(10) + ' mtime ' + stat.mtime.toISOString();
  } catch (error) {
    return pkg + '  不可读: ' + error.message;
  }
}

function isPatched(base, pkg) {
  try {
    return fs.readFileSync(targetPath(base, pkg), 'utf8').startsWith(MARK);
  } catch {
    return false;
  }
}

/** 用备份覆盖目标文件；`--restore` 总会执行，打补丁流程只在已打补丁时回滚一次。 */
function restore(base, pkg, { force = false } = {}) {
  const saved = backupPath(pkg);
  if (!fs.existsSync(saved)) {
    log('[skip] 无备份，未改动: ' + pkg);
    return;
  }
  if (!force && !isPatched(base, pkg)) {
    log('[skip] 未打补丁，无需还原: ' + pkg);
    return;
  }
  writeFile(targetPath(base, pkg), fs.readFileSync(saved, 'utf8'), '还原 ' + pkg);
  log('[restore] ' + pkg + '  (来自 backups/' + pkg + '.client.js)');
}

function sub(source, anchor, replacement) {
  if (!source.includes(anchor)) throw new Error('缺少锚点（DSH 版本可能已变化）: ' + anchor.slice(0, 120));
  return source.replace(anchor, replacement);
}

/* ---------------------------------------------------------------- 补丁内容 */

function patchChat(source) {
  let s = source;
  s = sub(s, '"remote.session",', '"remote.session",\n "remote.commands",');

  s = sub(s,
    'function MessageIconActions({ text, time, clock, onBranch,',
    'function MessageIconActions({ text, time, clock, onRetract, retracting = false, onBranch,');

  s = sub(s, '\t\t\t\t\textraActions,', `\t\t\t\t\tonRetract && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
 label: retracting ? t("message.retracting") : t("message.retract"), side:"bottom",
 children:(0,react_jsx_runtime.jsx)("button", {type:"button", className:MessageIconActions_module_css_default.action, "aria-label":t("message.retract"), disabled:retracting, onClick:onRetract,
 children:(0,react_jsx_runtime.jsx)("svg",{viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.7,"aria-hidden":true,children:(0,react_jsx_runtime.jsx)("path",{d:"M9 4 3 10l6 6M3 10h11a7 7 0 0 1 0 14"})})})}),
\t\t\t\t\textraActions,`);

  const modern = s.includes('function UserMessageNodeView({ node, renderMessageImages, openFile, openSkill, t }) {');
  const viewAnchor = modern
    ? 'function UserMessageNodeView({ node, renderMessageImages, openFile, openSkill, t }) {'
    : 'function UserMessageNodeView({ node, renderFactorySlot, loadImage, t }) {';
  s = sub(s, viewAnchor, viewAnchor.replace('t }) {', 't, sessionId, inputActions, retractMessage, useAccess }) {') + `
 const [retracting,setRetracting]=(0,react.useState)(false);
 const retractPending=(0,react.useRef)(false);
 ${modern ? 'const allowed=typeof retractMessage==="function";' : 'const allowed=useAccess("commands/execute");'}
 const onRetract=async()=>{
   if(retractPending.current)return;
   if(!inputActions || typeof inputActions.setDraft!=="function") {window.alert(t("message.retractFailed")+": draft API unavailable");return;}
   retractPending.current=true;setRetracting(true);
   try {
     const result=await retractMessage(sessionId,node.data.seq);
     inputActions.setDraft(result.text);
     await inputActions.persistDraft?.();
     if(Array.isArray(result.attachments)&&result.attachments.length>0){
       const staged=ctx.get("uiConversation")?.stageRestoredAttachments?.(sessionId,result.attachments)??[];
       if(staged.length<result.attachments.length) window.alert(t("message.retractPartial")+" ("+staged.length+"/"+result.attachments.length+")");
     }
   }
   catch(e){window.alert(t("message.retractFailed")+": "+e.message)}
   finally{retractPending.current=false;setRetracting(false)}
 };`);

  s = sub(s,
    'time: data.time,\n\t\t\t\t\tclock: "start",',
    'time: data.time,\n onRetract: allowed ? onRetract : undefined, retracting,\n\t\t\t\t\tclock: "start",');

  s = sub(s,
    'key: "user",\n\t\t\t\tlocale: NS',
    'key: "user",\n inject:()=>({retractMessage:async(sessionId,seq)=>{const r=await ctx.remote.commands.execute(sessionId,"/native-retract "+seq,[]);if(!r.ok)throw new Error(r.error.message);const result=r.value?.result;if(result?.kind!=="success")throw new Error(result?.text??"撤回失败");return JSON.parse(result.text)}}),\n\t\t\t\tlocale: NS');

  s = sub(s, 'const zh = {',
    'const zh = {\n "message.retract":"撤回", "message.retracting":"撤回中…", "message.retractFailed":"撤回失败", "message.retractPartial":"部分附件未能恢复到输入框",');
  s = sub(s, 'const en = {',
    'const en = {\n "message.retract":"Retract", "message.retracting":"Retracting…", "message.retractFailed":"Retract failed", "message.retractPartial":"Some attachments could not be restored",');
  return s;
}

function patchConversation(source) {
  let s = source;

  /* 1) 恢复后的附件以运行时草稿形式进入输入框，并直接复用已落盘的持久引用 */
  s = sub(s, '\t\t\tcreateDrafts(sessionId, files) {', `\t\t\t/** runtime-only draft attachments staged by native retract */
\t\t\tstageRestoredAttachments(sessionId, items) {
\t\t\t\tconst staged = [];
\t\t\t\tfor (const item of Array.isArray(items) ? items : []) {
\t\t\t\t\tif (item === null || typeof item !== "object" || typeof item.attachmentId !== "string") continue;
\t\t\t\t\tif (item.kind === "image") {
\t\t\t\t\t\tconst draft = {
\t\t\t\t\t\t\tkind: "image",
\t\t\t\t\t\t\tid: randomUUID(),
\t\t\t\t\t\t\trestored: item.attachmentId,
\t\t\t\t\t\t\tpreviewUrl: this.uiConversation.imageUrl(sessionId, { attachmentId: item.attachmentId })
\t\t\t\t\t\t};
\t\t\t\t\t\tthis.draftAttachments.set(draft.id, draft);
\t\t\t\t\t\tstaged.push(draft.id);
\t\t\t\t\t\tcontinue;
\t\t\t\t\t}
\t\t\t\t\tif (item.kind !== "file") continue;
\t\t\t\t\tconst file = new File([new Uint8Array(0)], typeof item.name === "string" && item.name !== "" ? item.name : "file", { type: "application/octet-stream" });
\t\t\t\t\tconst draft = { kind: "file", id: randomUUID(), file, restored: item.attachmentId };
\t\t\t\t\tthis.draftAttachments.set(draft.id, draft);
\t\t\t\t\tthis.fileUploads.update((drafts) => {
\t\t\t\t\t\tdrafts[draft.id] = { status: "ready", file: item };
\t\t\t\t\t});
\t\t\t\t\tstaged.push(draft.id);
\t\t\t\t}
\t\t\t\tif (staged.length > 0) this.rootCtx.emit("native-retract/attachments-restored", sessionId, staged);
\t\t\t\treturn staged;
\t\t\t}
\t\t\tcreateDrafts(sessionId, files) {`);

  s = sub(s,
    'if (attachment?.kind === "file") this.beginFileUpload(sessionId, attachment);',
    'if (attachment?.kind === "file" && !(attachment.restored !== void 0 && this.fileUploads.getSnapshot()[attachment.id]?.status === "ready")) this.beginFileUpload(sessionId, attachment);');

  s = sub(s,
    '\t\t\t\t\tconst result = await this.ctx.fileUpload.upload(sessionId, attachment.file,',
    '\t\t\t\t\tconst result = attachment.restored !== void 0 ? { ok: true, value: { receiptId: attachment.restored, file: { attachmentId: attachment.restored, name: attachment.file.name, bytes: 0 } } } : await this.ctx.fileUpload.upload(sessionId, attachment.file,');

  /* 2) 会话壳收到通知后把附件 id 并入当前草稿 */
  s = sub(s,
    '\t\t\t\tthis.shells.set(binding, shell);',
    '\t\t\t\tthis.shells.set(binding, shell);\n\t\t\t\t/* native retract: restored attachments join the draft rail */\n\t\t\t\tactx.effect(() => actx.on("native-retract/attachments-restored", (id, ids) => {\n\t\t\t\t\tif (id === binding.sessionId && Array.isArray(ids) && ids.length > 0) shell.actions.addAttachments(ids);\n\t\t\t\t}), "ui-conversation: native retract attachments");');

  /* 3) 历史重放过滤被撤回区间 */
  s = sub(s, 'var ConversationNodeAssembler = class {', `function nativeRetractVisible(entries) {
 const cuts=entries.flatMap(r=>{const e=r.event;const m=e.type==="user/message"&&/^rewind-native:(\\d+):/.exec(e.data?.id??"");return m?[[Number(m[1]),e.seq]]:[]});
 const commands=new Set(entries.filter(r=>r.event.type==="command/run"&&r.event.data.name==="native-retract").map(r=>r.event.data.commandId));
 return entries.filter(r=>!commands.has(r.event.data?.commandId)&&!cuts.some(([from,to])=>r.event.seq>=from&&r.event.seq<to));
 }
 var ConversationNodeAssembler = class {`);

  s = sub(s,
    'const sorted = [...entries].sort((left, right) => left.event.seq - right.event.seq);',
    'const sorted = nativeRetractVisible([...entries]).sort((left, right) => left.event.seq - right.event.seq);');

  s = sub(s,
    'append(record) {\n\t\t\t\tconst event = record.event;',
    'append(record) {\n\t\t\t\tconst event = record.event;\n if(event.type==="command/done"&&event.data?.text?.startsWith("{\\"cut\\":"))return "none";\n if(event.type==="user/message"&&event.data?.id?.startsWith("rewind-native:"))return this.replaceWindow([...this.inputs.values(),record],this.hasMore);');

  s = sub(s,
    'const fresh = entries.filter((entry) => !this.inputs.has(entry.event.seq))',
    'const fresh = nativeRetractVisible([...this.inputs.values(),...entries]).filter((entry) => !this.inputs.has(entry.event.seq))');
  return s;
}

/**
 * 两阶段写入：先对每个目标算完补丁，全部成功才开始落盘。
 * 任一锚点缺失（常见于 DSH 升级后）时不动任何文件，避免半成品。
 */
function applyAll(base, jobs) {
  const planned = [];
  const broken = [];
  for (const job of jobs) {
    const file = targetPath(base, job.pkg);
    const current = fs.readFileSync(file, 'utf8');
    if (current.startsWith(MARK)) {
      log('[skip] 已打过补丁: ' + job.pkg);
      continue;
    }
    try {
      const patched = job.transform(current);
      new vm.Script(patched, { filename: file });
      const saved = backupPath(job.pkg);
      if (fs.existsSync(saved) && fs.readFileSync(saved, 'utf8') !== current) {
        throw new Error('已有备份与当前产物不同；请保留旧备份并使用独立备份目录，避免覆盖升级后的文件');
      }
      planned.push({ ...job, current, patched });
    } catch (error) {
      broken.push({ pkg: job.pkg, reason: error.message });
    }
  }

  if (broken.length > 0) {
    for (const item of broken) {
      fail(item.pkg + ' 打补丁失败：' + item.reason);
    }
    log('\n[中止] 有锚点不匹配，未写入任何文件。'
      + '\n       这通常表示 DSH 已升级、原生产物结构变化，需要更新本脚本的锚点后再试。');
    return;
  }

  if (planned.length === 0) return;

  if (dryRun) {
    for (const item of planned) {
      log('[dry-run] ' + item.pkg + ' 可打补丁（' + item.current.length + ' → ' + item.patched.length + ' 字符）');
    }
    return;
  }

  fs.mkdirSync(backups, { recursive: true });
  for (const item of planned) {
    fs.writeFileSync(backupPath(item.pkg), item.current);
    writeFile(targetPath(base, item.pkg), MARK + '\n' + item.patched, '打补丁 ' + item.pkg);
    log('[patch] ' + item.pkg + '  (备份: backups/' + item.pkg + '.client.js)');
  }
}

/* ---------------------------------------------------------------- 主流程 */

function main() {
  log('平台: ' + process.platform + ' (' + process.arch + ')  node ' + process.version);
  const base = resolveBase();
  if (!base) return;

  if (!restoreOnly) {
    const patched = PACKAGES.filter((pkg) => isPatched(base, pkg));
    if (patched.length === PACKAGES.length) {
      log('\n[skip] 两个目标包都已是补丁版本，无需重复执行。');
      log('       需要重打（例如 DSH 升级后）：先 --restore，再重新运行本脚本。');
      return;
    }
    log('\n[目标文件]');
    for (const pkg of PACKAGES) log('  ' + statLine(base, pkg));
    log('');
  }

  if (restoreOnly) {
    for (const pkg of PACKAGES) {
      if (dryRun) log('[dry-run] 将还原（不写入）: ' + pkg);
      else restore(base, pkg, { force: true });
    }
    return;
  }

  applyAll(base, [
    { pkg: 'dsh-client-ui-chat', transform: patchChat },
    { pkg: 'dsh-client-ui-conversation', transform: patchConversation },
  ]);
  if (process.exitCode) return;

  if (dryRun) {
    log('\n[dry-run] 未写入任何文件。');
    return;
  }
  log('完成：重启 DSH Desktop，或在 Web 页面按 Ctrl+Shift+R 强刷后生效。');
}

module.exports = { patchChat, patchConversation, normalizePackagesDir };
if (require.main === module) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
