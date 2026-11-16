import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXPECTED_OPENCODE_PLUGIN_BUNDLES = [
  "jugglework-anthropic-adaptive-thinking.js",
  "jugglework-anthropic-tool-schema.js",
  "jugglework-capabilities-knowledge.js",
  "jugglework-confirmation-gate.js",
  "jugglework-context-overflow.js",
  "jugglework-extensions-preview.js",
  "jugglework-mcp-workspace-policy.js",
  "jugglework-office-attachments.js",
  "jugglework-safe-grep.js",
  "jugglework-screenshot-history.js",
];

const ALLOWED_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.startsWith("node:") ? name : `node:${name}`),
  "bun",
  "bun:ffi",
  "bun:jsc",
  "bun:sqlite",
  "bun:test",
  "bun:wrap",
]);

function portableRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function importedSpecifiers(source) {
  const matches = source.matchAll(
    /(?:\b(?:import|export)\s+(?:[^"']*?\s+from\s*)?|\bimport\s*\(\s*)["']([^"']+)["']/g,
  );
  return [...matches].map((match) => match[1]);
}

function assertStaticallyResolvable(source, fileName) {
  if (/\bimport\s*\(\s*(?!["'])/.test(source) || /\brequire\s*\(/.test(source)) {
    throw new Error(`OpenCode plugin ${fileName} contains a dependency that cannot be statically verified`);
  }
  if (/(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=/.test(source)) {
    throw new Error(`OpenCode plugin ${fileName} contains a source map reference`);
  }
}

function listReleaseFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else files.push(portableRelative(root, filePath));
    }
  };
  visit(root);
  return files.sort();
}

function assertInsideRoot(root, candidate, diagnosticName) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`OpenCode plugin import escapes the bundle directory: ${diagnosticName}`);
  }
}

export function verifyOpenCodePluginBundles(directory) {
  const requestedRoot = path.resolve(directory);
  if (!existsSync(requestedRoot)) throw new Error("OpenCode plugin bundle directory is missing");
  const root = realpathSync(requestedRoot);
  const releaseFiles = listReleaseFiles(root);
  const sourceMaps = releaseFiles.filter((fileName) => fileName.endsWith(".map"));
  if (sourceMaps.length > 0) {
    throw new Error(`OpenCode plugin bundles contain source maps: ${sourceMaps.join(", ")}`);
  }

  const verified = [];
  const visited = new Set();
  const verifyFile = (fileName) => {
    const filePath = path.resolve(root, fileName);
    assertInsideRoot(root, filePath, fileName);
    const relativeFileName = portableRelative(root, filePath);
    if (visited.has(relativeFileName)) return;
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new Error(`OpenCode plugin bundle is missing: ${relativeFileName}`);
    }
    const realFilePath = realpathSync(filePath);
    assertInsideRoot(root, realFilePath, relativeFileName);
    visited.add(relativeFileName);
    const source = readFileSync(realFilePath, "utf8");
    assertStaticallyResolvable(source, relativeFileName);
    const specifiers = importedSpecifiers(source);
    const rejectedImports = [...new Set(specifiers.filter((specifier) =>
      !specifier.startsWith("./") && !specifier.startsWith("../") && !ALLOWED_BUILTINS.has(specifier),
    ))];
    if (rejectedImports.length > 0) {
      throw new Error(
        `OpenCode plugin ${relativeFileName} is not self-contained; bare imports: ${rejectedImports.join(", ")}`,
      );
    }
    for (const specifier of new Set(specifiers.filter(
      (candidate) => candidate.startsWith("./") || candidate.startsWith("../"),
    ))) {
      const importedPath = path.resolve(path.dirname(realFilePath), specifier);
      assertInsideRoot(root, importedPath, `${relativeFileName} -> ${specifier}`);
      if (!existsSync(importedPath)) {
        throw new Error(`OpenCode plugin ${relativeFileName} references missing bundled chunk: ${specifier}`);
      }
      verifyFile(portableRelative(root, importedPath));
    }
    verified.push({ fileName: relativeFileName, bytes: Buffer.byteLength(source) });
  };

  for (const fileName of EXPECTED_OPENCODE_PLUGIN_BUNDLES) verifyFile(fileName);
  const unexpectedJavaScript = releaseFiles.filter((fileName) => fileName.endsWith(".js") && !visited.has(fileName));
  if (unexpectedJavaScript.length > 0) {
    throw new Error(`OpenCode plugin directory contains unreferenced JavaScript: ${unexpectedJavaScript.join(", ")}`);
  }
  return { directory: ".", verified: verified.sort((a, b) => a.fileName.localeCompare(b.fileName)) };
}

function readDirectoryArg() {
  const inline = process.argv.find((entry) => entry.startsWith("--dir="));
  if (inline) return inline.slice("--dir=".length);
  const index = process.argv.indexOf("--dir");
  if (index >= 0) return process.argv[index + 1];
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/opencode-plugins");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...verifyOpenCodePluginBundles(readDirectoryArg()) }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
