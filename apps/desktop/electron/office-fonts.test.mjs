import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOfficeFonts } from "./office-fonts.mjs";

const bytes = Buffer.from("wOFFfont-fixture");
const entry = {
  kind: "font",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  url: "https://fonts.example.test/font.woff",
  mime: "font/woff",
};
async function fixture(t, fetch, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "office-fonts-中文 "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    fonts: createOfficeFonts({
      directory,
      assetsDirectory: directory,
      entries: [entry],
      fetch,
      ...options,
    }),
  };
}

test("cold network fetch pins bytes without forwarding document credentials; warm cache survives restart and offline", async (t) => {
  let calls = 0;
  const { fonts, directory } = await fixture(t, async (url, options) => {
    calls++;
    assert.equal(url, entry.url);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { Accept: "font/woff" });
    return new Response(bytes);
  });
  assert.deepEqual((await fonts.resolve(entry)).bytes, bytes);
  await fonts.setOnline(false);
  const restarted = createOfficeFonts({
    directory,
    assetsDirectory: directory,
    entries: [entry],
    fetch: () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(await restarted.settings(), { online: false });
  assert.deepEqual((await restarted.resolve(entry)).bytes, bytes);
  assert.equal(calls, 1);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [`${entry.sha256}.font`, "settings.json"].sort(),
  );
});

test("corrupt cache is removed and cold offline lookup fails without fetching", async (t) => {
  const { fonts, directory } = await fixture(t, () =>
    assert.fail("must not download"),
  );
  await writeFile(path.join(directory, `${entry.sha256}.font`), "damaged");
  await fonts.setOnline(false);
  assert.equal((await fonts.resolve(entry)).error, "offline");
  assert.deepEqual(await readdir(directory), ["settings.json"]);
});

test("malformed preferences keep verified local fonts usable and do not re-enable online", async (t) => {
  const { fonts, directory } = await fixture(t, () =>
    assert.fail("must remain offline"),
  );
  await writeFile(path.join(directory, "settings.json"), "broken-json");
  await writeFile(path.join(directory, `${entry.sha256}.font`), bytes);
  assert.deepEqual(await fonts.settings(), { online: false });
  assert.deepEqual((await fonts.resolve(entry)).bytes, bytes);
});

test("startup removes only its own interrupted download files", async (t) => {
  const { fonts, directory } = await fixture(t, () =>
    assert.fail("no download"),
  );
  await writeFile(
    path.join(directory, `${entry.sha256}.${randomUUID()}.tmp`),
    "partial",
  );
  await writeFile(
    path.join(directory, `settings.${randomUUID()}.tmp`),
    "partial",
  );
  await writeFile(path.join(directory, "other.tmp"), "preserve");
  await fonts.settings();
  assert.deepEqual(await readdir(directory), ["other.tmp"]);
});

test("cache budget evicts old completed files while retaining the response being downloaded", async (t) => {
  const { fonts, directory } = await fixture(
    t,
    async () => new Response(bytes),
    { budget: bytes.length },
  );
  const old = `${"a".repeat(64)}.font`;
  await writeFile(path.join(directory, old), bytes);
  assert.ok((await fonts.resolve(entry)).bytes);
  assert.deepEqual(await readdir(directory), [`${entry.sha256}.font`]);
});

test("invalid bytes and oversized streaming responses never enter cache", async (t) => {
  for (const payload of [
    Buffer.from("wOFFwrong-byte!"),
    Buffer.concat([bytes, bytes]),
  ]) {
    const { fonts, directory } = await fixture(
      t,
      async () => new Response(payload),
    );
    assert.equal((await fonts.resolve(entry)).error, "unavailable");
    assert.deepEqual(await readdir(directory), []);
  }
});

test("timeout, document cancellation and disabling online abort downloads without temporary files", async (t) => {
  for (const mode of ["timeout", "cancel", "disable"]) {
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const { fonts, directory } = await fixture(
      t,
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
          started();
        }),
      { timeoutMs: 30 },
    );
    const controller = new AbortController();
    const pending = fonts.resolve(entry, controller.signal);
    await ready;
    if (mode === "cancel") controller.abort();
    if (mode === "disable") await fonts.setOnline(false);
    assert.ok((await pending).error);
    assert.equal(
      (await readdir(directory)).some(
        (name) => name.endsWith(".tmp") || name.endsWith(".font"),
      ),
      false,
    );
  }
});

test("bundled font has priority and cache filenames never use font names or URLs", async (t) => {
  const { fonts, directory } = await fixture(t, () =>
    assert.fail("must use bundled font"),
  );
  const bundled = {
    ...entry,
    fontId: "CON:微软雅黑/<>?*",
    file: "bundled.font",
  };
  await writeFile(path.join(directory, "bundled.font"), bytes);
  assert.deepEqual((await fonts.resolve(bundled)).bytes, bytes);
  assert.deepEqual(await readFile(path.join(directory, "bundled.font")), bytes);
});
