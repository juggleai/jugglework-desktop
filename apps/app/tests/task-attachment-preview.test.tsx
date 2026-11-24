import type { ReactNode } from "react";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { t } from "../src/i18n";
import { loadAttachmentPreview } from "../src/react-app/domains/tasks/task-attachment-preview-resource";

// Only replace the browser portal/focus machinery; exercise the real preview,
// asynchronous loader and download button together.
const children = ({ children }: { children: ReactNode }) => <>{children}</>;
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ children, onOpenChange }: { children: ReactNode; onOpenChange: (open: boolean) => void }) =>
    <section><button onClick={() => onOpenChange(false)}>close</button>{children}</section>,
  DialogContent: children, DialogHeader: children, DialogTitle: children, DialogDescription: children, DialogFooter: children,
}));
const { TaskAttachmentPreview } = await import("../src/react-app/domains/tasks/task-attachment-preview");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const file = (name: string) => ({ name, size: null, url: "https://files.test/object?signed=123" });
const signal = () => new AbortController().signal;
const noop = () => {};
let view: TestRenderer.ReactTestRenderer | undefined;
async function show(name: string, onClose = noop, onDownload = noop) {
  await act(async () => {
    const element = <TaskAttachmentPreview file={file(name)} onClose={onClose} onDownload={onDownload} />;
    if (view) view.update(element);
    else view = TestRenderer.create(element);
  });
  return view!.root;
}
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
  mock.restore();
});

test.each(["report.html", "drawing.svg", "bundle.js", "document.pdf", "archive.zip"])("%s offers download without fetching or embedding", async name => {
  const fetch = spyOn(globalThis, "fetch"), download = mock(noop), close = mock(noop);
  const root = await show(name, close, download);
  expect(fetch).not.toHaveBeenCalled();
  expect(root.findByProps({ role: "status" }).children).toEqual([t("tasks.attachment_preview_unsupported")]);
  expect(root.findAll(node => ["embed", "object", "iframe", "webview"].includes(String(node.type)))).toHaveLength(0);
  root.findAllByType("button").find(node => node.children.includes(t("tasks.download_file")))!.props.onClick();
  root.findAllByType("button").find(node => node.children.includes("close"))!.props.onClick();
  expect(download).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

test("plain text stays a literal React text child; the signed request omits credentials, referrer and redirects", async () => {
  const text = "<svg></svg>\n<script></script> & **text**";
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } }));
  const root = await show("notes.TXT");
  expect(root.findByType("pre").children).toEqual([text]);
  expect(root.findByType("pre").props.dangerouslySetInnerHTML).toBeUndefined();
  expect(fetch).toHaveBeenCalledWith(file("notes.TXT").url, expect.objectContaining({
    credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal),
  }));
});

test("rejects local schemes, relative URLs and embedded credentials before fetch", async () => {
  const fetch = spyOn(globalThis, "fetch");
  for (const url of ["file:///a.txt", "data:text/plain,text", "blob:https://files.test/123", "/relative", "https://user:pass@files.test/x"]) {
    await expect(loadAttachmentPreview({ ...file("a.txt"), url }, signal())).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
});

test("rejects an active response MIME even under an allowed filename", async () => {
  const fetch = spyOn(globalThis, "fetch");
  const create = spyOn(URL, "createObjectURL");
  for (const mime of ["image/svg+xml", "text/html", "application/javascript"]) {
    fetch.mockResolvedValueOnce(new Response("content", { headers: { "content-type": mime } }));
    expect(await loadAttachmentPreview(file("photo.png"), signal())).toEqual({ kind: "unsupported" });
  }
  expect(create).not.toHaveBeenCalled();
});

test("limits text by actual streamed size even without a Content-Length or stored size", async () => {
  const cancel = mock(noop);
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(600_000)); }, cancel });
  spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
  expect(await loadAttachmentPreview(file("log.txt"), signal())).toEqual({ kind: "too-large" });
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("switch aborts a pending request; a late response never allocates a URL or replaces the new preview", async () => {
  let finish!: (response: Response) => void;
  const fetch = spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(new Response("second"));
  const create = spyOn(URL, "createObjectURL");
  await show("first.png");
  const request = fetch.mock.calls[0][1]!.signal!;
  const root = await show("second.txt");
  expect(request.aborted).toBe(true);
  await act(async () => finish(new Response(new Uint8Array([1]))));
  expect(root.findByType("pre").children).toEqual(["second"]);
  expect(create).not.toHaveBeenCalled();
});

test("media receives only typed blob URLs, revoked on switch and unmount", async () => {
  spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "application/octet-stream" } }));
  const create = spyOn(URL, "createObjectURL").mockImplementation(blob => `blob:test/${blob.type}`);
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(noop);
  let previous: string | undefined;
  for (const [name, tag, mime] of [["photo.JPG", "img", "image/jpeg"], ["clip.webm", "video", "video/webm"], ["music.mp3", "audio", "audio/mpeg"]] as const) {
    const root = await show(name);
    if (previous) expect(revoke).toHaveBeenCalledWith(previous);
    previous = `blob:test/${mime}`;
    expect(root.findByType(tag).props.src).toBe(previous);
    if (tag !== "img") expect(root.findByType(tag).props.controls).toBe(true);
  }
  await act(async () => view!.unmount());
  view = undefined;
  expect(revoke).toHaveBeenCalledWith(previous);
  expect(create).toHaveBeenCalledTimes(3);
  expect(revoke).toHaveBeenCalledTimes(3);
});

test("network failure leaves download available", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const download = mock(noop);
  const root = await show("a.txt", noop, download);
  expect(root.findByProps({ role: "alert" }).children).toEqual([t("tasks.attachment_preview_failed")]);
  root.findAllByType("button").find(node => node.children.includes(t("tasks.download_file")))!.props.onClick();
  expect(download).toHaveBeenCalledTimes(1);
});
