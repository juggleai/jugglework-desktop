// Serve (dev) and emit (build) Excalidraw's bundled fonts under
// /whiteboard-assets/ so the whiteboard never falls back to its esm.sh CDN.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

export const WHITEBOARD_ASSET_BASE = "whiteboard-assets";

export function excalidrawFontsDir(fromDir: string): string {
  // package.json is not in the package's exports map; the main entry lives in dist/prod.
  const require = createRequire(join(fromDir, "package.json"));
  const entry = require.resolve("@excalidraw/excalidraw");
  const fonts = join(dirname(entry), "fonts");
  if (!existsSync(fonts)) throw new Error(`Excalidraw fonts not found: ${fonts}`);
  return fonts;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

export function whiteboardAssetsPlugin(appRoot: string): Plugin {
  const fonts = excalidrawFontsDir(appRoot);
  const prefix = `/${WHITEBOARD_ASSET_BASE}/fonts/`;
  return {
    name: "jugglework-whiteboard-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith(prefix)) return next();
        const file = resolve(fonts, decodeURIComponent(url.slice(prefix.length)));
        if (!file.startsWith(fonts + sep) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", file.endsWith(".woff2") ? "font/woff2" : "application/octet-stream");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const file of listFiles(fonts)) {
        this.emitFile({
          type: "asset",
          fileName: `${WHITEBOARD_ASSET_BASE}/fonts/${relative(fonts, file).split(sep).join("/")}`,
          source: readFileSync(file),
        });
      }
    },
  };
}
