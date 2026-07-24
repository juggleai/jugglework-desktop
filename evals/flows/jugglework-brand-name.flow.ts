import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "jugglework-brand-name";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

function witness(ctx: FlowContext, condition: unknown, assertion: string, actual?: unknown) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, assertion);
}

async function read(relativePath: string) {
  return readFile(join(ROOT, relativePath), "utf8");
}

export default defineFlow({
  id: FLOW_ID,
  title: "JuggleWork replaces the visible OpenWork brand without breaking compatibility",
  kind: "user-facing",
  steps: [
    {
      name: "The desktop app launches as JuggleWork",
      run: async (ctx) => {
        await ctx.prove("The running desktop app identifies itself as JuggleWork", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "JuggleWork control API",
            });
            await ctx.navigateHash("/settings/shell");
            await ctx.waitForText("Branding", { timeoutMs: 30_000 });
            await ctx.eval(`(() => {
              const input = document.querySelector("#shell-app-name");
              input?.scrollIntoView({ block: "center" });
              return Boolean(input);
            })()`);
            await ctx.waitFor(`(() => {
              const input = document.querySelector("#shell-app-name");
              if (!input) return false;
              const rect = input.getBoundingClientRect();
              return rect.top >= 0 && rect.bottom <= window.innerHeight;
            })()`, { label: "JuggleWork application name input in the viewport" });
          },
          assert: async () => {
            const identity = await ctx.eval(`(() => ({
              title: document.title,
              appName: document.querySelector("#shell-app-name")?.value ?? null,
            }))()`);
            const correctIdentity = await ctx.eval(
              `document.title === "JuggleWork" && document.querySelector("#shell-app-name")?.value === "JuggleWork"`,
            );
            witness(
              ctx,
              correctIdentity,
              "Window title and configured application name both equal JuggleWork",
              identity,
            );
            await ctx.expectNoText("OpenWork");
          },
          screenshot: {
            name: "jugglework-desktop-identity",
            requireText: ["Branding", "JuggleWork"],
            rejectText: ["OpenWork"],
            hashIncludes: "/settings/shell",
          },
        });
      },
    },
    {
      name: "User-facing surfaces use the JuggleWork brand",
      run: async (ctx) => {
        await ctx.prove("App, installer, and email surfaces consistently say JuggleWork", {
          voiceover: vo[1],
          action: async () => {
            await ctx.eval(`(() => {
              const heading = Array.from(document.querySelectorAll("h1, h2, h3, div"))
                .find((element) => element.textContent?.trim() === "Organization-wide settings");
              heading?.scrollIntoView({ block: "start" });
              return Boolean(heading);
            })()`);
            await ctx.waitForText("JuggleWork Cloud");
          },
          assert: async () => {
            const surfaces = {
              webTitle: await read("apps/app/index.html"),
              desktop: await read("apps/desktop/electron/main.mjs"),
              installer: await read("apps/installer/src/ui-html.ts"),
              email: await read("packages/email/src/templates/index.ts"),
              englishUi: await read("apps/app/src/i18n/locales/en.ts"),
            };
            for (const [surface, source] of Object.entries(surfaces)) {
              const hasNewBrand = /\bJuggleWork\b/.test(source);
              const hasOldBrand = /\bOpenWork\b/.test(source);
              witness(
                ctx,
                hasNewBrand && !hasOldBrand,
                `${surface} contains JuggleWork and no standalone OpenWork brand`,
                { hasNewBrand, hasOldBrand },
              );
            }
            await ctx.expectNoText("OpenWork");
            ctx.output(
              "Representative renamed surfaces",
              Object.keys(surfaces).join("\n"),
            );
          },
          screenshot: {
            name: "jugglework-cloud-branding",
            requireText: ["Organization-wide settings", "JuggleWork Cloud"],
            rejectText: ["OpenWork"],
            hashIncludes: "/settings/shell",
          },
        });
      },
    },
    {
      name: "Existing integrations remain compatible",
      run: async (ctx) => {
        await ctx.prove("Technical OpenWork identifiers remain unchanged for compatibility", {
          voiceover: vo[2],
          action: async () => {
            await ctx.navigateHash("/settings/advanced");
            await ctx.waitForText("Advanced", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const rootPackage = await read("package.json");
            const appPackage = await read("apps/app/package.json");
            const desktopMain = await read("apps/desktop/electron/main.mjs");
            const desktopRuntime = await read("apps/desktop/electron/runtime.mjs");
            const englishUi = await read("apps/app/src/i18n/locales/en.ts");
            const compatibility = {
              packageScope: appPackage.includes('"name": "@openwork/app"'),
              environment: rootPackage.includes("OPENWORK_DEV_MODE"),
              deepLink: desktopMain.includes('entry.startsWith("openwork://")'),
              configStorage: desktopRuntime.includes('".openwork", "openwork-orchestrator"'),
              existingDomain: desktopMain.includes("openworklabs.com"),
              visibleProtocolHelp: englishUi.includes("openwork://"),
            };
            for (const [identifier, preserved] of Object.entries(compatibility)) {
              witness(ctx, preserved, `${identifier} compatibility identifier is preserved`);
            }
            await ctx.expectNoText("OpenWork");
            ctx.output("Preserved compatibility identifiers", JSON.stringify(compatibility, null, 2));
          },
          screenshot: {
            name: "jugglework-compatible-settings",
            requireText: ["Advanced"],
            rejectText: ["OpenWork"],
            hashIncludes: "/settings/advanced",
          },
        });
      },
    },
    {
      name: "The renamed real app passes the frame proof",
      run: async (ctx) => {
        await ctx.prove("The live JuggleWork UI remains navigable and contains no old visible brand", {
          voiceover: vo[3],
          action: async () => {
            await ctx.navigateHash("/settings/appearance");
            await ctx.waitForText("Appearance", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectHashIncludes("/settings/appearance");
            await ctx.expectNoText("OpenWork");
            const ready = await ctx.eval(
              `document.title === "JuggleWork" && Boolean(window.__openworkControl)`,
            );
            witness(ctx, ready, "The live JuggleWork window and control API are ready");
          },
          screenshot: {
            name: "jugglework-verified-settings",
            requireText: ["Appearance"],
            rejectText: ["OpenWork"],
            hashIncludes: "/settings/appearance",
          },
        });
      },
    },
  ],
});
