import { createRoot } from "react-dom/client";
import { WhiteboardPage, type WhiteboardBridge } from "../react-app/domains/meeting/whiteboard/whiteboard-page";

// The meeting stage sets the bridge on this page's same-origin iframe element.
type WhiteboardFrame = HTMLIFrameElement & { __juggleworkWhiteboard?: WhiteboardBridge };

let bridge: WhiteboardBridge | undefined;
try { bridge = (window.frameElement as WhiteboardFrame | null)?.__juggleworkWhiteboard; } catch { bridge = undefined; }
const root = createRoot(document.getElementById("root")!);
root.render(bridge
  ? <WhiteboardPage bridge={bridge} />
  : <div className="whiteboard-message" role="alert">白板只能在 JuggleWork 会议中打开。</div>);
