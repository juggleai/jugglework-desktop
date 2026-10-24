/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

mock.module("../src/components/ui/dialog", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => open ? <>{children}</> : null,
    DialogContent: Box, DialogDescription: Box, DialogFooter: Box, DialogHeader: Box, DialogTitle: Box,
  };
});

const { PresentationDialog } = await import("../src/react-app/domains/session/presentation/presentation-dialog");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let view: TestRenderer.ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); });

function field(label: string) {
  return view!.root.findByProps({ "aria-label": label });
}

test("guided dialog validates and submits every field with the selected current file", async () => {
  const onSubmit = mock(async () => undefined);
  const onOpenChange = mock(() => undefined);
  await act(async () => {
    view = TestRenderer.create(<PresentationDialog open currentFile="research/source.pdf" onOpenChange={onOpenChange} onSubmit={onSubmit} />);
  });
  await act(async () => {
    field("Presentation purpose").props.onChange({ target: { value: "Board update" } });
    field("Presentation audience").props.onChange({ target: { value: "Board" } });
    field("Presentation outline").props.onChange({ target: { value: "Results, risks, next steps" } });
    field("Slide count").props.onChange({ target: { value: "6" } });
    field("Presentation template").props.onChange({ target: { value: "editorial" } });
    field("Presentation output filename").props.onChange({ target: { value: "board-update" } });
  });
  expect(field("Include current file").props.checked).toBe(true);
  await act(async () => { await view!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  expect(onSubmit).toHaveBeenCalledWith({
    version: 1, purpose: "Board update", audience: "Board", outline: "Results, risks, next steps",
    slideCount: 6, template: "editorial", outputName: "board-update.pptx",
    currentFile: { path: "research/source.pdf", name: "source.pdf" },
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("cancel closes without submission and invalid submission stays open", async () => {
  const onSubmit = mock(async () => undefined);
  const onOpenChange = mock(() => undefined);
  await act(async () => {
    view = TestRenderer.create(<PresentationDialog open currentFile={null} onOpenChange={onOpenChange} onSubmit={onSubmit} />);
  });
  await act(async () => { await view!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(view!.root.findByProps({ role: "alert" }).children.join("")).toContain("Purpose is required");
  await act(async () => { view!.root.findAllByType("button").find((button) => button.children.includes("Cancel"))!.props.onClick(); });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("submission rejection keeps the dialog open and displays the error", async () => {
  const onSubmit = mock(async () => { throw new Error("Session is busy"); });
  const onOpenChange = mock(() => undefined);
  await act(async () => {
    view = TestRenderer.create(<PresentationDialog open currentFile={null} onOpenChange={onOpenChange} onSubmit={onSubmit} />);
  });
  await act(async () => {
    field("Presentation purpose").props.onChange({ target: { value: "Board update" } });
    field("Presentation audience").props.onChange({ target: { value: "Board" } });
    field("Presentation outline").props.onChange({ target: { value: "Results and next steps" } });
  });
  await act(async () => { await view!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });

  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(view!.root.findByProps({ role: "alert" }).children.join("")).toContain("Session is busy");
});
