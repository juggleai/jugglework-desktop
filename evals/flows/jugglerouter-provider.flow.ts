import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "jugglerouter-provider";
const PROVIDER_NAME = "JuggleRouter";
const MODEL_ID = "gpt-5.3-codex";
const RESPONSE_MARKER = "JUGGLE-ROUTER-OK";
const PROVIDER_SEARCH = 'input[placeholder="Filter providers by name or ID"]';
const API_KEY_INPUT = 'input[type="password"]';
const MODEL_SEARCH = 'input[placeholder="Search models..."]';

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

function quoted(value: string) {
  return JSON.stringify(value);
}

async function waitForControl(ctx: FlowContext) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "JuggleWork control API",
  });
}

async function openProviderDialog(ctx: FlowContext) {
  await ctx.navigateHash("/settings/ai");
  const alreadyOpen = await ctx.eval(
    `Boolean(document.querySelector(${quoted(PROVIDER_SEARCH)}))`,
  );
  if (alreadyOpen) return;
  await ctx.waitForText("Connect provider", { timeoutMs: 60_000 });
  await ctx.clickText("Connect provider", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitForText("Connect providers", { timeoutMs: 30_000 });
}

async function disconnectJuggleRouter(ctx: FlowContext) {
  return ctx.eval(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const disconnect = buttons.find((button) => {
      if ((button.textContent || "").trim() !== "Disconnect") return false;
      let node = button.parentElement;
      for (let depth = 0; depth < 6 && node; depth += 1, node = node.parentElement) {
        if ((node.innerText || "").includes(${quoted(PROVIDER_NAME)})) return true;
      }
      return false;
    });
    if (!disconnect) return false;
    disconnect.click();
    return true;
  })()`);
}

async function ensureNewTask(ctx: FlowContext) {
  await ctx.navigateHash("/");
  await waitForControl(ctx);
  await ctx.waitFor(
    `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`,
    { timeoutMs: 60_000, label: "new task action" },
  );
  await ctx.control("session.create_task");
  await ctx.waitFor(
    `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`,
    { timeoutMs: 60_000, label: "task composer" },
  );
}

async function openModelMenu(ctx: FlowContext) {
  await ctx.waitFor(
    `Boolean(document.querySelector('button[aria-label="Change model"]'))`,
    { timeoutMs: 30_000, label: "model picker trigger" },
  );
  await ctx.eval(`document.querySelector('button[aria-label="Change model"]').click()`);
  await ctx.waitFor(`Boolean(document.querySelector(${quoted(MODEL_SEARCH)}))`, {
    timeoutMs: 30_000,
    label: "model picker search",
  });
}

async function searchModels(ctx: FlowContext, query: string) {
  await ctx.fill(MODEL_SEARCH, query);
  await ctx.waitForText(query, { timeoutMs: 30_000 });
}

export default defineFlow({
  id: FLOW_ID,
  title: "Connect JuggleRouter, use a routed Codex model, and disconnect cleanly",
  kind: "user-facing",
  spec: `evals/voiceovers/${FLOW_ID}.md`,
  requiredEnv: ["JUGGLEROUTER_API_KEY"],
  steps: [
    {
      name: "Frame 1 — open the provider connection flow",
      run: async (ctx) => {
        await ctx.prove("AI Provider settings open the existing provider connection flow", {
          voiceover: vo[0],
          action: async () => {
            await waitForControl(ctx);
            await ctx.navigateHash("/settings/ai");
            await ctx.waitForText("Connect provider", { timeoutMs: 60_000 });
            const disconnected = await disconnectJuggleRouter(ctx);
            if (disconnected) {
              await ctx.waitFor(
                `!Array.from(document.querySelectorAll("button")).some((button) => {
                  if ((button.textContent || "").trim() !== "Disconnect") return false;
                  return (button.parentElement?.parentElement?.innerText || "").includes(${quoted(PROVIDER_NAME)});
                })`,
                { timeoutMs: 60_000, label: "previous JuggleRouter connection removed" },
              );
            }
            await openProviderDialog(ctx);
          },
          assert: async () => {
            await ctx.expectText("Connect providers");
          },
          screenshot: {
            name: "frame-1-provider-dialog",
            requireText: ["Connect providers"],
            hashIncludes: "/settings/ai",
          },
        });
      },
    },
    {
      name: "Frame 2 — JuggleRouter is built in",
      run: async (ctx) => {
        await ctx.prove("The provider catalog includes a built-in JuggleRouter entry", {
          voiceover: vo[1],
          action: async () => {
            await ctx.fill(PROVIDER_SEARCH, PROVIDER_NAME);
            await ctx.waitForText(PROVIDER_NAME, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(PROVIDER_NAME);
            await ctx.expectText("jugglerouter");
            await ctx.expectText("API key");
          },
          screenshot: {
            name: "frame-2-jugglerouter-entry",
            requireText: [PROVIDER_NAME, "jugglerouter", "API key"],
          },
        });
      },
    },
    {
      name: "Frame 3 — show the website and key field",
      run: async (ctx) => {
        await ctx.prove("JuggleRouter connection explains the endpoint and links to its website beside a protected key field", {
          voiceover: vo[2],
          action: async () => {
            await ctx.clickText(PROVIDER_NAME, { selector: "button", timeoutMs: 30_000 });
            await ctx.waitForText("Visit jugglerouter.com", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("OpenAI-compatible endpoint");
            await ctx.expectText("Visit jugglerouter.com");
            const passwordField = await ctx.eval(
              `document.querySelector(${quoted(API_KEY_INPUT)})?.getAttribute("type") === "password"`,
            );
            ctx.assert(passwordField, "JuggleRouter API key input is not protected as a password field.");
          },
          screenshot: {
            name: "frame-3-jugglerouter-key",
            requireText: [PROVIDER_NAME, "OpenAI-compatible endpoint", "Visit jugglerouter.com", "API key"],
          },
        });
      },
    },
    {
      name: "Frame 4 — connect with the local key store",
      run: async (ctx) => {
        await ctx.prove("Saving the API key connects JuggleRouter without exposing the credential", {
          voiceover: vo[3],
          action: async () => {
            await ctx.fill(API_KEY_INPUT, ctx.env.JUGGLEROUTER_API_KEY ?? "");
            await ctx.clickText("Save key", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitForText(PROVIDER_NAME, { timeoutMs: 90_000 });
            await ctx.waitForText("Disconnect", { timeoutMs: 90_000 });
          },
          assert: async () => {
            await ctx.expectText(PROVIDER_NAME);
            await ctx.expectText("Disconnect");
            await ctx.expectNoText(ctx.env.JUGGLEROUTER_API_KEY ?? "");
          },
          screenshot: {
            name: "frame-4-jugglerouter-connected",
            requireText: [PROVIDER_NAME, "Disconnect"],
            rejectText: [ctx.env.JUGGLEROUTER_API_KEY ?? ""],
            hashIncludes: "/settings/ai",
          },
        });
      },
    },
    {
      name: "Frame 5 — import only chat models",
      run: async (ctx) => {
        await ctx.prove("The model picker shows JuggleRouter chat models and excludes image, embedding, and video-only catalog entries", {
          voiceover: vo[4],
          action: async () => {
            await ensureNewTask(ctx);
            await openModelMenu(ctx);
            await searchModels(ctx, PROVIDER_NAME);
          },
          assert: async () => {
            await ctx.expectText(PROVIDER_NAME);
            await ctx.expectText(MODEL_ID);
            await ctx.expectNoText("gpt-image-2");
            await ctx.expectNoText("text-embedding-v4");
            await ctx.expectNoText("doubao-seedance");
          },
          screenshot: {
            name: "frame-5-chat-models-only",
            requireText: [PROVIDER_NAME, MODEL_ID],
            rejectText: ["gpt-image-2", "text-embedding-v4", "doubao-seedance"],
          },
        });
      },
    },
    {
      name: "Frame 6 — connected status survives reload",
      run: async (ctx) => {
        await ctx.prove("After the automatic engine reload, AI Provider settings show JuggleRouter as connected", {
          voiceover: vo[5],
          action: async () => {
            await ctx.navigateHash("/settings/ai");
            await waitForControl(ctx);
            await ctx.waitForText(PROVIDER_NAME, { timeoutMs: 60_000 });
            await ctx.waitForText("Disconnect", { timeoutMs: 60_000 });
          },
          assert: async () => {
            await ctx.expectText(PROVIDER_NAME);
            await ctx.expectText("Disconnect");
          },
          screenshot: {
            name: "frame-6-connected-after-reload",
            requireText: [PROVIDER_NAME, "Disconnect"],
            hashIncludes: "/settings/ai",
          },
        });
      },
    },
    {
      name: "Frame 7 — choose the routed Codex model",
      run: async (ctx) => {
        await ctx.prove("A new task can select JuggleRouter's gpt-5.3-codex model", {
          voiceover: vo[6],
          action: async () => {
            await ensureNewTask(ctx);
            await openModelMenu(ctx);
            await searchModels(ctx, MODEL_ID);
            const selected = await ctx.eval(`(() => {
              const items = Array.from(document.querySelectorAll('[data-slot="command-item"]'));
              const item = items.find((candidate) => (candidate.innerText || "").includes(${quoted(MODEL_ID)}));
              if (!item) return false;
              item.click();
              return true;
            })()`);
            ctx.assert(selected, `Could not select ${MODEL_ID}.`);
            await ctx.waitFor(
              `document.querySelector('button[aria-label="Change model"]')?.innerText.includes(${quoted(MODEL_ID)})`,
              { timeoutMs: 30_000, label: `${MODEL_ID} selected` },
            );
          },
          assert: async () => {
            const selected = await ctx.eval(
              `document.querySelector('button[aria-label="Change model"]')?.innerText.includes(${quoted(MODEL_ID)})`,
            );
            ctx.assert(selected, `${MODEL_ID} is not the visible selected model.`);
          },
          screenshot: {
            name: "frame-7-codex-model-selected",
            requireText: [MODEL_ID],
            hashIncludes: "/session",
          },
        });
      },
    },
    {
      name: "Frame 8 — stream a real response",
      run: async (ctx) => {
        await ctx.prove("The selected JuggleRouter model receives a coding task and streams the expected response", {
          voiceover: vo[7],
          action: async () => {
            await ctx.control("composer.set_text", {
              text: "Return only the uppercase success token formed by joining the words JUGGLE, ROUTER, and OK with hyphens.",
            });
            await ctx.waitFor(
              `window.__openworkControl.listActions().some((action) => action.id === "composer.send" && !action.disabled)`,
              { timeoutMs: 30_000, label: "send action" },
            );
            await ctx.control("composer.send");
            await ctx.waitForText(RESPONSE_MARKER, { timeoutMs: 180_000 });
          },
          assert: async () => {
            await ctx.expectText(RESPONSE_MARKER);
            const completed = await ctx.eval(
              `window.__openworkControl.listActions().some((action) => action.id === "composer.stop" && action.disabled)`,
            );
            ctx.assert(completed, "JuggleRouter response did not finish streaming.");
          },
          screenshot: {
            name: "frame-8-jugglerouter-response",
            requireText: [RESPONSE_MARKER, MODEL_ID],
            hashIncludes: "/session",
          },
        });
      },
    },
    {
      name: "Frame 9 — disconnect removes the model",
      run: async (ctx) => {
        await ctx.prove("Disconnect removes JuggleRouter credentials and makes its models unavailable to the workspace", {
          voiceover: vo[8],
          action: async () => {
            await ctx.navigateHash("/settings/ai");
            await ctx.waitForText(PROVIDER_NAME, { timeoutMs: 60_000 });
            const disconnected = await disconnectJuggleRouter(ctx);
            ctx.assert(disconnected, "JuggleRouter Disconnect button was not available.");
            await ctx.waitFor(
              `!Array.from(document.querySelectorAll("button")).some((button) => {
                if ((button.textContent || "").trim() !== "Disconnect") return false;
                return (button.parentElement?.parentElement?.innerText || "").includes(${quoted(PROVIDER_NAME)});
              })`,
              { timeoutMs: 90_000, label: "JuggleRouter disconnected" },
            );
            await ensureNewTask(ctx);
            await openModelMenu(ctx);
            await ctx.fill(MODEL_SEARCH, PROVIDER_NAME);
            await ctx.waitForText("No models found.", { timeoutMs: 60_000 });
          },
          assert: async () => {
            await ctx.expectText("No models found.");
            await ctx.expectNoText(MODEL_ID);
          },
          screenshot: {
            name: "frame-9-jugglerouter-removed",
            requireText: ["No models found."],
            rejectText: [MODEL_ID],
          },
        });
      },
    },
  ],
});
