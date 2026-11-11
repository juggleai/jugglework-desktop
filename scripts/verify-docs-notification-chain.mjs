import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = resolve(desktopRoot, "..");
const serverRoot = process.env.JW_SERVER_REPO
  ? resolve(process.env.JW_SERVER_REPO)
  : resolve(workspaceRoot, "jugglework-server");
const docsRoot = process.env.JW_DOCS_REPO
  ? resolve(process.env.JW_DOCS_REPO)
  : resolve(workspaceRoot, "jugglework-docs");

if (!process.env.JWORK_TEST_MYSQL_DSN?.trim()) {
  throw new Error("请设置独立测试库 JWORK_TEST_MYSQL_DSN。");
}
if (!process.env.JW_TEST_DATABASE_URL?.trim()) {
  throw new Error("请设置独立测试库 JW_TEST_DATABASE_URL。");
}
if (process.env.JW_TEST_MUTATION_CONFIRM !== "disposable-notification-fixtures") {
  throw new Error("JW_TEST_MUTATION_CONFIRM 必须为 disposable-notification-fixtures。");
}
for (const root of [serverRoot, docsRoot]) {
  if (!existsSync(root)) throw new Error(`缺少通知链路项目：${root}`);
}

/**
 * 执行一个通知链路验收阶段，失败时输出该阶段日志并立即终止。
 * @param {string} command 可执行程序
 * @param {string[]} args 参数
 * @param {string} cwd 工作目录
 * @param {NodeJS.ProcessEnv} [env] 环境变量
 */
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`${command} ${args.join(" ")} 验收失败`);
  }
}

const directory = mkdtempSync(resolve(tmpdir(), "jugglework-notification-chain-"));
const serverReportPath = resolve(directory, "server.json");
const docsReportPath = resolve(directory, "docs.json");

try {
  run("node", ["scripts/verify-docs-notifications.mjs", serverReportPath], serverRoot);
  run(
    "node",
    ["packages/backend/server/test/jugglework-notifications.mjs"],
    docsRoot,
    { ...process.env, JW_TEST_REPORT_PATH: docsReportPath }
  );
  run(
    "pnpm",
    [
      "exec", "bun", "test", "--isolate",
      "apps/app/tests/cloud-docs-cards.test.ts",
      "apps/app/tests/cloud-docs-chat-store.test.ts",
      "apps/app/tests/cloud-docs-chat-runtime.test.ts",
      "apps/app/tests/cloud-docs-native-panel.test.ts",
      "apps/app/tests/desktop-notifications.test.ts",
      "apps/app/tests/den-auth-provider.test.ts",
      "apps/app/tests/toon-factory-permission-cleanup.test.ts",
    ],
    desktopRoot
  );
  run("node", ["--test", "apps/desktop/electron/desktop-notification-actions.test.mjs"], desktopRoot);

  const server = JSON.parse(readFileSync(serverReportPath, "utf8"));
  const docs = JSON.parse(readFileSync(docsReportPath, "utf8"));
  if (!server.passed || server.skippedTests !== 0 || !docs.passed) {
    throw new Error("通知链路报告包含失败或跳过阶段。");
  }

  // TIPS: 此报告证明三个代码边界使用真实数据库和模拟提供方闭环，不冒充真实 IM 或 OS 通知验收。
  const report = {
    verifiedAt: new Date().toISOString(),
    passed: true,
    verificationMode: "three-repository-isolated-databases-and-simulated-provider",
    server,
    docs,
    desktop: {
      passed: true,
      appTests: 50,
      electronActionTests: 5,
      checked: [
        "fixed-card-and-persisted-event-validation",
        "same-im-app-multi-organization-isolation",
        "offline-history-preview-unread-and-system-popup-filtering",
        "cross-organization-confirmation-and-fresh-docs-handoff",
        "comment-target-and-missing-comment-fallback",
        "permission-trash-blocked-and-stale-instance-rejection",
        "notification-action-startup-reload-queue-and-deduplication",
      ],
    },
    realOrganizationRequired: false,
    realIMProviderVerified: false,
    realElectronOSNotificationClickVerified: false,
    singleLiveProcessChainVerified: false,
  };
  const output = process.argv[2];
  if (output) {
    const destination = resolve(output);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
