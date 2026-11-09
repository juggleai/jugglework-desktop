import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WS = require("ws");
const fs = require("fs");
const clients = [];
const results = [];
const output =
  process.env.MEETING_QA_OUTPUT_DIR || "/tmp/jugglework-meeting-qa-evidence";
fs.mkdirSync(output, { recursive: true });
async function connect(port, choose) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find(choose);
  if (!t) throw Error("target absent");
  const ws = new WS(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let n = 0;
  const pending = new Map();
  ws.on("message", (s) => {
    const x = JSON.parse(s);
    if (x.id) {
      pending.get(x.id)?.(x);
      pending.delete(x.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++n;
      const timer = setTimeout(() => rej(Error("CDP timed out")), 10000);
      pending.set(id, (x) => {
        clearTimeout(timer);
        res(x);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const c = {
    ws,
    call,
    async eval(expression) {
      const r = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.error || r.result?.exceptionDetails) throw Error(JSON.stringify(r));
      return r.result.result.value;
    },
  };
  clients.push(c);
  return c;
}
const main = await connect(9837, (t) =>
  t.url.includes("meeting-electron/index.html"),
);
const native = await connect(9237, () => true);
await native.eval(
  "globalThis.qaElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron')",
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, desc) {
  for (let i = 0; i < 35; i++) {
    if (await fn()) return;
    await sleep(150);
  }
  throw Error("timeout: " + desc);
}
const nativeClose = () =>
  native.eval(
    "qaElectron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='about:blank').close()",
  );
const click = (c, label) =>
  c.eval(
    `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('missing button');b.click()})()`,
  );
const snapshot = () => main.eval("__meetingQA.state()");
async function shot(c, name) {
  const r = await c.call("Page.captureScreenshot");
  fs.writeFileSync(
    output + "/" + name + ".png",
    Buffer.from(r.result.data, "base64"),
  );
}
async function start(role) {
  await main.eval(`__meetingQA.start('${role}')`);
  await until(async () => (await snapshot()).phase === "joined", "join");
  return connect(9837, (t) => t.url === "about:blank");
}
async function ended(label) {
  await until(async () => (await snapshot()).phase === "idle", "exit");
  const state = await snapshot();
  if (state.tracks.some((t) => t.state !== "ended") || state.chatLeft !== 1)
    throw Error("media/chat cleanup failed " + JSON.stringify(state));
  await until(
    async () =>
      await native.eval(
        "qaElectron.BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()==='about:blank').length===0",
      ),
    "native close",
  );
  results.push({ case: label, pass: true, state });
}
try {
  await until(() => main.eval("!!window.__meetingQA"), "fixture ready");
  await main.eval(
    "document.querySelectorAll('main button').forEach(b=>b.disabled=true);__meetingQA.failNext=false",
  );
  await main.eval(
    "(async()=>{const s=await import('/src/react-app/domains/meeting/store.ts');await s.useMeetingStore.getState().leave(true)})()",
  );
  await sleep(500);
  let child = await start("member");
  await nativeClose();
  await until(
    () => child.eval("!!document.querySelector('[role=dialog]')"),
    "member dialog",
  );
  if (await child.eval("document.body.innerText.includes('确认全员结束')"))
    throw Error("member sees end");
  await shot(child, "meeting-member-close");
  await click(child, "继续会议");
  if ((await snapshot()).phase !== "joined") throw Error("cancel left meeting");
  results.push({ case: "member native close and cancel", pass: true });
  await nativeClose();
  await until(
    () => child.eval("!!document.querySelector('[role=dialog]')"),
    "member dialog again",
  );
  await click(child, "仅自己离开");
  await ended("member confirmed leave");
  child = await start("host");
  await nativeClose();
  await until(
    () => child.eval("document.body.innerText.includes('确认全员结束')"),
    "host choices",
  );
  await shot(child, "meeting-host-close");
  await main.eval("__meetingQA.failNext=true");
  await click(child, "仅自己离开");
  await until(
    () => child.eval("document.body.innerText.includes('测试：服务暂不可用')"),
    "failure displayed",
  );
  if ((await snapshot()).phase !== "joined") throw Error("failed exit closed");
  results.push({ case: "failed exit retains confirmation/window", pass: true });
  await click(child, "继续会议");
  await click(child, "返回工作台");
  await until(
    () =>
      native.eval(
        "qaElectron.BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('meeting-electron/index.html')&&w.isFocused())",
      ),
    "main focused",
  );
  await until(
    () => main.eval("!!document.querySelector('.meeting-float')"),
    "floating main",
  );
  await shot(main, "meeting-main-float");
  await main.eval(
    "document.querySelector('.meeting-float button[aria-label=静音]').click()",
  );
  await until(
    () =>
      main.eval(
        "!!document.querySelector('.meeting-float button[aria-label=解除静音]')",
      ),
    "float mute",
  );
  results.push({
    case: "return to main floating preview and mic control",
    pass: true,
  });
  await main.eval("document.querySelector('.float-preview').click()");
  await until(
    () => main.eval("!document.querySelector('.meeting-float')"),
    "return meeting",
  );
  await until(
    () =>
      native.eval(
        "qaElectron.BrowserWindow.getAllWindows().some(w=>w.webContents.getURL()==='about:blank'&&w.isFocused()&&w.isVisible())",
      ),
    "native meeting focused",
  );
  results.push({
    case: "native focus restores meeting from floating preview",
    pass: true,
  });
  await nativeClose();
  await until(
    () => child.eval("!!document.querySelector('[role=dialog]')"),
    "host leave dialog",
  );
  await click(child, "仅自己离开");
  await ended("host only leave");
  child = await start("host");
  await nativeClose();
  await until(
    () => child.eval("!!document.querySelector('[role=dialog]')"),
    "host end dialog",
  );
  await click(child, "确认全员结束");
  await ended("host end everyone");
  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(output + "/results.json", JSON.stringify(results, null, 2));
} catch (e) {
  console.error(e);
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} finally {
  await main
    .eval(
      "document.querySelectorAll('main button').forEach(b=>b.disabled=false)",
    )
    .catch(() => {});
  clients.forEach((c) => c.ws.close());
}
