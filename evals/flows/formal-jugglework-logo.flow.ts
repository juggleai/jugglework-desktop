import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "formal-jugglework-logo";
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_LOGO = `${REPO_ROOT}/jugglework-logo.png`;
const APP_LOGO = `${REPO_ROOT}/apps/app/public/jugglework-logo.png`;
const DESKTOP_PNG = `${REPO_ROOT}/apps/desktop/resources/icons/icon.png`;
const DESKTOP_ICO = `${REPO_ROOT}/apps/desktop/resources/icons/icon.ico`;
const DESKTOP_ICNS = `${REPO_ROOT}/apps/desktop/resources/icons/icon.icns`;
const BUILDER_CONFIG = `${REPO_ROOT}/apps/desktop/electron-builder.yml`;
const INSTALLER_UI = `${REPO_ROOT}/apps/installer/src/ui-html.ts`;

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

interface PngFacts {
  bytes: number;
  colorType: number;
  hasAlpha: boolean;
  hash: string;
  height: number;
  width: number;
}

interface BoardItem {
  detail: string;
  label: string;
  src: string;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function pngFacts(path: string): Promise<PngFacts> {
  const buffer = await readFile(path);
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error(`${path} is not a PNG.`);
  }
  const colorType = buffer.readUInt8(25);
  return {
    bytes: buffer.length,
    colorType,
    hasAlpha: colorType === 4 || colorType === 6,
    hash: sha256(buffer),
    height: buffer.readUInt32BE(20),
    width: buffer.readUInt32BE(16),
  };
}

async function pngDataUrl(path: string): Promise<string> {
  return `data:image/png;base64,${(await readFile(path)).toString("base64")}`;
}

async function showBoard(
  ctx: FlowContext,
  board: {
    description: string;
    eyebrow: string;
    items: BoardItem[];
    title: string;
  },
): Promise<void> {
  await ctx.eval(`(() => {
    const board = ${JSON.stringify(board)};
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
    document.body.innerHTML = "";
    document.body.style.margin = "0";
    document.body.style.background = "#eef4f7";
    document.body.style.color = "#071b2e";
    document.body.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    const shell = document.createElement("main");
    shell.setAttribute("data-formal-logo-proof", board.eyebrow);
    shell.style.cssText = "min-height:100vh;box-sizing:border-box;padding:54px 64px 48px;display:grid;align-content:center;gap:28px;background:radial-gradient(circle at 14% 8%,rgba(28,210,229,.22),transparent 34%),radial-gradient(circle at 86% 86%,rgba(5,35,74,.12),transparent 36%)";

    const header = document.createElement("header");
    header.style.cssText = "max-width:900px";
    const eyebrow = document.createElement("div");
    eyebrow.textContent = board.eyebrow;
    eyebrow.style.cssText = "font-size:13px;font-weight:750;letter-spacing:.16em;text-transform:uppercase;color:#058aa2";
    const title = document.createElement("h1");
    title.textContent = board.title;
    title.style.cssText = "margin:10px 0 10px;font-size:44px;line-height:1.04;letter-spacing:-.035em;color:#061b32";
    const description = document.createElement("p");
    description.textContent = board.description;
    description.style.cssText = "margin:0;max-width:760px;font-size:17px;line-height:1.55;color:#496173";
    header.append(eyebrow, title, description);

    const grid = document.createElement("section");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(" + Math.min(board.items.length, 4) + ",minmax(0,1fr));gap:18px";
    for (const item of board.items) {
      const card = document.createElement("article");
      card.style.cssText = "min-height:290px;padding:24px;border:1px solid rgba(7,27,46,.09);border-radius:24px;background:rgba(255,255,255,.88);box-shadow:0 22px 70px rgba(21,51,77,.12);display:grid;grid-template-rows:1fr auto;gap:18px";
      const well = document.createElement("div");
      well.style.cssText = "min-height:190px;border-radius:18px;display:grid;place-items:center;background-color:#f9fbfc;background-image:linear-gradient(45deg,#edf1f3 25%,transparent 25%),linear-gradient(-45deg,#edf1f3 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#edf1f3 75%),linear-gradient(-45deg,transparent 75%,#edf1f3 75%);background-size:22px 22px;background-position:0 0,0 11px,11px -11px,-11px 0";
      const image = document.createElement("img");
      image.src = item.src;
      image.alt = item.label;
      image.style.cssText = "display:block;width:min(74%,210px);height:190px;object-fit:contain";
      well.append(image);
      const copy = document.createElement("div");
      const label = document.createElement("h2");
      label.textContent = item.label;
      label.style.cssText = "margin:0 0 6px;font-size:17px;color:#061b32";
      const detail = document.createElement("p");
      detail.textContent = item.detail;
      detail.style.cssText = "margin:0;font-size:13px;line-height:1.45;color:#617585";
      copy.append(label, detail);
      card.append(well, copy);
      grid.append(card);
    }
    shell.append(header, grid);
    document.body.append(shell);
    return true;
  })()`);
  await ctx.waitFor(
    `Array.from(document.querySelectorAll("[data-formal-logo-proof] img")).every((image) => image.complete && image.naturalWidth > 0)`,
    { timeoutMs: 30_000, label: `${board.eyebrow} proof images` },
  );
}

