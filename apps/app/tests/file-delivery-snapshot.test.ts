import { expect, test } from "bun:test";
import type { SessionFileArtifacts } from "@jugglework/types/file-artifacts";
import { artifactsFromDelivery } from "../src/lib/artifacts";

test("旧轮次保留快照名称、零字节大小，打开使用重命名后的当前文件", () => {
  const data: SessionFileArtifacts = {
    files: [
      {
        artifactId: "af_1",
        workspaceId: "ws_1",
        relativePath: "重命名.txt",
        name: "重命名.txt",
        kind: "text",
        mimeType: "text/plain",
        exists: true,
        sizeBytes: 128,
        updatedAt: 2,
        editingOwner: "internal",
      },
    ],
    turns: [
      {
        sessionId: "ses_1",
        turnId: "msg_1",
        runIds: ["run_1"],
        finishedRunIds: ["run_1"],
        status: "ready",
        targets: [],
        items: [
          {
            sessionId: "ses_1",
            turnId: "msg_1",
            artifactId: "af_1",
            source: "runtime",
            snapshot: { name: "原稿.docx", sizeBytes: 0, updatedAt: 1 },
          },
        ],
      },
    ],
  };
  const artifact = artifactsFromDelivery(data, "msg_1")[0];
  expect(artifact).toMatchObject({
    name: "原稿.docx",
    type: "document",
    sizeBytes: 0,
    path: "重命名.txt",
    legacy_target: { value: "重命名.txt", preview: "text", size: 128 },
  });
  expect(artifactsFromDelivery(data, "msg_other")).toEqual([]);
  data.files[0]!.exists = false;
  data.turns[0]!.items[0]!.snapshot.sizeBytes = null;
  const missing = artifactsFromDelivery(data, "msg_1")[0]!;
  expect(missing.sizeBytes).toBeUndefined();
  expect(missing.legacy_target.exists).toBe(false);
});
