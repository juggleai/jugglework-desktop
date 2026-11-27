import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const diagnosticSource = await fs.readFile(new URL('../src/react-app/domains/meeting/diagnostics.ts', import.meta.url), 'utf8');
const diagnosticUrl = 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(diagnosticSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64');
const deadlineSource = await fs.readFile(new URL('../src/react-app/domains/meeting/device-operation.ts', import.meta.url), 'utf8');
const deadlineUrl = 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(deadlineSource, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64');
const preferencesUrl = 'data:text/javascript;base64,' + Buffer.from(`
 const defaults = {microphoneId:'',cameraId:'',speakerId:'',outputVolume:100,shareQuality:'balanced'};
 const listeners = new Set(); let prefs = defaults;
 export const readMeetingPreferences = () => prefs;
 export const subscribeMeetingPreferences = cb => { listeners.add(cb); return () => listeners.delete(cb); };
 export const setPrefs = (patch = {}) => { prefs = {...defaults,...patch}; for (const cb of listeners) cb(); };
`).toString('base64');
const {setPrefs} = await import(preferencesUrl);
test.afterEach(() => setPrefs());
function transpile(source, options) {
 // Data-URL adapter tests inject the compositor and preference event source.
 source = source.replace('import { createMeetingEffectTrack } from "./video-effects";', 'const createMeetingEffectTrack=(...args)=>globalThis.__effects.create(...args);')
  .replace('import { readMeetingVideoEffects, subscribeMeetingVideoEffects } from "./video-effects-preferences";', `const readMeetingVideoEffects=()=>globalThis.__effects?.read() ?? {avatar:'none',background:'none',filter:'none',beauty:0}; const subscribeMeetingVideoEffects=fn=>globalThis.__effects.subscribe(fn);`);
 if (source.includes('withMeetingDeviceDeadline(') && !source.includes('function withMeetingDeviceDeadline'))
  source = `import {withMeetingDeviceDeadline} from "${deadlineUrl}";\n` + source;
  source = source.replace(/from "\.\/diagnostics"/g, `from "${diagnosticUrl}"`)
   .replace(/from "\.\/meeting-preferences"/g, `from "${preferencesUrl}"`);
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
 source=source.replace('import { create } from "zustand";', 'const create=()=>({setState:()=>{}});');
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
 source=source.replace('import { ensureMeetingMediaPermissions, handleScreenCaptureDenied, meetingDeviceError } from "./media-permission";',
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

test('the bound remote sink follows live volume and speaker changes without replaying', async () => {
 const {bindRemoteAudio}=await load('../src/react-app/domains/meeting/remote-audio.ts');
 const stream=new EventTarget();stream.getAudioTracks=()=>[{readyState:'live'}];
 const routes=[];let finish,plays=0;
 const element={sinkId:'',play:async()=>{plays++},pause(){},async setSinkId(id){
  routes.push(id);if(id==='headset')await new Promise(r=>{finish=r});this.sinkId=id;
 }};
 setPrefs({speakerId:'headset',outputVolume:35});
 const binding=bindRemoteAudio(element,stream,()=>{});
 try {
  assert.equal(element.volume,0.35);
  setPrefs({speakerId:'speakers',outputVolume:0});setPrefs({speakerId:'',outputVolume:0});
  assert.equal(element.volume,0);finish();await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(routes,['headset','']);assert.equal(element.sinkId,'');assert.equal(plays,1);
 } finally {binding.dispose()}
 setPrefs({speakerId:'speakers',outputVolume:90});await Promise.resolve();
 assert.equal(element.volume,0);assert.deepEqual(routes,['headset','']);
});

test('meeting cards pass chat type classification and have readable conversation previews', async () => {
 const source=await fs.readFile(new URL('../src/react-app/domains/jugglechat/components.tsx',import.meta.url),'utf8');
 const file=ts.createSourceFile('components.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const nodes=file.statements.filter(node =>
   (ts.isFunctionDeclaration(node)&&node.name?.text==='messagePreview') ||
   (ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>['MESSAGE_NAMES','SUPPORTED_MESSAGE_NAMES'].includes(d.name.getText(file)))));
 const code=transpile(nodes.map(node=>node.getText(file)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const {DOCS_MESSAGE_NAME}=await load('../src/react-app/domains/jugglechat/docs-message.ts');
 const check=new Function('DOCS_MESSAGE_NAME',code+'; return { supported: SUPPORTED_MESSAGE_NAMES, preview: messagePreview };')(DOCS_MESSAGE_NAME);
 for(const name of ['jw:meeting-card','jw:meeting-invite']){
   assert.equal(check.supported.has(name),true);
   assert.equal(check.preview({name,content:{title:'产品讨论'}}),'[会议] 产品讨论');
 }
});

test('first unmute adds a real microphone over ZEGO silent placeholder', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/zego-adapter.ts',import.meta.url),'utf8');
 source=source.replace('import { ensureMeetingMediaPermissions, handleScreenCaptureDenied, meetingDeviceError } from "./media-permission";','const ensureMeetingMediaPermissions=async()=>{}; const meetingDeviceError=e=>e.message;');
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
 const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 let captures=0,replacements=0,updates=0;
 const placeholder={kind:'audio',readyState:'live',enabled:false,label:'MediaStreamAudioDestinationNode'};
 const microphone={kind:'audio',readyState:'live',enabled:true,stop(){}};
 const video={kind:'video',readyState:'live'};
 const tracks=[placeholder];
 const local={getAudioTracks:()=>tracks,getVideoTracks:()=>[video]};
  setPrefs({microphoneId:'mic-1',cameraId:'camera-1'});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async options=>{assert.deepEqual(options,{audio:{deviceId:{exact:'mic-1'}},video:false});captures++;return {getAudioTracks:()=>[microphone],getTracks:()=>[microphone]};}}}});
 try {
  const media=new MeetingMedia(()=>updates++,()=>{},()=>{});
  media.local=local;media.cameraEnabled=true;media.microphoneCaptured=false;
  media.engine={addTrack:async(stream,track)=>{assert.equal(stream,local);tracks[0]=track;replacements++;return {errorCode:0};},replaceTrack:()=>assert.fail('SDK placeholder is not a captured microphone'),muteMicrophone:()=>true};
  await media.setDevices(true,true);
  assert.equal(captures,1);assert.equal(replacements,1);assert.equal(tracks[0],microphone);
  await media.setDevices(false,true);await media.setDevices(true,true);
   assert.equal(captures,1);assert.equal(replacements,1);assert.equal(updates,0);
   const switches=[];
   media.engine.useAudioDevice=async (s,id)=>{assert.equal(s,local);switches.push(id);return {errorCode:0}};
   for(const microphoneId of ['mic-2','']) {
    await media.setDevices(false,true);setPrefs({microphoneId});
    assert.equal(microphone.enabled,false);await media.setDevices(true,true);
   }
   assert.deepEqual(switches,['mic-2','default']);assert.equal(captures,1);
  assert.equal(local.getVideoTracks()[0],video);
 } finally {if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;}
});

