import { describe, expect, test } from "bun:test";
import { modelSupportsImageInput } from "../src/react-app/domains/session/sync/attachment-support";

describe("model image support", () => {
  test("requires explicit attachment or image modality metadata", () => {
    expect(modelSupportsImageInput({ attachment: true })).toBe(true);
    expect(modelSupportsImageInput({ modalities: { input: ["text", "image"] } })).toBe(true);
    expect(modelSupportsImageInput({ modalities: { input: ["text"] } })).toBe(false);
    expect(modelSupportsImageInput(undefined)).toBe(false);
  });
});
