import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMeetingDiagnostics } from './meeting-diagnostics.mjs';

test('native hang and renderer/GPU exit evidence survives app restart without window content', async () => {
 const directory=await mkdtemp(join(tmpdir(),'meeting-native-trace-'));
 try {
  const file=join(directory,'native.json');
  const app=Object.assign(new EventEmitter(),{getVersion:()=> 'test'});
  const get=installMeetingDiagnostics(app,file,()=> 'meeting');
  get.record('runtime.health',{pressure:'warning',databaseBytes:1024});
  const window=Object.assign(new EventEmitter(), {id:7, webContents:Object.assign(new EventEmitter(),{isDestroyed:()=>false,getOSProcessId:()=>42})});
  app.emit('browser-window-created',{},window);
  window.emit('unresponsive');
  window.webContents.emit('render-process-gone',{}, {reason:'crashed',exitCode:1,url:'https://secret.invalid?token=SECRET'});
  app.emit('child-process-gone',{}, {type:'GPU',reason:'crashed',exitCode:2,serviceName:'SECRET'});
  assert.equal(get().records.at(-3).event,'window.unresponsive');
  assert.equal(get().records.some(r=>r.event==='runtime.health'),true);
  const stored=await readFile(file,'utf8');assert.ok(!stored.includes('SECRET'));
  const restarted=Object.assign(new EventEmitter(),{getVersion:()=> 'test'});
  const after=installMeetingDiagnostics(restarted,file,()=> 'main')();
  assert.equal(after.records.filter(r=>r.event==='renderer.gone').length,1);
  assert.equal(after.records.filter(r=>r.event==='process.start').length,2);
  for(let i=0;i<220;i++)window.emit('responsive');
  assert.equal(get().records.length,200);
 } finally {await rm(directory,{recursive:true,force:true});}
});
