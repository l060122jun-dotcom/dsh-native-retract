import { randomUUID } from 'node:crypto';
export const inject = ['commands', 'sessions', 'clientModules'];

function textOf(content) {
  return content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
}

/** Durable image/file references carried by one user message, in order. */
function attachmentsOf(content) {
  const attachments = [];
  for (const block of content) {
    if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
      attachments.push({ kind: 'image', attachmentId: block.attachment.attachmentId });
    } else if (block.type === 'file' && typeof block.attachment?.attachmentId === 'string') {
      attachments.push({
        kind: 'file',
        attachmentId: block.attachment.attachmentId,
        name: typeof block.attachment.name === 'string' ? block.attachment.name : '',
        bytes: Number.isSafeInteger(block.attachment.bytes) ? block.attachment.bytes : 0,
      });
    }
  }
  return attachments;
}

export async function retract(ctx, agent, seq) {
  const target = agent.session.eventAt(seq);
  if (!Number.isSafeInteger(seq) || target?.type !== 'user/message' || target.surfaceOp !== 'append' || target.data.source?.kind !== 'user') throw new Error('请选择已发送的用户消息');
  if (!agent.session.surface.nodes.includes(seq)) throw new Error('这条消息已撤回或已被上下文压缩');
  agent.cancel({kind:'user'});
  await agent.whenIdle();
  return agent.runMaintenance(async () => {
    const session = agent.session;
    const nodes = session.surface.nodes.filter(n => n >= seq);
    if (!nodes.length || !nodes.includes(seq)) throw new Error('消息状态已更新，请刷新后重试');
    const events = session.snapshotEvents();
    let cut = seq;
    for (let i=seq-1;i>=0;i--) {
      const e=events[i];
      if(e.type==='user/message' && e.surfaceOp==='append') break;
      if(e.type==='turn/start') {cut=e.seq;break;}
      if(e.type==='turn/end') break;
    }
    session.append('user/message', {id:`rewind-native:${cut}:${randomUUID()}`,role:'user',source:{kind:'user'},content:[]}, {surfaceOp:{op:'replace',startSeq:nodes[0],endSeq:nodes.at(-1)},sourceEventSeqs:nodes});
    await ctx.sessions.flush(session);
    return {cut, text: textOf(target.data.content), attachments: attachmentsOf(target.data.content)};
  });
}
export function apply(ctx) {
  ctx.clientModules.rebuilt('@deepseek-ai/dsh-client-ui-chat');
  ctx.clientModules.rebuilt('@deepseek-ai/dsh-client-ui-conversation');
  ctx.commands.register({name:'native-retract',description:'撤回所选用户消息及后续对话，保留原始日志，不回滚文件。',input:{hint:'消息事件序号'},handler:async ({agent,rawInput})=>{
    try {return {kind:'success',text:JSON.stringify(await retract(ctx,agent,Number(rawInput.trim())))}} catch(e){return {kind:'error',text:e.message}}
  }});
}
