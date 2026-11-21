import * as React from "react";
import { afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { $getRoot, $getSelection, $isRangeSelection, $nodesOfType, $setSelection, createEditor, KEY_ENTER_COMMAND, PASTE_COMMAND, type LexicalEditor } from "lexical";
import { LinkNode } from "@lexical/link";
import { ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ContentEditableElement } from "@lexical/react/LexicalContentEditable.js";
import { $readDescription, $writeDescription, descriptionNodes, TaskImageNode } from "../src/react-app/domains/tasks/task-description-markdown";
import { TaskCommentEditor, TaskDescriptionEditor } from "../src/react-app/domains/tasks/task-description-editor";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let view: TestRenderer.ReactTestRenderer;
const currentEditor = (): LexicalEditor => view.root.findByType(ContentEditableElement).props.editor;
afterEach(async () => { if (view) await act(async () => view.unmount()); });
const byId = (id: string) => view.root.findByProps({ "data-testid": id });
const clickTool = (name: string) => act(async () => byId(`task-description-format-${name}`).props.onClick());
const write = () => currentEditor().getEditorState().read($writeDescription);
const update = (fn: () => void) => act(async () => currentEditor().update(fn, { discrete: true }));

const commentTool = (name: string) => byId(`task-comment-format-${name}`);
const clickCommentTool = (name: string) => act(async () => commentTool(name).props.onClick());
async function enter(modifiers: Partial<KeyboardEvent> = {}) {
  const preventDefault = mock();
  await update(() => { currentEditor().dispatchCommand(KEY_ENTER_COMMAND, { preventDefault, ...modifiers } as KeyboardEvent); });
  return preventDefault;
}

test("comment formatting toggle keeps the draft, selection and editor instance", async () => {
  function Comment() {
    const [value, setValue] = React.useState("alpha beta");
    return <TaskCommentEditor value={value} onChange={setValue} onSend={() => {}} pending={false} members={[]} />;
  }
  await act(async () => { view = TestRenderer.create(<Comment />); });
  const editor = currentEditor();
  const toolbar = byId("task-comment-toolbar");
  expect(toolbar.findAllByType("button")).toHaveLength(6);
  expect(toolbar.findByProps({ "aria-disabled": "true" }).findByProps({ role: "tooltip" }).props.children).toBeTruthy();
  const toggleLabel = () => commentTool("toggle").findByProps({ role: "tooltip" }).props.children;
  const closedLabel = toggleLabel();
  await update(() => $getRoot().getAllTextNodes()[0].select(6, 10));
  await clickCommentTool("toggle");
  expect(currentEditor()).toBe(editor);
  expect(commentTool("toggle").props["aria-pressed"]).toBe(true);
  expect(toggleLabel()).not.toBe(closedLabel);
  await clickCommentTool("bold");
  await clickCommentTool("toggle");
  expect(toggleLabel()).toBe(closedLabel);
  expect(write()).toBe("alpha **beta**");
  expect(editor.getEditorState().read(() => $getSelection()?.getTextContent())).toBe("beta");
});

test("comment Enter sends once; composition, Shift+Enter, pending and blank drafts do not send", async () => {
  const onSend = mock();
  const component = (value: string, pending = false) => <TaskCommentEditor value={value} members={[]} onChange={() => {}} pending={pending} onSend={onSend} />;
  await act(async () => { view = TestRenderer.create(component("hello")); });
  const form = byId("task-comment-editor");
  const submit = () => act(async () => form.props.onSubmit({ preventDefault() {} }));
  expect(form.type).toBe("form");
  await update(() => $getRoot().selectEnd());
  expect(await enter({ isComposing: true })).not.toHaveBeenCalled();
  expect(await enter({ keyCode: 229 })).not.toHaveBeenCalled();
  expect(write()).toBe("hello");
  await enter({ shiftKey: true });
  await update(() => { const range = $getSelection(); if ($isRangeSelection(range)) range.insertText("next"); });
  expect(write()).toBe("hello\nnext");
  expect(onSend).not.toHaveBeenCalled();
  expect(await enter()).toHaveBeenCalled();
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(write()).toBe("hello\nnext");
  await submit();
  expect(onSend).toHaveBeenCalledTimes(2);
  for (const [value, pending] of [["busy", true], ["  \n", false]] as const) {
    await act(async () => view.update(component(value, pending)));
    expect(form.findByProps({ type: "submit" }).props.disabled).toBe(true);
    await enter(); await submit();
    expect(onSend).toHaveBeenCalledTimes(2);
  }
});

test("mention Enter takes precedence over sending, including when there are no matches", async () => {
  const onSend = mock();
  const members = [{ id: "k", userId: "k", role: "member", user: { id: "k", name: "Kevin", account: null, avatar: null, email: null } }];
  await act(async () => { view = TestRenderer.create(<TaskCommentEditor value="draft" onChange={() => {}} onSend={onSend} members={members} pending={false} />); });
  await update(() => $getRoot().selectEnd());
  await clickCommentTool("mention");
  await enter();
  expect(write()).toContain("[@Kevin](task-member:k)");
  await update(() => $getRoot().selectEnd().insertText("@unknown"));
  expect(view.root.findAllByProps({ role: "listbox" })).toHaveLength(1);
  await enter();
  expect(onSend).not.toHaveBeenCalled();
});

test("Enter in the comment image URL field confirms the image without submitting the comment", async () => {
  const onSend = mock();
  await act(async () => { view = TestRenderer.create(<TaskCommentEditor value="draft" onChange={() => {}} onSend={onSend} members={[]} pending={false} />); });
  await clickCommentTool("image");
  const popup = view.root.findByProps({ role: "dialog" });
  const url = popup.findByType("input");
  expect(byId("task-comment-editor").findByProps({ type: "submit" }).props.disabled).toBe(true);
  await act(async () => url.props.onChange({ target: { value: "https://example.com/demo.png" } }));
  const event = { key: "Enter", nativeEvent: {}, preventDefault: mock(), stopPropagation: mock() };
  await act(async () => url.props.onKeyDown(event));
  expect(event.preventDefault).toHaveBeenCalled();
  expect(event.stopPropagation).toHaveBeenCalled();
  expect(write()).toContain("](https://example.com/demo.png)");
  expect(onSend).not.toHaveBeenCalled();
});

test("legacy Markdown imports real rich nodes and survives export and re-import", () => {
  const doc = createEditor({ nodes: descriptionNodes, onError: error => { throw error; } });
  const source = "## Draft\n**bold** _italic_ ~~removed~~ <u>**under**</u>\n\n4. ordered\n5. more\n- bullet\n> quote\n> next\n[site](https://example.com/path) ![map](https://example.com/map.png)";
  function read(markdown: string) { doc.update(() => $readDescription(markdown), { discrete: true }); }
  function verify() {
    doc.getEditorState().read(() => {
      const texts = $getRoot().getAllTextNodes();
      expect($nodesOfType(HeadingNode)[0].getTag()).toBe("h2");
      for (const [text, format] of [["bold", "bold"], ["italic", "italic"], ["removed", "strikethrough"], ["under", "underline"], ["under", "bold"]] as const) {
        expect(texts.find(n => n.getTextContent() === text)?.hasFormat(format)).toBe(true);
      }
      expect($nodesOfType(ListNode).map(n => [n.getListType(), n.getStart(), n.getChildrenSize()])).toEqual([["number", 4, 2], ["bullet", 1, 1]]);
      expect($nodesOfType(QuoteNode)[0].getTextContent()).toBe("quote\nnext");
      expect($nodesOfType(LinkNode)[0].getURL()).toBe("https://example.com/path");
      expect($nodesOfType(TaskImageNode)[0].getTextContent()).toBe("map");
    });
  }
  read(source); verify();
  doc.update(() => $nodesOfType(HeadingNode)[0].selectEnd().insertText(" edited"), { discrete: true });
  const saved = doc.getEditorState().read($writeDescription);
  expect(saved.startsWith("## Draft edited\n")).toBe(true);
  expect(saved).toContain("\n\n4. ordered");
  expect(saved).toContain("<u>under</u>");
  expect(saved).toContain("![map](https://example.com/map.png)");
  read(saved); verify();
  expect(doc.getEditorState().read($writeDescription)).toBe(saved);
});

test("unsafe resources and arbitrary HTML remain text, including after another edit", () => {
  const doc = createEditor({ nodes: descriptionNodes, onError: error => { throw error; } });
  const source = "[unsafe](javascript:alert) ![bad](data:image/png;base64,QQ) ![mail](mailto:a@b.co) <img src=x> &#99999999;";
  doc.update(() => $readDescription(source), { discrete: true });
  doc.getEditorState().read(() => {
    expect($nodesOfType(LinkNode)).toHaveLength(0);
    expect($nodesOfType(TaskImageNode)).toHaveLength(0);
    expect($getRoot().getTextContent()).toBe(source);
  });
  doc.update(() => $getRoot().selectEnd().insertText("!"), { discrete: true });
  expect(doc.getEditorState().read($writeDescription)).toBe(source + "!");
});

test("toolbar formats the selected run, keeps selection across prop echoes and inserts a validated link", async () => {
  const changes = mock();
  function Form() {
    const [value, setValue] = React.useState("first second");
    return <TaskDescriptionEditor value={value} onChange={next => { changes(next); setValue(next); }} />;
  }
  await act(async () => { view = TestRenderer.create(<Form />); });
  expect(currentEditor().getEditorState().read($getSelection)).toBeNull();
  expect(byId("task-create-description-toolbar").findAllByType("button")).toHaveLength(11);
  for (const button of byId("task-create-description-toolbar").findAllByType("button")) {
    expect(button.findByProps({ role: "tooltip" }).props.children).toBe(button.props["aria-label"]);
  }
  expect(changes).not.toHaveBeenCalled();
  await update(() => $getRoot().getAllTextNodes()[0].select(6, 12));
  await clickTool("underline");
  expect(changes).toHaveBeenLastCalledWith("first <u>second</u>");
  expect(currentEditor().getEditorState().read(() => $getSelection()?.getTextContent())).toBe("second");
  await clickTool("link");
  await update(() => $setSelection(null)); // keyboard focus moved into the URL input
  await update(() => $getRoot().selectStart()); // browser re-focus can report a temporary caret
  const popup = view.root.findByProps({role: "dialog"});
  const [text, input] = popup.findAllByType("input");
  expect(text.props.value).toBe("second");
  await act(async () => input.props.onChange({ target: { value: "javascript:alert" } }));
  expect(popup.findAllByType("button")[1].props.disabled).toBe(true);
  await act(async () => input.props.onChange({ target: { value: "https://example.com/doc" } }));
  await act(async () => text.props.onChange({ target: { value: "Document" } }));
  await act(async () => popup.findAllByType("button")[1].props.onClick());
  expect(write()).toBe("first [<u>Document</u>](https://example.com/doc)");
  expect(currentEditor().getEditorState().read(() => $nodesOfType(LinkNode)[0].getTextContent())).toBe("Document");
});

test("canceling a new link leaves the description unchanged", async () => {
  await act(async () => { view = TestRenderer.create(<TaskDescriptionEditor value="Original" onChange={() => {}} />); });
  await update(() => $getRoot().selectEnd());
  await clickTool("link");
  const popup = view.root.findByProps({ role: "dialog" });
  const [text, address] = popup.findAllByType("input");
  await act(async () => address.props.onChange({ target: { value: "https://example.com" } }));
  expect(popup.findAllByType("button")[1].props.disabled).toBe(true);
  await act(async () => text.props.onChange({ target: { value: "Example" } }));
  await act(async () => popup.findAllByType("button")[0].props.onClick());
  expect(write()).toBe("Original");
  expect(view.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
});

for (const trigger of ["typed", "toolbar"]) {
  test(`${trigger} mention searches the current directory and replaces only the query`, async () => {
    const members = ["Kevin", "Zimo"].map(name => ({ id: name, userId: name, role: "member", user: { id: name, name, account: null, avatar: null, email: null } }));
    await act(async () => { view = TestRenderer.create(<TaskDescriptionEditor members={members} value="前后" onChange={() => {}} />); });
    await update(() => $getRoot().getAllTextNodes()[0].select(1, 1));
    const type = (text: string) => update(() => { const range = $getSelection(); if ($isRangeSelection(range)) range.insertText(text); });
    if (trigger === "typed") await type("@"); else await clickTool("mention");
    const options = () => view.root.findAllByProps({ role: "option" });
    expect(options()).toHaveLength(2);
    await type("zi");
    expect(options()).toHaveLength(1);
    await act(async () => options()[0].props.onClick());
    expect(write()).toBe("前[@Zimo](task-member:Zimo) 后");
    expect(view.root.findAllByProps({ role: "listbox" })).toHaveLength(0);
    const saved = write();
    await act(async () => view.update(<TaskDescriptionEditor compact readOnly members={members} value={saved} onChange={() => {}} />));
    expect(byId("task-detail-description-preview").findByProps({ children: "@Zimo" }).props.className).toContain("text-blue-10");
    await act(async () => view.update(<TaskDescriptionEditor members={members} value={saved} onChange={() => {}} />));
    await update(() => $getRoot().selectEnd());
    await clickTool("mention");
    expect(options()[1].props["aria-disabled"]).toBe(true);
    expect(options()[1].props.onClick).toBeUndefined();
    expect(options()[0].props["aria-selected"]).toBe(true);
  });
}

test("emoji picker inserts the chosen emoji at the saved range only after selection", async () => {
  await act(async () => { view = TestRenderer.create(<TaskDescriptionEditor value="left right" onChange={() => {}} />); });
  await update(() => $getRoot().getAllTextNodes()[0].select(5, 5));
  await clickTool("emoji");
  expect(write()).toBe("left right");
  const picker = view.root.findByProps({ role: "dialog" });
  expect(picker.findAllByType("section")).toHaveLength(2);
  await update(() => $setSelection(null));
  await act(async () => picker.findByProps({ children: "🚀" }).props.onClick());
  expect(write()).toBe("left 🚀right");
  expect(view.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
});

test("typing after enabling bold and striking a selection displays rich text after reopening", async () => {
  function Detail() {
    const [value, setValue] = React.useState("");
    return <TaskDescriptionEditor compact value={value} onChange={setValue} />;
  }
  await act(async () => { view = TestRenderer.create(<Detail />); });
  const preview = () => byId("task-detail-description-preview");
  await act(async () => preview().props.onClick());
  await update(() => $getRoot().selectEnd());
  const pressed = (tool: string) => byId(`task-description-format-${tool}`).props["aria-pressed"];
  expect(pressed("bold")).toBe(false);
  await clickTool("bold");
  expect(pressed("bold")).toBe(true);
  await update(() => { const range = $getSelection(); if ($isRangeSelection(range)) range.insertText("任务说明"); });
  await update(() => $getRoot().getAllTextNodes()[0].select(0, 4));
  await clickTool("strike");
  expect(pressed("bold")).toBe(true);
  expect(pressed("strike")).toBe(true);
  await clickTool("strike");
  expect(pressed("strike")).toBe(false);
  expect(pressed("bold")).toBe(true);
  await clickTool("strike");
  const verify = () => currentEditor().getEditorState().read(() => {
    const text = $getRoot().getAllTextNodes()[0];
    expect(text.getTextContent()).toBe("任务说明");
    expect(text.hasFormat("bold") && text.hasFormat("strikethrough")).toBe(true);
  });
  verify();
  await act(async () => byId("task-detail-description-editor").props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }));
  expect(preview().findByType("s").findByType("strong").props.children).toBe("任务说明");
  await act(async () => preview().props.onClick());
  verify();
});

test("compact keyboard entry saves only on external blur and reopens the edited Markdown", async () => {
  const save = mock();
  function Detail() {
    const [value, setValue] = React.useState("alpha");
    return <TaskDescriptionEditor compact value={value} onChange={setValue} onBlur={() => save(value)} />;
  }
  await act(async () => { view = TestRenderer.create(<Detail />); });
  const preview = () => byId("task-detail-description-preview");
  await act(async () => preview().props.onKeyDown({ key: "Enter", preventDefault() {} }));
  const frame = byId("task-detail-description-editor");
  expect(frame.props.className).toContain("h-[168px]");
  await update(() => $getRoot().selectEnd());
  await clickTool("ordered");
  expect(byId("task-description-format-ordered").props["aria-pressed"]).toBe(true);
  expect(write()).toBe("1. alpha");
  await clickTool("quote");
  expect(byId("task-description-format-ordered").props["aria-pressed"]).toBe(false);
  expect(byId("task-description-format-quote").props["aria-pressed"]).toBe(true);
  expect(write()).toBe("> alpha");
  await act(async () => frame.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} }));
  expect(save).not.toHaveBeenCalled();
  await act(async () => frame.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }));
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith("> alpha");
  await act(async () => preview().props.onClick());
  expect(currentEditor().getEditorState().read(() => $nodesOfType(QuoteNode)[0].getTextContent())).toBe("alpha");
});

test("paste accepts only plain text and readOnly exposes no edit entry", async () => {
  const onChange = mock();
  await act(async () => { view = TestRenderer.create(<TaskDescriptionEditor value="before" onChange={onChange} />); });
  await update(() => {
    $getRoot().selectEnd();
    currentEditor().dispatchCommand(PASTE_COMMAND, { preventDefault() {}, clipboardData: { getData: (mime: string) => mime === "text/plain" ? " label" : '<a href="file:///a">label</a>' } } as ClipboardEvent);
  });
  expect(onChange).toHaveBeenLastCalledWith("before label");
  await act(async () => view.update(<TaskDescriptionEditor compact readOnly value="**replacement**" onChange={onChange} />));
  const preview = byId("task-detail-description-preview");
  expect(preview.props.onKeyDown).toBeUndefined();
  expect(preview.props.onClick).toBeUndefined();
  expect(preview.findAllByType("button")).toHaveLength(0);
  expect(preview.findByType("strong").props.children).toBe("replacement");
});
