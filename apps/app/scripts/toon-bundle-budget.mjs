import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../dist/assets/", import.meta.url);
const files = await readdir(root);
const modules = files.filter((name) => /toon|xyflow|codemirror/i.test(name) && /\.(?:js|css)$/.test(name));
const bytes = (await Promise.all(modules.map(async (name) => gzipSync(await readFile(join(root.pathname, name))).byteLength))).reduce((sum, value) => sum + value, 0);
const threshold = 650 * 1024;
console.log(JSON.stringify({ metric: "toon-lazy-bundle-gzip", bytes, threshold, modules }, null, 2));
if (!modules.length) throw new Error("No lazy Toon workspace bundle chunks were found in dist/assets");
if (bytes > threshold) throw new Error(`Toon lazy bundle exceeds ${threshold} gzip bytes`);
