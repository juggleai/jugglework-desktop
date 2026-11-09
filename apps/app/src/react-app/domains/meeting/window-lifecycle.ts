// Electron cancels a native close when beforeunload is prevented. Once media
// cleanup marks the session idle, the programmatic close is allowed through.
export function guardMeetingWindowClose(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  isActive: () => boolean,
  confirm: () => void,
) {
  const listener = (event: BeforeUnloadEvent) => {
    if (!isActive()) return;
    event.preventDefault();
    event.returnValue = "请确认离开会议";
    confirm();
  };
  target.addEventListener("beforeunload", listener as EventListener);
  return () =>
    target.removeEventListener("beforeunload", listener as EventListener);
}
