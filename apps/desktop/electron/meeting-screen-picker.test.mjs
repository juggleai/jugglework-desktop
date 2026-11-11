import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMeetingScreenPicker } from './meeting-screen-picker.mjs';
function fixture(options = {}) {
  const notices = [], answers = [];
  function window() {
    const webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
      send: (channel, value) => notices.push({channel, ...value}) });
    return Object.assign(new EventEmitter(), {isDestroyed: () => false, webContents});
  }
  const main = window(), meeting = window();
  const img = value => ({isEmpty: () => !value, toDataURL: () => value});
  let sources = [
    {id:'screen:1:0',name:'Display',thumbnail:img('desktop')},
    {id:'window:2:0',name:'Document A',thumbnail:img('preview'),appIcon:img('app')},
    {id:'window:3:0',name:'Document B',thumbnail:img(''),appIcon:img('app')},
  ];
  let capture = async () => sources;
  const picker = createMeetingScreenPicker({desktopCapturer:{getSources: () => capture()},getMainWindow:()=>main,getMeetingWindow:()=>meeting,...options});
  const event = {sender:main.webContents,senderFrame:main.webContents.mainFrame};
  const start = () => { picker.handle({frame:meeting.webContents.mainFrame,userGesture:true},answer=>answers.push(answer)); return notices.at(-1).requestId; };
  return {picker,main,meeting,event,notices,answers,start,setSources:v=>{sources=v;},setCapture:v=>{capture=v;}};
}
test('enumeration does not capture; explicit selected source resolves only once', async () => {
  const f=fixture(), id=f.start(); const list=await f.picker.list(f.event,id);
  assert.equal(f.answers.length,0); assert.equal(list[0].name,'桌面 1');
  assert.equal(list[1].appKey,list[2].appKey); assert.equal(list[2].thumbnail,'');
  assert.equal(await f.picker.choose(f.event,id,'window:2:0'),true);
  assert.equal(f.answers[0].video.id,'window:2:0');
  await assert.rejects(f.picker.choose(f.event,id,'window:2:0'));
  assert.equal(f.answers.length,1); assert.match(f.notices.at(-1).channel,/closed$/);
});
test('cancel resolves null without enumerating sources', async () => {
  const f=fixture(); f.setCapture(()=>{throw Error('must not enumerate');});
  await f.picker.choose(f.event,f.start(),null); assert.deepEqual(f.answers,[null]);
});
test('untrusted frames, missing gesture and overlapping requests are rejected', async () => {
  const f=fixture();
  for(const request of [{frame:{},userGesture:true},{frame:f.meeting.webContents.mainFrame,userGesture:false}])
    f.picker.handle(request,result=>assert.equal(result,null));
  const id=f.start(); f.picker.handle({frame:f.meeting.webContents.mainFrame,userGesture:true},result=>assert.equal(result,null));
  await f.picker.choose(f.event,id,null);
});
test('IPC caller, nonce and source must all match pending selection', async () => {
  const f=fixture(),id=f.start();
  await assert.rejects(f.picker.list({...f.event,senderFrame:{}},id));
  await assert.rejects(f.picker.list({sender:f.meeting.webContents,senderFrame:f.meeting.webContents.mainFrame},id));
  await assert.rejects(f.picker.list(f.event,'stale'));
  await assert.rejects(f.picker.choose(f.event,id,'window:2:0'));
  await f.picker.list(f.event,id);
  await assert.rejects(f.picker.choose(f.event,id,'window:999:0'));
  assert.equal(f.answers.length,0); await f.picker.choose(f.event,id,null);
});
test('window removed after enumeration leaves picker open for refresh or cancel', async () => {
  const f=fixture(),id=f.start(); await f.picker.list(f.event,id); f.setSources([]);
  await assert.rejects(f.picker.choose(f.event,id,'window:2:0'),/已关闭/);
  assert.equal(f.answers.length,0); assert.deepEqual(await f.picker.list(f.event,id),[]);
  await f.picker.choose(f.event,id,null);
});
test('cancel while selection is being rechecked cannot start late capture', async () => {
  const f=fixture(),id=f.start(); await f.picker.list(f.event,id);
  /** @type {(value: any[]) => void} */
  let resolve = () => { throw Error("capture did not start"); }; f.setCapture(()=>new Promise(r=>{resolve=r;}));
  const choosing=f.picker.choose(f.event,id,'window:2:0');
  await f.picker.choose(f.event,id,null); resolve([{id:'window:2:0'}]);
  assert.equal(await choosing,false); assert.deepEqual(f.answers,[null]);
});
for (const reason of ['closed','render-process-gone','did-start-navigation']) test(`request released on ${reason}`, () => {
  const f=fixture(); f.start();
  (reason==='closed'?f.meeting:reason==='render-process-gone'?f.meeting.webContents:f.main.webContents).emit(reason);
  assert.deepEqual(f.answers,[null]); assert.equal(f.meeting.listenerCount('closed'),0);
});
test('abandoned request times out', async () => {
  const f=fixture({timeoutMs:10}); f.start(); await new Promise(r=>setTimeout(r,30)); assert.deepEqual(f.answers,[null]);
});

for (const reason of ['closed','render-process-gone']) test(`request released when main ${reason}`, () => {
  const f=fixture(); f.start();
  (reason==='closed'?f.main:f.main.webContents).emit(reason);
  assert.deepEqual(f.answers,[null]); assert.equal(f.meeting.listenerCount('closed'),0);
});
