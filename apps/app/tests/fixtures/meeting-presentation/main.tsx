import React from "react";
import { createRoot } from "react-dom/client";
import { MeetingChatToasts } from "../../../src/react-app/domains/meeting/meeting-chat-toasts";
import { MeetingInvitePicker } from "../../../src/react-app/domains/meeting/meeting-invite-picker";
import { MeetingCode } from "../../../src/react-app/domains/meeting/meeting-code";
import type { ChatMessage } from "../../../src/react-app/domains/jugglechat/types";
import "../../../src/react-app/domains/meeting/meeting.css";

const root = createRoot(document.getElementById("root")!);
const makeMessage = (id: string, sender = "remote"): ChatMessage => ({
  messageId: id, sender: { id: sender, name: sender === "me" ? "我" : "参会成员" },
  name: "jw:meeting-chat", conversationId: "fixture", conversationType: 3,
  content: { content: `消息 ${id}：这是一条会议消息，用于验证右下角浮层和聊天面板的切换。` },
});
let width = 900, height = 500, count = 2, share = false, focus = true, open = false, meeting = "first";
let messages = [makeMessage("history")];
function render() {
  root.render(<div className="meeting-ui meeting-room-ui" style={{width, height}}>
    <section className="room"><div className="room-main"><div className="stage-area">
      <div className={`stage${focus ? " stage-focus" : ""}`}>
        {share ? <div className="tile share-stage" data-focused={focus}><span className="tile-label">屏幕共享</span></div> : null}
        {Array.from({length: count}, (_, i) => <div className="tile" key={i} data-focused={focus && !share && i === 0}>
          <span className="avatar">{i + 1}</span><span className="tile-label">成员 {i + 1}</span>
        </div>)}
      </div>
      <MeetingChatToasts key={meeting} messages={messages} open={open} userId="me" onOpen={() => { open = true; render(); }} />
    </div>{open ? <aside className="room-panel">会议聊天</aside> : null}</div></section>
  </div>);
}
const pause = (ms = 280) => new Promise(r => setTimeout(r, ms));
const assert = (condition: unknown, reason: string) => { if (!condition) throw new Error(reason); };
const toasts = () => document.querySelectorAll(".meeting-message-toast").length;
render();
(window as any).runMeetingPresentationCheck = async () => {
  const geometry: object[] = [];
  for (const size of [[900, 500], [620, 360]]) {
    [width, height] = size;
    for (const n of [1, 2, 6, 12]) for (const shared of [false, true]) {
      count = n; share = shared; render(); await pause();
      const tiles = [...document.querySelectorAll<HTMLElement>(".stage > .tile")];
      const rects = tiles.map(t => t.getBoundingClientRect());
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        assert(!(a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1), `tiles overlap: ${width}/${n}/${shared}/${i}/${j}`);
      }
      const stage = document.querySelector(".stage")!;
      assert(rects[0].width >= stage.clientWidth - 1, "focus tile must fill stage width");
      assert(stage.scrollWidth <= stage.clientWidth + 1, "stage overflows horizontally");
      assert(rects.slice(1).every(r => r.top >= rects[0].bottom), "thumbnails must follow focus tile");
      geometry.push({width, height, members:n, share:shared, primaryHeight:rects[0].height});
    }
  }
  width = 900; height = 500; count = 2; share = false; render(); await pause();
  assert(toasts() === 0, "history must not appear as a new message");
  const toastContainer = document.querySelector(".meeting-message-toasts");
  messages = [...messages, makeMessage("new")]; render(); await pause();
  assert(toasts() === 1, "new incoming message should appear");
  assert(document.querySelector(".meeting-message-toasts") === toastContainer, "toast layer must remain mounted");
  assert(getComputedStyle(document.querySelector(".meeting-toast-slot")!).animationFillMode === "both", "entry must hide the pre-animation frame");
  assert(getComputedStyle(document.querySelector(".meeting-message-toast")!).backdropFilter === "none", "toast must not blur/recompose live video");
  const firstToast = document.querySelector(".meeting-message-toast")!.getBoundingClientRect();
  const area = document.querySelector(".stage-area")!.getBoundingClientRect();
  assert(firstToast.right <= area.right && firstToast.bottom <= area.bottom && firstToast.left >= area.left, "toast must stay inside stage");
  messages = [...messages, makeMessage("new"), makeMessage("own", "me")]; render(); await pause();
  assert(toasts() === 1, "duplicate and own messages must not create toasts");
  messages = [...messages, ...[1, 2, 3, 4, 5].map(i => makeMessage(`burst-${i}`))]; render(); await pause();
  assert(toasts() === 3, "burst must be bounded to three toasts");
  open = true; render(); await pause();
  assert(toasts() === 0, "opening chat must clear current toasts");
  messages = [...messages, makeMessage("while-open")]; render(); await pause();
  open = false; render(); await pause();
  assert(toasts() === 0, "closing chat must not replay messages received while open");
  messages = [...messages, makeMessage("click")]; render(); await pause();
  document.querySelector<HTMLButtonElement>(".toast-message")!.click(); await pause();
  assert(open && toasts() === 0, "clicking toast must open chat and dismiss toasts");
  open = false; messages = [...messages, makeMessage("dismiss")]; render(); await pause();
  const dismissing = document.querySelector(".meeting-toast-slot");
  document.querySelector<HTMLButtonElement>(".toast-close")!.click(); await pause(25);
  assert(dismissing?.isConnected && dismissing.getAttribute("data-exiting") === "true", "dismissal must animate before removing its row");
  await pause();
  assert(toasts() === 0 && !open, "close button must dismiss without opening chat");
  messages = [...messages, makeMessage("expires")]; render(); await pause();
  assert(toasts() === 1, "expiry fixture missing");
  await pause(6500);
  assert(toasts() === 0, "toast must expire automatically");
  messages = [...messages, makeMessage("old-meeting")]; render(); await pause();
  meeting = "second"; render(); await pause();
  assert(toasts() === 0, "new meeting must not retain old toasts");
  const contacts = Array.from({length:8}, (_,i) => ({user_id:`member-${i}`,nickname:i === 0 ? "很长的参会成员名称用于验证截断" : `成员 ${i + 1}`}));
  let sent: string[] = [];
  root.render(<div className="meeting-ui"><MeetingCode code="MEET-123456" /><MeetingInvitePicker contacts={contacts} busy={false} error="" onClose={() => {}} onInvite={ids => {sent=ids;}} /></div>);
  await pause();
  const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
  const beforeHeight = dialog.getBoundingClientRect().height;
  assert(dialog.scrollWidth <= dialog.clientWidth, "invitation dialog overflows horizontally");
  assert(document.activeElement?.getAttribute("aria-label") === "搜索成员", "invitation should focus search");
  const choice = document.querySelector<HTMLInputElement>(".invite-candidates input[type=checkbox]")!;
  const chosenName = choice.closest("label")!.querySelector(".invite-person-name")!.textContent;
  const expectedId = contacts.find(c => c.nickname === chosenName)!.user_id;
  choice.click(); await pause();
  assert(document.querySelectorAll(".invite-selected .invite-person").length === 1, "selection must appear in right column");
  assert(dialog.getBoundingClientRect().height === beforeHeight, "selection must not resize invitation modal");
  document.querySelector<HTMLButtonElement>(".modal-foot .primary")!.click();
  assert(sent.length === 1 && sent[0] === expectedId, "invitation must use chosen member IDs");
  document.querySelector<HTMLButtonElement>(".invite-clear")!.click(); await pause();
  assert(document.querySelectorAll(".invite-selected .invite-person").length === 0, "clear must remove selected members");
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const execDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
  let copied = "";
  try {
    Object.defineProperty(navigator, "clipboard", {configurable:true, value:{writeText: async(value:string) => {copied=value;}}});
    const copyButton = document.querySelector<HTMLButtonElement>(".meeting-code-button")!;
    const widthBefore = copyButton.getBoundingClientRect().width;
    copyButton.click(); await pause();
    assert(copied === "MEET-123456", "copy must write exactly the meeting code");
    assert(copyButton.dataset.copied === "true" && !!copyButton.querySelector(".lucide-check"), "copy success check missing");
    assert(getComputedStyle(copyButton.querySelector("svg")!).color === "rgb(42, 150, 115)", "copy success check must be green");
    assert(!document.querySelector(".code-copy-feedback"), "copy must not show a text notification");
    assert(copyButton.getBoundingClientRect().width === widthBefore, "copy feedback must not move the button");
    Object.defineProperty(navigator, "clipboard", {configurable:true, value:{writeText:async()=>{throw new Error("denied");}}});
    Object.defineProperty(document, "execCommand", {configurable:true,value:()=>false});
    copyButton.click(); await pause();
    assert(copyButton.dataset.copied === "false" && !!copyButton.querySelector(".lucide-copy"), "copy failure must not report success");
    assert(document.querySelectorAll("textarea").length === 0, "copy fallback must clean up its input");
    assert([...document.querySelectorAll("svg")].every(svg => svg.getAttribute("stroke-width") === "1.75"), "meeting icon stroke widths must match");
  } finally {
    if(clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor); else delete (navigator as any).clipboard;
    if(execDescriptor) Object.defineProperty(document, "execCommand", execDescriptor); else delete (document as any).execCommand;
  }
  root.unmount();
  return {layoutCases: geometry.length, geometry, chat: "history/dedup/own/burst/open/close/click/animated-dismiss/expiry/meeting-reset passed", invitation:"selection/stable-height/clear/callback passed", copy:"value/success/failure/stable-width/cleanup passed", icons:"uniform stroke passed"};
};
