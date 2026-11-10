import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source=await fs.readFile(new URL('../src/react-app/domains/meeting/diagnostics.ts',import.meta.url),'utf8');
const load=async suffix=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source+`\nexport const instance=${suffix};`,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));

test('bounded diagnostics persist across restart; metrics exclude credentials and retain numeric media counters', async () => {
 const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 const values=new Map();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}});
 try {
  const d=await load(1);
  const safe=d.meetingNumericMetrics({audio:{audioBitrate:34,audioLevel:0.3,token:'SECRET',serverUrl:'https://secret',deviceId:123},secret:456,sdp:'SECRET'});
  assert.deepEqual(safe,{audio:{audioBitrate:34,audioLevel:0.3}});
  for(let i=0;i<1205;i++)d.meetingDiagnostic('sample',{i});
  assert.equal(JSON.parse(d.meetingDiagnosticsJson()).entries.length,1200);
  const restarted=await load(2);
  assert.equal(JSON.parse(restarted.meetingDiagnosticsJson()).entries.at(-1).data.i,1204);
  let complete;
  const pending=restarted.meetingDiagnosticStep('device.camera',{},()=>new Promise(r=>{complete=r}));
  const persisted=JSON.parse([...values.values()][0]);
  assert.equal(persisted.at(-1).event,'device.camera.start');
  complete();await pending;
  await assert.rejects(restarted.meetingDiagnosticStep('failure',{},async()=>{throw Object.assign(new Error('SECRET'),{code:7});}));
  const report=restarted.meetingDiagnosticsJson();
  assert.ok(!report.includes('SECRET'));
  assert.equal(JSON.parse(report).entries.at(-1).data.code,7);
  globalThis.localStorage.setItem=()=>{throw Error('quota');};
  assert.doesNotThrow(()=>restarted.meetingDiagnostic('still.usable'));
  assert.equal(JSON.parse(restarted.meetingDiagnosticsJson()).storageAvailable,false);
 } finally {if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;}
});
