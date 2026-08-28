import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "jugglework-connect-status";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const DEMO_EMAIL = "alex@acme.test";
const DEMO_PASSWORD = "JuggleWorkDemo123!";
const PROMPT = "Say hello without using connected services.";
const SAVED_TOKEN_KEY = "jugglework.eval.juggleworkConnectStatus.sessionToken";

const state = {
  workspaceId: null,
  transcriptCount: 0,
};

function quoted(value) {
  return JSON.stringify(value);
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`);
}

async function authDelay(ctx, action) {
  const baseUrl = ctx.env.JUGGLEWORK_EVAL_DEN_API_URL.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/__jugglework_eval/auth-delay${action ? `?action=${action}` : ""}`, {
    method: action ? "POST" : "GET",
  });
  ctx.assert(response.ok, `The eval auth-delay control failed (${response.status}).`);
  return response.json();
}

async function dismissFirstTaskOnboarding(ctx) {
  if (await ctx.hasText("Power your first task")) {
    await ctx.clickText("Skip and use the free model", { selector: "button", timeoutMs: 15_000 });
  }
}

async function ensureLocalCloudSession(ctx) {
  const denBaseUrl = ctx.env.JUGGLEWORK_EVAL_DEN_API_URL.trim();
  const denOrigin = ctx.env.JUGGLEWORK_EVAL_DEN_ORIGIN?.trim() || denBaseUrl;
  let token = ctx.env.JUGGLEWORK_EVAL_DEN_TOKEN?.trim() ?? "";
  if (!token) {
    const signIn = await fetch(`${denBaseUrl.replace(/\/+$/, "")}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: denOrigin },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    ctx.assert(signIn.ok, `The isolated Den demo account could not sign in (${signIn.status}).`);
    const payload = await signIn.json();
    token = typeof payload?.token === "string" ? payload.token.trim() : "";
  }
  ctx.assert(token, "The isolated Den demo sign-in did not return a session.");
  const response = await fetch(`${denBaseUrl.replace(/\/+$/, "")}/v1/me/orgs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(response.ok, `The isolated Den stack could not resolve the demo organization (${response.status}).`);
  const payload = await response.json();
  const orgs = Array.isArray(payload?.orgs) ? payload.orgs : [];
  const org = orgs.find((entry) => entry.id === payload.activeOrgId) ?? orgs[0];
  ctx.assert(org?.id, "The isolated Den demo session has no organization.");
  await ctx.eval(`(() => {
    const shellConfig = JSON.parse(localStorage.getItem("jugglework.shell-config") || "{}");
    localStorage.setItem("jugglework.shell-config", JSON.stringify({ ...shellConfig, statusBar: true }));
    localStorage.setItem("jugglework.den.baseUrl", ${quoted(denBaseUrl)});
    localStorage.setItem("jugglework.den.authToken", ${quoted(token)});
    localStorage.setItem("jugglework.den.activeOrgId", ${quoted(org.id)});
    ${org.slug ? `localStorage.setItem("jugglework.den.activeOrgSlug", ${quoted(org.slug)});` : ""}
    ${org.name ? `localStorage.setItem("jugglework.den.activeOrgName", ${quoted(org.name)});` : ""}
    return true;
  })()`);
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__juggleworkControl)", { timeoutMs: 60_000, label: "control API after Cloud session restore" });
  await dismissFirstTaskOnboarding(ctx);
}

async function createFreshTask(ctx) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await ctx.eval("window.__juggleworkControl.execute('session.create_task', null)", { awaitPromise: true });
    if (result?.ok === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Could not create a fresh task for the Connect status proof.");
}

async function transcriptCount(ctx) {
  const result = await ctx.eval("window.__juggleworkControl.execute('session.read_transcript', { count: 30 })", { awaitPromise: true });
  if (result?.ok === true) return result.result?.messages?.length ?? 0;
  if (result?.error === "No messages in this session") return 0;
  throw new Error(`Could not read the active transcript: ${result?.error ?? "unknown error"}`);
}

async function waitForTranscriptIncrease(ctx, before) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = await transcriptCount(ctx);
    if (count > before) return count;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Transcript did not grow beyond ${before}.`);
}

async function waitForConnectReady(ctx) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await ctx.hasText("JuggleWork Connect: Ready")) return;
    await ctx.eval("window.dispatchEvent(new Event('focus'))");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("JuggleWork Connect did not become ready after background retries.");
}

async function beginSavedSessionRestore(ctx) {
  await authDelay(ctx, "hold");
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__juggleworkControl)", { timeoutMs: 60_000, label: "control API during saved-session restore" });
  await dismissFirstTaskOnboarding(ctx);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const delay = await authDelay(ctx);
    if (delay.calls >= 1 && delay.pending === delay.calls) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Saved-session validation did not enter the held state.");
}

async function installHealthFailureProbe(ctx) {
  const result = await ctx.eval(`(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__;
    if (!bridge?.invokeDesktop) return false;
    const existing = window.__juggleworkConnectStatusProbe;
    if (existing?.originalInvoke) bridge.invokeDesktop = existing.originalInvoke;
    if (existing?.originalFetch) window.fetch = existing.originalFetch;
    const originalInvoke = bridge.invokeDesktop.bind(bridge);
    const originalFetch = window.fetch.bind(window);
    const failedHealth = (health) => ({
      ...health,
      phase: "engine_failed",
      usable: false,
      usableByCurrentModel: false,
      firstFailure: {
        code: "jugglework_connect_eval_failure",
        stage: "engine_delivery",
        retryable: true,
        recommendedAction: "Run diagnostics",
        message: "JuggleWork Connect could not verify connected service tools.",
      },
    });
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === "string" ? input : input?.url || String(input);
      if (!url.includes("/mcp/jugglework-cloud/")) return response;
      let health;
      try { health = await response.clone().json(); } catch { return response; }
      if (!health || typeof health !== "object" || !("usable" in health)) return response;
      return new Response(JSON.stringify(failedHealth(health)), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    bridge.invokeDesktop = async (command, ...args) => {
      const response = await originalInvoke(command, ...args);
      const url = String(args[0] || "");
      if (command !== "__fetch" || !url.includes("/mcp/jugglework-cloud/") || !response?.body) return response;
      let health;
      try { health = JSON.parse(response.body); } catch { return response; }
      if (!health || typeof health !== "object" || !("usable" in health)) return response;
      return {
        ...response,
        body: JSON.stringify(failedHealth(health)),
      };
    };
    window.__juggleworkConnectStatusProbe = { originalInvoke, originalFetch };
    return true;
  })()`);
  ctx.assert(result === true, "Could not install the bounded Connect health failure probe.");
}

async function restoreHealthProbe(ctx) {
  await ctx.eval(`(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__;
    const probe = window.__juggleworkConnectStatusProbe;
    if (bridge && probe?.originalInvoke) bridge.invokeDesktop = probe.originalInvoke;
    if (probe?.originalFetch) window.fetch = probe.originalFetch;
    delete window.__juggleworkConnectStatusProbe;
    return true;
  })()`);
}

async function setup(ctx) {
  await authDelay(ctx, "release").catch(() => undefined);
  await ctx.waitFor("Boolean(window.__juggleworkControl)", { timeoutMs: 60_000, label: "control API" });
  await restoreHealthProbe(ctx);
  await ensureLocalCloudSession(ctx);
  state.workspaceId = await ctx.eval(`(() => {
    const hashWorkspace = (location.hash.match(new RegExp("/workspace/([^/]+)")) || [])[1] || "";
    return hashWorkspace || (localStorage.getItem("jugglework.react.activeWorkspace") || "").trim();
  })()`);
  ctx.assert(state.workspaceId, "The active workspace was not available.");
  const hasSession = await ctx.eval("window.location.hash.includes('/session/ses_')");
  if (!hasSession) {
    await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
    await ctx.waitFor("window.__juggleworkControl?.listActions?.().some((action) => action.id === 'session.create_task' && !action.disabled)", {
      timeoutMs: 90_000,
      label: "session.create_task enabled",
    });
    await createFreshTask(ctx);
    await ctx.waitFor("window.location.hash.includes('/session/ses_')", { timeoutMs: 90_000, label: "fresh task session" });
  }
  await dismissFirstTaskOnboarding(ctx);
  await waitForConnectReady(ctx);
  state.transcriptCount = await transcriptCount(ctx);
}

export default {
  id: FLOW_ID,
  title: "Signed-in users see non-blocking JuggleWork Connect lifecycle health",
  kind: "user-facing",
  requiredEnv: ["JUGGLEWORK_EVAL_DEN_API_URL"],
  steps: [
    { name: "Setup signed-in Connect status", run: setup },
    {
      name: "Frame 1: saved-session restore shows Checking",
      run: async (ctx) => {
        await ctx.prove("A retained signed-in session shows JuggleWork Connect checking while authentication is restored", {
          voiceover: vo[0],
          action: async () => {
            await beginSavedSessionRestore(ctx);
            await ctx.waitForText("JuggleWork Connect: Checking", { timeoutMs: 10_000 });
          },
          assert: async () => {
            const delay = await authDelay(ctx);
            witness(ctx, delay.pending >= 1, "Cloud session restoration is genuinely still pending while the status shows Checking.", delay);
          },
          screenshot: {
            name: "jugglework-connect-checking",
            claim: "The signed-in status bar shows JuggleWork Connect checking during session restoration.",
            requireText: ["JuggleWork Connect: Checking", "Ready for new tasks"],
            hashIncludes: `/workspace/${state.workspaceId}/session/`,
          },
        });
      },
    },
    {
      name: "Frame 2: checking does not block tasks",
      run: async (ctx) => {
        await ctx.prove("The shared background lifecycle leaves normal message submission unblocked", {
          voiceover: vo[1],
          action: async () => {
            await ctx.control("composer.set_text", { text: PROMPT });
            const clicked = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll("button")].find((entry) => entry.title === "Run task");
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(clicked, "Could not submit the normal task while Connect was checking.");
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (await ctx.hasText("Power your first task")) {
              await dismissFirstTaskOnboarding(ctx);
              await ctx.control("composer.set_text", { text: PROMPT });
              const retried = await ctx.waitFor(`(() => {
                const button = [...document.querySelectorAll("button")].find((entry) => entry.title === "Run task");
                if (!button || button.disabled) return false;
                button.click();
                return true;
              })()`, { timeoutMs: 10_000, label: "Run task after first-task model choice" });
              ctx.assert(retried, "Could not resubmit after the first-task model choice.");
            }
            state.transcriptCount = await waitForTranscriptIncrease(ctx, state.transcriptCount);
          },
          assert: async () => {
            witness(ctx, state.transcriptCount > 0, "The message entered the transcript while Connect restoration remained pending.", { transcriptCount: state.transcriptCount });
            ctx.expectText("JuggleWork Connect: Checking");
          },
          screenshot: {
            name: "jugglework-connect-nonblocking",
            claim: "A normal task is submitted while JuggleWork Connect continues checking in the background.",
            requireText: ["JuggleWork Connect: Checking", PROMPT],
            rejectText: ["Preparing connected service tools"],
            hashIncludes: `/workspace/${state.workspaceId}/session/`,
          },
        });
      },
    },
    {
      name: "Frame 3: successful restore shows Ready",
      run: async (ctx) => {
        await ctx.prove("Successful reconciliation changes JuggleWork Connect to Ready", {
          voiceover: vo[2],
          action: async () => {
            await authDelay(ctx, "release");
            await waitForConnectReady(ctx);
          },
          assert: async () => {
            ctx.expectNoText("JuggleWork Connect: Needs attention");
          },
          screenshot: {
            name: "jugglework-connect-ready",
            claim: "The status bar reports JuggleWork Connect ready after background restoration succeeds.",
            requireText: ["JuggleWork Connect: Ready", "Ready for new tasks"],
            hashIncludes: `/workspace/${state.workspaceId}/session/`,
          },
        });
      },
    },
    {
      name: "Frame 4: bounded failure offers diagnostics",
      run: async (ctx) => {
        await ctx.prove("A persistent lifecycle failure turns the status red and offers diagnostics", {
          voiceover: vo[3],
          action: async () => {
            await installHealthFailureProbe(ctx);
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline && !(await ctx.hasText("JuggleWork Connect: Needs attention"))) {
              await ctx.eval("window.dispatchEvent(new Event('focus'))");
              await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
            ctx.assert(await ctx.hasText("JuggleWork Connect: Needs attention"), "JuggleWork Connect did not reach Needs attention after bounded retries.");
            await ctx.clickText("JuggleWork Connect: Needs attention", { selector: "button", timeoutMs: 5_000 });
            await ctx.waitForText("Run diagnostics", { timeoutMs: 5_000 });
          },
          assert: async () => {
            const red = await ctx.eval(`Boolean(document.querySelector('[data-testid="jugglework-connect-status"] .bg-red-9'))`);
            witness(ctx, red, "The failed JuggleWork Connect status uses the red error indicator.", { red });
          },
          screenshot: {
            name: "jugglework-connect-needs-attention",
            claim: "The failed status is red and explains how to run diagnostics.",
            requireText: ["JuggleWork Connect: Needs attention", "JuggleWork Connect needs attention", "Run diagnostics"],
            hashIncludes: `/workspace/${state.workspaceId}/session/`,
          },
        });
      },
    },
    {
      name: "Frame 5: signed-out status is hidden",
      run: async (ctx) => {
        await ctx.prove("The JuggleWork Connect status is absent when the user is signed out", {
          voiceover: vo[4],
          action: async () => {
            await restoreHealthProbe(ctx);
            await ctx.eval(`(() => {
              const token = localStorage.getItem("jugglework.den.authToken") || "";
              if (token) localStorage.setItem(${quoted(SAVED_TOKEN_KEY)}, token);
              localStorage.removeItem("jugglework.den.authToken");
              location.reload();
              return true;
            })()`);
            await ctx.waitFor("Boolean(window.__juggleworkControl)", { timeoutMs: 60_000, label: "control API after sign-out" });
            await ctx.waitFor("!document.body.innerText.includes('JuggleWork Connect:')", { timeoutMs: 15_000, label: "Connect status hidden" });
          },
          assert: async () => {
            ctx.expectNoText("JuggleWork Connect:");
          },
          screenshot: {
            name: "jugglework-connect-signed-out-hidden",
            claim: "Signed-out users do not see an JuggleWork Connect lifecycle status.",
            requireText: ["Ready for new tasks"],
            rejectText: ["JuggleWork Connect:"],
            hashIncludes: `/workspace/${state.workspaceId}/session/`,
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        await authDelay(ctx, "release").catch(() => undefined);
        await restoreHealthProbe(ctx).catch(() => undefined);
        await ctx.eval(`(() => {
          const token = localStorage.getItem(${quoted(SAVED_TOKEN_KEY)});
          if (token) localStorage.setItem("jugglework.den.authToken", token);
          localStorage.removeItem(${quoted(SAVED_TOKEN_KEY)});
          return true;
        })()`);
      },
    },
  ],
};
