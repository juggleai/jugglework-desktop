import { app, BrowserWindow, ipcMain, screen as nativeScreen, Menu } from 'electron';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDesktopPet } from '../electron/pet-window.mjs';

// TIPS: 使用独立账号目录和虚拟鼠标坐标，驱动真实Electron画布，不发送真实任务或移动用户宠物。
const output=mkdtempSync(join(tmpdir(),'juggle-pet-placement-'));
app.setPath('userData',join(output,'profile'));
void app.whenReady().then(async()=>{
  const main=new BrowserWindow({show:false});
  const screen=new EventEmitter();
  let workArea={...nativeScreen.getPrimaryDisplay().workArea}, cursor={x:0,y:0};
  screen.getPrimaryDisplay=screen.getDisplayNearestPoint=()=>({workArea});
  screen.getCursorScreenPoint=()=>cursor;
  const controller=createDesktopPet({BrowserWindow,screen,ipcMain,Menu,preferencesPath:join(output,'pet.json'),preloadPath:resolve(import.meta.dirname,'../electron/pet-preload.mjs'),getMainWindow:()=>main,loadPage:win=>win.loadURL(process.env.JUGGLEWORK_PET_SMOKE_URL || 'http://localhost:5173/pet.html')});
  const report={output,assertions:{},errors:[]};
  try{
    const choices=Array.from({length:14},(_,index)=>({key:`fixture:choice-${index}`,workspaceId:'fixture',sessionId:`choice-${index}`,project:'示例项目',title:index===0?'当前会话':`历史会话 ${index}`}));
    main.webContents.send=(channel,payload)=>{if(channel==='jugglework:pet:host-action')ipcMain.emit('jugglework:pet:host-reply',{sender:main.webContents},{requestId:payload.requestId,result:payload.action.type==='latest'?{target:choices[0]}:payload.action.type==='sessions'?{targets:choices}:{}});};
    await controller.setVisible(true);
    const pet=BrowserWindow.getAllWindows().find(win=>win!==main);
    let passthrough;const ignore=pet.setIgnoreMouseEvents.bind(pet);pet.setIgnoreMouseEvents=(value,options)=>{passthrough=value;return ignore(value,options);};
    const evaluate=code=>pet.webContents.executeJavaScript(code);
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const waitFor=async code=>{const until=Date.now()+5000;while(Date.now()<until){if(await evaluate(code))return;await pause(25);}throw new Error(`验收超时 ${code}`);};
    pet.webContents.on('console-message',event=>{if(event.level==='error')report.errors.push(event.message);});
    let resizes=0,loads=0;pet.on('resize',()=>resizes++);pet.webContents.on('did-start-loading',()=>loads++);
    ipcMain.emit('jugglework:pet:publish',{sender:main.webContents},{contextKey:'placement-test',ready:true,syncing:false,partial:false,locale:'zh',theme:'light',voicePhase:'idle',voiceAvailable:false,tasks:Array.from({length:8},(_,i)=>({key:`task-${i}`,workspaceId:'fixture',sessionId:`task-${i}`,project:'布局验收',title:`任务 ${i+1}`,turnKey:'turn',state:'running',statusText:'正在思考',progressText:'已运行命令',canStop:true}))});
    await waitFor('document.querySelector(".pet-root")?.dataset.positioned === "true"');
    controller.focus();
    await waitFor('document.querySelector(".pet-tools")?.dataset.visible === "true"');
    await pause(300);
    report.assertions.repeatedBellToggleStable=await evaluate(`(async()=>{
      const character=document.querySelector('.pet-character'),controls=document.querySelector('.pet-controls'),sprite=document.querySelector('.pet-sprite'),surface=document.querySelector('.pet-control-surface');
      const before=character.getBoundingClientRect(),bubble=surface.getBoundingClientRect(),url=sprite.style.backgroundImage;
      let stable=true;
      for(let i=0;i<16;i++){
        document.querySelectorAll('.pet-tools button')[2].click();
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const after=character.getBoundingClientRect(),next=surface.getBoundingClientRect();
        stable&&=document.querySelector('.pet-character')===character&&document.querySelector('.pet-controls')===controls&&document.querySelector('.pet-sprite')===sprite&&sprite.style.backgroundImage===url&&Math.abs(after.x-before.x)<.1&&Math.abs(after.y-before.y)<.1&&Math.abs(next.x-bubble.x)<.1&&Math.abs(next.y-bubble.y)<.1&&Math.abs(next.width-120)<.1&&getComputedStyle(surface).opacity==='1';
      }return stable;
    })()`);
    report.assertions.bellDoesNotResizeOrReload=resizes===0&&loads===0;
    await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
    await waitFor('document.querySelector(".pet-card")');
    await evaluate('document.querySelector(".pet-card").click()');
    await waitFor('document.querySelectorAll(".pet-card").length===8');
    const handle=await evaluate('(()=>{const r=document.querySelector(".pet-tools button").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    const oldViewport=await evaluate('window.__JUGGLEWORK_PET__.getViewport()');
    cursor={x:pet.getBounds().x+handle.x,y:pet.getBounds().y+handle.y};await pause(25);
    pet.webContents.sendInputEvent({type:'mouseMove',...handle});
    pet.webContents.sendInputEvent({type:'mouseDown',...handle,button:'left',clickCount:1});await pause(25);
    // Electron注入缺少screenX/Y，补齐屏幕位移，保留真实按键、指针捕获和click传播。
    await evaluate('document.querySelector(".pet-tools button").dispatchEvent(new PointerEvent("pointermove",{bubbles:true,pointerId:1,buttons:1,screenX:12,screenY:4}))');
    await pause(30);cursor={x:cursor.x+12,y:cursor.y+4};await pause(65);
    pet.webContents.sendInputEvent({type:'mouseUp',...handle,button:'left',clickCount:1});await pause(35);
    const movedViewport=await evaluate('window.__JUGGLEWORK_PET__.getViewport()');
    report.assertions.toolbarGestureMovesPet=Math.abs(movedViewport.screenX+movedViewport.character.x-oldViewport.screenX-oldViewport.character.x-12)<=1;
    report.assertions.toolbarDragDoesNotClickInput=await evaluate('!document.querySelector(".pet-composer") && document.querySelectorAll(".pet-card").length===8');
    const moveTo=async(x,y)=>{
      const v=await evaluate('window.__JUGGLEWORK_PET__.getViewport()');
      cursor={x:0,y:0};ipcMain.emit('jugglework:pet:drag',{sender:pet.webContents},true);
      cursor={x:x-(v.screenX+v.character.x),y:y-(workArea.y+v.character.y)};
      await pause(65);ipcMain.emit('jugglework:pet:drag',{sender:pet.webContents},false);await pause(60);
    };
    const snapshot=()=>evaluate(`(()=>{const panel=document.querySelector('.pet-panels'),r=panel.getBoundingClientRect(),t=document.querySelector('.pet-tools').getBoundingClientRect(),c=document.querySelector('.pet-character').getBoundingClientRect();return{side:panel.dataset.side,align:panel.dataset.align,panel:{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height},tools:{x:t.x,right:t.right},character:{x:c.x,y:c.y},viewport:{width:innerWidth,height:innerHeight},cardsHeight:document.querySelector('.pet-cards').clientHeight,cardsScroll:document.querySelector('.pet-cards').scrollHeight}})()`);
    await moveTo(workArea.x+40,workArea.y+28);let view=await snapshot();
    report.assertions.topMovesListBelow=view.side==='below'&&view.panel.y>view.character.y+112;
    report.assertions.leftEdgesAlign=Math.abs(view.panel.x-view.tools.x)<1;
    report.assertions.topListStaysVisible=view.panel.y>=20&&view.panel.bottom<=view.viewport.height-20;
    writeFileSync(join(output,'top-left.png'),(await pet.webContents.capturePage()).toPNG());
    // TIPS: 被列表裁剪的关闭按钮仍有DOM矩形，但透明位置必须穿透原生窗口。
    const clippedClose=await evaluate(`(()=>{const p=document.querySelector('.pet-panels').getBoundingClientRect();return [...document.querySelectorAll('.pet-close')].map(e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}).find(r=>r.y>p.bottom+24&&r.y<innerHeight-16)})()`);
    if(!clippedClose) throw new Error('缺少滚动裁剪的关闭按钮验收样本');
    cursor={x:pet.getBounds().x+clippedClose.x,y:pet.getBounds().y+clippedClose.y};await pause(50);
    report.assertions.clippedClosePassesTransparentClicks=passthrough===true;
    await evaluate('document.querySelector(".pet-cards").scrollTop=10000');await pause(60);
    // 滚动后移到最后一张可见卡片，显示关闭按钮，再检查左上角越过面板边界的可见部分。
    const lastCard=await evaluate('(()=>{const r=[...document.querySelectorAll(".pet-card")].at(-1).getBoundingClientRect();return{x:r.x+40,y:r.y+24}})()');
    cursor={x:pet.getBounds().x+lastCard.x,y:pet.getBounds().y+lastCard.y};await pause(30);
    pet.webContents.sendInputEvent({type:'mouseMove',...lastCard});await pause(60);
    const closePoint=await evaluate('(()=>{const e=[...document.querySelectorAll(".pet-close")].at(-1),r=e.getBoundingClientRect();return{x:r.x+2,y:r.y+r.height/2,visible:getComputedStyle(e).pointerEvents==="auto"}})()');
    cursor={x:pet.getBounds().x+closePoint.x,y:pet.getBounds().y+closePoint.y};await pause(40);
    report.assertions.visibleScrolledCloseRemainsInteractive=closePoint.visible&&passthrough===false;
    await evaluate('document.querySelector(".pet-cards").scrollTop=0');await pause(50);
    await moveTo(workArea.x+workArea.width-144,workArea.y+workArea.height-193);view=await snapshot();
    report.assertions.bottomMovesListAbove=view.side==='above'&&view.panel.bottom<view.character.y;
    report.assertions.rightEdgesAlign=Math.abs(view.panel.right-view.tools.right)<1;
    report.assertions.bottomListStaysVisible=view.panel.y>=20&&view.panel.bottom<=view.viewport.height-20;
    writeFileSync(join(output,'bottom-right.png'),(await pet.webContents.capturePage()).toPNG());
    const v=await evaluate('window.__JUGGLEWORK_PET__.getViewport()');
    cursor={x:0,y:0};ipcMain.emit('jugglework:pet:drag',{sender:pet.webContents},true);
    const start={x:v.screenX+v.character.x,y:workArea.y+v.character.y};
    let smooth=true;
    for(let step=1;step<=12;step++){cursor={x:-step*4,y:-step*3};await pause(22);const next=await evaluate('window.__JUGGLEWORK_PET__.getViewport()');smooth&&=Math.abs(next.screenX+next.character.x-(start.x+cursor.x))<=1&&Math.abs(workArea.y+next.character.y-(start.y+cursor.y))<=1;}
    ipcMain.emit('jugglework:pet:drag',{sender:pet.webContents},false);
    report.assertions.dragTracksContinuousCoordinates=smooth;
    report.assertions.dragWithinDisplayNeverResizes=resizes===0;
    workArea={...workArea,height:420};screen.emit('display-metrics-changed');await pause(160);view=await snapshot();
    report.assertions.shortDisplayScrollsWithoutClipping=view.panel.y>=20&&view.panel.bottom<=view.viewport.height-20&&view.cardsScroll>view.cardsHeight;
    cursor={x:pet.getBounds().x+2,y:pet.getBounds().y+2};ipcMain.emit('jugglework:pet:keyboard',{sender:pet.webContents},true);await pause(30);
    report.assertions.focusedCanvasStillPassesTransparentClicks=pet.isFocusable()&&passthrough===true;
    report.snapshots={shortDisplay:view};
    // 输入位置独立于菜单；以短屏幕同时验证上下翻转、紧邻间距、限高及原生命中。
    await moveTo(workArea.x+40,workArea.y+28);
    await evaluate('document.querySelectorAll(".pet-tools button")[0].click()');
    await waitFor('document.querySelector(".pet-target")?.textContent.includes("当前会话")');
    const inputBefore=await evaluate('(()=>{const r=document.querySelector(".pet-composer").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}})()');
    await evaluate('document.querySelector(".pet-input-plus").click()');
    await waitFor('document.querySelectorAll(".pet-session-option").length===14');
    const optionsView=()=>evaluate(`(()=>{const m=document.querySelector('.pet-input-options').getBoundingClientRect(),c=document.querySelector('.pet-composer').getBoundingClientRect(),l=document.querySelector('.pet-session-list');return{side:document.querySelector('.pet-panels').dataset.optionsSide,menu:{x:m.x,y:m.y,right:m.right,bottom:m.bottom,width:m.width},input:{x:c.x,y:c.y,right:c.right,bottom:c.bottom,width:c.width},scrolls:l.scrollHeight>l.clientHeight,height:innerHeight}})()`);
    let options=await optionsView();
    report.assertions.plusMenuBelowTouchesInput=options.side==='below'&&Math.abs(options.menu.y-options.input.bottom-8)<1;
    report.assertions.plusMenuDoesNotMoveInput=Math.abs(inputBefore.x-options.input.x)<1&&Math.abs(inputBefore.y-options.input.y)<1&&Math.abs(inputBefore.width-options.input.width)<1;
    report.assertions.plusMenuBelowFitsAndScrolls=options.menu.bottom<=options.height-16&&options.scrolls;
    report.assertions.plusMenuLeftEdgesAlign=Math.abs(options.menu.x-options.input.x)<1&&Math.abs(options.menu.width-options.input.width)<1;
    await evaluate('document.documentElement.style.background="#fff"');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    writeFileSync(join(output,'plus-below.png'),(await pet.webContents.capturePage()).toPNG());
    await evaluate('document.documentElement.style.removeProperty("background")');
    await moveTo(workArea.x+workArea.width-144,workArea.y+190);options=await optionsView();
    report.assertions.plusMenuAboveTouchesInput=options.side==='above'&&Math.abs(options.input.y-options.menu.bottom-8)<1;
    report.assertions.plusMenuAboveFitsAndScrolls=options.menu.y>=16&&options.scrolls;
    report.assertions.plusMenuRightEdgesAlign=Math.abs(options.menu.right-options.input.right)<1;
    cursor={x:pet.getBounds().x+options.menu.x+20,y:pet.getBounds().y+options.menu.y+40};await pause(40);
    report.assertions.plusMenuNativeHitRegion=passthrough===false;
    await evaluate('document.documentElement.style.background="#fff"');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    writeFileSync(join(output,'plus-above.png'),(await pet.webContents.capturePage()).toPNG());
    await evaluate('document.documentElement.style.removeProperty("background")');
    writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    process.exitCode=report.errors.length||Object.values(report.assertions).some(value=>!value)?1:0;
  }catch(error){console.error(error);console.error(JSON.stringify(report));process.exitCode=1;}
  finally{controller.dispose();main.destroy();app.exit(process.exitCode||0);}
});
