import * as React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ArtifactCards, ArtifactCard } from "../src/components/chat/artifact";
import { getArtifactsFromMessages } from "../src/lib/artifacts";
import type { UIMessage } from "ai";
import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import { FileViewer } from "../src/react-app/domains/session/files/file-viewer";
import { useFilesPanelStore } from "../src/react-app/domains/session/files/files-panel-store";

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
