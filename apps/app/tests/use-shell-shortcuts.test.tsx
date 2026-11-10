import React from "react";
import { expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

import { useShellShortcuts } from "../src/react-app/shell/use-shell-shortcuts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ShellShortcutProbe(props: { workspaceId: string }) {
  const shortcuts = useShellShortcuts({
    canCreateTask: true,
    workspaceId: props.workspaceId,
    onCreateTask: () => undefined,
  });
  return (
    <button
      type="button"
      data-terminal-open={shortcuts.terminalOpen ? "true" : "false"}
      onClick={() => shortcuts.setTerminalOpen(true)}
    >
      Terminal
    </button>
  );
}

test("hides the retained terminal binding when the selected workspace changes", async () => {
  const previousWindow = globalThis.window;
  const listeners = new Map<string, EventListener>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string, listener: EventListener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
    },
  });

  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<ShellShortcutProbe workspaceId="workspace-a" />);
    });
    const terminalButton = () => renderer!.root.findByType("button");

    await act(async () => terminalButton().props.onClick());
    expect(terminalButton().props["data-terminal-open"]).toBe("true");

    await act(async () => {
      renderer!.update(<ShellShortcutProbe workspaceId="workspace-a" />);
    });
    expect(terminalButton().props["data-terminal-open"]).toBe("true");

    await act(async () => {
      renderer!.update(<ShellShortcutProbe workspaceId="workspace-b" />);
    });
    expect(terminalButton().props["data-terminal-open"]).toBe("false");
  } finally {
    await act(async () => renderer?.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
