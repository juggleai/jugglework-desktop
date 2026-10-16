import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";
import { createRemoteControlLifecycleManager } from "./remote-control-lifecycle-manager.mjs";

const INPUT = Object.freeze({
  grant: "one-time-grant",
  scope: { controlPlaneBaseUrl: "https://cloud.example.test/jwork/api", userId: "user-1", organizationId: "org-1" },
});

function harness({ failAt = null, pauseAt = null, status: statusOverrides = {} } = {}) {
  const calls = [];
  const diagnostics = [];
  /** @type {() => void} */
  let resolveReplacement = () => {};
  /** @type {() => void} */
  let markReplacementStarted = () => {};
  const replacementGate = new Promise((resolve) => { resolveReplacement = () => resolve(); });
  const replacementStarted = new Promise((resolve) => { markReplacementStarted = () => resolve(); });
  let releaseStage = () => {};
  let markStageStarted = () => {};
  const stageGate = new Promise((resolve) => { releaseStage = () => resolve(); });
  const stageStarted = new Promise((resolve) => { markStageStarted = () => resolve(); });
  const pause = async (stage) => {
    if (pauseAt !== stage) return;
    markStageStarted();
    await stageGate;
  };
  let settings = { enabled: true };
  let status = {
    schemaVersion: 1,
    state: "disabled",
    connected: false,
    enrollmentAuthorized: true,
    locallyDisabled: true,
    enrolled: true,
    activeControlSessionCount: 0,
    remoteOperationCount: 0,
    lifecycleGeneration: 1,
    connectionGeneration: null,
    lastErrorCode: null,
    ...statusOverrides,
  };
  const agent = {
    status: () => status,
    stopAll: async () => {
      calls.push("stop");
      await pause("disable-stop");
      if (failAt === "stop") throw new Error("secret-stop");
      status = { ...status, state: "disabled", connected: false, locallyDisabled: true, activeControlSessionCount: 0 };
    },
    refreshLocalSettings: async () => {
      calls.push("refresh");
      if (settings.enabled) await pause("startup");
      if (failAt === "startup" && settings.enabled) throw new Error("secret-startup");
      if (settings.enabled) status = { ...status, state: "connecting", locallyDisabled: false };
      else status = { ...status, state: "disabled", connected: false, locallyDisabled: true };
      return status;
    },
    waitForWelcome: async ({ signal }) => {
      calls.push("welcome");
      await pause("welcome");
      if (signal.aborted) throw Object.assign(new Error("cancelled"), { code: "welcome_aborted" });
      if (failAt === "welcome") {
        status = { ...status, lastErrorCode: "transport_closed_1008_policy_rejected" };
        throw Object.assign(new Error("rejected"), { code: "transport_closed_1008_policy_rejected" });
      }
      status = { ...status, state: "connected", connected: true };
      return status;
    },
    replaceIdentity: async () => {
      calls.push("replace");
      markReplacementStarted();
      await pause("replacement");
      if (failAt === "pending") await replacementGate;
      if (failAt === "enrollment") throw new Error("grant=secret privateKey=secret");
      status = { ...status, enrolled: true };
    },
    deleteCredential: async () => { calls.push("delete"); status = { ...status, enrolled: false }; },
    drainOldOperations: async () => { calls.push("drain"); },
  };
  const manager = createRemoteControlLifecycleManager({
    getAgent: () => agent,
    disableSettings: async () => { calls.push("disable"); await pause("disable-settings"); settings = { enabled: false }; return settings; },
    enableSettings: async () => { calls.push("enable"); await pause("enable"); if (failAt === "enable") throw new Error("secret-enable"); settings = { enabled: true }; return settings; },
    applyLocalEffects: (value) => { calls.push(value.enabled ? "effects-enabled" : "effects-disabled"); },
    cancelPendingWork: async () => {
      calls.push("cancel");
      await pause("disable-cancel");
      if (failAt === "cancel") throw new Error("secret-cancel");
      if (failAt === "cancel-unavailable" || failAt === "cancel-timeout") {
        throw new ManagedRuntimeClientError(failAt === "cancel-unavailable" ? "unavailable" : "timeout");
      }
      if (failAt === "cancel-http") {
        const error = new ManagedRuntimeClientError("http_error", { serverCode: "unauthorized" });
        error.status = 401;
        throw error;
      }
    },
    synchronizePendingPolicy: async () => {
      calls.push("policy");
      await pause("policy");
      if (failAt === "policy-timeout") throw new ManagedRuntimeClientError("timeout");
      if (failAt === "policy") throw new Error("secret-policy-failure");
    },
    logger: { warn: (message, metadata) => diagnostics.push({ message, metadata }) },
  });
  return { manager, calls, diagnostics, resolveReplacement, replacementStarted, releaseStage, stageStarted, get settings() { return settings; } };
}

