import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import WebSocket from "ws";

const port = 5198;
const debugPort = 9829;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const resultPath = resolve("tests/artifacts/toon-browser-performance.json");
const server = spawn("pnpm", ["vite", "--host", "127.0.0.1", "--port", String(port)], { stdio: "ignore" });
const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${debugPort}`, `http://127.0.0.1:${port}/toon-performance.html`], { stdio: "ignore" });
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function target() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      const page = pages.find((entry) => entry.type === "page" && entry.url.includes("toon-performance.html"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error("Chrome performance target did not start");
}

function connect(url) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    let sequence = 0;
    const pending = new Map();
    socket.on("open", () => resolveConnect({
      close: () => socket.close(),
      send(method, params = {}) {
        const id = ++sequence;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolveSend, rejectSend) => pending.set(id, { resolve: resolveSend, reject: rejectSend }));
      },
    }));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      const callbacks = pending.get(message.id);
      if (!callbacks) return;
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message)); else callbacks.resolve(message.result);
    });
    socket.on("error", reject);
  });
}

try {
  const cdp = await connect(await target());
  await cdp.send("Runtime.enable");
  await cdp.send("Performance.enable");
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
    const value = await cdp.send("Runtime.evaluate", { expression: "Boolean(window.__toonPerf)", returnByValue: true });
    ready = value.result.value === true;
    if (!ready) await sleep(50);
  }
  if (!ready) throw new Error("ReactFlow harness did not become ready");
  const measuredZoom = await cdp.send("Runtime.evaluate", { expression: "window.__toonPerf.runZoom()", awaitPromise: true, returnByValue: true });
  const measuredDrag = await cdp.send("Runtime.evaluate", { expression: "window.__toonPerf.runDrag()", awaitPromise: true, returnByValue: true });
  const info = await cdp.send("Runtime.evaluate", { expression: "({mountedAt:window.__toonPerf.mountedAt,readyAt:window.__toonPerf.readyAt,nodeCount:window.__toonPerf.nodeCount,edgeCount:window.__toonPerf.edgeCount,domNodes:document.getElementsByTagName('*').length,renderedNodes:document.querySelectorAll('.react-flow__node').length,renderedEdges:document.querySelectorAll('.react-flow__edge').length,heap:performance.memory?.usedJSHeapSize??null})", returnByValue: true });
  const zoomSamples = measuredZoom.result.value.sort((left, right) => left - right);
  const dragSamples = measuredDrag.result.value.sort((left, right) => left - right);
  const summary = { ...info.result.value, firstPaintMs: info.result.value.readyAt - info.result.value.mountedAt, zoomFrameP95Ms: zoomSamples[Math.ceil(zoomSamples.length * 0.95) - 1], dragFrameP95Ms: dragSamples[Math.ceil(dragSamples.length * 0.95) - 1], thresholds: { frameP95Ms: 20, domNodes: 12_000, heapBytes: 128 * 1024 * 1024 } };
  summary.passed = summary.zoomFrameP95Ms < summary.thresholds.frameP95Ms && summary.dragFrameP95Ms < summary.thresholds.frameP95Ms && summary.domNodes < summary.thresholds.domNodes && (summary.heap === null || summary.heap < summary.thresholds.heapBytes);
  await mkdir(resolve("tests/artifacts"), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  cdp.close();
  if (!summary.passed) process.exitCode = 1;
} finally {
  browser.kill("SIGTERM");
  server.kill("SIGTERM");
}
