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
import { ArtifactActionsProvider } from "../src/react-app/domains/session/artifacts/artifact-actions-provider";
import { useUiStateStore } from "../src/react-app/shell/ui-state-store";

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
const { TurnChangesView, splitDiffLines } = await import("../src/react-app/domains/session/files/turn-changes-view");
const { parseUnifiedDiff } = await import("../src/react-app/domains/session/files/parse-unified-diff");
const { FileTabs } = await import("../src/react-app/domains/session/files/file-tabs");

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

test("summary shows relative paths and sums only recorded text changes", () => {
  const first = { ...artifact("report.md"), path: "docs/report.md", change: { additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" } };
  const second = { ...artifact("other.md"), path: "notes/other.md", change: { additions: 2, deletions: 4, patch: "@@ -1 +1 @@\n-old\n+new" } };
  const html = renderToStaticMarkup(<ArtifactCards artifacts={[first, second, artifact("report.docx")]} />);
  expect(html).toContain('title="docs/report.md"');
  expect(html).toContain("docs/");
  expect(html).toContain("+5");
  expect(html).toContain("-5");
  expect(html).toContain("View changes");
  expect(html).not.toContain("Size unknown");
  expect(html).toContain("More actions");
  expect(html).toContain("Open in separate window");
});

test("long paths elide the leading directory while preserving the filename and actions", () => {
  const path = "artifacts/generated/gen_3969623b-8e18-4edf-a891-1496989b8eed/截图中都有什么字.docx";
  const item = { ...artifact("截图中都有什么字.docx"), path };
  const html = renderToStaticMarkup(<ArtifactCard artifact={item} compact onOpenInTab={() => {}} />);
  expect(html).toContain('data-testid="artifact-path-directory"');
  expect(html).toContain("[direction:rtl]");
  expect(html).toContain('data-testid="artifact-path-separator"');
  expect(html).toContain('data-testid="artifact-path"');
  expect(html).toContain("font-normal text-muted-foreground");
  expect(html).toContain('data-testid="artifact-path-filename"');
  expect(html).toContain("截图中都有什么字.docx");
  expect(html).toContain("Open file in tab");
  expect(html).toContain("More actions");
});

test("active file tab always shows close while inactive tabs reveal it on hover", () => {
  const html = renderToStaticMarkup(<FileTabs
    tabs={[
      { path: "artifacts/截图中都有什么字.docx", name: "截图中都有什么字.docx" },
      { path: "artifacts/另一个很长的文件名.docx", name: "另一个很长的文件名.docx" },
    ]}
    activePath="artifacts/截图中都有什么字.docx"
    dirtyPaths={new Set()}
    changesTab={null}
    onSelect={() => {}}
    onClose={() => {}}
  />);
  expect(html).not.toContain("invisible");
  expect(html).toContain('data-active="true"');
  expect(html).toContain('data-active="false"');
  expect(html).toContain("opacity-100");
  expect(html).toContain("opacity-0");
  expect(html).toContain("group-hover:opacity-100");
  expect(html).toContain("pr-2 group-hover:pr-7 group-focus-within:pr-7");
  expect(html).toContain("pr-7");
  expect(html).toContain("truncate");
  expect(html).toContain("Close 截图中都有什么字.docx");
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

test("file and summary actions open turn changes in the session side panel; undo requires confirmation", async () => {
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const undo = mock(() => {});
  const client = new QueryClient();
  const sessionId = "turn-changes-test";
  let view: ReactTestRenderer | undefined;
  try {
    const changed = { ...artifact("report.md"), path: "docs/report.md", change: { additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" } };
    await act(async () => { view = create(<QueryClientProvider client={client}><ArtifactActionsProvider client={{} as JuggleWorkServerClient} sessionId={sessionId} workspaceId="workspace" workspaceRoot="/repo" remote>
      <ArtifactCards artifacts={[changed]} turnId="user-turn" onUndo={undo} />
    </ArtifactActionsProvider></QueryClientProvider>); });
    await act(async () => view!.root.findByProps({ "data-testid": "artifact-card" }).findAllByType("button")[0]!.props.onClick());
    expect(useUiStateStore.getState().sidePanelState[sessionId]).toBe("files");
    expect(useFilesPanelStore.getState().sessions[sessionId]).toMatchObject({ activeKey: "changes", selectedChangePath: "docs/report.md", turnChanges: { turnId: "user-turn", artifacts: [changed] } });
    expect(view!.root.findAllByType("pre")).toHaveLength(0);
    await act(async () => view!.root.findAll((node) => node.type === "button" && node.children.includes("View changes"))[0]!.props.onClick());
    expect(useFilesPanelStore.getState().sessions[sessionId]?.selectedChangePath).toBeNull();
    const buttons = () => view!.root.findAll((node) => node.type === "button" && node.children.includes("Undo"));
    await act(async () => buttons()[0]!.props.onClick());
    expect(undo).not.toHaveBeenCalled();
    expect(JSON.stringify(view!.toJSON())).toContain("subsequent tasks");
    await act(async () => buttons().at(-1)!.props.onClick());
    expect(undo).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => view?.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
    useFilesPanelStore.getState().clearSession(sessionId);
    useUiStateStore.getState().setSidePanelState(sessionId, null);
    client.clear();
  }
});

test("turn viewer pairs changed lines and opens a binary file in a file tab", async () => {
  const patch = "@@ -10,2 +10,3 @@\n-old\n+new\n+extra\n same";
  expect(splitDiffLines(parseUnifiedDiff(patch)[0]!.lines).map((row) => [row.left?.oldLine, row.right?.newLine])).toEqual([[10, 10], [undefined, 11], [11, 12]]);
  const changed = { ...artifact("report.md"), change: { additions: 2, deletions: 1, patch } };
  const doc = artifact("report.docx");
  const html = renderToStaticMarkup(<TurnChangesView artifacts={[changed, doc]} selectedPath={changed.path} onSelect={() => {}} />);
  expect(html).toContain('data-testid="turn-split-diff"');
  expect(html).toContain("bg-red-3");
  expect(html).toContain("bg-green-3");
  expect(html).toContain("old");
  expect(html).toContain("extra");
  const binaryHtml = renderToStaticMarkup(<TurnChangesView artifacts={[doc]} selectedPath={doc.path} onSelect={() => {}} onOpenFile={() => {}} />);
  expect(binaryHtml).not.toContain("No text diff is available");
  expect(binaryHtml).not.toContain("Preview file");
  expect(binaryHtml).not.toContain('data-testid="turn-split-diff"');
  expect(binaryHtml).not.toContain("artifact-change-counts");
  expect(binaryHtml).toContain("Open file in tab");
  expect(binaryHtml).not.toContain("Open in separate window");
  expect(binaryHtml).toContain("lucide-square-arrow-out-up-right");

  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const openFile = mock(() => {});
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(<TurnChangesView artifacts={[doc]} selectedPath={null} onSelect={() => {}} onOpenFile={openFile} />); });
    await act(async () => view!.root.findByProps({ "data-testid": "artifact-card" }).findAllByType("button")[0]!.props.onClick());
    expect(openFile).toHaveBeenCalledWith(doc);
    await act(async () => view!.root.findByProps({ "data-testid": "artifact-card" }).findAllByType("button")[1]!.props.onClick());
    expect(openFile).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => view?.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  }
});

test("turn viewer selection and closing do not alter other sessions or open file tabs", async () => {
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const store = useFilesPanelStore.getState();
  const items = [artifact("first.md"), artifact("second.md")].map((item) => ({ ...item, change: { additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" } }));
  store.openFile("changes-a", { path: "draft.md", name: "draft.md" });
  store.openTurnChanges("changes-b", "turn-b", items, "second.md");
  store.openTurnChanges("changes-a", "turn-a", items, "first.md");
  let view: ReactTestRenderer | undefined;
  const select = mock((path: string | null) => store.selectChange("changes-a", path));
  try {
    await act(async () => { view = create(<TurnChangesView artifacts={items} selectedPath="first.md" onSelect={select} />); });
    await act(async () => view!.root.findAllByProps({ "data-testid": "artifact-card" })[1]!.findAllByType("button")[0]!.props.onClick());
    expect(select).toHaveBeenCalledWith("second.md");
    store.openFile("changes-a", { path: "report.docx", name: "report.docx" });
    expect(useFilesPanelStore.getState().sessions["changes-a"]).toMatchObject({ activeKey: "files", activePath: "report.docx" });
    store.closeFile("changes-a", "report.docx");
    expect(useFilesPanelStore.getState().sessions["changes-a"]).toMatchObject({ activeKey: "changes", activePath: null, turnChanges: { turnId: "turn-a" } });
    await act(async () => { view!.update(<FileTabs tabs={[]} activePath={null} dirtyPaths={new Set()} changesTab={{ label: "Changes", count: 2, active: true, onSelect: () => {}, onClose: () => store.clearTurnChanges("changes-a") }} onSelect={() => {}} onClose={() => {}} />); });
    await act(async () => view!.root.findByProps({ "aria-label": "Close turn changes" }).props.onClick());
    expect(useFilesPanelStore.getState().sessions["changes-a"]).toMatchObject({ activeKey: "files", tabs: [{ path: "draft.md", name: "draft.md" }], turnChanges: undefined });
    expect(useFilesPanelStore.getState().sessions["changes-b"]?.selectedChangePath).toBe("second.md");
  } finally {
    await act(async () => view?.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
    store.clearSession("changes-a"); store.clearSession("changes-b");
  }
});
