import { expect, test } from "bun:test";
import { normalizeCloudDocPromptParts } from "./prompt.js";

test("模型正文使用可读云文档标签，定位信息仅保留在展示元数据", () => {
  const ref = { tenantId: "t", workspaceId: "w", docId: "d", title: "产品方案", blockIds: ["b1", "b2"] };
  const encoded = `[cloud-doc ${encodeURIComponent(JSON.stringify(ref))}]`;
  const parts = [{ type: "text", text: `修改 ${encoded}，保留其他段落`, metadata: { existing: "kept" } }, { type: "file", text: encoded }];
  normalizeCloudDocPromptParts(parts);
  expect(parts[0].text).toBe("修改 [云文档《产品方案》·选区 2 段]，保留其他段落");
  expect(parts[0].text).not.toContain("tenantId");
  expect(parts[0].metadata as Record<string, unknown>).toEqual({ existing: "kept", cloudDocSourceText: `修改 ${encoded}，保留其他段落` });
  expect(parts[1].text).toBe(encoded);
});

test("无效引用不会把编码或意外正文继续交给模型，普通文字和已有元数据保持", () => {
  const parts = [{ type: "text", text: "普通文字 [cloud-doc invalid%] 结尾" }];
  normalizeCloudDocPromptParts(parts);
  expect(parts[0].text).toBe("普通文字 [无效云文档引用] 结尾");
});
