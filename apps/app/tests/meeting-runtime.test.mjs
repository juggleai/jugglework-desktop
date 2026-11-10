import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const diagnosticSource = await fs.readFile(new URL('../src/react-app/domains/meeting/diagnostics.ts', import.meta.url), 'utf8');
const diagnosticUrl = 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(diagnosticSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64');
const deadlineSource = await fs.readFile(new URL('../src/react-app/domains/meeting/device-operation.ts', import.meta.url), 'utf8');
const deadlineUrl = 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(deadlineSource, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64');
function transpile(source, options) {
 if (source.includes('withMeetingDeviceDeadline(') && !source.includes('function withMeetingDeviceDeadline'))
  source = `import {withMeetingDeviceDeadline} from "${deadlineUrl}";\n` + source;
 source = source.replace(/from "\.\/diagnostics"/g, `from "${diagnosticUrl}"`);
 // The store harness strips imports and provides its own dependencies.
 if (source.includes('meetingDiagnostic(') && !source.includes(diagnosticUrl))
  source = `import {meetingDiagnostic, meetingDiagnosticError, meetingDiagnosticStep} from "${diagnosticUrl}";\n` + source;
 return ts.transpileModule(source, options);
}

async function load(relative) {
 const source=await fs.readFile(new URL(relative,import.meta.url),'utf8');
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
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
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
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
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
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
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
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
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
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

test('remote audio retries blocked playback, handles late audio tracks and detaches on leave', async () => {
 const {bindRemoteAudio}=await load('../src/react-app/domains/meeting/remote-audio.ts');
 const stream=new EventTarget();const tracks=[];
 stream.getAudioTracks=()=>tracks;
 let plays=0,paused=0,reject=true;const states=[];
 const element={srcObject:null,muted:true,volume:0,play:async()=>{plays++;if(reject)throw Error('NotAllowedError');},pause:()=>paused++};
 const binding=bindRemoteAudio(element,stream,value=>states.push(value));
 await Promise.resolve();assert.equal(plays,0);
 tracks.push({readyState:'live'});stream.dispatchEvent(new Event('addtrack'));
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(states.at(-1),true);assert.equal(element.muted,false);assert.equal(element.volume,1);
 reject=false;await binding.play();assert.equal(states.at(-1),false);
 binding.dispose();assert.equal(element.srcObject,null);assert.equal(paused,1);
 const previous=plays;stream.dispatchEvent(new Event('addtrack'));await binding.play();
 assert.equal(plays,previous);
});

test('meeting cards pass chat type classification and have readable conversation previews', async () => {
 const source=await fs.readFile(new URL('../src/react-app/domains/jugglechat/components.tsx',import.meta.url),'utf8');
 const file=ts.createSourceFile('components.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const nodes=file.statements.filter(node =>
   (ts.isFunctionDeclaration(node)&&node.name?.text==='messagePreview') ||
   (ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>['MESSAGE_NAMES','SUPPORTED_MESSAGE_NAMES'].includes(d.name.getText(file)))));
 const code=transpile(nodes.map(node=>node.getText(file)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const check=new Function(code+'; return { supported: SUPPORTED_MESSAGE_NAMES, preview: messagePreview };')();
 for(const name of ['jw:meeting-card','jw:meeting-invite']){
   assert.equal(check.supported.has(name),true);
   assert.equal(check.preview({name,content:{title:'产品讨论'}}),'[会议] 产品讨论');
 }
});

test('first unmute adds a real microphone over ZEGO silent placeholder', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/zego-adapter.ts',import.meta.url),'utf8');
 source=source.replace('import { ensureMeetingMediaPermissions, meetingDeviceError } from "./media-permission";','const ensureMeetingMediaPermissions=async()=>{}; const meetingDeviceError=e=>e.message;');
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
 const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 let captures=0,replacements=0,updates=0;
 const placeholder={kind:'audio',readyState:'live',enabled:false,label:'MediaStreamAudioDestinationNode'};
 const microphone={kind:'audio',readyState:'live',enabled:true,stop(){}};
 const video={kind:'video',readyState:'live'};
 const tracks=[placeholder];
 const local={getAudioTracks:()=>tracks,getVideoTracks:()=>[video]};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{captures++;return {getAudioTracks:()=>[microphone],getTracks:()=>[microphone]};}}}});
 try {
  const media=new MeetingMedia(()=>updates++,()=>{},()=>{});
  media.local=local;media.cameraEnabled=true;media.microphoneCaptured=false;
  media.engine={addTrack:async(stream,track)=>{assert.equal(stream,local);tracks[0]=track;replacements++;return {errorCode:0};},replaceTrack:()=>assert.fail('SDK placeholder is not a captured microphone'),muteMicrophone:()=>true};
  await media.setDevices(true,true);
  assert.equal(captures,1);assert.equal(replacements,1);assert.equal(tracks[0],microphone);
  await media.setDevices(false,true);await media.setDevices(true,true);
  assert.equal(captures,1);assert.equal(replacements,1);assert.equal(updates,0);
  assert.equal(local.getVideoTracks()[0],video);
 } finally {if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;}
});

