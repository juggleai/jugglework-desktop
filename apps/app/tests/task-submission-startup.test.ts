import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const sessionSurface = readFileSync(
  new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url),
  "utf8",
);
const composer = readFileSync(
  new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url),
  "utf8",
);
const sessionRoute = readFileSync(
  new URL("../src/react-app/shell/session-route.tsx", import.meta.url),
  "utf8",
);

describe("task submission startup feedback", () => {
  test("enters preparation before awaiting send and clears only the matching session", () => {
    const prepareIndex = sessionSurface.indexOf("setSubmissionPendingIdentity(surfaceIdentity)");
    const sendIndex = sessionSurface.indexOf("const pendingSend = sendDraft(nextDraft, submission)", prepareIndex);
    const awaitIndex = sessionSurface.indexOf("const result = await pendingSend", sendIndex);

    expect(prepareIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(prepareIndex);
    expect(awaitIndex).toBeGreaterThan(sendIndex);
    expect(sessionSurface).toContain(
      "setSubmissionPendingIdentity((current) => current === surfaceIdentity ? null : current)",
    );
  });

  test("shows an explicit live preparation phase and disables duplicate submit", () => {
    expect(sessionSurface).toContain('data-testid="task-submission-preparing"');
    expect(sessionSurface).toContain("const submissionPreparationLabel = !localSubmissionPreparing");
    expect(sessionSurface).toContain('t("composer.preparing_task")');
    expect(sessionSurface).toContain('t("composer.checking_connections")');
    expect(sessionSurface).toContain('t("composer.restoring_connections")');
    expect(sessionSurface).toContain('t("composer.submitting_task")');
    expect(composer).toContain("props.submissionPreparingLabel ?? t(\"composer.run_task\")");
    expect(composer).toContain("props.submissionPreparing");
  });

  test("keeps ordinary tasks on the fast path and gates explicit Cloud capabilities", () => {
    expect(sessionRoute).toContain("const requiresCloudMcpReadiness = draft.parts.some");
    expect(sessionRoute).toContain('part.kind === "cloud-skill"');
    expect(sessionRoute).toContain('part.kind === "cloud-mcp"');
    expect(sessionRoute).toContain('part.kind === "extension"');
    expect(sessionRoute).toContain("skipGate: !requiresCloudMcpReadiness");
  });
});
