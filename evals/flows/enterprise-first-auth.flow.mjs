/**
 * Enterprise new-member first run — factory-fresh desktop app first auth.
 *
 * Required env:
 * - JUGGLEWORK_EVAL_DEN_API_URL: Den API base URL for the enterprise sandbox.
 * - JUGGLEWORK_EVAL_DEN_WEB_URL: Den Web origin used by the desktop handoff link.
 *
 * Optional env:
 * - JUGGLEWORK_EVAL_CDP_URL or --cdp-url: CDP endpoint for a factory-fresh Electron app.
 * - JUGGLEWORK_EVAL_ENTERPRISE_ORG_NAME: organization display name (default Example Organization).
 * - JUGGLEWORK_EVAL_ENTERPRISE_NEW_MEMBER_EMAIL: signed-in member email (default new.member@example.com).
 * - JUGGLEWORK_EVAL_ENTERPRISE_NEW_MEMBER_WORKSPACE: workspace folder (default /workspace/enterprise-first-auth).
 * - JUGGLEWORK_EVAL_ENTERPRISE_GATEWAY_URL: gateway base URL used if the transcript asks for JIT login without a full link.
 * - JUGGLEWORK_EVAL_ENTERPRISE_NEW_MEMBER_GATEWAY_USER: gateway login user override (default signed-in member email).
 * - JUGGLEWORK_EVAL_ENTERPRISE_PASSWORD: account password (default TutorialDemo123!).
 * - JUGGLEWORK_EVAL_ENTERPRISE_TASK_TIMEOUT_MS: chat turn timeout in milliseconds.
 *
 * Runner note: evals/runner/run.mjs chooses one CDP endpoint for a run. Point
 * JUGGLEWORK_EVAL_CDP_URL (or --cdp-url) at the freshly installed sandbox/app.
 */

import {
  assertEvidence,
  configureDesktopForDen,
  createDesktopHandoff,
  deliverDesktopDeepLink,
  ensureLocalWorkspace,
  ensureLocalWorkspaceBeforeConnectPollIfNeeded,
  enterpriseOrgName,
  envText,
  resetDesktopDenSession,
  retryAfterGatewayLoginIfNeeded,
  sendPromptAndWait,
  signInByEmail,
  timeoutMs,
  waitForJuggleWorkConnectReady,
  workspaceFolder,
} from "./enterprise-gateway-common.mjs";

const DEFAULT_NEW_MEMBER_EMAIL = "new.member@example.com";
const WORKSPACE_ENV = "JUGGLEWORK_EVAL_ENTERPRISE_NEW_MEMBER_WORKSPACE";
const DEFAULT_WORKSPACE = "/workspace/enterprise-first-auth";
const PROMPT = "Use JuggleWork Cloud capabilities to find and use the `my-incidents` skill, then report the open incidents assigned to me.";
const PROMPT_AFTER_JIT = "The enterprise incident gateway sign-in is complete. Start fresh without reusing prior results: find and use `my-incidents` / `enterprise_graph_query` with `assigned_to: me` and `status: open`, then report my open incidents.";
const JIT_COMPLETE_SENTINEL = "JUGGLEWORK_ENTERPRISE_JIT_COMPLETE_SENTINEL";

const state = {
  newMemberToken: "",
  workspaceId: "",
  latestTranscript: "",
};

