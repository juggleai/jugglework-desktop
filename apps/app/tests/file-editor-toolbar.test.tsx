import * as React from "react";
import { expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import { t } from "../src/i18n";

const Container = ({ children }: any) => <>{children}</>;
mock.module("../src/components/ui/dropdown-menu", () => ({
  DropdownMenu: Container,
  DropdownMenuTrigger: ({ render, children }: any) =>
    React.cloneElement(render, {}, children),
  DropdownMenuContent: Container,
  DropdownMenuCheckboxItem: ({ children, ...props }: any) => (
    <button data-font-toggle {...props}>
      {children}
    </button>
  ),
  DropdownMenuItem: ({ children, ...props }: any) => (
    <button data-menu-item {...props}>
      {children}
    </button>
  ),
}));
const { FileEditorToolbar, getOfficeEditorStatus } =
  await import("../src/react-app/domains/session/files/file-editor-toolbar");

test("两种宿主共享字体联网开关和请求状态，预取成功提示下次打开，卸载后取消订阅", async () => {
  const previousWindow = Reflect.get(globalThis, "window");
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let state = {
    online: true,
    fontFailures: 0,
    readyOnReopen: false,
    retryableFonts: 0,
  };
  const subscribers = new Set<(value: any) => void>();
  const publish = () => {
    for (const subscriber of subscribers) subscriber({ documentId: "doc" });
  };
  const native = {
    resources: async () => ({ ...state }),
    onResourcesChanged: (callback: (value: any) => void) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    setFontOnline: async (value: boolean) => {
      state.online = value;
      publish();
      return { online: value };
    },
    retryFonts: async () => {
      state.readyOnReopen = true;
      publish();
    },
  };
  Reflect.set(globalThis, "window", {
    __JUGGLEWORK_ELECTRON__: { office: native },
  });
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(
        <>
          {["panel", "window"].map((host) => (
            <FileEditorToolbar
              key={host}
              officeDocumentId="doc"
              name="数据.csv"
              status="unsaved"
              saveDisabled={false}
              onSave={() => {}}
            />
          ))}
        </>,
      );
    });
    const toggles = () =>
      view!.root
        .findAllByType("button")
        .filter((button) => button.props["data-font-toggle"] !== undefined);
    expect(toggles()).toHaveLength(2);
    expect(toggles().every((toggle) => toggle.props.checked)).toBe(true);
    expect(JSON.stringify(view!.toJSON())).not.toContain(
      t("office.font_unavailable"),
    );
    await act(async () => {
      await toggles()[0]!.props.onCheckedChange(false);
    });
    expect(toggles().every((toggle) => !toggle.props.checked)).toBe(true);
    await act(async () => {
      state.fontFailures = 1;
      state.retryableFonts = 1;
      state.online = true;
      publish();
    });
    expect(JSON.stringify(view!.toJSON())).toContain(
      t("office.font_unavailable"),
    );
    const retry = view!.root
      .findAllByType("button")
      .find(
        (button) =>
          button.props["data-menu-item"] !== undefined &&
          button.props.children === t("office.font_retry"),
      );
    await act(async () => {
      await retry!.props.onClick();
    });
    expect(JSON.stringify(view!.toJSON())).toContain(
      t("office.font_ready_reopen"),
    );
    expect(
      view!.root
        .findAllByType("button")
        .filter(
          (button) => button.props["aria-label"] === t("session_files.save"),
        )
        .every((button) => !button.props.disabled),
    ).toBe(true);
  } finally {
    if (view) await act(async () => view!.unmount());
    expect(subscribers.size).toBe(0);
    Reflect.set(globalThis, "window", previousWindow);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test("只有真实就绪且无修改的模型显示已保存，导入、故障及外部编辑不冒充已保存", () => {
  const document = { state: "ready", dirty: false } as OfficeDocumentSession;
  expect(getOfficeEditorStatus(document)).toBe("saved");
  expect(getOfficeEditorStatus({ ...document, dirty: true })).toBe("unsaved");
  expect(getOfficeEditorStatus(document, true)).toBe("saving");
  expect(getOfficeEditorStatus({ ...document, state: "opening" })).toBe(
    "loading",
  );
  expect(getOfficeEditorStatus({ ...document, state: "error" })).toBe("error");
  expect(getOfficeEditorStatus({ ...document, state: "external" })).toBe(
    "external",
  );
});

test("两种宿主顶栏同步显示保存状态，独立窗口菜单只在侧栏提供，云端操作保持禁用", async () => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const calls: string[] = [];
  let view: ReactTestRenderer | undefined;
  const render = (dirty: boolean) => (
    <>
      {["panel", "window"].map((host) => (
        <FileEditorToolbar
          key={host}
          name="演示数据.csv"
          status={dirty ? "unsaved" : "saved"}
          saveDisabled={false}
          onSave={() => calls.push(`${host}:save`)}
          onReveal={() => calls.push(`${host}:reveal`)}
          onSaveCopy={() => calls.push(`${host}:copy`)}
          onOpenWindow={
            host === "panel" ? () => calls.push("panel:window") : undefined
          }
          showFolderShortcut={host === "panel"}
        />
      ))}
    </>
  );
  try {
    await act(async () => {
      view = create(render(false));
    });
    const buttons = (label: string) =>
      view!.root
        .findAllByType("button")
        .filter((button) => button.props["aria-label"] === label);
    expect(
      view!.root
        .findAllByProps({ role: "status" })
        .map((status) => status.children.at(-1)),
    ).toEqual([t("office.saved"), t("office.saved")]);
    expect(
      buttons(t("session_files.save")).every((button) => button.props.disabled),
    ).toBe(true);
    expect(
      buttons(t("artifact.upload")).every((button) => button.props.disabled),
    ).toBe(true);
    expect(
      buttons(t("artifact.share")).every((button) => button.props.disabled),
    ).toBe(true);
    expect(buttons(t("artifact.share"))).toHaveLength(2);
    expect(
      buttons(t("artifact.share")).every(
        (button) => button.findAllByType("span").length === 0,
      ),
    ).toBe(true);
    expect(t("artifact.share")).not.toContain("TODO");
    expect(t("artifact.share_unavailable")).not.toContain("TODO");
    const windowItems = view!.root
      .findAllByType("button")
      .filter(
        (button) =>
          button.props["data-menu-item"] !== undefined &&
          button.props.children.at(-1) === t("artifact.open_window"),
      );
    expect(windowItems).toHaveLength(1);
    windowItems[0]!.props.onClick();
    buttons(t("artifact.open_folder"))[0]!.props.onClick();
    await act(async () => {
      view!.update(render(true));
    });
    expect(
      view!.root
        .findAllByProps({ role: "status" })
        .map((status) => status.children.at(-1)),
    ).toEqual([t("office.unsaved"), t("office.unsaved")]);
    for (const button of buttons(t("session_files.save"))) {
      expect(button.props.disabled).toBe(false);
      button.props.onClick();
    }
    expect(calls).toEqual([
      "panel:window",
      "panel:reveal",
      "panel:save",
      "window:save",
    ]);
  } finally {
    if (view) await act(async () => view!.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});
