import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OfficeEngine } from "./engine.js";

const nativeTest = process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;
const execFileAsync = promisify(execFile);

nativeTest("bundled presentation generator opens with editable text in the native Office engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-presentation-native-"));
  const engine = new OfficeEngine({ logDirectory: join(root, "logs") });
  let fileId: string | undefined;
  try {
    const outputName = "native-generated.pptx";
    const specification = {
      version: 1,
      template: "minimal",
      outputName,
      slides: [
        { title: "Editable native title", bullets: ["Editable native bullet"] },
        { title: "Second native slide" },
      ],
    };
    const generator = join(import.meta.dir, "../../../desktop/resources/skills/public-skills/presentation-generator/generate-presentation.mjs");
    await execFileAsync("node", [generator, "--spec-json", JSON.stringify(specification), "--output", outputName], {
      env: { ...process.env, JUGGLEWORK_ARTIFACT_DIR: root },
    });
    const output = join(root, outputName);
    await engine.tool("open_file", { file_path: output, wait: true });
    fileId = (await engine.editor(output))!.file_id;
    const info = await engine.tool("slide_get_info", { file_id: fileId });
    expect(info.slide_count).toBe(2);
    const page = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
    const shapes = page.shapes as Array<{ id: string; text?: string }>;
    const title = shapes.find((shape) => shape.text?.includes("Editable native title"));
    expect(title).toBeTruthy();
    await engine.tool("slide_set_text", { file_id: fileId, page_index: 0, shape_id: title!.id, text: "Changed native title" });
    const changed = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
    expect(JSON.stringify(changed)).toContain("Changed native title");
  } finally {
    if (fileId) await engine.close(fileId, true);
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