test('lifecycle polling ends media even when chat admission is pending', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/store.ts',import.meta.url),'utf8');
 source=source.replace(/^import .*;$/gm,'');
 source='const {create,meetingAPI,meetingScope,meetingClosed,MeetingMedia,joinMeetingChatroom,acquireMediaSession,releaseMediaSession}=globalThis.__syncDeps;\n'+source;
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const oldWindow=globalThis.window,oldInterval=globalThis.setInterval,oldClear=globalThis.clearInterval;
 let tick,releaseChat,disposed=0,renewals=0;
 const snapshot={id:'m',organizationId:'org',status:'live',hostId:'u',version:1,participants:{u:{sessionId:'session'}}};
 globalThis.window=new EventTarget();
 globalThis.setInterval=(fn,ms)=>{assert.equal(ms,3000);tick=fn;return 123;};
 globalThis.clearInterval=()=>{};
 globalThis.__syncDeps={
 create:init=>{let state;const set=p=>{state={...state,...(typeof p==='function'?p(state):p)}};const get=()=>state;state=init(set,get);return {getState:get,setState:set};},
 meetingAPI:{join:async()=>{renewals++;return {meeting:{...snapshot},userId:'u',sessionId:'session',chatroomId:'room',token:'test'};},get:async()=>({meeting:{...snapshot}})},
 meetingScope:()=> 'org',meetingClosed:m=>m.status==='ended',
 MeetingMedia:class {async join(){} dispose(){disposed++;} renew(){}},
 joinMeetingChatroom:()=>new Promise(r=>{releaseChat=r}),
 acquireMediaSession:()=>{},releaseMediaSession:()=>{},
 };
 try{
  const {useMeetingStore}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
  const joining=useMeetingStore.getState().join(snapshot,false,false);
  await new Promise(r=>setTimeout(r,0));
  assert.equal(typeof tick,'function');assert.equal(useMeetingStore.getState().phase,'joined');
  snapshot.status='ended';snapshot.version++;
  tick();await new Promise(r=>setTimeout(r,0));
  assert.equal(useMeetingStore.getState().phase,'idle');assert.equal(disposed,1);assert.equal(renewals,1);
  releaseChat({leave:async()=>{},signal:async()=>{}});await joining;
  assert.equal(useMeetingStore.getState().phase,'idle');
 }finally{globalThis.window=oldWindow;globalThis.setInterval=oldInterval;globalThis.clearInterval=oldClear;delete globalThis.__syncDeps;}
});

