import * as React from "react";
import { expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { t } from "../src/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { splitTaskAttachments, joinTaskAttachments } from "../src/react-app/domains/tasks/task-description-markdown";
import { TaskAttachmentSection } from "../src/react-app/domains/tasks/task-attachment-section";

test("task attachment cards preserve legacy unknown sizes and exclude inline images and code", () => {
  const old = '[old.pdf](https://files.test/old.pdf "task-file")';
  const body = `![figure](https://files.test/image.png "task-file")\n\`${old}\``;
  const next = { name: "图[1].pdf", size: 1234567, url: "https://files.test/new.pdf" };
  const draft = joinTaskAttachments(`${body}\n${old}`, [next]);
  const split = splitTaskAttachments(draft);
  expect(split.body).toBe(body);
  expect(split.files).toEqual([{ name: "old.pdf", url: "https://files.test/old.pdf", size: null }, next]);
  expect(joinTaskAttachments(split.body, split.files)).toBe(draft);
  const html = renderToStaticMarkup(<TaskAttachmentSection files={split.files} onAdd={() => {}} />);
  expect(html).toContain("old.pdf"); expect(html).toContain("1.23 MB");
  expect(html).not.toContain('type="file"');
});

test("extracting a draft's files preserves authored line breaks, links, images and code examples", () => {
  const example = '[example.pdf](https://files.test/sample.pdf "task-file")';
  const file = { name: "Plan (<1>).pdf", size: 15, url: "https://files.test/plan.pdf" };
  const body = `![image](https://files.test/image.png) [link](https://example.test)\n~~~md\n${example}\n~~~\n    ${example}\n\n`;
  expect(splitTaskAttachments(joinTaskAttachments(body, [file]))).toEqual({ body, files: [file] });
});

test("card actions are ordered, permission-aware, and only unlink after confirmation", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const file = { name: "clip.mp4", size: 400, url: "https://files.test/clip.bin" };
  let confirmed = false;
  const original = Object.getOwnPropertyDescriptor(globalThis, "confirm");
  const confirm = mock(() => confirmed);
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: confirm });
  const remove = mock(async () => false);
  let view: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => { view = TestRenderer.create(<TaskAttachmentSection files={[file]} onAdd={() => {}} onRemove={remove} />); });
    const actions = () => view!.root.findByProps({ role: "group" }).findAllByType("button");
    expect(actions().map(action => action.props.title)).toEqual([t("tasks.attachment_preview"), t("tasks.download_file"), t("tasks.remove_attachment")]);
    await act(async () => { actions()[2]!.props.onClick(); });
    expect(remove).not.toHaveBeenCalled();
    confirmed = true;
    await act(async () => { actions()[2]!.props.onClick(); });
    expect(confirm.mock.calls).toHaveLength(2);
    expect(remove).toHaveBeenCalledWith(file, 0);
    expect(view!.root.findByProps({ role: "alert" }).children).toEqual([t("tasks.attachment_remove_failed")]);
    await act(async () => { view!.update(<TaskAttachmentSection files={[file]} onAdd={() => {}} />); });
    expect(actions().map(action => action.props.title)).toEqual([t("tasks.attachment_preview"), t("tasks.download_file")]);
  } finally {
    await act(async () => view?.unmount());
    if (original) Object.defineProperty(globalThis, "confirm", original); else Reflect.deleteProperty(globalThis, "confirm");
  }
});