export default {
  id: "enterprise-first-auth",
  title: "Enterprise factory-fresh desktop first auth provisions org resources and discovers my-incidents",
  kind: "user-facing",
  requiredEnv: ["JUGGLEWORK_EVAL_DEN_API_URL", "JUGGLEWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame: first open",
      run: async (ctx) => {
        await ctx.prove("A just-installed enterprise desktop app opens to the JuggleWork welcome screen", {
          action: async () => {
            await ctx.waitForText("Welcome to JuggleWork", { timeoutMs: 90_000 });
          },
          assert: async () => {
            await ctx.expectText("Welcome to JuggleWork");
          },
          screenshot: {
            name: "enterprise-first-open",
            claim: "The first launch starts from the generic JuggleWork welcome screen before the member signs in.",
            requireText: ["Welcome to JuggleWork"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Dispatch new member's Den desktop handoff",
      run: async (ctx) => {
        state.newMemberToken = await dispatchDesktopHandoff(ctx, newMemberEmail(ctx));
      },
    },
    {
      name: "Settle the org step",
      run: async (ctx) => {
        // Resolved before the frame below so its claim and assertions can
        // describe the journey the member actually got.
        state.orgStep = await waitForOrgStep(ctx);
      },
    },
    {
      name: "Frame: org step",
      run: async (ctx) => {
        const picker = state.orgStep === "picker";
        await ctx.prove(
          picker
            ? "New member chooses the organization during first desktop auth"
            : "A sole organization membership is connected without asking",
          {
            action: async () => {
              // Already settled by the preceding step.
            },
            assert: async () => {
              await ctx.expectText(enterpriseOrgName(ctx));
              if (state.orgStep === "picker") {
                await ctx.expectText("Choose your organization");
                await ctx.expectText("Continue with organization");
              } else {
                await ctx.expectNoText("Choose your organization");
              }
              const signedIn = await desktopAuthState(ctx);
              assertEvidence(ctx, signedIn.hasToken, "The desktop handoff persisted a Den auth token before org selection", signedIn);
            },
            screenshot: {
              name: "enterprise-choose-org",
              claim: picker
                ? "Before anything is clicked, the app asks the member which organization to connect."
                : "With one organization to join there is nothing to choose, so the app connects it and moves on.",
              requireText: [enterpriseOrgName(ctx)],
              rejectText: ["Something went wrong"],
            },
          },
        );
      },
    },
    {
      name: "Leave the org step",
      run: async (ctx) => {
        // Nothing to click when onboarding adopted the sole organization.
        if (state.orgStep !== "picker") return;
        await clickTextStartingWith(ctx, "Continue with organization", "button, [role=button]", 30_000);
      },
    },
    {
      name: "Frame: org provisioned",
      run: async (ctx) => {
        await ctx.prove("Organization resources are provisioned before the member enters the workspace", {
          action: async () => {
            await waitForOrgResources(ctx);
          },
          assert: async () => {
            await ctx.expectText(enterpriseOrgName(ctx));
            await ctx.expectText("You have access to the following resources.");
            await ctx.expectText("Continue to workspace");
          },
          screenshot: {
            name: "enterprise-org-provisioned",
            claim: "Before Continue to workspace is clicked, the app shows organization resources are ready.",
            requireText: [enterpriseOrgName(ctx), "You have access to the following resources.", "Continue to workspace"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Continue to workspace and wait for JuggleWork Connect",
      run: async (ctx) => {
        await clickTextStartingWith(ctx, "Continue to workspace", "button, [role=button]", 30_000);
        await ctx.waitFor("Boolean((localStorage.getItem('jugglework.den.authToken') ?? '').trim())", { timeoutMs: 60_000, label: "desktop Den auth token" });
        const shell = await ctx.waitFor(`(() => {
          const text = document.body.innerText || '';
          return text.includes('JuggleWork Connect') || text.includes('Run task') || location.hash.includes('/workspace') || location.hash.includes('/welcome');
        })()`, { timeoutMs: 90_000, label: "desktop app shell after org provisioning" });
        assertEvidence(ctx, Boolean(shell), "The signed-in desktop app shell is visible after org provisioning", await desktopAuthState(ctx));
        const folder = workspaceFolder(ctx, WORKSPACE_ENV, DEFAULT_WORKSPACE);
        state.workspaceId = await ensureLocalWorkspaceBeforeConnectPollIfNeeded(ctx, folder);
        if (state.workspaceId) {
          assertEvidence(ctx, true, "A local workspace is created from the welcome route before polling JuggleWork Connect", {
            folder,
            workspaceId: state.workspaceId,
          });
        }
        const ready = await waitForJuggleWorkConnectReady(ctx);
        assertEvidence(ctx, ready.ready, "JuggleWork Connect reaches Ready on the factory-fresh app", ready);
      },
    },
    {
      name: "Create new member's fresh workspace",
      run: async (ctx) => {
        const folder = workspaceFolder(ctx, WORKSPACE_ENV, DEFAULT_WORKSPACE);
        if (state.workspaceId) {
          assertEvidence(ctx, true, "A local workspace is available for the member's first run", {
            folder,
            workspaceId: state.workspaceId,
          });
          return;
        }
        state.workspaceId = await ensureLocalWorkspace(ctx, folder);
        assertEvidence(ctx, state.workspaceId.length > 0, "A local workspace is created for the member's first run", {
          folder,
          workspaceId: state.workspaceId,
        });
      },
    },
    {
      name: "Frame: org skill on fresh machine",
      run: async (ctx) => {
        await ctx.prove("Member's first task discovers the my-incidents org skill on a fresh machine", {
          action: async () => {
            const timeout = timeoutMs(ctx, "JUGGLEWORK_EVAL_ENTERPRISE_FIRST_AUTH_TIMEOUT_MS", 300_000);
            const first = await sendPromptAndWait(ctx, PROMPT, { timeout });
            state.latestTranscript = await retryAfterGatewayLoginIfNeeded(
              ctx,
              newMemberEmail(ctx),
              first,
              JIT_COMPLETE_SENTINEL,
              PROMPT_AFTER_JIT,
              { timeout, gatewayUserEnvName: "JUGGLEWORK_EVAL_ENTERPRISE_NEW_MEMBER_GATEWAY_USER" },
            );
          },
          assert: async () => {
            const transcript = state.latestTranscript;
            assertEvidence(ctx, transcript.toLowerCase().includes("my-incidents"), "Transcript mentions the cloud-delivered my-incidents skill", transcript);
          },
          screenshot: {
            name: "enterprise-org-skill-on-fresh-machine",
            claim: "The first chat on a brand-new desktop discovers and uses the my-incidents skill.",
            requireText: ["my-incidents"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};

function newMemberEmail(ctx) {
  return envText(ctx, "JUGGLEWORK_EVAL_ENTERPRISE_NEW_MEMBER_EMAIL") || DEFAULT_NEW_MEMBER_EMAIL;
}

async function dispatchDesktopHandoff(ctx, email) {
  await configureDesktopForDen(ctx);
  await resetDesktopDenSession(ctx);
  const token = await signInByEmail(ctx, email);
  const juggleworkUrl = await createDesktopHandoff(ctx, token);
  await deliverDesktopDeepLink(ctx, juggleworkUrl);
  await waitForDesktopToken(ctx, juggleworkUrl);
  return token;
}

async function waitForDesktopToken(ctx, juggleworkUrl) {
  try {
    await ctx.waitFor("Boolean((localStorage.getItem('jugglework.den.authToken') ?? '').trim())", { timeoutMs: 60_000, label: "desktop Den token after handoff" });
  } catch (error) {
    const diagnostics = await desktopAuthState(ctx);
    const redactedUrl = juggleworkUrl.replace(/([?&]grant=)[^&]+/, "$1<redacted>");
    throw new Error(`Timed out waiting for desktop Den token after deep-link handoff ${redactedUrl}. Diagnostics: ${JSON.stringify(diagnostics)}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Onboarding only asks which organization to connect when the member belongs
 * to more than one; a sole membership is adopted for them and the step is
 * skipped. Resolve to whichever the member actually got so the frames below
 * assert the journey they saw.
 *
 * @returns {Promise<"picker" | "adopted">}
 */
async function waitForOrgStep(ctx) {
  const orgName = enterpriseOrgName(ctx);
  return await ctx.waitFor(`(() => {
    const orgName = ${JSON.stringify(orgName)};
    const text = document.body.innerText || '';
    const buttons = [...document.querySelectorAll('button, [role=button]')].map((entry) => (entry.textContent ?? '').replace(/\\s+/g, ' ').trim());
    if (text.includes('Choose your organization') && text.includes(orgName) && buttons.some((button) => button.startsWith('Continue with organization'))) {
      return 'picker';
    }
    if (text.includes(orgName) && text.includes('You have access to the following resources.')) {
      return 'adopted';
    }
    return null;
  })()`, { timeoutMs: 90_000, label: "enterprise organization step" });
}

async function waitForOrgResources(ctx) {
  const orgName = enterpriseOrgName(ctx);
  await ctx.waitFor(`(() => {
    const orgName = ${JSON.stringify(orgName)};
    const text = document.body.innerText || '';
    return text.includes(orgName) && text.includes('You have access to the following resources.') && text.includes('Continue to workspace');
  })()`, { timeoutMs: 90_000, label: "enterprise provisioned resources screen" });
}

async function clickTextStartingWith(ctx, prefix, selector, timeoutMs) {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((entry) => normalize(entry.textContent).startsWith(${JSON.stringify(prefix)}) && entry.disabled !== true && entry.getAttribute('aria-disabled') !== 'true');
    element?.scrollIntoView({ block: 'center', inline: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs, label: `clickable text starting with ${JSON.stringify(prefix)}` });
}

async function desktopAuthState(ctx) {
  return ctx.eval(`(() => ({
    hasToken: Boolean((localStorage.getItem('jugglework.den.authToken') ?? '').trim()),
    activeOrgId: localStorage.getItem('jugglework.den.activeOrgId') || '',
    activeOrgName: localStorage.getItem('jugglework.den.activeOrgName') || '',
    hash: location.hash,
    visibleText: (document.body.innerText || '').slice(0, 1_000),
    handoffEvents: window.__enterpriseHandoffDiagnostics?.events ?? [],
    handoffExchanges: window.__enterpriseHandoffDiagnostics?.exchanges ?? [],
  }))()`);
}
