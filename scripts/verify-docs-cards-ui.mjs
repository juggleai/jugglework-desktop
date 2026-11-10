import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
  new URL("../apps/app/package.json", import.meta.url),
);
const { build } = createRequire(require.resolve("vite/package.json"))(
  "esbuild",
);
const { chromium } = require(process.env.JW_TEST_PLAYWRIGHT_MODULE);
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,useParams} from 'react-router-dom';
import {DocsNotificationBubble} from './apps/app/src/react-app/domains/jugglechat/docs-notification-bubble';
import {CloudDocsPage} from './apps/app/src/react-app/domains/cloud-docs/cloud-docs-page';
import {bindDocsMessage} from './apps/app/src/react-app/domains/jugglechat/docs-message';
const bot='jw_docs_'+ 'a'.repeat(32);
const message={messageId:'im-1',name:'jw:docs-notification',sender:{id:bot},conversationId:'group_a',conversationType:2,content:{contractVersion:1,eventId:'00000000-0000-4000-8000-000000000001',tenantId:'a',pageId:'page_1',commentId:'comment_1',kind:'comment.created',occurredAt:'2026-11-06T00:00:00Z',part:'group'}};
const scope={key:'a',tenantId:'a',server:'https://source.test/prefix',userId:'u',imUserId:'same',authFingerprint:'auth'};
const context={tenantId:'a',botIMUserId:bot,groupId:'group_a',groups:[{conversationId:'group_a',managed:true,currentTenant:true}]};
const bound=bindDocsMessage(message,scope,context);
window.fixture={settings:{baseUrl:scope.server,activeOrgId:'a',authToken:'auth'},valid:true,validations:[],launches:[],opens:[],closes:[],listeners:new Set(),toasts:[],hold:false};
window.__JUGGLEWORK_ELECTRON__={cloudDocs:{onState:fn=>{fixture.listeners.add(fn);return()=>fixture.listeners.delete(fn)},setBounds:()=>{},setAppearance:()=>{},open:async value=>{fixture.opens.push(value);fixture.listeners.forEach(fn=>fn({instanceId:value.instanceId,status:'ready'}))},close:async id=>fixture.closes.push(id)}};
function Docs(){const {tenantId}=useParams();return <CloudDocsPage tenantId={tenantId} workspaceId='fixture'/>}
function Cards(){return <main><section data-testid='bound'><DocsNotificationBubble message={bound}/></section><section data-testid='forwarded'><DocsNotificationBubble message={JSON.parse(JSON.stringify(bound))}/></section><section data-testid='unknown'><DocsNotificationBubble message={{...message,content:{...message.content,contractVersion:2}}}/></section></main>}
createRoot(document.getElementById('app')).render(<MemoryRouter><Routes><Route path='/' element={<Cards/>}/><Route path='/cloud-docs/:tenantId' element={<Docs/>}/></Routes></MemoryRouter>);`;
const mocks = {
  "@/app/lib/den": `export const readDenSettings=()=>fixture.settings;export const readDenUserId=()=> 'u';export const denCredentialFingerprint=v=>v;export const createDenClient=()=>({validateDocsCard:async value=>{fixture.validations.push(value);if(fixture.hold) await new Promise(resolve=>fixture.release=resolve);return {valid:fixture.valid}},launchCloudDocs:async value=>{fixture.launches.push(value);return {...value,launchGrant:'fixture',bootstrapUrl:'https://docs.test/bootstrap'}}});`,
  auth: `export const useDenAuth=()=>({user:{id:'u'},isSignedIn:true,activeOrganization:{id:fixture.settings.activeOrgId,name:'组织 '+fixture.settings.activeOrgId},organizations:[{id:'a',name:'组织 a'},{id:'b',name:'组织 b'}],switchOrganization:async id=>{fixture.settings.activeOrgId=id}});`,
  "@/i18n": `export {default as zh} from '@/i18n/locales/zh';import zh from '@/i18n/locales/zh';export const t=key=>zh[key]??key;export const currentLocale=()=> 'zh';export const subscribeLocale=()=>()=>{};`,
  "@/app/theme": `export const getResolvedThemeMode=()=>document.documentElement.dataset.theme??'light';export const subscribeToTheme=()=>()=>{};`,
  "@/react-app/shell/app-navigation-rail": `export const APP_NAVIGATION_RAIL_WIDTH=56;export const AppNavigationRail=()=>null;`,
  "@/react-app/shell/app-inset-surface": `export const AppInsetSurface=({children})=>children;`,
  "@/components/ui/button": `import React from 'react';export const Button=({children,variant,...props})=>React.createElement('button',props,children);`,
  sonner: `export const toast={error:message=>fixture.toasts.push(message)};`,
};
const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: "tsx" },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  tsconfig: resolve(root, "apps/app/tsconfig.json"),
  nodePaths: [resolve(root, "apps/app/node_modules")],
  plugins: [
    {
      name: "simulated-host",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.endsWith("den-auth-provider"))
            return { path: "auth", namespace: "fixture" };
          if (Object.hasOwn(mocks, args.path))
            return { path: args.path, namespace: "fixture" };
        });
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: mocks[args.path],
          loader: "js",
          resolveDir: root,
        }));
      },
    },
  ],
});
const css = await readFile(
  resolve(root, "apps/app/src/react-app/domains/jugglechat/jugglechat.css"),
  "utf8",
);
const server = createServer((req, res) => {
  if (req.url === "/component.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(bundle.outputFiles[0].text);
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(
    `<html><style>:root{--ui-text:#1c2024;--ui-text-secondary:#6b7280;--ui-text-muted:#6b7280;--ui-border:#ddd;--ui-surface:#fff;--ui-link:#2563eb}body{font-family:system-ui;background:var(--ui-surface);color:var(--ui-text)}[data-theme=dark]{--ui-text:#eee;--ui-text-secondary:#aaa;--ui-text-muted:#aaa;--ui-border:#444;--ui-surface:#18191b;--ui-link:#99bbff}${css}</style><body><div id='app'></div><script src='/component.js'></script></body></html>`,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath:
    process.env.JW_TEST_CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const checked = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 760 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const home = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByTestId("bound").getByRole("button").waitFor();
  };
  await home();
  assert.equal(
    await page.getByTestId("forwarded").getByRole("button").count(),
    0,
  );
  assert.equal(
    await page.getByTestId("unknown").getByRole("button").count(),
    0,
  );
  assert.equal(
    await page
      .locator("body")
      .innerText()
      .then((t) => t.includes("page_1") || t.includes("comment_1")),
    false,
  );
  checked.push("fixed-template-and-no-action-fallback");
  await page.evaluate(() => (fixture.hold = true));
  await page
    .getByTestId("bound")
    .getByRole("button")
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await page.waitForFunction(() => fixture.validations.length === 1);
  await page.evaluate(() => fixture.release());
  await page.waitForFunction(() => fixture.opens.length === 1);
  const launched = await page.evaluate(() => fixture.launches[0]);
  assert.deepEqual(launched.target, {
    kind: "page",
    pageId: "page_1",
    commentId: "comment_1",
  });
  assert.equal(launched.presentation.mode, "product");
  checked.push("repeated-click-single-fresh-product-handoff");
  await page.evaluate(() =>
    fixture.listeners.forEach((fn) =>
      fn({ instanceId: "old", status: "unauthorized" }),
    ),
  );
  assert.equal(
    await page.getByText("你没有此文档的访问权限，或文档已被删除").count(),
    0,
  );
  checked.push("old-native-instance-event-ignored");
  await page.evaluate(() =>
    fixture.listeners.forEach((fn) =>
      fn({ instanceId: fixture.opens[0].instanceId, status: "unauthorized" }),
    ),
  );
  await page.getByText("你没有此文档的访问权限，或文档已被删除").waitFor();
  checked.push("current-native-denial-visible");
  await home();
  await page.evaluate(() => {
    fixture.hold = true;
  });
  await page.getByTestId("bound").getByRole("button").click();
  await page.waitForFunction(() => fixture.validations.length === 1);
  await page.evaluate(() => {
    fixture.settings.activeOrgId = "b";
    fixture.release();
  });
  await page.waitForFunction(() => fixture.toasts.length === 1);
  assert.equal(await page.evaluate(() => fixture.launches.length), 0);
  checked.push("late-validation-after-org-switch-no-handoff");
  await home();
  await page.evaluate(() => (fixture.valid = false));
  await page.getByTestId("bound").getByRole("button").click();
  await page.waitForFunction(() => fixture.toasts.length === 1);
  assert.equal(await page.evaluate(() => fixture.launches.length), 0);
  checked.push("invalid-delivery-no-handoff");
  await home();
  const output = process.env.JW_TEST_SCREENSHOT_DIR;
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, "docs-card-light.png") });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  assert.equal(
    await page
      .locator(".jw-docs-card")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(238, 238, 238)",
  );
  if (output)
    await page.screenshot({ path: resolve(output, "docs-card-dark.png") });
  checked.push("host-theme-card-colors");
  assert.deepEqual(errors, []);
  const report = {
    verifiedAt: new Date().toISOString(),
    passed: true,
    component: "actual-desktop-bubble-and-cloud-docs-page",
    provider: "simulated-source-and-electron-host",
    checked,
    realElectron: false,
    fullMilestone4Passed: false,
  };
  if (process.env.JW_TEST_REPORT_PATH)
    await writeFile(
      process.env.JW_TEST_REPORT_PATH,
      JSON.stringify(report, null, 2) + "\n",
    );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