test('camera toggles retain audio publication and microphone capture', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/zego-adapter.ts',import.meta.url),'utf8');
 source=source.replace('import { ensureMeetingMediaPermissions, meetingDeviceError } from "./media-permission";','const ensureMeetingMediaPermissions=async()=>{};const meetingDeviceError=e=>e.message;');
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
 const old=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const audio={kind:'audio',enabled:true,readyState:'live'},video={kind:'video',stop(){this.stopped=true;}};
 let videos=[video];
 const local={getAudioTracks:()=>[audio],getVideoTracks:()=>videos};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async c=>{assert.deepEqual(c,{audio:false,video:true});return {getVideoTracks:()=>[video],getTracks:()=>[video]};}}}});
 try{
 const media=new MeetingMedia(()=>assert.fail('video updates must not detach audio'),()=>{},()=>{});
 media.local=local;media.cameraEnabled=true;media.cameraCaptured=true;media.microphoneCaptured=true;
 media.engine={enableVideoCaptureDevice:async()=>true,removeTrack:async()=>{videos=[];return {errorCode:0}},addTrack:async(s,t)=>{videos=[t];return {errorCode:0}},stopPublishingStream:()=>assert.fail('must not restart publishing')};
 await media.setDevices(true,false);await media.setDevices(true,true);
 assert.equal(media.local,local);assert.equal(local.getAudioTracks()[0],audio);assert.equal(audio.enabled,true);assert.equal(media.microphoneCaptured,true);
 }finally{if(old)Object.defineProperty(globalThis,'navigator',old);else delete globalThis.navigator;}
});

test('device state rejects stale sessions, duplicates and reordered signals', async () => {
 const {acceptDeviceState}=await load('../src/react-app/domains/meeting/device-state.ts');
 const current=acceptDeviceState({sessionId:'new',seq:4,mic:true,camera:false},'new');
 assert.equal(acceptDeviceState({sessionId:'old',seq:99,mic:false,camera:false},'new',current),null);
 assert.equal(acceptDeviceState({sessionId:'new',seq:3,mic:false,camera:false},'new',current),null);
 assert.equal(acceptDeviceState({sessionId:'new',seq:4,mic:false,camera:false},'new',current),null);
 assert.equal(acceptDeviceState({sessionId:'new',seq:5,mic:false,camera:false},'new',current).mic,false);
});

test('successful leave still disposes media when an in-flight renewal replaces the lease', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/store.ts',import.meta.url),'utf8');
 source=source.replace(/^import .*;$/gm,'');
 source='const {create,meetingAPI,meetingScope,meetingClosed,MeetingMedia,joinMeetingChatroom,acquireMediaSession,releaseMediaSession}=globalThis.__leaveRaceDeps;\n'+source;
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const oldWindow=globalThis.window,oldInterval=globalThis.setInterval,oldClear=globalThis.clearInterval,oldNow=Date.now;
 let tick,finishLeave,disposed=0,renewals=0,now=1000;
 const snapshot={id:'m',organizationId:'org',status:'live',hostId:'u',version:1,participants:{u:{sessionId:'session'}}};
 globalThis.window=new EventTarget(); Date.now=()=>now;
 globalThis.setInterval=fn=>{tick=fn;return 123;};globalThis.clearInterval=()=>{};
 globalThis.__leaveRaceDeps={
 create:init=>{let state;const set=p=>{state={...state,...(typeof p==='function'?p(state):p)}};const get=()=>state;state=init(set,get);return {getState:get,setState:set};},
 meetingAPI:{join:async()=>{renewals++;return {meeting:{...snapshot},userId:'u',sessionId:'session',chatroomId:'room',token:'test'};},get:async()=>({meeting:{...snapshot}}),action:()=>new Promise(r=>{finishLeave=r;})},
 meetingScope:()=> 'org',meetingClosed:m=>m.status==='ended',
 MeetingMedia:class {async join(){} dispose(){disposed++;} renew(){}},
 joinMeetingChatroom:async()=>({leave:async()=>{},signal:async()=>{}}),
 acquireMediaSession:()=>{},releaseMediaSession:()=>{},
 };
 try {
  const {useMeetingStore,forceMeetingCleanup}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
  await useMeetingStore.getState().join(snapshot,false,false);
  const leaving=useMeetingStore.getState().leave(true);
  now+=21_000;tick();await new Promise(r=>setTimeout(r,0));
  assert.equal(renewals,2);
  finishLeave({meeting:{...snapshot,status:'ended'}});await leaving;
  const phase=useMeetingStore.getState().phase;
  const disposedBeforeCleanup=disposed;
  forceMeetingCleanup();
  assert.equal(phase,'idle');assert.equal(disposedBeforeCleanup,1);
 } finally {globalThis.window=oldWindow;globalThis.setInterval=oldInterval;globalThis.clearInterval=oldClear;Date.now=oldNow;delete globalThis.__leaveRaceDeps;}
});

