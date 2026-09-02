import { builtinModules } from "node:module";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const entryPoint = path.join(repoRoot, "packages", "jugglework-ui-mcp", "index.mjs");
const outputDirectory = path.join(desktopRoot, "resources", "jugglework-ui-mcp");
const temporaryDirectory = `${outputDirectory}.tmp-${process.pid}`;
const outputFile = path.join(temporaryDirectory, "index.mjs");
const allowedExternalImports = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export async function prepareJuggleWorkUiMcp({
  input = entryPoint,
  output = outputDirectory,
} = {}) {
  const temp = output === outputDirectory ? temporaryDirectory : `${output}.tmp-${process.pid}`;
  const outfile = path.join(temp, "index.mjs");
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });

  try {
    const result = await build({
      entryPoints: [input],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      minify: true,
      sourcemap: false,
      legalComments: "none",
      metafile: true,
      logLevel: "info",
    });

    const generated = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]];
    const unresolved = (generated?.imports ?? [])
      .filter((item) => item.external && !allowedExternalImports.has(item.path))
      .map((item) => item.path);
    if (unresolved.length > 0) {
      throw new Error(`UI control MCP bundle has unresolved runtime imports: ${unresolved.join(", ")}`);
    }

    const source = await readFile(outfile, "utf8");
    if (!source.includes("jugglework-ui")) {
      throw new Error("UI control MCP bundle does not contain the expected server identity.");
    }

    await rm(output, { recursive: true, force: true });
    await rename(temp, output);
    return { entryPoint: input, outputFile: path.join(output, "index.mjs"), bytes: Buffer.byteLength(source) };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareJuggleWorkUiMcp();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
