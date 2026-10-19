import * as React from "react";
import { expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ArtifactItem } from "../src/lib/artifacts";
import { OpenTargetProvider } from "../src/lib/target-provider";
import { ArtifactActionsProvider } from "../src/react-app/domains/session/artifacts/artifact-actions-provider";
import { useFilesPanelStore } from "../src/react-app/domains/session/files/files-panel-store";
import { t } from "../src/i18n";

// 此回归只验证文件入口分发；浮层布局由实际 Electron 页面验收。
const Container = ({ children }: any) => <>{children}</>;
const Trigger = ({ render, children, ...props }: any) =>
  React.cloneElement(render, props, children);
mock.module("../src/components/ui/tooltip", () => ({
  Tooltip: Container,
  TooltipTrigger: Trigger,
  TooltipContent: () => null,
}));
mock.module("../src/components/ui/dropdown-menu", () => ({
  DropdownMenu: Container,
  DropdownMenuTrigger: Trigger,
  DropdownMenuContent: () => null,
  DropdownMenuItem: Container,
  DropdownMenuSeparator: () => null,
}));
const { ArtifactCard } = await import("../src/components/chat/artifact");

test.each([
  [true, false],
  [false, false],
  [true, true],
])(
  "产物挂载不自动打开、主体复用 tab，Office 运行中开窗交给宿主等待 (%s, %s)",
  async (available, running) => {
    const previousWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    const opened: unknown[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __JUGGLEWORK_ELECTRON__: {
          fileWindow: {
            available: available ? async () => true : undefined,
            open: async (input: unknown) => {
              opened.push(input);
            },
          },
          fileEditor: {},
        },
      },
    });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const item: ArtifactItem = {
      id: "file",
      path: "报告.docx",
      name: "报告.docx",
      type: "document",
      messageId: "turn",
      messageIndex: 0,
      legacy_target: {
        id: "file",
        kind: "file",
        value: "报告.docx",
        name: "报告.docx",
        preview: "document",
        exists: true,
        confidence: 100,
        reason: "turn-delivery",
      },
    };
    const query = new QueryClient();
    let view: ReactTestRenderer | undefined;
    const sessionId = "entry-test";
    const store = useFilesPanelStore.getState();
    store.clearSession(sessionId);
    try {
      await act(async () => {
        view = create(
          <QueryClientProvider client={query}>
            <OpenTargetProvider
              onOpenTarget={(target) =>
                store.openFile(sessionId, {
                  path: target.value,
                  name: target.name,
                })
              }
            >
              <ArtifactActionsProvider
                workspaceId="ws"
                workspaceRoot="/workspace"
                sessionId={sessionId}
                remote={false}
                running={running}
                client={
                  {
                    statWorkspaceFile: async () => ({
                      exists: true,
                      kind: "file",
                    }),
                  } as any
                }
              >
                <ArtifactCard artifact={item} />
              </ArtifactActionsProvider>
            </OpenTargetProvider>
          </QueryClientProvider>,
        );
      });
      expect(
        useFilesPanelStore.getState().sessions[sessionId]?.tabs ?? [],
      ).toEqual([]);
      expect(opened).toEqual([]);
      const cardButton = () =>
        view!.root
          .findAllByType("button")
          .find((button) => button.props.title === item.name)!;
      await act(async () => {
        cardButton().props.onClick();
        cardButton().props.onClick();
      });
      expect(useFilesPanelStore.getState().sessions[sessionId]?.tabs).toEqual([
        { path: item.path, name: item.name },
      ]);
      const windowButton = view!.root
        .findAllByType("button")
        .find(
          (button) => button.props["aria-label"] === t("artifact.open_window"),
        )!;
      expect(windowButton.props.disabled).toBe(!available);
      if (!available) {
        expect(opened).toEqual([]);
        return;
      }
      store.clearSession(sessionId);
      await act(async () => {
        view!.root
          .findAllByType("button")
          .find(
            (button) =>
              button.props["aria-label"] === t("artifact.open_window"),
          )!
          .props.onClick();
      });
      expect(opened).toEqual([
        { workspaceId: "ws", sessionId, path: item.path },
      ]);
      expect(
        useFilesPanelStore.getState().sessions[sessionId]?.tabs ?? [],
      ).toEqual([]);
    } finally {
      await act(async () => view?.unmount());
      store.clearSession(sessionId);
      query.clear();
      if (previousWindow)
        Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  },
);
