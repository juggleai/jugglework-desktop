/** @jsxImportSource react */
import * as React from "react";
import { afterAll, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const runPath = mock(async () => {});
const actions = { desktop: true, running: false, runPath };
mock.module("../src/react-app/domains/session/artifacts/artifact-actions-provider", () => ({ useArtifactActions: () => actions }));
const Container = ({ children }: any) => <>{children}</>;
mock.module("../src/components/ui/dropdown-menu", () => ({
  DropdownMenu: Container,
  DropdownMenuTrigger: ({ render, children, ...props }: any) => React.cloneElement(render, props, children),
  DropdownMenuContent: Container,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
const { ChangesView } = await import("../src/react-app/domains/session/files/changes-view");
const { FileChangeSection } = await import("../src/react-app/domains/session/files/file-change-section");
afterAll(() => mock.restore());
const changes = ["src/very/long/directory/first.ts", "src/another/directory/second.ts"].map(path => ({ path, status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-const before = 1\n+const after = 2" }));

test("expanding and collapsing one change preserves other expanded files", async () => {
  let view: ReactTestRenderer | undefined;
  function Harness() {
    const [selected, select] = React.useState<string | null>(changes[0]!.path);
    return <ChangesView changes={changes} selectedPath={selected} onSelect={select} onOpenFile={() => {}} onRefresh={() => {}} loading={false} refreshing={false} vcsAvailable error={null} />;
  }
  try {
    await act(async () => { view = create(<Harness />); });
    const diffCount = () => view!.root.findAllByProps({ "data-testid": "workspace-unified-diff" }).length;
    const header = (index: number) => view!.root.findAllByType("button").find(node => node.props.title === changes[index]!.path)!;
    expect(diffCount()).toBe(1);
    await act(async () => header(1).props.onClick());
    expect(diffCount()).toBe(2);
    await act(async () => header(0).props.onClick());
    expect(diffCount()).toBe(1);
    expect(header(1).props["aria-expanded"]).toBe(true);
    expect(header(0).props["aria-expanded"]).toBe(false);
  } finally { await act(async () => view?.unmount()); }
});

test("file menu restores existing file operations while expansion stays on the row", async () => {
  const toggle = mock(() => {});
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(<FileChangeSection change={changes[0]!} expanded onToggle={toggle} />); });
    const button = (label: string) => view!.root.findAllByType("button").find(node => node.children.includes(label))!;
    const labels = ["Show in folder", "Open with default app", "Add to conversation", "Copy path", "Save a copy", "Upload to cloud"];
    for (const label of labels) expect(button(label).findAllByType("svg")).toHaveLength(1);
    expect(button("Upload to cloud").props.disabled).toBe(true);
    expect(view!.root.findAllByType("button").some(node => node.children.includes("Collapse file"))).toBe(false);
    await act(async () => button("Show in folder").props.onClick());
    expect(runPath).toHaveBeenCalledWith("reveal", changes[0]!.path);
    await act(async () => button("Open with default app").props.onClick());
    expect(runPath).toHaveBeenCalledWith("external", changes[0]!.path);
    await act(async () => button("Add to conversation").props.onClick());
    expect(runPath).toHaveBeenCalledWith("attach", changes[0]!.path);
    await act(async () => button("Copy path").props.onClick());
    expect(runPath).toHaveBeenCalledWith("copy-path", changes[0]!.path);
    await act(async () => button("Save a copy").props.onClick());
    expect(runPath).toHaveBeenCalledWith("save-copy", changes[0]!.path);
    await act(async () => view!.root.findAllByType("button").find(node => node.props.title === changes[0]!.path)!.props.onClick());
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(view!.root.findByProps({ "data-testid": "change-file-path" }).props.className).toContain("[direction:rtl]");
  } finally { await act(async () => view?.unmount()); }
});

test("deleted files remain inspectable but never open a missing file", async () => {
  const open = mock(() => {});
  const toggle = mock(() => {});
  const change = { ...changes[0]!, status: "deleted" as const };
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(<FileChangeSection change={change} expanded={false} onOpenFile={open} />); });
    const header = () => view!.root.findAllByType("button").find(node => node.props.title === change.path)!;
    expect(header().props.disabled).toBe(true);
    expect(header().props.onClick).toBeUndefined();
    const reveal = view!.root.findAllByType("button").find(node => node.children.includes("Show in folder"))!;
    expect(reveal.props.disabled).toBe(true);
    await act(async () => { view!.update(<FileChangeSection change={change} expanded={false} onToggle={toggle} onOpenFile={open} />); });
    expect(header().props.disabled).toBe(false);
    await act(async () => header().props.onClick());
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  } finally { await act(async () => view?.unmount()); }
});

test("restored actions keep remote and running restrictions", async () => {
  let view: ReactTestRenderer | undefined;
  try {
    const render = () => <FileChangeSection change={{ ...changes[0]!, path: "方案.md" }} expanded={false} />;
    actions.desktop = false;
    await act(async () => { view = create(render()); });
    const button = (label: string) => view!.root.findAllByType("button").find(node => node.children.includes(label))!;
    for (const label of ["Show in folder", "Open with default app", "Copy path", "Save a copy", "Upload to cloud"]) expect(button(label).props.disabled).toBe(true);
    expect(button("Add to conversation").props.disabled).toBe(false);
    actions.desktop = true;
    actions.running = true;
    await act(async () => view!.update(render()));
    for (const label of ["Open with default app", "Add to conversation", "Save a copy", "Upload to cloud"]) expect(button(label).props.disabled).toBe(true);
    for (const label of ["Show in folder", "Copy path"]) expect(button(label).props.disabled).toBe(false);
  } finally {
    actions.desktop = true;
    actions.running = false;
    await act(async () => view?.unmount());
  }
});

test.each(["doc", "DOCX", "xls", "xlsx", "csv", "ppt", "pptx", "pdf", "md", "markdown", "html", "htm"])("uploads supported %s files through the existing action pipeline", async extension => {
  const path = `artifacts/产品方案.${extension}`;
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(<FileChangeSection change={{ ...changes[0]!, path }} expanded={false} />); });
    const upload = view!.root.findAllByType("button").find(node => node.children.includes("Upload to cloud"))!;
    expect(upload.props.disabled).toBe(false);
    await act(async () => upload.props.onClick());
    expect(runPath).toHaveBeenCalledWith("upload-cloud", path);
    await act(async () => { view!.update(<FileChangeSection change={{ ...changes[0]!, path, status: "deleted" }} expanded={false} />); });
    expect(view!.root.findAllByType("button").find(node => node.children.includes("Upload to cloud"))!.props.disabled).toBe(true);
  } finally { await act(async () => view?.unmount()); }
});

test("unsupported uploads display their reason outside the disabled menu item", async () => {
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(<FileChangeSection change={{ ...changes[0]!, path: "source.ts" }} expanded={false} />); });
    const upload = view!.root.findAllByType("button").find(node => node.children.includes("Upload to cloud"))!;
    expect(upload.props.disabled).toBe(true);
    const reason = view!.root.findByType("p");
    expect(reason.children).toEqual([upload.props.title]);
    expect(reason.props.className).not.toContain("pointer-events-none");
  } finally { await act(async () => view?.unmount()); }
});