describe("remote-control lifecycle manager", () => {
  it("orders disable, fencing, identity replacement, persistence enable, and startup", async () => {
    const fixture = harness();
    const result = await fixture.manager.reregisterAndEnable(INPUT);
    assert.equal(result.ok, true);
    assert.equal(result.status.replacementPending, false);
    assert.equal(result.status.replacementStatus, "succeeded");
    assert.deepEqual(fixture.calls, [
      "disable", "effects-disabled", "stop", "cancel", "refresh", "drain", "replace",
      "enable", "effects-enabled", "refresh", "welcome", "policy",
    ]);
  });

  it("rejects an overlapping grant without starting a second identity", async () => {
    const fixture = harness({ failAt: "pending" });
    const first = fixture.manager.reregisterAndEnable({ ...INPUT, grant: "first-grant" });
    await fixture.replacementStarted;
    const second = await fixture.manager.reregisterAndEnable({ ...INPUT, grant: "second-grant" });
    assert.equal(second.ok, false);
    assert.equal(second.error.code, "replacement_in_progress");
    assert.equal(second.status.replacementPending, true);
    assert.equal(fixture.calls.filter((call) => call === "replace").length, 1);
    fixture.resolveReplacement();
    assert.equal((await first).ok, true);
  });

  it("fails closed, removes partial identity, permits retry, and never returns secret-bearing errors", async () => {
    const failed = harness({ failAt: "enrollment" });
    const result = await failed.manager.reregisterAndEnable(INPUT);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "enrollment_failed");
    assert.equal(result.status.replacementPending, false);
    assert.equal(result.status.replacementStatus, "failed");
    assert.equal(result.status.enrolled, false);
    assert.deepEqual(failed.calls.slice(-6), ["disable", "effects-disabled", "stop", "delete", "refresh", "policy"]);
    assert.doesNotMatch(JSON.stringify(result), /one-time-grant|privateKey|secret/i);

    const retry = harness();
    assert.equal((await retry.manager.reregisterAndEnable({ ...INPUT, grant: "fresh-grant" })).ok, true);
  });

  it("preserves the old identity when pending work cannot be fenced before replacement", async () => {
    const fixture = harness({ failAt: "cancel" });
    const result = await fixture.manager.reregisterAndEnable(INPUT);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "stop_failed");
    assert.equal(result.status.locallyDisabled, true);
    assert.equal(result.status.enrolled, true);
    assert.ok(!fixture.calls.includes("replace"));
    assert.ok(!fixture.calls.includes("delete"));
    assert.doesNotMatch(JSON.stringify(result), /secret/i);
  });

  for (const failAt of ["cancel-unavailable", "cancel-timeout"]) {
    it(`continues a fresh unregistered replacement when the empty managed runtime is ${failAt.replace("cancel-", "")}`, async () => {
      const fixture = harness({ failAt, status: { enrolled: false } });
      const result = await fixture.manager.reregisterAndEnable(INPUT);
      assert.equal(result.ok, true);
      assert.ok(fixture.calls.includes("cancel"));
      assert.ok(fixture.calls.indexOf("drain") > fixture.calls.indexOf("cancel"));
      assert.ok(fixture.calls.indexOf("replace") > fixture.calls.indexOf("drain"));
    });
  }

  it("continues a registered offline replacement when both status snapshots prove quiescence", async () => {
    const fixture = harness({ failAt: "cancel-unavailable", status: { enrolled: true } });
    assert.equal((await fixture.manager.reregisterAndEnable(INPUT)).ok, true);
  });

  for (const status of [
    { connected: true },
    { activeControlSessionCount: 1 },
    { remoteOperationCount: 1 },
    { remoteOperationCount: undefined },
  ]) {
    it(`fails closed when unavailable cancellation lacks zero-work evidence ${JSON.stringify(status)}`, async () => {
      const fixture = harness({ failAt: "cancel-unavailable", status });
      const result = await fixture.manager.reregisterAndEnable(INPUT);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "stop_failed");
      assert.equal(fixture.calls.includes("replace"), false);
      assert.equal(fixture.calls.includes("drain"), false);
    });
  }

  it("fails closed on a managed runtime HTTP/authentication error even when quiescent", async () => {
    const fixture = harness({ failAt: "cancel-http" });
    const result = await fixture.manager.reregisterAndEnable(INPUT);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "stop_failed");
    assert.equal(fixture.calls.includes("replace"), false);
  });

  it("guards conflicting identity mutations while replacement is pending", async () => {
    const fixture = harness({ failAt: "pending" });
    const replacing = fixture.manager.reregisterAndEnable(INPUT);
    await fixture.replacementStarted;
    assert.throws(() => fixture.manager.assertMutationAvailable(), /already in progress/);
    fixture.resolveReplacement();
    await replacing;
    assert.doesNotThrow(() => fixture.manager.assertMutationAvailable());
  });

  it("cleans up after settings persistence and transport startup failures", async () => {
    for (const [failAt, code] of [["enable", "enable_failed"], ["startup", "startup_failed"], ["welcome", "startup_failed"]]) {
      const fixture = harness({ failAt });
      const result = await fixture.manager.reregisterAndEnable(INPUT);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code);
      assert.equal(result.status.enrolled, false);
      assert.equal(result.status.locallyDisabled, true);
      assert.ok(fixture.calls.includes("delete"));
      assert.doesNotMatch(JSON.stringify(result), /secret/i);
    }
  });

  it("retains a content-free welcome failure snapshot after cleanup", async () => {
    const fixture = harness({ failAt: "welcome" });
    const result = await fixture.manager.reregisterAndEnable(INPUT);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "startup_failed");
    assert.deepEqual(result.status.replacementFailure, {
      stage: "welcome",
      code: "welcome_transport_closed",
      agentErrorCode: "transport_closed",
      closeCode: 1008,
      lifecycleGeneration: 1,
      connectionGeneration: null,
    });
    assert.deepEqual(fixture.manager.status().replacementFailure, result.status.replacementFailure);
    assert.deepEqual(fixture.diagnostics, [{
      message: "remote_control_replacement_failed",
      metadata: result.status.replacementFailure,
    }]);
    assert.doesNotMatch(JSON.stringify(result.status.replacementFailure), /policy_rejected|secret/i);
  });

  it("preserves the authenticated identity when managed-runtime policy fails after welcome", async () => {
    const fixture = harness({ failAt: "policy-timeout" });
    const result = await fixture.manager.reregisterAndEnable(INPUT);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "startup_failed");
    assert.equal(result.status.replacementFailure.stage, "pending_policy");
    assert.equal(result.status.replacementFailure.code, "pending_policy_timeout");
    assert.equal(result.status.replacementFailure.agentErrorCode, null);
    assert.ok(fixture.calls.indexOf("policy") > fixture.calls.indexOf("welcome"));
    assert.equal(fixture.calls.includes("delete"), false);
    assert.equal(result.status.enrolled, true);
    assert.equal(result.status.locallyDisabled, true);
    assert.equal(result.status.connected, false);
  });

  it("keeps replacement pending while post-welcome policy synchronization is queued", async () => {
    const fixture = harness({ pauseAt: "policy" });
    const replacement = fixture.manager.reregisterAndEnable(INPUT);
    await fixture.stageStarted;
    const pending = fixture.manager.status();
    assert.equal(pending.connected, true);
    assert.equal(pending.replacementPending, true);
    assert.equal(pending.replacementFailure, null);
    fixture.releaseStage();
    assert.equal((await replacement).ok, true);
  });

  for (const entryPoint of ["IPC Stop All", "tray Stop All", "direct disable"]) {
    for (const stage of ["replacement", "enable", "startup", "welcome", "policy"]) {
      it(`${entryPoint} wins over replacement during ${stage}`, async () => {
        const fixture = harness({ pauseAt: stage });
        const replacement = fixture.manager.reregisterAndEnable(INPUT);
        await fixture.stageStarted;
        const disabling = fixture.manager.disable();
        await Promise.resolve();
        assert.ok(fixture.calls.filter((call) => call === "disable").length >= 2);
        fixture.releaseStage();
        const [result] = await Promise.all([replacement, disabling]);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "cancelled");
        assert.equal(fixture.settings.enabled, false);
        assert.equal(fixture.manager.status().locallyDisabled, true);
        if (stage === "policy") assert.equal(fixture.calls.includes("delete"), false);
      });
    }
  }

  for (const stage of ["disable-settings", "disable-cancel", "disable-stop"]) {
    it(`an already pending disable blocks replacement while paused at ${stage}`, async () => {
      const fixture = harness({ pauseAt: stage });
      const disabling = fixture.manager.disable();
      await fixture.stageStarted;
      const replacement = await fixture.manager.reregisterAndEnable(INPUT);
      assert.equal(replacement.ok, false);
      assert.equal(replacement.error.code, "replacement_in_progress");
      assert.equal(fixture.calls.includes("replace"), false);
      assert.equal(fixture.calls.includes("enable"), false);
      fixture.releaseStage();
      await disabling;
      assert.equal(fixture.settings.enabled, false);
      assert.equal(fixture.manager.status().locallyDisabled, true);
    });
  }
});
