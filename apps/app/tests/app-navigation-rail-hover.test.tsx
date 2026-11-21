/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { useCloudDocsBounds } from "../src/react-app/domains/cloud-docs/use-cloud-docs-bounds";

mock.module("../src/react-app/domains/jugglechat/store", () => ({ useJuggleChatStore: () => null }));
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({ useCloudSession: () => null }));
mock.module("../src/react-app/domains/settings/cloud/device-connection-menu-item", () => ({ DeviceConnectionMenuItem: () => null, useDeviceConnection: () => null }));
mock.module("../src/react-app/shell/app-navigation-sidebar-preview", () => ({ useAppNavigationSidebarPreview: () => null }));
const { RailButton } = await import("../src/react-app/shell/app-navigation-rail");

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originals = { window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
afterAll(() => { Object.assign(globalThis, originals); mock.restore(); });

test("真实 RailButton hover 保留提示文字，不创建 DOM tooltip／截图／hide，也不抢焦点；preview 与点击仍可操作", async () => {
  const snapshot = mock(async () => "screen"), bounds = mock((_input: { visible: boolean }) => {});
  const focus = mock(() => {}), click = mock(() => {}), preview = mock((_target: string, _open: boolean) => {});
  (globalThis as any).window = { __JUGGLEWORK_ELECTRON__: { cloudDocs: { snapshot, setBounds: bounds } } };
  (globalThis as any).document = { hidden: false, querySelectorAll: () => [], activeElement: { focus } };
  globalThis.getComputedStyle = (() => ({ visibility: "visible", display: "block", borderTopLeftRadius: "18px" })) as typeof getComputedStyle;
  let sync!: ReturnType<typeof useCloudDocsBounds>["sync"];
  function Host() {
    const host = React.useRef({ getBoundingClientRect: () => ({ x: 60, y: 50, width: 800, height: 700 }) } as HTMLDivElement);
    sync = useCloudDocsBounds(host).sync;
    return <>
      <RailButton label="云文档" tooltipLabel="文档提示" onClick={click}><span /></RailButton>
      <RailButton label="应用" showTooltip={false} appPreviewTarget="plugins" onAppPreviewChange={preview}><span /></RailButton>
    </>;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); });
  await act(async () => sync("docs", true));
  const [button, previewButton] = renderer.root.findAllByType("button");
  expect(button.props.title).toBe("文档提示");
  expect(button.props["aria-label"]).toBe("云文档");
  expect(previewButton.props.title).toBeUndefined();
  await act(async () => { button.props.onMouseEnter(); sync("docs", true); button.props.onMouseLeave(); sync("docs", true); });
  expect(renderer.root.findAll(node => node.props.role === "tooltip")).toHaveLength(0);
  expect(snapshot).not.toHaveBeenCalled();
  expect(bounds.mock.calls.every(([value]) => value.visible)).toBe(true);
  expect(focus).not.toHaveBeenCalled();
  await act(async () => { button.props.onClick(); previewButton.props.onMouseEnter(); previewButton.props.onMouseLeave(); });
  expect(click).toHaveBeenCalledTimes(1);
  expect(preview.mock.calls).toEqual([["plugins", true], ["plugins", false]]);
  await act(async () => renderer.unmount());
});
