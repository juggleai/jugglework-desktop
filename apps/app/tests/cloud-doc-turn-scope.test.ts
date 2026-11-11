import { afterAll, expect, mock, test } from "bun:test";
const actual = await import("../src/app/lib/den.ts?cloud-doc-scope-real");
let tenant = "a";
mock.module("../src/app/lib/den", () => ({ ...actual, readDenSettings: () => ({ activeOrgId: tenant, authToken: "fixture" }) }));
(globalThis as any).window = { __JUGGLEWORK_ELECTRON__: { cloudDocs: {} } };
const { setActiveCloudDoc, captureCloudDocTurn } = await import("../src/app/lib/cloud-doc-turn");
const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store");
afterAll(() => mock.restore());
const a = { tenantId: "a", workspaceId: "wa", docId: "da", title: "A" };
const b = { tenantId: "b", workspaceId: "wb", docId: "db", title: "B" };

test("排队时冻结所属会话的打开文档，切换会话或组织后不扩大范围", () => {
  tenant = "a";
  setActiveCloudDoc("s-a", a);
  const queued = useComposerStateStore.getState().appendQueuedDraft("s-a", { mode: "prompt", text: "修改当前文档", parts: [{ type: "text", text: "修改当前文档" }], attachments: [] });
  tenant = "b";
  setActiveCloudDoc("s-b", b);
  expect(queued.draft.cloudDocTurn).toEqual({ currentTenantId: "a", references: [], activeDoc: a });
  expect(captureCloudDocTurn("s-b", "要求").activeDoc).toEqual(b);
  expect(captureCloudDocTurn("s-a", "要求").activeDoc).toBeNull();
  expect(captureCloudDocTurn("unknown", "要求").activeDoc).toBeNull();
  expect(captureCloudDocTurn("s-b", "要求", false).activeDoc).toBeNull();
  useComposerStateStore.getState().clearQueuedDrafts("s-a");
  setActiveCloudDoc("s-a", null); setActiveCloudDoc("s-b", null);
});
