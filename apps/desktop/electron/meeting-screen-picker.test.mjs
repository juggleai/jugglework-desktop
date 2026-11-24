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
  const picker = createMeetingScreenPicker({platform:'darwin',desktopCapturer:{getSources: () => capture()},getMainWindow:()=>main,getMeetingWindow:()=>meeting,...options});
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
test('choosing a whole screen records its display; windows and cancels do not', async () => {
  const displays = [{ id: 1 }, { id: 7 }];
  const f = fixture({ getDisplays: () => displays });
  f.setSources([
    { id: 'screen:1:0', display_id: '1', name: 'Display', thumbnail: { isEmpty: () => true } },
    { id: 'screen:9:0', display_id: '9', name: 'Gone', thumbnail: { isEmpty: () => true } },
    { id: 'window:2:0', name: 'Doc', thumbnail: { isEmpty: () => true } },
  ]);
  assert.equal(f.picker.sharedDisplayId(), null);
  let id = f.start(); await f.picker.list(f.event, id);
  await f.picker.choose(f.event, id, 'screen:1:0');
  assert.equal(f.picker.sharedDisplayId(), 1);
  // A new request (re-share) forgets the previous source until it is chosen.
  id = f.start(); assert.equal(f.picker.sharedDisplayId(), null);
  await f.picker.list(f.event, id); await f.picker.choose(f.event, id, 'window:2:0');
  assert.equal(f.picker.sharedDisplayId(), null);
  // A screen whose display_id is not a connected display is never annotatable.
  id = f.start(); await f.picker.list(f.event, id); await f.picker.choose(f.event, id, 'screen:9:0');
  assert.equal(f.picker.sharedDisplayId(), null);
  id = f.start(); await f.picker.list(f.event, id); await f.picker.choose(f.event, id, 'screen:1:0');
  f.picker.clearShared(); assert.equal(f.picker.sharedDisplayId(), null);
  id = f.start(); await f.picker.choose(f.event, id, null); assert.equal(f.picker.sharedDisplayId(), null);
});

test('a verified window is bound to the current capture and readable only by the application main frame', async () => {
  const f = fixture({ resolveWindowIdentity: async id => id === 2 ? { pid: 812 } : null });
  const id = f.start();
  await f.picker.list(f.event, id);
  await f.picker.choose(f.event, id, 'window:2:0');
  assert.deepEqual(f.picker.readSharedWindow?.(f.event), { kind: 'window', captureId: id, sourceId: 'window:2:0', windowId: 2, pid: 812 });
  assert.throws(() => f.picker.readSharedWindow({ ...f.event, senderFrame: {} }), /仅主窗口/);
  assert.equal(f.picker.sharedDisplayId(), null);
  f.picker.clearShared();
  assert.equal(f.picker.readSharedWindow(f.event), null);
});

test('failed window identity lookup does not prevent ordinary capture', async () => {
  const f = fixture({ resolveWindowIdentity: async () => { throw new Error('unavailable'); } });
  const id = f.start();
  await f.picker.list(f.event, id);
  assert.equal(await f.picker.choose(f.event, id, 'window:2:0'), true);
  assert.equal(f.answers[0].video.id, 'window:2:0');
  assert.equal(f.picker.readSharedWindow?.(f.event), null);
});

test('a cancelled identity lookup cannot overwrite a newer capture', async () => {
  let release = (_value) => {};
  let started = () => {};
  const looking = new Promise(resolve => { started = () => resolve(undefined); });
  const f = fixture({ resolveWindowIdentity: id => id === 2
    ? new Promise(resolve => { release = resolve; started(); }) : Promise.resolve({ pid: 913 }) });
  const oldId = f.start();
  await f.picker.list(f.event, oldId);
  const oldChoice = f.picker.choose(f.event, oldId, 'window:2:0');
  assert.equal(await Promise.race([looking.then(() => 'lookup'), oldChoice.then(() => 'capture')]), 'lookup');
  await f.picker.choose(f.event, oldId, null);
  const newId = f.start();
  await f.picker.list(f.event, newId);
  await f.picker.choose(f.event, newId, 'window:3:0');
  release({ pid: 812 });
  assert.equal(await oldChoice, false);
  assert.equal(f.picker.readSharedWindow(f.event).captureId, newId);
  assert.deepEqual(f.answers.map(answer => answer?.video.id ?? null), [null, 'window:3:0']);
});

test('Windows source handles reach authentication and the capture target without numeric conversion', async () => {
  const hwnd = '9007199254740993';
  const seen = [];
  const f = fixture({ platform: 'win32', resolveWindowsIdentity: async value => {
    seen.push(value);
    return { pid: 812, processStartedAt: '134000000000000001' };
  } });
  f.setSources([{ id: `window:${hwnd}:0`, name: 'Synthetic', thumbnail: { isEmpty: () => true } }]);
  const id = f.start();
  await f.picker.list(f.event, id);
  await f.picker.choose(f.event, id, `window:${hwnd}:0`);
  assert.deepEqual(seen, [hwnd]);
  assert.deepEqual(f.picker.readSharedWindow(f.event), {
    kind: 'window', platform: 'win32', captureId: id, sourceId: `window:${hwnd}:0`,
    windowId: hwnd, pid: 812, processStartedAt: '134000000000000001',
  });
  assert.equal(f.answers[0].video.id, `window:${hwnd}:0`);
});

test('Windows refuses unscoped identities without breaking ordinary window sharing', async () => {
  for (const identity of [{ pid: 812 }, { pid: 812, processStartedAt: '' }, { pid: 0, processStartedAt: '123' }, null]) {
    const f = fixture({ platform: 'win32', resolveWindowsIdentity: async () => identity,
      resolveWindowIdentity: async () => { throw new Error('must not use the macOS resolver'); } });
    const id = f.start();
    await f.picker.list(f.event, id);
    assert.equal(await f.picker.choose(f.event, id, 'window:2:0'), true);
    assert.equal(f.picker.readSharedWindow(f.event), null);
    assert.equal(f.answers[0].video.id, 'window:2:0');
  }
});

test('Windows rejects a handle outside uint64 without calling the native identity resolver', async () => {
  let calls = 0;
  const f = fixture({ platform: 'win32', resolveWindowsIdentity: async () => { calls++; return null; } });
  const sourceId = 'window:18446744073709551616:0';
  f.setSources([{ id: sourceId, name: 'Synthetic', thumbnail: { isEmpty: () => true } }]);
  const id = f.start();
  await f.picker.list(f.event, id);
  await f.picker.choose(f.event, id, sourceId);
  assert.equal(calls, 0);
  assert.equal(f.picker.readSharedWindow(f.event), null);
  assert.equal(f.answers[0].video.id, sourceId);
});

test('a cancelled Windows identity lookup cannot publish a stale target', async () => {
  let release = (_value) => {};
  let started = () => {};
  const waiting = new Promise(resolve => { started = () => resolve(undefined); });
  const f = fixture({ platform: 'win32', resolveWindowsIdentity: () => new Promise(resolve => { release = resolve; started(); }) });
  const id = f.start();
  await f.picker.list(f.event, id);
  const choosing = f.picker.choose(f.event, id, 'window:2:0');
  await waiting;
  await f.picker.choose(f.event, id, null);
  release({ pid: 812, processStartedAt: '123' });
  assert.equal(await choosing, false);
  assert.equal(f.picker.readSharedWindow(f.event), null);
  assert.deepEqual(f.answers, [null]);
});
