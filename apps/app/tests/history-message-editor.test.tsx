/** @jsxImportSource react */
import { afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

const { HistoryMessageEditor } = await import("../src/react-app/domains/session/surface/history-message-editor");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let view: TestRenderer.ReactTestRenderer;
afterEach(async () => { await act(async () => view?.unmount()); });

async function open(onConfirm: (text: string) => Promise<boolean>) {
  const onClose = mock(() => {});
  await act(async () => {
    view = TestRenderer.create(<HistoryMessageEditor initialText="original" onConfirm={onConfirm} onClose={onClose} />);
  });
  const buttons = view.root.findAllByType("button");
  return {
    onClose, cancel: buttons[0], send: buttons[1],
    change: (value: string) => act(() => view.root.findByType("textarea").props.onChange({ target: { value } })),
  };
}

test("opening, editing and cancelling a history message never submit it", async () => {
  const confirm = mock(async () => true);
  const editor = await open(confirm);
  expect(view.root.findByType("textarea").props.value).toBe("original");
  await editor.change("new draft");
  await act(() => editor.cancel.props.onClick());
  expect(confirm).not.toHaveBeenCalled();
  expect(editor.onClose).toHaveBeenCalledTimes(1);
});

test("empty edits are blocked and a failed send retains the text for retry", async () => {
  const confirm = mock(async (_text: string) => false);
  const editor = await open(confirm);
  await editor.change(" ");
  expect(editor.send.props.disabled).toBe(true);
  await editor.change("replacement");
  await act(async () => editor.send.props.onClick());
  expect(confirm).toHaveBeenCalledWith("replacement");
  expect(editor.onClose).not.toHaveBeenCalled();
  expect(view.root.findByType("textarea").props.value).toBe("replacement");
});

test("a second confirmation while the send is pending cannot duplicate the new turn", async () => {
  const request = Promise.withResolvers<boolean>();
  const confirm = mock(() => request.promise);
  const editor = await open(confirm);
  await act(async () => {
    const first = editor.send.props.onClick();
    await editor.send.props.onClick();
    request.resolve(true);
    await first;
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(editor.onClose).toHaveBeenCalledTimes(1);
});