test('first camera enable uses SDK-owned metadata and keeps source alive until disposal', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/zego-adapter.ts',import.meta.url),'utf8');
 source=source.replace('import { ensureMeetingMediaPermissions, meetingDeviceError } from "./media-permission";','const ensureMeetingMediaPermissions=async()=>{}; const meetingDeviceError=e=>e.message;');
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
 const audio={kind:'audio',readyState:'live',stop(){this.readyState='ended'}};
 const video={kind:'video',readyState:'live',stop(){this.readyState='ended'}};
 const tracks=[audio];const local={getAudioTracks:()=>[audio],getTracks:()=>tracks};
 const captured={getVideoTracks:()=>[video],getTracks:()=>[video]};
 const destroyed=[];
 const media=new MeetingMedia(()=>{},()=>{},()=>{});
 media.local=local;media.joinInfo={roomId:'r',userId:'u',sessionId:'s'};media.microphoneCaptured=true;
 let registered=false;
 media.engine={createStream:async config=>{assert.deepEqual(config,{camera:{audio:false,video:true}});registered=true;return captured;},
 addTrack:async(s,t)=>{assert.equal(registered,true,'raw getUserMedia tracks have no SDK videoInfo');assert.equal(s,local);assert.equal(t,video);tracks.push(t);return {errorCode:0};},
 destroyStream:s=>{destroyed.push(s);s.getTracks().forEach(t=>t.stop());},stopPublishingStream(){},logoutRoom(){},destroyEngine(){}};
 await media.setDevices(true,true);
 assert.equal(media.cameraEnabled,true);assert.equal(local.getAudioTracks()[0],audio);assert.equal(destroyed.length,0);
 media.dispose();assert.ok(destroyed.includes(local));assert.ok(destroyed.includes(captured));assert.equal(video.readyState,'ended');
});

test('hung device operations expire once and late completion cannot succeed', async () => {
 const {withMeetingDeviceDeadline}=await load('../src/react-app/domains/meeting/device-operation.ts');
 let resolve,cleanup=0;
 const work=withMeetingDeviceDeadline(()=>new Promise(r=>{resolve=r}),()=>cleanup++,5);
 await assert.rejects(work,/设备切换超时/);
 resolve(true);await new Promise(r=>setTimeout(r,10));assert.equal(cleanup,1);
 assert.equal(await withMeetingDeviceDeadline(async()=>42,()=>cleanup++,50),42);
 await assert.rejects(withMeetingDeviceDeadline(async()=>{throw Error('denied')},()=>cleanup++,50),/denied/);
 assert.equal(cleanup,1);
});

test('camera capture returning after the deadline is destroyed without restoring exited media', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/zego-adapter.ts',import.meta.url),'utf8');
 source=source.replace('import { ensureMeetingMediaPermissions, meetingDeviceError } from "./media-permission";','const ensureMeetingMediaPermissions=async()=>{}; const meetingDeviceError=e=>e.message;');
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
 const {withMeetingDeviceDeadline}=await load('../src/react-app/domains/meeting/device-operation.ts');
 const audio={kind:'audio',readyState:'live',stop(){this.readyState='ended';}};
 const video={kind:'video',readyState:'live',stop(){this.readyState='ended';}};
 let finishCapture;
 const media=new MeetingMedia(()=>assert.fail('must not restore exited tile'),()=>{},()=>{});
 media.local={getTracks:()=>[audio]};media.joinInfo={roomId:'r',userId:'u',sessionId:'s'};
 media.engine={createStream:()=>new Promise(r=>{finishCapture=r}),destroyStream:s=>s.getTracks().forEach(t=>t.stop()),stopPublishingStream(){},logoutRoom(){},destroyEngine(){},addTrack:()=>assert.fail('late capture must not publish')};
 await assert.rejects(withMeetingDeviceDeadline(()=>media.setDevices(true,true),()=>media.dispose(),5),/超时/);
 finishCapture({getTracks:()=>[video]});await new Promise(r=>setTimeout(r,0));
 assert.equal(audio.readyState,'ended');assert.equal(video.readyState,'ended');assert.equal(media.cameraEnabled,false);
});