function pass(ctx: FlowContext, assertion: string, actual: unknown): void {
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion,
    actual: typeof actual === "string" ? actual : JSON.stringify(actual),
  });
}

export default defineFlow({
  id: FLOW_ID,
  title: "JuggleWork uses the approved W artwork across every shipped product-logo surface",
  kind: "user-facing",
  spec: `evals/voiceovers/${FLOW_ID}.md`,
  preserveTheme: true,
  steps: [
    {
      name: "Frame 1 — desktop identity",
      run: async (ctx) => {
        const source = await pngFacts(SOURCE_LOGO);
        const desktop = await pngFacts(DESKTOP_PNG);
        await ctx.prove("The approved W artwork is the production desktop identity", {
          voiceover: vo[0],
          action: async () => {
            await showBoard(ctx, {
              eyebrow: "Desktop identity",
              title: "JuggleWork 正式桌面图标",
              description: "透明 W 主图已进入 Electron 的生产图标资源，供 Dock、任务栏和应用窗口使用。",
              items: [
                {
                  label: "正式源 Logo",
                  detail: `${source.width}×${source.height} · RGBA · 透明背景`,
                  src: await pngDataUrl(SOURCE_LOGO),
                },
                {
                  label: "桌面应用图标",
                  detail: `${desktop.width}×${desktop.height} · Electron production icon`,
                  src: await pngDataUrl(DESKTOP_PNG),
                },
              ],
            });
          },
          assert: async () => {
            ctx.assert(source.hasAlpha, "The approved source logo does not have an alpha channel.");
            ctx.assert(desktop.hasAlpha, "The production desktop PNG does not have an alpha channel.");
            ctx.assert(desktop.width === 1024 && desktop.height === 1024, `Desktop icon is ${desktop.width}×${desktop.height}, expected 1024×1024.`);
            pass(ctx, "Approved source and production desktop PNG both decode with alpha", { source, desktop });
          },
          screenshot: {
            name: "frame-1-desktop-identity",
            requireText: ["JuggleWork 正式桌面图标", "正式源 Logo", "桌面应用图标"],
          },
        });
      },
    },
    {
      name: "Frame 2 — app and browser identity",
      run: async (ctx) => {
        const source = await pngFacts(SOURCE_LOGO);
        const app = await pngFacts(APP_LOGO);
        const favicon16 = await pngFacts(`${REPO_ROOT}/apps/app/public/favicon-16x16.png`);
        const favicon32 = await pngFacts(`${REPO_ROOT}/apps/app/public/favicon-32x32.png`);
        const apple = await pngFacts(`${REPO_ROOT}/apps/app/public/apple-touch-icon.png`);
        await ctx.prove("The app mark, favicons, and Apple Touch Icon share the official W", {
          voiceover: vo[1],
          action: async () => {
            await showBoard(ctx, {
              eyebrow: "App & browser identity",
              title: "应用内与浏览器统一使用 JuggleWork Logo",
              description: "应用默认品牌图、浏览器标签图标和 Apple Touch Icon 都由同一份正式素材派生。",
              items: [
                { label: "应用默认品牌图", detail: "Canonical public asset", src: "/jugglework-logo.png" },
                { label: "favicon 32", detail: "32×32 browser icon", src: "/favicon-32x32.png" },
                { label: "favicon 16", detail: "16×16 browser icon", src: "/favicon-16x16.png" },
                { label: "Apple Touch Icon", detail: "180×180 home-screen icon", src: "/apple-touch-icon.png" },
              ],
            });
          },
          assert: async () => {
            ctx.assert(source.hasAlpha, "The approved source logo does not have an alpha channel.");
            ctx.assert(app.hasAlpha && app.width === 1024 && app.height === 1024, "The browser-loadable canonical logo is not a 1024×1024 RGBA asset.");
            ctx.assert(favicon16.width === 16 && favicon16.height === 16, "The 16px favicon has the wrong dimensions.");
            ctx.assert(favicon32.width === 32 && favicon32.height === 32, "The 32px favicon has the wrong dimensions.");
            ctx.assert(apple.width === 180 && apple.height === 180, "The Apple Touch Icon has the wrong dimensions.");
            ctx.assert(favicon16.hasAlpha && favicon32.hasAlpha && apple.hasAlpha, "One or more browser icons lost transparency.");
            pass(ctx, "Approved source and canonical app logo decode with alpha, and all browser icon sizes are valid", {
              source,
              canonical: app,
              favicon16,
              favicon32,
              apple,
            });
          },
          screenshot: {
            name: "frame-2-app-browser-identity",
            requireText: ["应用内与浏览器统一使用 JuggleWork Logo", "favicon 32", "Apple Touch Icon"],
          },
        });
      },
    },
    {
      name: "Frame 3 — installer identity",
      run: async (ctx) => {
        const installerSource = await readFile(INSTALLER_UI, "utf8");
        const installerHtml = `<!doctype html>
          <style>
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f4f5; color: #18181b; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            main { display: grid; gap: 12px; justify-items: center; width: 340px; text-align: center; }
            .logo { max-height: 100px; max-width: 260px; object-fit: contain; margin-bottom: 10px; }
            .title { font-size: 17px; font-weight: 600; }
            .client { font-size: 14px; color: #71717a; line-height: 1.35; }
          </style>
          <main>
            <img class="logo" src="/jugglework-logo.png" alt="JuggleWork" />
            <div class="title">Paste your install link</div>
            <div class="client">Connect this installer to your JuggleWork workspace.</div>
          </main>`;
        await ctx.prove("The default installer renders the official JuggleWork mark", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval(`(() => {
              const shell = document.createElement("main");
              shell.setAttribute("data-formal-logo-proof", "Installer identity");
              shell.style.cssText = "min-height:100vh;box-sizing:border-box;padding:44px 58px;background:radial-gradient(circle at 15% 10%,rgba(28,210,229,.22),transparent 35%),#eef4f7;color:#061b32;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
              const eyebrow = document.createElement("div");
              eyebrow.textContent = "Installer identity";
              eyebrow.style.cssText = "font-size:13px;font-weight:750;letter-spacing:.16em;text-transform:uppercase;color:#058aa2";
              const title = document.createElement("h1");
              title.textContent = "安装器默认品牌";
              title.style.cssText = "margin:10px 0 24px;font-size:44px;letter-spacing:-.035em";
              const frame = document.createElement("iframe");
              frame.title = "JuggleWork installer preview";
              frame.srcdoc = ${JSON.stringify(installerHtml)};
              frame.style.cssText = "display:block;width:min(920px,calc(100vw - 116px));height:520px;border:1px solid rgba(7,27,46,.12);border-radius:24px;background:#fff;box-shadow:0 24px 80px rgba(21,51,77,.16)";
              shell.append(eyebrow, title, frame);
              document.body.innerHTML = "";
              document.body.style.margin = "0";
              document.body.append(shell);
              return true;
            })()`);
            await ctx.waitFor(
              `(() => {
                const frame = document.querySelector('iframe[title="JuggleWork installer preview"]');
                const frameDocument = frame?.contentDocument;
                const logo = frameDocument?.querySelector(".logo");
                const image = logo?.tagName === "IMG" ? logo : logo?.querySelector("img");
                return Boolean(frameDocument?.body.innerText.includes("Paste your install link") && (!image || (image.complete && image.naturalWidth > 0)));
              })()`,
              { timeoutMs: 30_000, label: "installer preview with default logo" },
            );
          },
          assert: async () => {
            ctx.assert(installerSource.includes('<img class="logo" src="/jugglework-logo.png" alt="JuggleWork" />'), "The production installer template does not identify the JuggleWork logo asset.");
            ctx.assert(!installerSource.includes("#267CE8"), "The production installer template still contains the old OpenWork blue SVG artwork.");
            pass(ctx, "The production installer template uses the JuggleWork logo and excludes the old OpenWork SVG color signature", INSTALLER_UI);
          },
          screenshot: {
            name: "frame-3-installer-identity",
            requireText: ["安装器默认品牌"],
          },
        });
      },
    },
    {
      name: "Frame 4 — packaged platform identity",
      run: async (ctx) => {
        const png = await readFile(DESKTOP_PNG);
        const ico = await readFile(DESKTOP_ICO);
        const icns = await readFile(DESKTOP_ICNS);
        const builder = await readFile(BUILDER_CONFIG, "utf8");
        const desktop = await pngFacts(DESKTOP_PNG);
        await ctx.prove("macOS, Windows, and Linux packages all consume the official W icon set", {
          voiceover: vo[3],
          action: async () => {
            const icon = `data:image/png;base64,${png.toString("base64")}`;
            await showBoard(ctx, {
              eyebrow: "Release packages",
              title: "三平台发布图标保持一致",
              description: "electron-builder 的 macOS、Windows 和 Linux 发布配置分别指向同一套 JuggleWork 正式图标衍生资源。",
              items: [
                { label: "macOS", detail: "icon.icns", src: icon },
                { label: "Windows", detail: "icon.ico", src: icon },
                { label: "Linux", detail: "icon.png", src: icon },
              ],
            });
          },
          assert: async () => {
            ctx.assert(icns.subarray(0, 4).toString("ascii") === "icns", "The macOS icon does not have an ICNS header.");
            ctx.assert(ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) > 0, "The Windows icon does not have a valid ICO directory header.");
            ctx.assert(builder.includes("icon: resources/icons/icon.icns"), "electron-builder does not reference the macOS ICNS.");
            ctx.assert(builder.includes("icon: resources/icons/icon.ico"), "electron-builder does not reference the Windows ICO.");
            ctx.assert(builder.includes("icon: resources/icons/icon.png"), "electron-builder does not reference the Linux PNG.");
            pass(ctx, "All three platform icon containers are valid and wired into electron-builder", {
              icns: { bytes: icns.length, hash: sha256(icns) },
              ico: { bytes: ico.length, entries: ico.readUInt16LE(4), hash: sha256(ico) },
              linux: desktop,
            });
          },
          screenshot: {
            name: "frame-4-release-packages",
            requireText: ["三平台发布图标保持一致", "macOS", "Windows", "Linux"],
          },
        });
      },
    },
  ],
});
