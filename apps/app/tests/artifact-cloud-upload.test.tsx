/** @jsxImportSource react */
import * as React from "react";
import { afterAll, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("../src/react-app/kernel/local-provider", () => ({
  useLocal: () => ({ prefs: {} }),
}));
mock.module("../src/components/ui/sonner", () => ({
  toast: { error: mock(), success: mock() },
}));
const { ArtifactActionsProvider, useArtifactActions } =
  await import("../src/react-app/domains/session/artifacts/artifact-actions-provider");
afterAll(() => mock.restore());

/** 验证上传入口的真实保存管线和上传中继事件，不连接真实服务。 */
async function withUploadAction(
  options: {
    path: string;
    prepare?: boolean | "fail";
    running?: boolean;
    missing?: boolean;
  },
  check: (order: string[], requests: any[]) => void,
) {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const order: string[] = [];
  const requests: any[] = [];
  const host = Object.assign(new EventTarget(), {
    __JUGGLEWORK_ELECTRON__: {
      fileEditor: {
        prepare: async () => {
          order.push("save");
          if (options.prepare === "fail") throw new Error("save failed");
          return options.prepare !== false;
        },
      },
      invokeDesktop: async () => "/repo/file",
    },
  });
  host.addEventListener("jugglework:upload-cloud", (event) => {
    order.push("upload");
    requests.push((event as CustomEvent).detail);
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: host,
  });
  const query = new QueryClient();
  let actions: ReturnType<typeof useArtifactActions>;
  function Probe() {
    actions = useArtifactActions();
    return null;
  }
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={query}>
          <ArtifactActionsProvider
            workspaceId="source-workspace"
            workspaceRoot="/repo"
            sessionId="source-chat"
            remote={false}
            running={options.running}
            client={
              {
                statWorkspaceFile: async () => {
                  order.push("stat");
                  return { exists: !options.missing, kind: "file" };
                },
                prepareOfficeFile: async (...args: unknown[]) => {
                  expect(args).toEqual([
                    "source-workspace",
                    "source-chat",
                    options.path,
                    false,
                  ]);
                  order.push("office-save");
                  return {};
                },
              } as any
            }
          >
            <Probe />
          </ArtifactActionsProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await actions!.runPath("upload-cloud", options.path);
    });
    check(order, requests);
  } finally {
    await act(async () => view?.unmount());
    query.clear();
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorAct);
  }
}

test("upload saves text before requesting the source workspace file from the root relay", async () => {
  await withUploadAction({ path: "notes/方案.md" }, (order, requests) => {
    expect(order).toEqual(["save", "stat", "upload"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      workspaceId: "source-workspace",
      path: "notes/方案.md",
    });
    expect(requests[0].requestId).toBeString();
  });
});

test("upload flushes Office edits through the existing Office preparation endpoint", async () => {
  await withUploadAction({ path: "方案.docx" }, (order, requests) => {
    expect(order).toEqual(["office-save", "stat", "upload"]);
    expect(requests).toHaveLength(1);
  });
});

test.each([
  { prepare: false },
  { prepare: "fail" as const },
  { running: true },
  { missing: true },
])(
  "cancel, save failure, active run or missing file never dispatches an upload (%j)",
  async (options) => {
    await withUploadAction(
      { path: "方案.md", ...options },
      (_order, requests) => {
        expect(requests).toEqual([]);
      },
    );
  },
);
