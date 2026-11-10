import { afterAll, expect, mock, test } from "bun:test";
import type { CloudDocsBridge } from "../src/app/lib/cloud-docs-types";

const settings = { baseUrl: "https://organization.test", authToken: "fixture", activeOrgId: "tenant-a" };
const launch = mock(async (input: any) => ({ tenantId: input.tenantId, presentation: input.presentation,
  bootstrapUrl: "https://docs.test/bootstrap", launchGrant: "fixture" }));
mock.module("../src/app/lib/den", () => ({
  createDenClient: () => ({ launchCloudDocs: launch }),
  readDenSettings: () => settings, readDenUserId: () => "user-a",
}));
const storage = new Map<string, string>();
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
afterAll(() => {
  mock.restore();
  if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});
const { uploadWord } = await import("../src/react-app/domains/cloud-docs/upload-word");

/** 以不同组织与文件服务依赖构造 Word 接入，确保文件不经控制面读取。 */
async function fixture() {
  storage.clear();
  const data = new TextEncoder().encode("docx fixture").buffer;
  const hash = await crypto.subtle.digest("SHA-256", data);
  const checksum = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
  let listener: Parameters<CloudDocsBridge["onState"]>[0];
  const close = mock(async () => {});
  const create = mock(async () => ({ workspaceId: "docs-ws", pageId: "page-a" }));
  const link = mock(async () => ({ status: "active" }));
  const bridge = {
    readWordBlocks: async () => ({ blocks: [{ id: "1234abcd", start: 42, text: "Hello", kind: "text", marks: [] }] }),
    onState: (callback: typeof listener) => { listener = callback; return () => {}; },
    open: async (input: any) => { listener({ instanceId: input.instanceId, status: "ready" }); },
    close, createWordPage: create, linkWord: link,
  } as unknown as CloudDocsBridge;
  const fileClient = {
    statWorkspaceFile: mock(async () => ({ exists: true, kind: "file" as const, size: data.byteLength })),
    downloadWorkspaceFile: mock(async () => ({ data, filename: "sample.docx", contentType: "application/octet-stream" })),
  };
  return { bridge, fileClient, create, link, close, checksum,
    input: { bridge, fileClient, documentId: "word-a", localWorkspaceId: "local-ws",
      relativePath: "sample.docx", title: "sample", savedFileSha256: checksum } };
}

test("上传复用本地文件客户端，后台创建并在首次关联成功后返回页面", async () => {
  const f = await fixture();
  const result = await uploadWord(f.input);
  expect(f.fileClient.downloadWorkspaceFile).toHaveBeenCalledWith("local-ws", "sample.docx");
  expect(f.create.mock.calls[0]![0]).toMatchObject({ checksum: f.checksum,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  expect((f.create.mock.calls[0]![0] as any).blocks).toEqual([{ id: "1234abcd", text: "Hello", kind: "text", marks: [] }]);
  expect(result).toMatchObject({ tenantId: "tenant-a", pageId: "page-a", workspaceId: "docs-ws" });
  expect(f.link).toHaveBeenCalledTimes(1);
  expect((f.link.mock.calls[0]![0] as any).original.sourceId).toMatch(/^[A-Za-z0-9_-]{43}=$/);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(storage.size).toBe(0);
});

test("文件摘要与保存回执不符时不能创建云文档", async () => {
  const f = await fixture();
  await expect(uploadWord({ ...f.input, savedFileSha256: "0".repeat(64) })).rejects.toThrow("word_file_changed_after_save");
  expect(f.create).not.toHaveBeenCalled();
});

test("创建后关联失败保留同一请求，重试不重复建文档并释放后台宿主", async () => {
  const f = await fixture();
  f.link.mockImplementationOnce(async () => { throw new Error("word_initial_checkpoint_unconfirmed"); });
  await expect(uploadWord(f.input)).rejects.toThrow("word_initial_checkpoint_unconfirmed");
  const id = (f.create.mock.calls[0]![0] as any).requestId;
  await uploadWord(f.input);
  expect((f.create.mock.calls[1]![0] as any).requestId).toBe(id);
  expect(f.close).toHaveBeenCalledTimes(2);
});
