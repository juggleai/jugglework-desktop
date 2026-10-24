import { describe, expect, test } from "bun:test";
import {
  PRESENTATION_REQUEST_VERSION,
  PRESENTATION_TEMPLATES,
  buildPresentationPrompt,
  createPresentationDraft,
  presentationSourcePath,
  validatePresentationRequest,
} from "../src/react-app/domains/session/presentation/presentation-request";
import { composerFilePartToPromptPart } from "../src/react-app/domains/session/sync/prompt-file-parts";

const request = {
  version: PRESENTATION_REQUEST_VERSION,
  purpose: "Quarterly strategy update",
  audience: "Leadership",
  outline: "Context, findings, recommendation",
  slideCount: 7,
  template: "executive" as const,
  outputName: "strategy",
  currentFile: { path: "reports/source.pdf" },
};

describe("presentation request", () => {
  test("defines versioned templates and normalizes a bounded request", () => {
    expect(PRESENTATION_TEMPLATES.map(({ id, version }) => [id, version])).toEqual([
      ["executive", 1], ["editorial", 1], ["minimal", 1],
    ]);
    expect(validatePresentationRequest(request)).toMatchObject({
      outputName: "strategy.pptx",
      currentFile: { path: "reports/source.pdf", name: "source.pdf" },
    });
  });

  test("rejects invalid versions, paths, templates, counts, and output names", () => {
    expect(() => validatePresentationRequest({ ...request, version: 2 })).toThrow("Unsupported");
    expect(() => validatePresentationRequest({ ...request, slideCount: 31 })).toThrow("between 1 and 30");
    expect(() => validatePresentationRequest({ ...request, template: "unknown" })).toThrow("template");
    expect(() => validatePresentationRequest({ ...request, outputName: "../deck.pptx" })).toThrow("filename");
    expect(() => validatePresentationRequest({ ...request, currentFile: { path: "../source.pdf" } })).toThrow("workspace-relative");
    expect(() => validatePresentationRequest({ ...request, currentFile: { path: "source.exe" } })).toThrow("not supported");
  });

  test("builds one complete constrained prompt plus a skill and real current-file part", () => {
    const prompt = buildPresentationPrompt(request);
    expect(prompt).toContain("presentation-generator skill");
    expect(prompt).toContain("jugglework_artifact_generate exactly once");
    expect(prompt).toContain('"template": "executive"');
    const draft = createPresentationDraft(request);
    expect(draft.text).toBe(prompt);
    expect(draft.parts).toEqual([
      { type: "text", text: prompt },
      { type: "skill", name: "presentation-generator" },
      { type: "file", path: "reports/source.pdf", label: "source.pdf" },
    ]);
    expect(composerFilePartToPromptPart(
      draft.parts.find((part) => part.type === "file")!,
      "/workspace",
    )).toEqual({
      type: "file",
      mime: "text/plain",
      url: "file:///workspace/reports/source.pdf",
      filename: "source.pdf",
    });
  });

  test("omits the file part when no current file was selected", () => {
    const draft = createPresentationDraft({ ...request, currentFile: undefined });
    expect(draft.parts.some((part) => part.type === "file")).toBe(false);
    expect(draft.text).toContain("no current file was selected");
  });

  test("offers only supported workspace-relative active files as sources", () => {
    expect(presentationSourcePath("research/source.docx")).toBe("research/source.docx");
    expect(presentationSourcePath("src/presentation.ts")).toBeNull();
    expect(presentationSourcePath("../outside.pdf")).toBeNull();
    expect(presentationSourcePath(null)).toBeNull();
  });
});
