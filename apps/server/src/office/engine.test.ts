import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficeEngine } from "./engine.js";

test("多平台源码资源按当前平台清单加载，不能使用根目录其他平台的清单", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-manifest-"));
  const platform = `${process.platform}-${process.arch}`;
  try {
    await mkdir(join(root, platform), { recursive: true });
    await mkdir(join(root, "wrapper/lib/common"), { recursive: true });
    await writeFile(join(root, platform, ".editor-sdk-version"), "0.0.0.499");
    await writeFile(join(root, platform, "editor_sdk"), "fixture");
    await writeFile(
      join(root, "wrapper/lib/common/tencent-docs-service.js"),
      "fixture",
    );
    const manifest = {
      schema: 1,
      platform,
      wrapperVersion: "0.2.196-wb",
      engineVersion: "0.0.0.499",
      binary: `${platform}/editor_sdk`,
      wrapper: "wrapper/lib/common/tencent-docs-service.js",
    };
    await writeFile(
      join(root, "version.json"),
      JSON.stringify({ ...manifest, platform: "other" }),
    );
    await writeFile(
      join(root, platform, "version.json"),
      JSON.stringify(manifest),
    );
    const engine = new OfficeEngine({
      resourceDirectory: root,
      logDirectory: join(root, "logs"),
    });
    expect(await engine.capabilities()).toMatchObject({
      available: true,
      engineVersion: "0.0.0.499",
    });
    await writeFile(join(root, platform, "version.json"), "invalid JSON");
    expect(await engine.capabilities()).toMatchObject({ available: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("缺少本地资源时报告不可用，启动失败且不尝试安装 SDK", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-resource-"));
  try {
    const engine = new OfficeEngine({
      resourceDirectory: root,
      logDirectory: join(root, "logs"),
    });
    expect(await engine.capabilities()).toMatchObject({
      available: false,
      formats: [],
    });
    await expect(engine.ensureStarted()).rejects.toThrow("尚未配置");
    await engine.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("其他平台或不匹配的配套版本不会启用编辑", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-platform-"));
  try {
    const engine = new OfficeEngine({
      resourceDirectory: root,
      logDirectory: join(root, "logs"),
    });
    await writeFile(
      join(root, "version.json"),
      JSON.stringify({ schema: 1, platform: "other-platform" }),
    );
    expect(await engine.capabilities()).toMatchObject({
      available: false,
      reason: "缺少当前平台的 Office 引擎资源",
    });
    await writeFile(
      join(root, "version.json"),
      JSON.stringify({
        schema: 1,
        platform: `${process.platform}-${process.arch}`,
        engineVersion: "unverified",
        wrapperVersion: "other",
      }),
    );
    expect(await engine.capabilities()).toMatchObject({
      available: false,
      reason: "Office 引擎版本尚未适配",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
