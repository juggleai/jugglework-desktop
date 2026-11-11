import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { installMeetingCompactWindow } from "./meeting-compact-window.mjs";
class FakeWindow extends EventEmitter {
  bounds = {x:100,y:100,width:1200,height:800};
  minimized = false;
  top = false;
  visible = true;
  focused = true;
  destroyed = false;
  closeRequested = false;
  isDestroyed(){return this.destroyed;}
  getBounds(){return {...this.bounds};}
  setBounds(bounds){this.bounds={...bounds};}
  setAlwaysOnTop(top){this.top=top;}
  setVisibleOnAllWorkspaces(){}
  isMinimized(){return this.minimized;}
  isVisible(){return this.visible;}
  isFocused(){return this.focused;}
  restore(){this.minimized=false;}
  showInactive(){this.visible=true;}
  show(){this.visible=true;}
  focus(){this.focused=true;}
  hide(){this.visible=false;this.focused=false;this.emit("hide");}
  minimize(){this.minimized=true;this.emit("minimize");}
  close(){this.closeRequested=true;}
  destroy(){this.destroyed=true;this.visible=false;this.emit("closed");}
}
function setup() {
 const main=new FakeWindow(),full=new FakeWindow(),mini=new FakeWindow();
 mini.visible=false;
 const control=installMeetingCompactWindow(main,full,mini,()=>({x:1920,y:0,width:1440,height:900}));
 control.markReady();
 return {main,full,mini,control};
}
test("minimize switches persistent windows without resizing or destroying the full window",()=>{
 const {full,mini,control}=setup(), original=full.getBounds();
 full.minimize();
 assert.equal(full.visible,false);
 assert.equal(mini.visible,true);
 assert.equal(mini.top,true);
 assert.deepEqual(mini.bounds,{x:3084,y:16,width:260,height:82});
 assert.deepEqual(full.bounds,original);
 control.restore();
 assert.equal(full.visible,true);
 assert.equal(full.minimized,false);
 assert.equal(mini.visible,false);
 assert.deepEqual(full.bounds,original);
 assert.equal(full.destroyed,false);
 assert.equal(mini.destroyed,false);
 full.emit("closed");
 assert.equal(mini.destroyed,true);
});
test("unfocused video shows mini without hiding full, focus dismisses mini",()=>{
 const {main,full,mini,control}=setup();
 full.focused=false;
 full.emit("blur");
 control.markReady();
 control.checkVisibility();
 assert.equal(control.isCompact(),true);
 assert.equal(full.visible,true);
 assert.equal(mini.visible,true);
 full.focused=true;
 full.emit("focus");
 assert.equal(mini.visible,false);
 main.minimize();
 main.hide();
 assert.equal(main.minimized,true);
 assert.equal(full.visible,true);
 assert.equal(mini.visible,false);
 full.hide();
 assert.equal(control.isCompact(),true);
 assert.equal(mini.visible,true);
 mini.hide();
 assert.equal(mini.visible,true);
 mini.visible=false;
 control.checkVisibility();
 assert.equal(mini.visible,true);
 assert.equal(full.closeRequested,false);
 full.emit("closed");
 assert.equal(main.listenerCount("hide"),0);
 assert.equal(main.listenerCount("minimize"),0);
});
test("mini waits for portal readiness and closing it routes through full-window confirmation",()=>{
 const main=new FakeWindow(),full=new FakeWindow(),mini=new FakeWindow();
 mini.visible=false;
 const control=installMeetingCompactWindow(main,full,mini,()=>({x:0,y:0,width:1440,height:900}));
 full.hide();
 assert.equal(mini.visible,false);
 control.markReady();
 assert.equal(mini.visible,true);
 let prevented=false;
 mini.emit("close",{preventDefault(){prevented=true;}});
 assert.equal(prevented,true);
 assert.equal(full.visible,true);
 assert.equal(full.closeRequested,true);
 assert.equal(mini.destroyed,false);
 full.emit("closed");
});
