import { expect, mock, test } from "bun:test";
import { submitPresentationCreation } from "../src/react-app/domains/session/presentation/presentation-submit";

const request = {
  version: 1 as const,
  purpose: "Launch plan",
  audience: "Team",
  outline: "Problem, plan, owners",
  slideCount: 4,
  template: "minimal" as const,
  outputName: "launch.pptx",
};

test("submits through sendDraft with one stable exact turn identity", async () => {
  const sendDraft = mock(async () => ({ outcome: "sent" as const }));
  await expect(submitPresentationCreation(request, sendDraft, "msg_presentation_stable")).resolves.toBe("msg_presentation_stable");
  expect(sendDraft).toHaveBeenCalledTimes(1);
  expect(sendDraft.mock.calls[0]?.[1]).toEqual({
    delivery: "start",
    messageID: "msg_presentation_stable",
    intent: "presentation-creation",
  });
  expect(sendDraft.mock.calls[0]?.[0].parts.some((part) => part.type === "skill" && part.name === "presentation-generator")).toBe(true);
});

test("rejects a blocked or cancelled submission instead of starting observation", async () => {
  for (const outcome of ["blocked", "cancelled"] as const) {
    const sendDraft = mock(async () => ({ outcome }));
    await expect(submitPresentationCreation(request, sendDraft, "msg_rejected")).rejects.toThrow("not accepted");
  }
});
