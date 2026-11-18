import { createRoot } from "react-dom/client";
import { WhiteboardPage, type WhiteboardBridge } from "../react-app/domains/meeting/whiteboard/whiteboard-page";

declare global { interface Window { __JUGGLEWORK_WHITEBOARD__?: WhiteboardBridge } }

const bridge = window.__JUGGLEWORK_WHITEBOARD__;
const root = createRoot(document.getElementById("root")!);
root.render(bridge
  ? <WhiteboardPage bridge={bridge} />
  : <div className="whiteboard-message" role="alert">白板只能在 JuggleWork 会议中打开。</div>);
