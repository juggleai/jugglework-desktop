import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
async function load(relative) {
 const source=await fs.readFile(new URL(relative,import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}
test('legacy calls and meetings cannot take each other’s media lease',async()=>{
 const {acquireMediaSession:acquire,releaseMediaSession:release}=await load('../src/react-app/domains/meeting/media-session.ts');
 acquire('call');assert.throws(()=>acquire('meeting'));
 release('meeting');assert.throws(()=>acquire('meeting'));
 release('call');acquire('meeting');assert.throws(()=>acquire('call'));
 release('meeting');acquire('call');release('call');
});
test('meeting navigation remains independent of a coding workspace',async()=>{
 const {parseWorkspaceAppPath}=await load('../src/react-app/shell/workspace-routes.ts');
 assert.deepEqual(parseWorkspaceAppPath('/meetings'),{view:'meetings',workspaceId:null});
 assert.deepEqual(parseWorkspaceAppPath('/meetings/'),{view:'meetings',workspaceId:null});
 assert.deepEqual(parseWorkspaceAppPath('/workspace/project/session/chat'),{view:'session',workspaceId:'project',sessionId:'chat'});
});
test('native close waits for confirmation, then permits close after media cleanup',async()=>{
 const {guardMeetingWindowClose}=await load('../src/react-app/domains/meeting/window-lifecycle.ts');
 const target=new EventTarget();let active=true;let confirmations=0;
 const unguard=guardMeetingWindowClose(target,()=>active,()=>confirmations++);
 const closing=new Event('beforeunload',{cancelable:true});
 Object.defineProperty(closing,'returnValue',{value:'',writable:true});
 target.dispatchEvent(closing);
 assert.equal(closing.defaultPrevented,true);assert.equal(confirmations,1);
 active=false;
 const confirmed=new Event('beforeunload',{cancelable:true});target.dispatchEvent(confirmed);
 assert.equal(confirmed.defaultPrevented,false);assert.equal(confirmations,1);
 unguard();
});

test('meeting URLs include the version beneath the deployed API prefix', async()=>{
 const {meetingApiUrl}=await load('../src/react-app/domains/meeting/api-url.ts');
 assert.equal(meetingApiUrl('https://t-work.jugglework.cn/jwork/api','/settings'),'https://t-work.jugglework.cn/jwork/api/v1/meetings/settings');
 assert.equal(meetingApiUrl('http://localhost:8020/api/','?from=a&to=b'),'http://localhost:8020/api/v1/meetings?from=a&to=b');
});

test('meeting readiness explains admission gate and IM dependency', async()=>{
 const {meetingReadinessReason:reason}=await load('../src/react-app/domains/meeting/readiness.ts');
 const ready={ready:false,hasServerSecret:true,settings:{enabled:true,appId:123,admissionConfigured:false}};
 assert.match(reason(ready),/meeting.admissionConfigured/);
 assert.match(reason({...ready,settings:{...ready.settings,admissionConfigured:true}}),/组织 IM/);
 assert.equal(reason({...ready,ready:true}),'');
 assert.match(reason(null),/刷新/);
});

test('end error only releases the client after server confirms a terminal meeting', async()=>{
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/api.ts',import.meta.url),'utf8');
 source=source.replace('import { meetingApiUrl } from "./api-url";','const meetingApiUrl = (base, path) => base + "/v1/meetings" + path;')
  .replace('import { readDenSettings, resolveDenBaseUrls } from "@/app/lib/den";','const readDenSettings = () => ({authToken:"test",activeOrgId:"org"}); const resolveDenBaseUrls = () => ({apiBaseUrl:"https://test.invalid"});');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {meetingAPI}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
 const originalFetch=globalThis.fetch, originalWindow=globalThis.window;
 let events=0, requests=[];
 globalThis.window={dispatchEvent:()=>events++};
 try {
  for (const state of ['ended','live']) {
   requests=[];
   globalThis.fetch=async (url, options)=>{
    requests.push(options.method||'GET');
    return options.method==='POST'
     ? new Response(JSON.stringify({error:{code:'internal_error',message:'The request could not be completed.'}}),{status:500})
     : new Response(JSON.stringify({meeting:{id:'test',status:state}}));
   };
   if(state==='ended') {
    const result=await meetingAPI.action('test','end');
    assert.equal(result.cleanupPending,true);
    assert.equal(result.meeting.status,'ended');
   } else {
    await assert.rejects(()=>meetingAPI.action('test','end'),/会议服务暂时/);
   }
   assert.deepEqual(requests,['POST','GET']);
  }
  assert.equal(events,1);
  globalThis.fetch=async()=>new Response(JSON.stringify({meeting:{status:'ended'},cleanupPending:true}),{status:202});
  assert.equal((await meetingAPI.action('test','end')).cleanupPending,true);
 } finally {
  globalThis.fetch=originalFetch;
  if(originalWindow===undefined) delete globalThis.window; else globalThis.window=originalWindow;
 }
});

test('device permissions are requested only when enabled and denial identifies settings target', async()=>{
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/media-permission.ts',import.meta.url),'utf8');
 source=source.replace('import { requestMeetingDevicePermission } from "@/app/lib/desktop";','const requestMeetingDevicePermission = (kind) => globalThis.__testMeetingPermission(kind);');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {ensureMeetingMediaPermissions:ensure,meetingDeviceError:describe}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
 const requests=[];
 globalThis.__testMeetingPermission=async kind=>{requests.push(kind);return {granted:kind!=='camera'};};
 try {
  await ensure(false,false); assert.deepEqual(requests,[]);
  await ensure(true,false); assert.deepEqual(requests,['microphone']);
  await assert.rejects(()=>ensure(false,true),/摄像头权限未开启/);
  assert.match(describe({name:'NotAllowedError'},true,false),/麦克风权限被拒绝/);
  assert.match(describe({message:'Permission denied'},false,true),/摄像头权限被拒绝/);
 } finally {delete globalThis.__testMeetingPermission;}
});

test('microphone toggles preserve the local video stream, including first audio enable', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/zego-adapter.ts',import.meta.url),'utf8');
 source=source.replace('import { ensureMeetingMediaPermissions, meetingDeviceError } from "./media-permission";',
 'const ensureMeetingMediaPermissions=async()=>{}; const meetingDeviceError=(e)=>e.message;');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
 const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 let captureCount=0, updates=0, added=0;
 const video={kind:'video',readyState:'live',enabled:true};
 const audio={kind:'audio',readyState:'live',enabled:true,stop(){this.readyState='ended';}};
 const tracks=[];
 const local={getAudioTracks:()=>tracks,getVideoTracks:()=>[video]};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async(options)=>{
   assert.deepEqual(options,{audio:true,video:false});captureCount++;
   return {getAudioTracks:()=>[audio],getTracks:()=>[audio]};
 }}}});
 try {
   const media=new MeetingMedia(()=>updates++,()=>{},()=>{});
   media.local=local;media.cameraEnabled=true;
   media.engine={
     addTrack:async(stream,track)=>{assert.equal(stream,local);tracks.push(track);added++;return {errorCode:0};},
     muteMicrophone:()=>true,
     stopPublishingStream:()=>assert.fail('must not stop video publishing'),
     destroyStream:()=>assert.fail('must not destroy video capture'),
   };
   await media.setDevices(true,true);
   await media.setDevices(false,true);
   assert.equal(audio.enabled,false);
   await media.setDevices(true,true);
   assert.equal(audio.enabled,true);
   assert.equal(media.local,local);assert.equal(local.getVideoTracks()[0],video);
   assert.equal(updates,0);assert.equal(captureCount,1);assert.equal(added,1);
   media.engine.addTrack=async()=>{throw Error('audio denied');};
   tracks.length=0;
   await assert.rejects(media.setDevices(true,true),/audio denied/);
   assert.equal(media.local,local);assert.equal(video.readyState,'live');assert.equal(updates,0);
 } finally {
   if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);
   else delete globalThis.navigator;
 }
});

test('member row invitation sends one private card, never a group notification', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/im-adapter.ts',import.meta.url),'utf8');
 source=source.replace('import { juggleChatRuntime } from "../jugglechat/runtime";','const juggleChatRuntime = globalThis.__meetingInviteRuntime;');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const sent=[];
 globalThis.__meetingInviteRuntime={isConnected:()=>true,getClient:()=>({sendMessage:async(m)=>sent.push(m)})};
 try {
  const {sendMeetingInvitation}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
  await sendMeetingInvitation({id:'meeting',organizationId:'org',title:'test',code:'123',startAt:'now',status:'live',version:2},'selected-user');
  assert.equal(sent.length,1);assert.equal(sent[0].conversationType,1);
  assert.equal(sent[0].conversationId,'selected-user');assert.equal(sent[0].content.meetingId,'meeting');
  globalThis.__meetingInviteRuntime.isConnected=()=>false;
  await assert.rejects(sendMeetingInvitation({id:'meeting'},'other'),/聊天连接/);
  assert.equal(sent.length,1);
 } finally {delete globalThis.__meetingInviteRuntime;}
});
