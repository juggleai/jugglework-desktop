import * as React from "react";
import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { getArtifactsFromMessages } from "../src/lib/artifacts";
import type { UIMessage } from "ai";
import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import { FileViewer } from "../src/react-app/domains/session/files/file-viewer";
import { useFilesPanelStore } from "../src/react-app/domains/session/files/files-panel-store";

// Exercise list state without mounting DOM-dependent floating overlays.
const Container = ({ children }: any) => <>{children}</>;
const Trigger = ({ render, children, ...props }: any) => React.cloneElement(render, props, children);
mock.module("../src/components/ui/tooltip", () => ({
  Tooltip: Container, TooltipTrigger: Trigger, TooltipContent: () => null,
}));
mock.module("../src/components/ui/dropdown-menu", () => ({
  DropdownMenu: Container, DropdownMenuTrigger: Trigger, DropdownMenuContent: () => null,
  DropdownMenuItem: Container, DropdownMenuSeparator: () => null,
}));
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => open ? <>{children}</> : null,
  DialogContent: Container, DialogTitle: Container,
}));
const { ArtifactCards, ArtifactCard } = await import("../src/components/chat/artifact");

function artifact(name: string, size?: number) {
  const target: OpenTarget = {
    id: name,
    kind: "file",
    value: name,
    name,
    preview: "document",
    confidence: 95,
    reason: "generated",
    exists: true,
    size,
  };
  const message: UIMessage = {
    id: name,
    role: "assistant",
    parts: [{ type: "text", text: `Created \`${name}\`` }],
  };
  return getArtifactsFromMessages([message], [target], {
    includeTargetFallbacks: false,
  }).find((item) => item.name === name)!;
}

test("card preserves the full accessible title and distinguishes zero from unknown size", () => {
  const name = "这是一份文件名长度超过二十字符的季度经营分析报告.docx";
  const zero = renderToStaticMarkup(
    <ArtifactCard artifact={artifact(name, 0)} />,
  );
  expect(zero).toContain(name);
  expect(zero).toContain("0 bytes");
  const unknown = renderToStaticMarkup(
    <ArtifactCard artifact={artifact("unknown.docx")} />,
  );
  expect(unknown).not.toContain("0 bytes");
  expect(unknown).not.toContain("NaN");
  expect(unknown).not.toContain("TODO");
});

test("turn list shows three cards and a count for the full list", () => {
  const artifacts = [1, 2, 3, 4].map((index) =>
    artifact(`report-${index}.docx`, index),
  );
  const html = renderToStaticMarkup(<ArtifactCards artifacts={artifacts} />);
  expect(html.match(/data-testid="artifact-card"/g)?.length).toBe(3);
  expect(html).toContain("(4)");
  expect(html).toContain("report-1.docx");
  expect(html).not.toContain("report-4.docx");
  expect(html).toContain('data-testid="artifact-summary"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Show more (1)");
  expect(html).not.toContain("rounded-2xl bg-muted/70");
});

test("empty lists stay hidden and small lists do not offer expansion", () => {
  expect(renderToStaticMarkup(<ArtifactCards artifacts={[]} />)).toBe("");
  for (const count of [1, 3]) {
    const html = renderToStaticMarkup(<ArtifactCards artifacts={Array.from({ length: count }, (_, i) => artifact(`file-${i}.md`, 0))} />);
    expect(html.match(/data-testid="artifact-summary"/g)?.length).toBe(1);
    expect(html.match(/data-testid="artifact-card"/g)?.length).toBe(count);
    expect(html).not.toContain('aria-expanded="false" aria-controls=');
    expect(html).not.toContain("Show more");
  }
});

test("expands and collapses remaining artifacts inline", async () => {
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(<ArtifactCards artifacts={[1, 2, 3, 4, 5].map((i) => artifact(`report-${i}.md`, i))} />);
    });
    const rows = () => view!.root.findAllByProps({ "data-testid": "artifact-card" });
    const toggle = () => view!.root.findAll((node) => node.type === "button" && typeof node.props["aria-expanded"] === "boolean" && Boolean(node.props["aria-controls"]))[0]!;
    expect(rows()).toHaveLength(3);
    await act(async () => toggle().props.onClick());
    expect(rows()).toHaveLength(5);
    expect(toggle().props["aria-expanded"]).toBe(true);
    await act(async () => toggle().props.onClick());
    expect(rows()).toHaveLength(3);
    expect(toggle().props["aria-expanded"]).toBe(false);
  } finally {
    await act(async () => view?.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  }
});

test("external handover pauses the internal editor and exposes explicit reload", async () => {
  const previousActEnvironment = Reflect.get(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const client = new QueryClient();
  client.setQueryData(["workspace-file", "workspace", "report.md"], {
    presentation: "markdown",
    text: "# Saved content",
    bytes: new ArrayBuffer(0),
    contentType: "text/markdown",
    updatedAt: 1,
    size: 15,
  });
  useFilesPanelStore
    .getState()
    .setExternal("external-preview", "report.md", true);
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={client}>
          <FileViewer
            client={{} as JuggleWorkServerClient}
            workspaceId="workspace"
            sessionId="external-preview"
            path="report.md"
            name="report.md"
            draft={undefined}
          />
        </QueryClientProvider>,
      );
    });
    const html = JSON.stringify(view!.toJSON());
    expect(html).toContain("# Saved content");
    expect(html).toContain("Reload in JuggleWork");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("contenteditable");
  } finally {
    await act(async () => view?.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
    useFilesPanelStore.getState().clearSession("external-preview");
    client.clear();
  }
});
