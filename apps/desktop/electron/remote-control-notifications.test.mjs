import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REMOTE_CONTROL_NOTIFICATION_CATEGORY,
  classifyRemoteControlNotification,
  createRemoteControlNotificationController,
} from "./remote-control-notifications.mjs";

const LIVE = Object.freeze({ origin: "live", workspaceId: "ws_secret", sessionId: "ses_secret" });

describe("remote control notifications", () => {
  it("classifies every supported category with fixed semantic copy", () => {
    const cases = [
      [{ ...LIVE, type: "interaction.waiting", interactionType: "permission", interactionId: "perm_secret" }, "waiting", "Permission needed"],
      [{ ...LIVE, type: "interaction.waiting", interactionType: "question", interactionId: "question_secret" }, "waiting", "Answer needed"],
      [{ ...LIVE, type: "run.terminal", runId: "run_secret", outcome: "completed" }, "terminal", "Remote run completed"],
      [{ ...LIVE, type: "run.terminal", runId: "run_secret", outcome: "failed" }, "terminal", "Remote run failed"],
      [{ ...LIVE, type: "run.terminal", runId: "run_secret", outcome: "aborted" }, "terminal", "Remote run aborted"],
      [{ origin: "live", type: "control.disconnected", transition: 4 }, "disconnect", "Remote control disconnected"],
      [{ origin: "live", type: "control.revoked", source: "local", transition: 5 }, "revocation", "Remote control stopped"],
      [{ origin: "live", type: "control.revoked", source: "cloud", transition: 6 }, "revocation", "Remote control revoked"],
    ];
    for (const [event, category, title] of cases) {
      const result = classifyRemoteControlNotification(event);
      assert.equal(result?.category, category);
      assert.equal(result?.title, title);
    }
    assert.deepEqual(Object.values(REMOTE_CONTROL_NOTIFICATION_CATEGORY), ["waiting", "terminal", "disconnect", "revocation"]);
  });

  it("never places actor-controlled or sensitive source fields in title or body", () => {
    const secrets = [
      "Mallory Actor", "prompt-secret", "transcript-secret", "question-secret", "resource-secret",
      "raw-error-secret", "ws_secret", "ses_secret", "run_secret", "/Users/private/file",
      "tool-payload-secret", "token-secret", "credential-secret", "https://secret.example/control?token=secret",
    ];
    const source = {
      ...LIVE,
      type: "run.terminal",
      runId: "run_secret",
      outcome: "failed",
      actorDisplayName: secrets[0],
      prompt: secrets[1],
      transcript: secrets[2],
      question: secrets[3],
      resources: [secrets[4]],
      error: secrets[5],
      path: secrets[9],
      payload: secrets[10],
      token: secrets[11],
      credential: secrets[12],
      url: secrets[13],
    };
    const result = classifyRemoteControlNotification(source);
    const visible = `${result?.title}\n${result?.body}`;
    for (const secret of secrets) assert.equal(visible.includes(secret), false);
  });

  it("deduplicates by stable content-free event identity and state transition", () => {
    const delivered = [];
    const controller = createRemoteControlNotificationController({ notify: (notification) => delivered.push(notification) });
    const interaction = { ...LIVE, type: "interaction.waiting", interactionType: "question", interactionId: "question_1" };
    assert.equal(controller.accept(interaction), true);
    assert.equal(controller.accept({ ...interaction, prompt: "different secret content" }), false);
    assert.equal(controller.accept({ ...interaction, interactionId: "question_2" }), true);
    const disconnect = { origin: "live", type: "control.disconnected", transition: 9 };
    assert.equal(controller.accept(disconnect), true);
    assert.equal(controller.accept(disconnect), false);
    assert.equal(controller.accept({ ...disconnect, transition: 10 }), true);
    assert.equal(delivered.length, 4);
  });

  it("does not notify hydration, snapshots, malformed events, or unsupported interactions", () => {
    const delivered = [];
    const controller = createRemoteControlNotificationController({ notify: (notification) => delivered.push(notification) });
    assert.equal(controller.accept({ ...LIVE, origin: "hydration", type: "run.terminal", runId: "run_1", outcome: "completed" }), false);
    assert.equal(controller.accept({ ...LIVE, origin: "snapshot", type: "interaction.waiting", interactionType: "question", interactionId: "q_1" }), false);
    assert.equal(controller.accept({ ...LIVE, origin: "live", type: "snapshot_required" }), false);
    assert.equal(controller.accept({ ...LIVE, origin: "live", type: "interaction.waiting", interactionType: "custom", interactionId: "i_1" }), false);
    assert.deepEqual(delivered, []);
  });

  it("fails best-effort and still suppresses repeated delivery attempts", () => {
    let attempts = 0;
    const controller = createRemoteControlNotificationController({
      notify: () => { attempts += 1; throw new Error("notification backend failed with token-secret"); },
    });
    const event = { origin: "live", type: "control.revoked", source: "cloud", transition: 1 };
    assert.equal(controller.accept(event), true);
    assert.equal(controller.accept(event), false);
    assert.equal(attempts, 1);
  });
});
