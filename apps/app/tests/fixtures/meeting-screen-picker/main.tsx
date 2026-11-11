import React from 'react';
import { createRoot } from 'react-dom/client';
import { MeetingScreenPicker } from '../../../src/react-app/domains/meeting/meeting-screen-picker';
import '../../../src/react-app/domains/meeting/meeting.css';
const root=createRoot(document.getElementById('root')!);
const svg=(color:string,label:string)=>`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="${color}"/><rect x="20" y="20" width="440" height="30" rx="8" fill="white" opacity=".5"/><text x="240" y="150" font-family="sans-serif" font-size="28" text-anchor="middle" fill="white">${label}</text></svg>`)}`;
const sources=[
  {id:'screen:1:0',kind:'screen' as const,name:'桌面 1',thumbnail:svg('#8094b3','Desktop 1'),appIcon:'',appKey:''},
  {id:'screen:2:0',kind:'screen' as const,name:'桌面 2',thumbnail:svg('#669d99','Desktop 2'),appIcon:'',appKey:''},
  ...Array.from({length:8},(_,i)=>({id:`window:${i}:0`,kind:'window' as const,name:`设计文档 ${i+1} — 项目协作空间`,thumbnail:svg(i%2?'#a289ab':'#b49b81',`Window ${i+1}`),appIcon:svg('#3478ff','A'),appKey:`app-${i}`})),
];
let closed=0,chosen='',fail=false,empty=false;
function render(key='initial') { root.render(<MeetingScreenPicker key={key} requestId="test" onClose={()=>{closed++;}} listSources={async()=>empty?[]:sources} chooseSource={async(_,id)=>{if(fail)throw Error('所选窗口已关闭，请刷新列表后重新选择。');chosen=id||'';return true;}}/>); }
const pause=()=>new Promise(r=>setTimeout(r,250));
function assert(value:unknown,message:string){if(!value)throw Error(message);}
function click(selector:string){document.querySelector<HTMLButtonElement>(selector)!.click();}
render();
(window as any).runScreenPickerCheck=async()=>{
 await pause();
 const modal=document.querySelector<HTMLElement>('[role=dialog]')!,confirm=()=>document.querySelector<HTMLButtonElement>('.screen-picker-foot .primary')!;
 const height=modal.getBoundingClientRect().height;
 assert(confirm().disabled,'sharing must require selection');
 assert(document.querySelectorAll('.screen-source').length===10,'all sources visible');
 assert(modal.scrollWidth<=modal.clientWidth,'modal horizontal overflow');
 assert(modal.getBoundingClientRect().bottom<=innerHeight,'modal outside viewport');
 click('.screen-source:nth-child(2)'); await pause();
 assert(!confirm().disabled && !chosen,'selection must not capture');
 assert(modal.getBoundingClientRect().height===height,'selection changed modal height');
 click('.screen-filter:nth-child(3)'); await pause();
 assert(confirm().disabled && document.querySelectorAll('.screen-source').length===8,'filter must clear hidden selection');
 click('.screen-source'); await pause(); fail=true; confirm().click(); await pause();
 assert(document.querySelector('[role=alert]')?.textContent?.includes('已关闭'),'stale source error missing');
 assert(closed===0 && !confirm().disabled,'failed confirm must allow retry');
 fail=false; confirm().click(); await pause(); assert(chosen==='window:0:0' && closed===1,'exact selection not confirmed');
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(closed===2,'Escape must cancel');
 empty=true;render('empty');await pause();assert(document.querySelector('.screen-picker-empty') && confirm().disabled,'empty sources must disable share');
 empty=false;render('preview');await pause();click('.screen-source');await pause();
 const footer=document.querySelector('.screen-picker-foot')!.getBoundingClientRect();
 assert(footer.bottom<=innerHeight && footer.top>=0,'footer inaccessible');
 return {size:[innerWidth,innerHeight],sources:10,selection:'explicit-only',filter:'clears-selection',staleSource:'retryable',escape:'passed',empty:'passed',geometry:'passed'};
};
