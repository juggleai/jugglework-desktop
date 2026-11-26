import { createMeetingSemanticAnnotationController } from "./meeting-semantic-annotation-controller";
import type { MeetingSemanticNativeEvent } from "@jugglework/types/desktop-ipc";

export function attachMeetingSemanticAnnotation(captureId: string) {
  const controller = createMeetingSemanticAnnotationController(captureId);
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail as MeetingSemanticNativeEvent;
    if (typeof detail?.nativeSessionId === "string" && Number.isInteger(detail.generation)) controller.receive(detail);
  };
  window.addEventListener("jugglework:meeting:semantic-annotation", listener);
  return () => { window.removeEventListener("jugglework:meeting:semantic-annotation", listener); controller.close(); };
}
