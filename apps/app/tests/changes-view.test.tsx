/** @jsxImportSource react */
import * as React from "react";
import { afterAll, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const runPath = mock(async () => {});
mock.module("../src/react-app/domains/session/artifacts/artifact-actions-provider", () => ({ useArtifactActions: () => ({ desktop: true, runPath }) }));
const Container = ({ children }: any) => <>{children}</>;
mock.module("../src/components/ui/dropdown-menu", () => ({
  DropdownMenu: Container,
  DropdownMenuTrigger: ({ render, children, ...props }: any) => React.cloneElement(render, props, children),
  DropdownMenuContent: Container,
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

test("file menu reuses directory reveal and toggles only its own file", async () => {
  const toggle = mock(() => {});
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(<FileChangeSection change={changes[0]!} expanded onToggle={toggle} />); });
    const button = (label: string) => view!.root.findAllByType("button").find(node => node.children.includes(label))!;
    await act(async () => button("Open in editor").props.onClick());
    expect(button("Open in editor").findAllByType("svg")).toHaveLength(0);
    expect(button("Collapse file").findAllByType("svg")).toHaveLength(0);
    expect(runPath).toHaveBeenCalledWith("reveal", changes[0]!.path);
    await act(async () => button("Collapse file").props.onClick());
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
    const reveal = view!.root.findAllByType("button").find(node => node.children.includes("Open in editor"))!;
    expect(reveal.props.disabled).toBe(true);
    await act(async () => { view!.update(<FileChangeSection change={change} expanded={false} onToggle={toggle} onOpenFile={open} />); });
    expect(header().props.disabled).toBe(false);
    await act(async () => header().props.onClick());
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  } finally { await act(async () => view?.unmount()); }
});
