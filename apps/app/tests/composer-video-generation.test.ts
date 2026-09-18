import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import {
  buildVideoGenerationInstruction,
  mergeVideoGenerationSystemContext,
  parseComposerVideoModels,
  videoGenerationSize,
  videoGenerationSystemInstruction,
} from "../src/react-app/domains/session/surface/composer/video-generation";

const composerPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url),
);
const sessionSurfacePath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url),
);
const videoControlsPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/video-generation-controls.tsx", import.meta.url),
);
const sessionRoutePath = fileURLToPath(
  new URL("../src/react-app/shell/session-route.tsx", import.meta.url),
);

describe("composer video generation", () => {
  test("normalizes, filters, and deduplicates ready text-to-video models", () => {
    expect(parseComposerVideoModels({
      models: [
        {
          ref: { providerID: "volcengine", modelID: "seedance-2-mini" },
          providerName: "Volcengine",
          modelName: "Seedance 2.0 Mini",
          availability: "ready",
          capabilities: { textToVideo: true },
        },
        {
          ref: { providerID: "volcengine", modelID: "seedance-2-mini" },
          providerName: "Duplicate",
          modelName: "Duplicate",
        },
        {
          ref: { providerID: "other", modelID: "not-ready" },
          availability: "missing_credentials",
        },
        { ref: { providerID: "", modelID: "invalid" } },
      ],
    })).toEqual([{
      providerID: "volcengine",
      modelID: "seedance-2-mini",
      providerName: "Volcengine",
      modelName: "Seedance 2.0 Mini",
      capabilities: { textToVideo: true },
    }]);
    expect(parseComposerVideoModels({ ok: false, error: "no_video_model_available" })).toEqual([]);
  });

  test("maps every visible aspect ratio to a deterministic 720p-based size", () => {
    expect(videoGenerationSize("auto")).toBeNull();
    expect(videoGenerationSize("3:4")).toBe("720x960");
    expect(videoGenerationSize("4:3")).toBe("960x720");
    expect(videoGenerationSize("9:16")).toBe("720x1280");
    expect(videoGenerationSize("16:9")).toBe("1280x720");
    expect(videoGenerationSize("1:1")).toBe("720x720");
    expect(videoGenerationSize("21:9")).toBe("1680x720");
  });

  test("builds a model-locked, single-submit video job instruction", () => {
    const prompt = buildVideoGenerationInstruction("A paper boat crossing a storm", {
      model: { providerID: "volcengine", modelID: "seedance-2-mini" },
      providerName: "Volcengine",
      modelName: "Seedance 2.0 Mini",
      aspectRatio: "16:9",
      durationSeconds: 10,
    });

    expect(prompt).toContain("`jugglework_video_generate`");
    expect(prompt).toContain("exactly once");
    expect(prompt).toContain("providerID `volcengine`");
    expect(prompt).toContain("modelID `seedance-2-mini`");
    expect(prompt).toContain("durationSeconds `10`");
    expect(prompt).toContain("resolution `1280x720`");
    expect(prompt).toContain("`jugglework_video_job_get`");
    expect(prompt).toEndWith("A paper boat crossing a storm");
  });

  test("injects video generation into system context while preserving the visible prompt", () => {
    const options = {
      model: { providerID: "volcengine", modelID: "seedance-2-mini" },
      providerName: "Volcengine",
      modelName: "Seedance 2.0 Mini",
      aspectRatio: "9:16" as const,
      durationSeconds: 8,
    };
    const resolvedText = buildVideoGenerationInstruction("A vertical city flythrough", options);
    const draft = { text: "A vertical city flythrough", resolvedText, videoGeneration: options };

    expect(videoGenerationSystemInstruction(draft)).toContain("`jugglework_video_generate`");
    expect(mergeVideoGenerationSystemContext(draft, "Workspace environment context")).toBe(
      `Workspace environment context\n\n${resolvedText}`,
    );
    expect(draft.text).toBe("A vertical city flythrough");
  });

  test("shows the menu entry only for discovered models and wires draft submission", () => {
    const composer = readFileSync(composerPath, "utf8");
    const surface = readFileSync(sessionSurfacePath, "utf8");
    const route = readFileSync(sessionRoutePath, "utf8");

    expect(composer).toContain('kind: "video-generation" as const');
    expect(composer).toContain("props.videoGenerationModels.length > 0");
    expect(composer).toContain("<VideoGenerationControls");
    expect(surface).toContain('action: "video_models_list"');
    expect(surface).toContain('action: "status"');
    expect(surface).toContain('args: { mode: "text-to-video" }');
    expect(surface).toContain("status?.submissionEnabled !== true");
    expect(surface).toContain("buildVideoGenerationInstruction(resolved.trim(), videoGeneration)");
    expect(surface).toContain("{ videoGeneration }");
    expect(route).toContain("mergeVideoGenerationSystemContext(draft, imageSystemContext)");
  });

  test("keeps the settings popover compact and uses a two-stage overflow menu in narrow windows", () => {
    const controls = readFileSync(videoControlsPath, "utf8");

    expect(controls).toContain("w-[min(23rem,calc(100vw-1.5rem))]");
    expect(controls).toContain("grid grid-cols-4 gap-2");
    expect(controls).toContain("flex h-14 flex-col");
    expect(controls).toContain('const [mobileOverflowOpen, setMobileOverflowOpen] = useState(false)');
    expect(controls).toContain('<div className="sm:hidden">');
    expect(controls).toContain('<MoreHorizontal size={18} />');
    expect(controls).toContain('className="w-36 gap-0 rounded-xl');
    expect(controls).toContain('<ChevronRight size={15}');
    expect(controls).toContain("{aspectRatioLabel(value.aspectRatio)} · {value.durationSeconds}s");
    expect(controls).toContain('inline-flex w-[7.75rem] shrink-0');
    expect(controls).toContain('w-[4.125rem] text-center font-medium tabular-nums');
    expect(controls).toContain('top-0 w-8 -translate-x-1/2 text-center');
  });
});
