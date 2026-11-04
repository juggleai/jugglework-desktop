import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveArtifactFileCopy, resolveArtifactExternalSource } from "./artifact-file-operations.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("外部文件标识解析原件，普通路径不请求服务且无登记的来源不能回退", async () => {
  const requests = [];
  const client = { postJson: async (route, body) => { requests.push({ route, body }); return { absolutePath: path.join(tmpdir(), "原始 报告.docx") }; } };
  assert.equal(await resolveArtifactExternalSource(client, "/workspace", "report.docx"), null);
  assert.equal(requests.length, 0);
  assert.equal(await resolveArtifactExternalSource(client, "/workspace", "external-files/key/report.docx"), path.join(tmpdir(), "原始 报告.docx"));
  assert.deepEqual(requests, [{ route: "/office/local-files/resolve", body: { workspaceRoot: "/workspace", path: "external-files/key/report.docx" } }]);
  assert.equal(await resolveArtifactExternalSource({ postJson: async () => ({ absolutePath: null }) }, "/other", "external-files/key/report.docx"), null);
  await assert.rejects(resolveArtifactExternalSource({ postJson: async () => ({ absolutePath: "relative.docx" }) }, "/workspace", "external-files/key/report.docx"), /来源/);
  await assert.rejects(resolveArtifactExternalSource({ postJson: async () => { throw new Error("未登记"); } }, "/workspace", "external-files/unknown/report.docx"), /未登记/);
});

test("copies zero-byte and large files with Unicode names without changing the source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-file-copy-"));
  roots.push(root);
  for (const size of [0, 6_000_000]) {
    const name = `报告 Q1 ${size}.docx`;
    const source = path.join(root, name);
    const destination = path.join(root, `copy-${name}`);
    const bytes = Buffer.alloc(size, 42);
    await writeFile(source, bytes);
    assert.equal(
      await saveArtifactFileCopy({
        assertDestination: async () => {},
        workspaceRoot: root,
        relativePath: name,
        choosePath: async (suggestion) => {
          assert.equal(suggestion, name);
          return destination;
        },
      }),
      destination,
    );
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(await readFile(source), bytes);
  }
});

test("cancelling creates no copy and selecting the original is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-file-copy-"));
  roots.push(root);
  const source = path.join(root, "report.docx");
  await writeFile(source, "original");
  assert.equal(
    await saveArtifactFileCopy({
      assertDestination: async () => {
        assert.fail("取消时不检查目标");
      },
      workspaceRoot: root,
      relativePath: "report.docx",
      choosePath: async () => null,
    }),
    null,
  );
  await assert.rejects(
    saveArtifactFileCopy({
      assertDestination: async () => {},
      workspaceRoot: root,
      relativePath: "report.docx",
      choosePath: async () => source,
    }),
    /different file/,
  );
  assert.equal(await readFile(source, "utf8"), "original");
});

test("覆盖前等待目标模型检查，拒绝或检查失败时不改写文件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-file-copy-"));
  roots.push(root);
  const target = path.join(root, "target.csv");
  await writeFile(path.join(root, "source.csv"), "source");
  await writeFile(target, "target");
  const checked = [];
  await assert.rejects(
    saveArtifactFileCopy({
      workspaceRoot: root,
      relativePath: "source.csv",
      choosePath: async () => target,
      assertDestination: async (destination) => {
        checked.push(destination);
        throw new Error("目标文档仍在编辑");
      },
    }),
    /仍在编辑/,
  );
  assert.deepEqual(checked, [target]);
  assert.equal(await readFile(target, "utf8"), "target");
});
