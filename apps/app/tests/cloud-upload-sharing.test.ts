import { afterAll, expect, mock, test } from "bun:test";
const actual = await import("../src/app/lib/den.ts?cloud-upload-sharing-real");
let tenant = "org-a", userId = "u1";
const settings = () => ({ baseUrl: "https://server.test", authToken: "test-auth", activeOrgId: tenant });
let launches = 0;
mock.module("../src/app/lib/den", () => ({ ...actual, readDenSettings: settings, readDenUserId: () => userId,
  createDenClient: () => ({ launchCloudDocs: async ({ tenantId }: any) => {
    launches++;
    return { tenantId, docsOrigin: "https://docs.test", bootstrapUrl: "https://docs.test/api/jw/session/bootstrap", launchGrant: "test-grant", presentation: { mode: "product" } };
  } }),
}));
const original = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const data = new Map<string, string>();
const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
const states = new Set<(state: any) => void>();
let opens = 0, closes = 0, uploads = 0;
const published: any[] = [];
const bridge = { onState: (handler: (state: any) => void) => { states.add(handler); return () => { states.delete(handler); }; },
  open: async ({ instanceId }: any) => { opens++; states.forEach(handler => handler({ instanceId, status: "ready" })); return { instanceId }; },
  close: async () => { closes++; },
  fileIntake: async ({ action }: any) => action === "lookup" ? { existing: [] } : { workspaceId: "native-ws", pageId: `page-${++uploads}`, state: "completed" },
};
const host = Object.assign(new EventTarget(), { localStorage: storage, __JUGGLEWORK_ELECTRON__: { cloudDocs: bridge, fileWindow: { setCloudUploads: async (value: unknown) => { published.push(value); } } } });
Object.defineProperty(globalThis, "window", { configurable: true, value: host });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
const { uploadCloudFile } = await import("../src/react-app/domains/cloud-docs/upload-file");
const { installUploadedCloudFiles, uploadedCloudFiles } = await import("../src/react-app/domains/cloud-docs/uploaded-files");
const { denSettingsChangedEvent, denSessionRevokedEvent } = await import("../src/app/lib/den-session-events");
const { configuredCloudDocsOrigin } = await import("../src/react-app/domains/cloud-docs/product-view");
afterAll(() => {
  host.dispatchEvent(new Event(denSessionRevokedEvent));
  mock.restore();
  for (const [name, prior] of [["window", original], ["localStorage", originalStorage], ["sessionStorage", originalSession]] as const) {
    if (prior) Object.defineProperty(globalThis, name, prior); else Reflect.deleteProperty(globalThis, name);
  }
});

test("每次上传生成独立页面，分享指向最近结果且不包含凭据；两次操作复用一个后台页", async () => {
  installUploadedCloudFiles();
  const client = { statWorkspaceFile: async () => ({ exists: true, kind: "file", size: 3 }), downloadWorkspaceFile: async () => ({ data: new Uint8Array([1, 2, 3]).buffer, filename: "方案.docx", contentType: "application/octet-stream" }) };
  const input = { bridge, fileClient: client, localWorkspaceId: "local", relativePath: "方案.docx", onDuplicate: async () => "new" as const } as any;
  const first = await uploadCloudFile(input), second = await uploadCloudFile(input);
  expect(first?.pageId).not.toBe(second?.pageId);
  expect(uploadedCloudFiles()[0].url).toBe("https://docs.test/workspace/native-ws/page-2?tenantId=org-a");
  expect(uploadedCloudFiles()[0].url).not.toContain("test-grant");
  expect(opens).toBe(1); expect(launches).toBe(1); expect(closes).toBe(0);
  expect(published.at(-1).records[0].url).toBe(uploadedCloudFiles()[0].url);
  const count = launches;
  expect(await configuredCloudDocsOrigin("org-a")).toBe("https://docs.test");
  expect(launches).toBe(count);
});

test("账号、组织切换后主窗口和独立窗口不能复用其他范围的分享结果；撤权立即清理", () => {
  tenant = "org-b"; host.dispatchEvent(new Event(denSettingsChangedEvent));
  expect(uploadedCloudFiles()).toEqual([]);
  expect(published.at(-1).records).toEqual([]);
  tenant = "org-a"; userId = "u2"; host.dispatchEvent(new Event(denSettingsChangedEvent));
  expect(uploadedCloudFiles()).toEqual([]);
  userId = "u1"; host.dispatchEvent(new Event(denSettingsChangedEvent));
  expect(uploadedCloudFiles()).toHaveLength(1);
  host.dispatchEvent(new CustomEvent(denSessionRevokedEvent, { detail: { authFingerprint: "previous-account" } }));
  expect(uploadedCloudFiles()).toHaveLength(1);
  host.dispatchEvent(new Event(denSessionRevokedEvent));
  expect(uploadedCloudFiles()).toEqual([]);
  expect(published.at(-1).records).toEqual([]);
});

test("组织 A 的迟到 AI 上传在切到 B 后拒绝，不能读取文件或创建 B 的页面", async () => {
  tenant = "org-b";
  const reads = mock(async () => ({ exists: true, kind: "file", size: 3 }));
  await expect(uploadCloudFile({ bridge: bridge as any, fileClient: { statWorkspaceFile: reads, downloadWorkspaceFile: mock() } as any, localWorkspaceId: "local", relativePath: "方案.docx", expectedTenantId: "org-a", onDuplicate: async () => "new" })).rejects.toThrow("switch_organization_required");
  expect(reads).not.toHaveBeenCalled();
});
