import { expect, test } from "bun:test";
import type { ComposerDraft, ComposerPart } from "../src/app/types";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { cloudDocToken } from "../src/app/lib/cloud-doc-reference";
import { draftToParts } from "../src/react-app/domains/session/sync/draft-parts";
import { appMentionInstruction } from "../src/react-app/domains/session/surface/composer/app-mentions";
import { buildCapabilityInstruction, fallbackCapabilityPrompt } from "../src/react-app/domains/session/surface/composer/capability-tags";
import { officeGroupDisplay, officeGroupText } from "../src/react-app/domains/session/surface/composer/office-selection-draft";

const office: Extract<ComposerPart, { type: "office-selection" }> = {
  type: "office-selection",
  instruction: { instructionId: "instruction-1", text: "只分析选区，不修改", bindingState: "needs-selection", referenceIds: [] },
  references: [],
};
const cloud = cloudDocToken({ tenantId: "org", workspaceId: "ws", docId: "doc", title: "方案", blockIds: ["block-1"] });
const paste: Extract<ComposerPart, { type: "paste" }> = { type: "paste", id: "paste-1", label: "1", text: "粘贴的用户限制\n不提交代码", lines: 2 };
const capability: Extract<ComposerPart, { type: "capability" }> = { type: "capability", kind: "extension", name: "custom", prompt: "Registered arbitrary prompt without a predictable prefix." };
const user = (text: string) => ({ type: "text", text, metadata: { composerTextSource: "user" } });
const expanded = (text: string, source: string) => ({ type: "text", text, metadata: { composerTextSource: source } });
const draft = (parts: ComposerPart[], text = "unused"): ComposerDraft => ({ mode: "prompt", parts, text, attachments: [] });

test("普通 parts 的正文、粘贴、能力、app 与特殊引用来源独立，发送文字不变", async () => {
  const input = draft([
    { type: "text", text: "只分析，不修改 " }, paste,
    { type: "skill", name: "review" }, capability, { type: "app", name: "Notes" },
    office, { type: "text", text: `请查看 ${cloud}` },
    { type: "agent", name: "reviewer" }, { type: "file", path: "src/index.ts" },
  ]);
  const before = structuredClone(input);
  const parts = await draftToParts(input, "/workspace", "session", null);
  expect(parts).toEqual([
    user("只分析，不修改 "), user(paste.text),
    expanded(buildCapabilityInstruction("skill", "review"), "capability"), expanded(capability.prompt, "capability"),
    expanded(appMentionInstruction("Notes"), "app"),
    { type: "text", text: officeGroupText(office), metadata: { officeSelectionGroup: officeGroupDisplay(office) } },
    { type: "text", text: `请查看 ${cloud}`, metadata: { cloudDocSourceText: `请查看 ${cloud}` } },
    { type: "agent", name: "reviewer" }, expect.objectContaining({ type: "file" }),
  ]);
  expect(input).toEqual(before);
});

test.each([true, false])("附件 token 路径（显式 token=%s）保留顺序、上传说明与所有文本来源", async (inline) => {
  const endpoint = resolveWorkspaceEndpoint({ id: "ws", workspaceType: "local" }, { baseUrl: "http://localhost:1234", token: "" })!;
  const uploads: string[] = [];
  endpoint.client.uploadInbox = async (workspaceId, file, options) => {
    uploads.push(workspaceId);
    return { ok: true, path: options!.path!, bytes: file.size };
  };
  const file = new File(["attachment bytes"], "notes.txt", { type: "text/plain" });
  const text = `前文[pasted text 1][skill review][extension custom][cloud-mcp catalog]@Notes [office-instruction instruction-1]${cloud}${inline ? "[attachment attached]" : ""}后文 @ordinary`;
  const input = draft([paste, capability, { type: "app", name: "Notes" }, office], text);
  input.attachments = [{ id: "attached", name: file.name, mimeType: file.type, size: file.size, kind: "file", file }];
  const parts = await draftToParts(input, "/workspace", "session", endpoint);
  expect(uploads).toEqual(["ws"]);
  expect(parts[0]).toEqual({
    type: "text", synthetic: true, metadata: { composerTextSource: "attachment" },
    text: [
      "Attached files were copied into this worker workspace for tool access:",
      `- notes.txt: ${input.attachments[0].workspaceCopy!.path} (file:///workspace/${input.attachments[0].workspaceCopy!.path})`,
      "Use these paths with Read/Bash/MCP/Docling when a tool needs the file bytes.",
    ].join("\n"),
  });
  const tail = [user("后文 "), user("@ordinary")];
  const filePart = expect.objectContaining({ type: "file", filename: "notes.txt" });
  expect(parts.slice(1)).toEqual([
    user("前文"), user(paste.text), expanded(buildCapabilityInstruction("skill", "review"), "capability"),
    expanded(capability.prompt, "capability"), expanded(fallbackCapabilityPrompt("cloud-mcp", "catalog"), "capability"),
    expanded(appMentionInstruction("Notes"), "app"), user(" "),
    { type: "text", text: officeGroupText(office), metadata: { officeSelectionGroup: officeGroupDisplay(office) } },
    { type: "text", text: cloud, metadata: { cloudDocSourceText: cloud } },
    ...(inline ? [filePart, ...tail] : [...tail, filePart]),
  ]);
});

test("粘贴的云文档标签和无效标签也不冒充纯用户正文", async () => {
  const parts = await draftToParts(draft([
    { ...paste, text: `只分析 ${cloud}` },
    { type: "text", text: "[cloud-doc invalid%]" },
  ]), "/workspace", "session", null);
  expect(parts).toEqual([
    { type: "text", text: `只分析 ${cloud}`, metadata: { cloudDocSourceText: `只分析 ${cloud}` } },
    { type: "text", text: "[cloud-doc invalid%]", metadata: { cloudDocSourceText: "[cloud-doc invalid%]" } },
  ]);
});
