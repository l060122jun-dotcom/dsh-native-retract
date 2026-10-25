import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const {patchConversation} = createRequire(import.meta.url)('./patch-native.cjs');
const DSH_ROOT = process.env.DSH_ROOT || '/opt/DeepSeek Harness/resources/dsh';
const DSH_PKG = (name) => `${DSH_ROOT}/node_modules/@deepseek-ai/${name}`;
const {Session,SessionSeq} = await import(pathToFileURL(DSH_PKG('dsh-session/lib/index.js')).href);
const {retract} = await import('../index.js');
const s=Session.create('session-native-retract-test');
const user=(text)=>s.append('user/message',{id:'m-'+s.seq,role:'user',source:{kind:'user'},content:[{type:'text',text}]},{surfaceOp:'append'});
s.append('turn/start',{turn:1});const first=user('keep');s.append('turn/end',{turn:1,reason:{kind:'completed'}});
s.append('turn/start',{turn:2});const second=user('restore me');s.append('turn/end',{turn:2,reason:{kind:'completed'}});
s.append('turn/start',{turn:3});user('later');s.append('turn/end',{turn:3,reason:{kind:'completed'}});
let cancelled=0,flushed=0;const agent={session:s,cancel(){cancelled++},async whenIdle(){},async runMaintenance(fn){return fn()}};
const result=await retract({sessions:{async flush(){flushed++}}},agent,second.seq);
assert.equal(result.text,'restore me');assert.equal(result.cut,3);assert.equal(cancelled,1);assert.equal(flushed,1);
assert(s.surface.nodes.includes(first.seq));assert(!s.surface.nodes.includes(second.seq));assert(!s.deriveMessages().some(m=>m.content.some(b=>b.text==='later')));
assert(s.snapshotEvents().some(e=>e.seq===second.seq));
await assert.rejects(()=>retract({sessions:{}},agent,second.seq),/已撤回/);
const after=user('new path');assert(s.deriveMessages().some(m=>m.id===after.data.id));
const fs=await import('node:fs');let code=fs.readFileSync(DSH_PKG('dsh-client-ui-conversation/lib/client.js'),'utf8');
if (!code.includes('function nativeRetractVisible(')) code = patchConversation(code);
const source=code.slice(code.indexOf('function nativeRetractVisible('),code.indexOf('var ConversationNodeAssembler = class'));
const visible=new Function(source+';return nativeRetractVisible')( )(s.snapshotEvents().map(event=>({event})));
assert(visible.some(r=>r.event.seq===first.seq));assert(!visible.some(r=>r.event.seq===second.seq));assert(visible.some(r=>r.event.seq===after.seq));

// 附件撤回：图片与文件引用原样回传，未被误判为文本
const image={type:'image',attachment:{attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',variant:'display'}};
const file={type:'file',attachment:{attachmentId:'sha256:'+'b'.repeat(64),name:'报告.pdf',bytes:2048}};
const withFiles=Session.create('session-native-retract-files');
withFiles.append('turn/start',{turn:1});
const attached=withFiles.append('user/message',{id:'m-files',role:'user',source:{kind:'user'},content:[{type:'text',text:'看下这两个文件'},image,file]},{surfaceOp:'append'});
withFiles.append('turn/end',{turn:1,reason:{kind:'completed'}});
const attachmentsHandler={session:withFiles,cancel(){},async whenIdle(){},async runMaintenance(fn){return fn()}};
const kept=await retract({sessions:{async flush(){}}},attachmentsHandler,attached.seq);
assert.equal(kept.text,'看下这两个文件');
assert.deepEqual(kept.attachments,[
  {kind:'image',attachmentId:image.attachment.attachmentId},
  {kind:'file',attachmentId:file.attachment.attachmentId,name:'报告.pdf',bytes:2048}
]);
console.log('PASS: exact boundary, retained prefix/log, draft, model history, duplicate protection, new branch, UI replay filter, attachment refs restored');
