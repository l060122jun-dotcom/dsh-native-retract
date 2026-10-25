const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const {patchChat, patchConversation} = require('./patch-native.cjs');
const root = process.env.DSH_ROOT;
if (!root) throw new Error('Set DSH_ROOT to the Desktop resources/app directory');
const packages = ['dsh-client-ui-chat', 'dsh-client-ui-conversation'];
const originals = packages.map(p => fs.readFileSync(path.join(root,'node_modules','@deepseek-ai',p,'lib','client.js'),'utf8'));
for (const source of originals) new vm.Script(source);
// 已打过补丁的安装：优先从仓库备份取未修改产物，保证测试始终针对原始结构
const pristine = path.join(__dirname,'..','backups');
const sources = packages.map((p,i) => {
  const saved = path.join(pristine, p + '.client.js');
  return fs.existsSync(saved) ? fs.readFileSync(saved,'utf8') : originals[i];
});
const patched = [patchChat(sources[0]), patchConversation(sources[1])];
for (const source of patched) new vm.Script(source);
assert(patched[1].includes('stageRestoredAttachments'));
assert(patched[1].includes('native-retract/attachments-restored'));
assert(patched[1].includes('receiptId: attachment.restored'));
assert(patched[1].includes('attachment.restored !== void 0 && this.fileUploads.getSnapshot()[attachment.id]?.status === "ready"'));
assert(patched[0].includes('ui.stageRestoredAttachments(sessionId,list)'));
assert(!/const onRetract=[\s\S]*?ctx\.get\("uiConversation"\)/.test(patched[0].slice(patched[0].indexOf('const onRetract=async()=>'), patched[0].indexOf('const onRetract=async()=>') + 1200)));
assert(!patched[0].includes('const allowed=useAccess("commands/execute");'));
assert(patched[0].includes('await inputActions.persistDraft?.()'));
assert(patched[0].includes('retractPending.current=true'));
const handler = patched[0].slice(patched[0].indexOf('const onRetract=async()=>'), patched[0].indexOf('\n };',patched[0].indexOf('const onRetract=async()=>')) + 4);
(async () => {
  let draft, calls=0;
  const invoke = new Function('inputActions','retractMessage','sessionId','node','retractPending','setRetracting','window','t', handler + ';return onRetract;');
  const retract = invoke({setDraft:t=>draft=t},async(id,seq)=>{assert.equal(id,'test');assert.equal(seq,7);calls++;return {text:'恢复原文'}},'test',{data:{seq:7}},{current:false},()=>{}, {alert:e=>{throw Error(e)}},k=>k);
  await Promise.all([retract(),retract()]);
  assert.equal(calls,1); assert.equal(draft,'恢复原文');
  const start=patched[1].indexOf('function nativeRetractVisible(');
  const end=patched[1].indexOf('var ConversationNodeAssembler = class',start);
  const visible=new Function(patched[1].slice(start,end)+';return nativeRetractVisible')();
  const events=[{seq:0,type:'user/message',data:{}},{seq:1,type:'user/message',data:{}},{seq:2,type:'command/run',data:{name:'native-retract',commandId:'c'}},{seq:3,type:'user/message',data:{id:'rewind-native:1:test'}},{seq:4,type:'command/done',data:{commandId:'c'}},{seq:5,type:'user/message',data:{}}].map(event=>({event}));
  assert.deepEqual(visible(events).map(r=>r.event.seq),[0,3,5]);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-retract-win-'));
  try {
    const repo=path.join(temp,'repo'), target=path.join(temp,'DSH Desktop','resources','app');
    fs.mkdirSync(path.join(repo,'scripts'),{recursive:true});
    fs.copyFileSync(__filename.replace('test-windows.cjs','patch-native.cjs'),path.join(repo,'scripts','patch-native.cjs'));
    const paths=packages.map((p,i)=>{const f=path.join(target,'node_modules','@deepseek-ai',p,'lib','client.js');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,originals[i]);return f});
    const run=(...args)=>{const r=spawnSync(process.execPath,[path.join(repo,'scripts','patch-native.cjs'),'--dir',target,...args],{stdio:'inherit'});assert.equal(r.status,0)};
    run('--dry-run'); paths.forEach((f,i)=>assert.equal(fs.readFileSync(f,'utf8'),originals[i]));
    run(); const installed=paths.map(f=>fs.readFileSync(f,'utf8'));
    run(); paths.forEach((f,i)=>assert.equal(fs.readFileSync(f,'utf8'),installed[i]));
    run('--restore','--dry-run'); paths.forEach((f,i)=>assert.equal(fs.readFileSync(f,'utf8'),installed[i]));
    run('--restore'); paths.forEach((f,i)=>assert.equal(fs.readFileSync(f,'utf8'),originals[i]));
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
  console.log('PASS Windows: actual bundle syntax, memo component, draft API, double-click guard, replay filter, spaced paths, dry-run, install, idempotency, restore');
})().catch(e=>{console.error(e);process.exitCode=1});