test('lifecycle polling ends media even when chat admission is pending', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/store.ts',import.meta.url),'utf8');
 source=source.replace(/^import .*;$/gm,'');
 source='const {create,meetingAPI,meetingScope,meetingClosed,MeetingMedia,joinMeetingChatroom,acquireMediaSession,releaseMediaSession,installDocShare,receiveShareDocs,reconcileDocShare,uninstallDocShare}=globalThis.__syncDeps;\n'+source;
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
 installDocShare:()=>{},receiveShareDocs:()=>{},reconcileDocShare:()=>{},uninstallDocShare:()=>{},
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
 source=source.replace('import { ensureMeetingMediaPermissions, handleScreenCaptureDenied, meetingDeviceError } from "./media-permission";','const ensureMeetingMediaPermissions=async()=>{};const meetingDeviceError=e=>e.message;');
 const output=transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
 const old=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const audio={kind:'audio',enabled:true,readyState:'live'},video={kind:'video',stop(){this.stopped=true;}};
 let videos=[video];
 const local={getAudioTracks:()=>[audio],getVideoTracks:()=>videos};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async c=>{assert.deepEqual(c,{audio:false,video:true});return {getVideoTracks:()=>[video],getTracks:()=>[video]};}}}});
 try{
 const media=new MeetingMedia(()=>assert.fail('video updates must not detach audio'),()=>{},()=>{});
  media.local=local;media.cameraEnabled=true;media.microphoneCaptured=true;
  const fresh={kind:'video',enabled:true,stop(){}};
  media.engine={createStream:async()=>({getVideoTracks:()=>[fresh]}),replaceTrack:async(s,t)=>{assert.equal(video.stopped,true);assert.equal(t,fresh);videos=[t];return {errorCode:0}},stopPublishingStream:()=>assert.fail('must not restart publishing')};
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
 source='const {create,meetingAPI,meetingScope,meetingClosed,MeetingMedia,joinMeetingChatroom,acquireMediaSession,releaseMediaSession,installDocShare,receiveShareDocs,reconcileDocShare,uninstallDocShare}=globalThis.__leaveRaceDeps;\n'+source;
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
 installDocShare:()=>{},receiveShareDocs:()=>{},reconcileDocShare:()=>{},uninstallDocShare:()=>{},
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
 source=source.replace('import { ensureMeetingMediaPermissions, handleScreenCaptureDenied, meetingDeviceError } from "./media-permission";','const ensureMeetingMediaPermissions=async()=>{}; const handleScreenCaptureDenied=async()=>{throw Error("屏幕共享权限未开启")}; const meetingDeviceError=e=>e.message;');
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
 const audio={kind:'audio',readyState:'live',stop(){this.readyState='ended'}};
  const video={kind:'video',enabled:true,readyState:'live',stop(){this.readyState='ended'}};
  const tracks=[audio];const local={getAudioTracks:()=>[audio],getTracks:()=>tracks,getVideoTracks:()=>tracks.filter(t=>t.kind==='video')};
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

test('meeting effects publish only registered camera output; preferences and teardown race safely', async t => {
 const src=await fs.readFile(new URL('../src/react-app/domains/meeting/zego-adapter.ts',import.meta.url),'utf8');
 const source=src.replace(/^import .* from "\.\/media-permission";$/m,'const ensureMeetingMediaPermissions=async()=>{};const meetingDeviceError=e=>e.message;');
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
 const oldWindow=globalThis.window, oldStream=globalThis.MediaStream;
 const none={background:'none',avatar:'none',beauty:0,filter:'none'};
 function setup(initial=none) {
  const tracks=[], registered=new Set(), published=[], effects=[], errors=[], cameraRequests=[];
  let prefs=initial, notify, engine;
  function track(kind,label) {
   const value={kind,label,enabled:true,readyState:'live',stop(){this.readyState='ended'},clone(){return track(kind,'private input')}};
   tracks.push(value);return value;
  }
  globalThis.MediaStream=class {
   constructor(list){this.list=[...list]}
   getTracks(){return [...this.list]} getAudioTracks(){return this.list.filter(t=>t.kind==='audio')} getVideoTracks(){return this.list.filter(t=>t.kind==='video')}
  };
  globalThis.__effects={read:()=>prefs,subscribe:fn=>{notify=fn;return ()=>{notify=null}},create:async(input,read)=>{
   const canvas=track('video','canvas');effects.push({input,read,canvas});return {track:canvas,stop:()=>canvas.stop()};
  }};
  globalThis.window={ZegoExpressEngine:class {
   constructor(){engine=this} on(){} async loginRoom(){return true} logoutRoom(){} destroyEngine(){} muteMicrophone(){} stopPublishingStream(){}
   async createStream({custom,camera}) {
    if(camera)cameraRequests.push(camera);
    const s=custom?new MediaStream(custom.source.getTracks()):new MediaStream([track('audio',camera.audio?'mic':'silent'),...(camera.video?[track('video','camera')]:[])]);
    registered.add(s);return s;
   }
   destroyStream(s){assert.ok(registered.delete(s));s.getTracks().forEach(t=>t.stop())}
   startPublishingStream(id,s){assert.ok(registered.has(s));published.push(s.getVideoTracks()[0]);return true}
   async replaceTrack(s,v){assert.ok(s.getVideoTracks().length);return this.attach(s,v)}
   async addTrack(s,v){assert.equal(s.getVideoTracks().length,0);return this.attach(s,v)}
   attach(s,v){assert.ok(registered.has(s));assert.ok([...registered].some(p=>p.getVideoTracks().includes(v)));s.list=[...s.getAudioTracks(),v];return {errorCode:0}}
  }};
  const media=new MeetingMedia(()=>{},message=>errors.push(message),()=>{});
  return {effects,media,errors,tracks,published,registered,cameraRequests,get engine(){return engine},get subscribed(){return !!notify},
   join:(cam,mic=true)=>media.join({meeting:{id:'m'},roomId:'r',userId:'u',sessionId:'s'},mic,cam),
   change(next){prefs={...none,...next};notify?.()},finish(){media.dispose();assert.equal(notify,null);assert.equal(registered.size,0);assert.ok(tracks.every(t=>t.readyState==='ended'))}};
 }
 try {
  await t.test('effects before first publish and first enable, with or without a microphone publisher',async()=>{
   for(const [mic,cam] of [[true,true],[true,false],[false,false]]){
    const h=setup({...none,avatar:'cat'});try {
     setPrefs({cameraId:'cam-a',microphoneId:'mic-a'});
     await h.join(cam,mic);if(!cam){assert.equal(h.effects.length,0);await h.media.setDevices(mic,true)}
     assert.deepEqual(h.cameraRequests,cam ? [{audio:true,video:true,audioInput:'mic-a',videoInput:'cam-a'}] : [
      ...(mic?[{audio:true,video:false,audioInput:'mic-a'}]:[]),{audio:false,video:true,videoInput:'cam-a'}]);
     assert.ok(!h.published.some(v=>v?.label==='camera'));assert.equal(h.media.local.getVideoTracks()[0],h.effects[0].canvas);
     const audio=h.media.local.getAudioTracks()[0];await h.media.setDevices(mic,false);
     assert.equal(h.effects[0].input.readyState,'ended');assert.equal(h.effects[0].canvas.readyState,'ended');
     setPrefs({cameraId:'cam-b',microphoneId:'mic-b'});h.change({background:'sky'});await h.media.setDevices(mic,true);
     assert.deepEqual(h.cameraRequests.at(-1),{audio:false,video:true,videoInput:'cam-b'});
     assert.equal(h.media.local.getVideoTracks()[0],h.effects[1].canvas);assert.equal(h.media.local.getAudioTracks()[0],audio);
     assert.equal(audio.readyState,'live');assert.equal(h.published.length,1);
    }finally{h.finish()}
   }
  });
  await t.test('raw default, synchronous privacy gate and live preferences through one canvas',async()=>{
   const h=setup();try {
    await h.join(true);const [raw]=h.published;assert.equal(raw.label,'camera');assert.equal(h.effects.length,0);
    h.change({avatar:'cat'});assert.equal(raw.enabled,false);await h.media.cameraWork;
    const effect=h.effects[0];assert.equal(raw.readyState,'ended');assert.equal(h.media.local.getVideoTracks()[0],effect.canvas);
    for(const next of [none,{...none,beauty:30}]){h.change(next);assert.deepEqual(effect.read(),next)}
    assert.equal(h.effects.length,1);assert.equal(h.errors.length,0);
   }finally{h.finish()}
  });
  await t.test('unsupported canvas at join keeps the requested microphone without sending any camera',async()=>{
   const h=setup({...none,background:'sky'});try {
    globalThis.__effects.create=async()=>{throw Error('no canvas capture')};
    await h.join(true);assert.deepEqual(h.published,[undefined]);assert.equal(h.media.local.getAudioTracks()[0].label,'mic');
    assert.match(h.errors[0],/特效未能发布/);assert.equal(h.media.cameraEnabled,false);
   }finally{h.finish()}
  });
  await t.test('SDK rejection or no-op reports failure; the old sender stays stopped',async()=>{
   for(const result of [{errorCode:42},{errorCode:0},false]){
    const h=setup();try{
     await h.join(true);h.engine.replaceTrack=async()=>result;h.change({filter:'mono'});await h.media.cameraWork;
     assert.equal(h.errors.length,1);assert.match(h.errors[0],/特效未能发布/);assert.equal(h.media.cameraEnabled,false);assert.equal(h.published[0].readyState,'ended');
     assert.equal(h.media.local.getAudioTracks()[0].readyState,'live');assert.equal(h.effects[0].input.readyState,'ended');
    }finally{h.finish()}
   }
  });
  await t.test('preferences arriving inside the first raw SDK add gate that sender before completion',async()=>{
   const h=setup();try {
    await h.join(false);let raw;
    h.engine.addTrack=async(s,v)=>{raw=v;h.change({avatar:'cat'});assert.equal(raw.enabled,false);return h.engine.attach(s,v)};
    await h.media.setDevices(true,true);await h.media.cameraWork;
    assert.equal(raw.readyState,'ended');assert.equal(h.media.local.getVideoTracks()[0],h.effects[0].canvas);assert.deepEqual(h.errors,[]);
   }finally{h.finish()}
  });
  await t.test('closing camera or leaving while custom registration is pending cannot restore capture',async()=>{
   for(const leave of [false,true]){
    const h=setup();try{
     await h.join(true);let resume,started;const pending=new Promise(r=>{started=r});const create=h.engine.createStream.bind(h.engine);
     h.engine.createStream=async config=>{const preview=await create(config);started();await new Promise(r=>{resume=r});return preview};
     h.change({avatar:'robot'});await pending;
     if(leave)h.media.dispose();else await h.media.setDevices(true,false);
     assert.equal(h.effects[0].input.readyState,'ended');resume();await h.media.cameraWork;
     assert.equal(h.published.length,1);assert.equal(h.effects[0].canvas.readyState,'ended');assert.deepEqual(h.errors,[]);
    }finally{h.finish()}
   }
  });
 }finally{globalThis.window=oldWindow;globalThis.MediaStream=oldStream;delete globalThis.__effects}
});

test('camera capture returning after the deadline is destroyed without restoring exited media', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/zego-adapter.ts',import.meta.url),'utf8');
 source=source.replace('import { ensureMeetingMediaPermissions, handleScreenCaptureDenied, meetingDeviceError } from "./media-permission";','const ensureMeetingMediaPermissions=async()=>{}; const handleScreenCaptureDenied=async()=>{throw Error("屏幕共享权限未开启")}; const meetingDeviceError=e=>e.message;');
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

test('meeting child video excludes audio and preserves its video view through device changes', async () => {
 const {bindMeetingVideo}=await load('../src/react-app/domains/meeting/video-view.ts');
 const original=globalThis.MediaStream;
 class Stream extends EventTarget {
  constructor(tracks=[]){super();this.tracks=[...tracks];}
  getTracks(){return [...this.tracks];}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}
  addTrack(t){this.tracks.push(t);}removeTrack(t){this.tracks=this.tracks.filter(v=>v!==t);}
 }
 globalThis.MediaStream=Stream;
 const audio=Object.assign(new EventTarget(),{kind:'audio',readyState:'live',enabled:true});
 const video=Object.assign(new EventTarget(),{kind:'video',readyState:'live',stop:()=>assert.fail('view cannot stop RTC tracks')});
 const source=new Stream([audio]);let plays=0;
 const element={muted:false,paused:true,srcObject:null,play:async()=>{plays++;element.paused=false;},pause:()=>{element.paused=true;}};
 try {
  const binding=bindMeetingVideo(element,source),view=element.srcObject;
  assert.notEqual(view,source);assert.deepEqual(view.getTracks(),[]);assert.equal(plays,0);
  source.addTrack(video);binding.sync();assert.deepEqual(view.getTracks(),[video]);assert.equal(plays,1);
  audio.enabled=false;binding.sync();assert.equal(element.srcObject,view);assert.equal(plays,1);
  assert.ok(!view.getTracks().includes(audio));
  video.readyState='ended';video.dispatchEvent(new Event('ended'));assert.deepEqual(view.getTracks(),[]);
  const next=Object.assign(new EventTarget(),{kind:'video',readyState:'live'});
  source.addTrack(next);source.dispatchEvent(new Event('addtrack'));assert.deepEqual(view.getTracks(),[next]);
  binding.dispose();assert.equal(element.srcObject,null);assert.equal(audio.readyState,'live');assert.equal(next.readyState,'live');
 } finally {if(original===undefined)delete globalThis.MediaStream;else globalThis.MediaStream=original;}
});

test('screen sharing distinguishes capture failures and releases failed or late captures', async () => {
 let source=await fs.readFile(new URL('../src/react-app/domains/meeting/zego-adapter.ts',import.meta.url),'utf8');
 source=source.replace('import { ensureMeetingMediaPermissions, handleScreenCaptureDenied, meetingDeviceError } from "./media-permission";','const ensureMeetingMediaPermissions=async()=>{}; const handleScreenCaptureDenied=async()=>{throw Error("屏幕共享权限未开启")}; const meetingDeviceError=e=>e.message;');
 const {MeetingMedia}=await import('data:text/javascript;base64,'+Buffer.from(transpile(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
 const oldMediaStream=globalThis.MediaStream;
 globalThis.MediaStream=class {constructor(tracks){this.tracks=tracks;}getTracks(){return this.tracks;}getVideoTracks(){return this.tracks;}};
 const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'Mac'}});
 const updates=[];
 const media=new MeetingMedia((tile,id)=>updates.push({tile,id}),()=>{},()=>{});
 media.joinInfo={roomId:'r',userId:'u',sessionId:'s'};
 let published=0,stopped=0,destroyed=0;const previews=new Set();
 media.engine={async createStream({custom}){assert.ok(custom.source instanceof MediaStream);const preview=new MediaStream(custom.source.getVideoTracks());previews.add(preview);return preview;},destroyStream(stream){destroyed++;previews.delete(stream);stream.getTracks().forEach(t=>t.stop());},startPublishingStream(id,stream){assert.ok(previews.has(stream),'must register raw capture with ZEGO before publishing');published++;return true;},stopPublishingStream(){stopped++;},logoutRoom(){},destroyEngine(){}};
 const capture=()=>{
  const track=Object.assign(new EventTarget(),{kind:'video',contentHint:'',getSettings:()=>({width:800,height:500}),readyState:'live',stop(){this.readyState='ended';}});
  return {track,stream:{getTracks:()=>[track],getVideoTracks:()=>[track]}};
 };
 const reject=name=>({getDisplayMedia:async()=>{throw Object.assign(new Error('capture failed'),{name});}});
 try {
  await media.startShare(reject('AbortError'));assert.equal(published,0);assert.equal(updates.length,0);
  await assert.rejects(media.startShare(reject('NotAllowedError')),/权限/);
  await assert.rejects(media.startShare(reject('InvalidStateError')),/返回会议窗口/);
  await assert.rejects(media.startShare(reject('NotReadableError')),/系统未能启动屏幕采集/);
  await assert.rejects(media.startShare(reject('NotFoundError')),/重新选择/);
  for(const [shareQuality,width,height,fps,hint] of [['balanced',1920,1080,24,''],['detail',2560,1440,15,'detail'],['motion',1920,1080,30,'motion']]) {
   setPrefs({shareQuality});const first=capture();
   await media.startShare({getDisplayMedia:async(options)=>{assert.deepEqual(options,{video:{width:{ideal:width},height:{ideal:height},frameRate:{ideal:fps,max:fps}},audio:false});return first.stream;}});
   assert.equal(updates.at(-1).tile.screen,true);assert.notEqual(updates.at(-1).tile.stream,first.stream);assert.equal(first.track.contentHint,hint);
   first.track.dispatchEvent(new Event('ended'));
   assert.equal(first.track.readyState,'ended');assert.equal(updates.at(-1).tile,null);
  }
  assert.equal(stopped,3);assert.equal(destroyed,3);assert.equal(published,3);
  for(const failure of [()=>false,()=>{throw Error('publisher failed');}]){
   const failed=capture();media.engine.startPublishingStream=failure;
   await assert.rejects(media.startShare({getDisplayMedia:async()=>failed.stream}));assert.equal(failed.track.readyState,'ended');
  }
  assert.equal(previews.size,0);
  let finishRegister;const registering=capture();
  media.engine.createStream=()=>new Promise(r=>{finishRegister=r;});
  const registration=media.startShare({getDisplayMedia:async()=>registering.stream});
  await new Promise(r=>setTimeout(r,0));
  media.stopShare();assert.equal(registering.track.readyState,'ended');
  finishRegister(new MediaStream(registering.stream.getTracks()));await registration;
  assert.equal(media.share,undefined);
  let resolve;
  const late=capture();const pending=media.startShare({getDisplayMedia:()=>new Promise(r=>{resolve=r;})});
  await media.startShare({getDisplayMedia:()=>assert.fail('duplicate picker must not open')});
  media.dispose();resolve(late.stream);await pending;
  assert.equal(late.track.readyState,'ended');assert.equal(media.share,undefined);
 }finally{
  media.dispose();if(oldMediaStream===undefined)delete globalThis.MediaStream;else globalThis.MediaStream=oldMediaStream;
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;
 }
});
