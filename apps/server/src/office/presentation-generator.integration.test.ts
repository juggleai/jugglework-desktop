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
      version: 2,
      template: "minimal",
      outputName,
      slides: [
        { layout: "cover", title: "Editable native title", subtitle: "Editable native subtitle", notes: "Editable speaker notes" },
        { layout: "agenda", title: "Agenda", items: ["First", "Second"] },
        { layout: "section", title: "Section", subtitle: "Transition", sectionNumber: "01" },
        { layout: "bullets", title: "Bullets", takeaway: "Conclusion", bullets: ["One", "Two"] },
        { layout: "cards", title: "Cards", cards: [{ title: "First card", body: "Editable card body" }, { title: "Second card", body: "Another editable body" }] },
        { layout: "stats", title: "Stats", stats: [{ value: "+18%", label: "Growth", detail: "Above plan" }] },
        { layout: "comparison", title: "Comparison", left: { title: "Before", items: ["Old"] }, right: { title: "After", items: ["New"] } },
        { layout: "process", title: "Process", steps: [{ title: "Plan", body: "Prepare" }, { title: "Run", body: "Execute" }] },
        { layout: "table", title: "Table", columns: ["Item", "Owner"], rows: [["Launch", "Team"]] },
        { layout: "summary", title: "Summary", takeaway: "Keep improving", actions: ["Act now"] },
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
    expect(info.slide_count).toBe(10);
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const pageInfo = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: pageIndex });
      expect((pageInfo.shapes as unknown[]).length).toBeGreaterThan(0);
    }
    const page = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
    const shapes = page.shapes as Array<{ id: string; text?: string }>;
    const title = shapes.find((shape) => shape.text?.includes("Editable native title"));
    expect(title).toBeTruthy();
    await engine.tool("slide_set_text", { file_id: fileId, page_index: 0, shape_id: title!.id, text: "Changed native title" });
    const changed = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
    expect(JSON.stringify(changed)).toContain("Changed native title");
    await engine.save(fileId);
    await engine.close(fileId);
    fileId = undefined;
    await engine.tool("open_file", { file_path: output, wait: true });
    fileId = (await engine.editor(output))!.file_id;
    const reopened = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
    expect(JSON.stringify(reopened)).toContain("Changed native title");
  } finally {
    if (fileId) await engine.close(fileId, true);
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
