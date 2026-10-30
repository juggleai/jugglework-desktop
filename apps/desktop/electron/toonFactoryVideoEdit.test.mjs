import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { mediaRun, verifyMediaTools } from "./mediaTools.mjs";
import { createToonFactoryVideoEditor, publishVideoEditFiles } from "./toonFactoryVideoEdit.mjs";

async function publicationFixture(t, multi) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "video-edit-publication-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const temporary = await fs.mkdtemp(path.join(root, ".videoEdit-"));
  await fs.mkdir(path.join(root, "outputs"));
  const names = multi ? ["video.mp4", "audio.m4a", "manifest.json"] : ["result.mp4"];
  const files = names.map(source => ({ source, output: `outputs/${source}` }));
  const contents = names.map(name => Buffer.from(`staged ${name}`));
  await Promise.all(files.map((file, index) => fs.writeFile(path.join(temporary, file.source), contents[index])));
  const controller = new AbortController();
  const reason = new Error("cancel at a controlled await boundary");
  const dependencies = { lstat: fs.lstat, realpath: fs.realpath, link: fs.link, stat: fs.stat, rm: fs.rm, unlink: fs.unlink };
  const state = { granted: true };
  const publish = () => publishVideoEditFiles({ root, temporary, files, signal: controller.signal, isDirectoryGranted: () => state.granted }, dependencies);
  const output = index => path.join(root, files[index].output);
  const assertEmpty = async () => assert.deepEqual(await fs.readdir(path.join(root, "outputs")), []);
  return { root, temporary, files, contents, controller, reason, dependencies, state, publish, output, assertEmpty };
}

for (const multi of [false, true]) {
  describe(multi ? "multi-file operation publication" : "export publication", () => {
    it("commits complete files and sizes, and removes staging before resolving", async t => {
      const h = await publicationFixture(t, multi);
      assert.deepEqual(await h.publish(), h.contents.map(content => content.length));
      for (let index = 0; index < h.files.length; index++) assert.deepEqual(await fs.readFile(h.output(index)), h.contents[index]);
      await assert.rejects(fs.stat(h.temporary), { code: "ENOENT" });
    });

    it("cancels during final projectPath await before the final link, rolling back earlier links", async t => {
      const h = await publicationFixture(t, multi);
      let paths = 0, links = 0;
      t.mock.method(h.dependencies, "realpath", async value => {
        const result = await fs.realpath(value);
        if (++paths === h.files.length) h.controller.abort(h.reason);
        return result;
      });
      t.mock.method(h.dependencies, "link", async (source, target) => { links++; await fs.link(source, target); });
      await assert.rejects(h.publish(), error => error === h.reason);
      assert.equal(paths, h.files.length);
      assert.equal(links, h.files.length - 1, "no link is started after cancellation");
      await h.assertEmpty();
    });

    for (const position of new Set([0, multi ? 2 : 0])) {
      it(`cancels while link ${position + 1} is completing and removes that link too`, async t => {
        const h = await publicationFixture(t, multi);
        let links = 0, stats = 0;
        t.mock.method(h.dependencies, "link", async (source, target) => {
          await fs.link(source, target);
          if (links++ === position) h.controller.abort(h.reason);
        });
        t.mock.method(h.dependencies, "stat", async target => { stats++; return fs.stat(target); });
        await assert.rejects(h.publish(), error => error === h.reason);
        assert.equal(links, position + 1);
        assert.equal(stats, position, "cancelled link is tracked before another await");
        await h.assertEmpty();
      });

      it(`rolls back on stat failure after link ${position + 1}`, async t => {
        const h = await publicationFixture(t, multi);
        const failure = Object.assign(new Error("post-link stat failed"), { code: "EIO" });
        let stats = 0;
        t.mock.method(h.dependencies, "stat", async target => {
          if (stats++ === position) throw failure;
          return fs.stat(target);
        });
        await assert.rejects(h.publish(), error => error === failure);
        assert.equal(stats, position + 1);
        await h.assertEmpty();
      });
    }

    it("cancels during final stat instead of returning a published result", async t => {
      const h = await publicationFixture(t, multi);
      let stats = 0;
      t.mock.method(h.dependencies, "stat", async target => {
        const result = await fs.stat(target);
        if (++stats === h.files.length) h.controller.abort(h.reason);
        return result;
      });
      await assert.rejects(h.publish(), error => error === h.reason);
      assert.equal(stats, h.files.length);
      await h.assertEmpty();
    });

    for (const boundary of ["path", "link"]) {
      it(`rolls back earlier files if the final ${boundary} await fails`, async t => {
        const h = await publicationFixture(t, multi);
        const failure = Object.assign(new Error(`${boundary} failed`), { code: "EIO" });
        let calls = 0;
        if (boundary === "path") t.mock.method(h.dependencies, "realpath", async value => {
          if (++calls === h.files.length) throw failure;
          return fs.realpath(value);
        });
        else t.mock.method(h.dependencies, "link", async (source, target) => {
          if (++calls === h.files.length) throw failure;
          await fs.link(source, target);
        });
        await assert.rejects(h.publish(), error => error === failure);
        assert.equal(calls, h.files.length);
        await h.assertEmpty();
      });
    }

    for (const cancel of [true, false]) {
      it(`${cancel ? "cancels" : "fails"} during staging cleanup and still rolls back outputs`, async t => {
        const h = await publicationFixture(t, multi);
        const failure = new Error("staging cleanup failed");
        let cleaned = false;
        t.mock.method(h.dependencies, "rm", async (target, options) => {
          if (target === h.temporary) {
            cleaned = true;
            if (!cancel) throw failure;
            await fs.rm(target, options);
            h.controller.abort(h.reason);
          } else await fs.rm(target, options);
        });
        await assert.rejects(h.publish(), error => error === (cancel ? h.reason : failure));
        assert.equal(cleaned, true);
        await h.assertEmpty();
      });
    }

    it("preserves an output created before link and rolls back only this transaction's files", async t => {
      const h = await publicationFixture(t, multi);
      const last = h.files.length - 1, original = Buffer.from("existing user output must survive");
      await fs.writeFile(h.output(last), original);
      await assert.rejects(h.publish(), { code: "EEXIST" });
      assert.deepEqual(await fs.readFile(h.output(last)), original);
      assert.deepEqual(await fs.readdir(path.join(h.root, "outputs")), [h.files[last].source]);
    });

    for (const replacement of ["file", "symlink", "directory", "modified"]) {
      it(`preserves a ${replacement} replacement after link and rolls back unaffected outputs`, async t => {
        const h = await publicationFixture(t, multi);
        const target = h.output(0), sentinel = path.join(h.root, "user-file");
        await fs.writeFile(sentinel, "independent user data");
        t.mock.method(h.dependencies, "rm", async (file, options) => {
          assert.equal(file, h.temporary);
          if (replacement === "file") {
            const saved = path.join(h.root, "replacement");
            await fs.copyFile(sentinel, saved);
            await fs.rename(saved, target);
          } else if (replacement === "modified") await fs.writeFile(target, "in-place user edit must survive");
          else {
            await fs.unlink(target);
            if (replacement === "symlink") await fs.symlink(sentinel, target);
            else { await fs.mkdir(target); await fs.writeFile(path.join(target, "keep"), "user directory"); }
          }
          await fs.rm(file, options);
          h.controller.abort(h.reason);
        });
        await assert.rejects(h.publish(), error => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, h.reason);
          assert.equal(error.errors[1].code, "MEDIA_PUBLICATION_IDENTITY_CONFLICT");
          assert.equal(error.errors[1].path, target);
          assert.match(error.errors[1].message, /目标已替换或修改/);
          return true;
        });
        assert.equal(await fs.readFile(sentinel, "utf8"), "independent user data");
        if (replacement === "directory") assert.equal(await fs.readFile(path.join(target, "keep"), "utf8"), "user directory");
        else if (replacement === "symlink") assert.equal(await fs.readlink(target), sentinel);
        else assert.equal(await fs.readFile(target, "utf8"), replacement === "modified" ? "in-place user edit must survive" : "independent user data");
        assert.deepEqual(await fs.readdir(path.join(h.root, "outputs")), [h.files[0].source]);
      });
    }

    for (const replacement of ["directory", "symlink", "ancestor-symlink"]) {
      it(`preserves files when the output parent becomes a different ${replacement}`, async t => {
        const h = await publicationFixture(t, multi);
        const originalParent = path.join(h.root, "outputs"), moved = path.join(h.root, "moved-outputs");
        const destination = path.join(h.root, "user-outputs");
        await fs.mkdir(destination);
        if (replacement === "ancestor-symlink") {
          await fs.mkdir(path.join(originalParent, "nested"));
          for (const file of h.files) file.output = `outputs/nested/${file.source}`;
        }
        t.mock.method(h.dependencies, "rm", async (file, options) => {
          assert.equal(file, h.temporary);
          await fs.rename(originalParent, moved);
          if (replacement === "directory") await fs.mkdir(originalParent);
          else await fs.symlink(destination, originalParent, "dir");
          const currentParent = replacement === "ancestor-symlink" ? path.join(originalParent, "nested") : originalParent;
          if (replacement === "ancestor-symlink") await fs.mkdir(currentParent);
          for (const entry of h.files) await fs.writeFile(path.join(currentParent, entry.source), "new parent user file");
          await fs.rm(file, options);
          h.controller.abort(h.reason);
        });
        await assert.rejects(h.publish(), error => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, h.reason);
          assert.equal(error.errors.length, h.files.length + 1);
          for (const conflict of error.errors.slice(1)) {
            assert.equal(conflict.code, "MEDIA_PUBLICATION_IDENTITY_CONFLICT");
            assert.match(conflict.message, /父目录已替换/);
          }
          return true;
        });
        for (const [index, entry] of h.files.entries()) {
          assert.equal(await fs.readFile(h.output(index), "utf8"), "new parent user file");
          assert.deepEqual(await fs.readFile(path.join(moved, ...(replacement === "ancestor-symlink" ? ["nested"] : []), entry.source)), h.contents[index]);
        }
      });
    }

    it("uses the source identity captured before link rather than adopting a replacement target", async t => {
      const h = await publicationFixture(t, multi);
      t.mock.method(h.dependencies, "link", async (source, target) => {
        await fs.link(source, target);
        const saved = path.join(h.root, "replacement");
        await fs.writeFile(saved, "replacement during link completion");
        await fs.rename(saved, target);
        h.controller.abort(h.reason);
      });
      await assert.rejects(h.publish(), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, h.reason);
        assert.match(error.message, /目标已替换或修改/);
        return true;
      });
      assert.equal(await fs.readFile(h.output(0), "utf8"), "replacement during link completion");
    });

    for (const replacement of ["directory", "symlink"]) {
      it(`rejects a replaced parent ${replacement} even when the leaf still has the original source inode`, async t => {
        const h = await publicationFixture(t, multi);
        const parent = path.join(h.root, "outputs"), moved = path.join(h.root, "moved");
        t.mock.method(h.dependencies, "rm", async (file, options) => {
          await fs.rename(parent, moved);
          if (replacement === "symlink") await fs.symlink(moved, parent, "dir");
          else {
            await fs.mkdir(parent);
            for (const entry of h.files) await fs.link(path.join(moved, entry.source), path.join(parent, entry.source));
          }
          await fs.rm(file, options);
          h.controller.abort(h.reason);
        });
        await assert.rejects(h.publish(), error => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, h.reason);
          assert.equal(error.errors.length, h.files.length + 1);
          assert.match(error.message, /父目录已替换/);
          return true;
        });
        for (const [index, entry] of h.files.entries()) {
          assert.deepEqual(await fs.readFile(h.output(index)), h.contents[index]);
          assert.deepEqual(await fs.readFile(path.join(moved, entry.source)), h.contents[index]);
        }
      });
    }

    for (const boundary of ["path", "link", "stat"]) {
      it(`rechecks authorization after ${boundary} await and rolls back`, async t => {
        const h = await publicationFixture(t, multi);
        let calls = 0;
        const revoke = () => { if (++calls === h.files.length) h.state.granted = false; };
        if (boundary === "path") t.mock.method(h.dependencies, "realpath", async value => { const result = await fs.realpath(value); revoke(); return result; });
        if (boundary === "link") t.mock.method(h.dependencies, "link", async (source, target) => { await fs.link(source, target); revoke(); });
        if (boundary === "stat") t.mock.method(h.dependencies, "stat", async target => { const result = await fs.stat(target); revoke(); return result; });
        await assert.rejects(h.publish(), /授权已变化/);
        await h.assertEmpty();
      });
    }
  });
}

describe("publication containment and rollback errors", () => {
  it("rejects traversal and symlinked output parents without publishing outside the project", async t => {
    const h = await publicationFixture(t, false);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "video-edit-outside-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.symlink(outside, path.join(h.root, "escape"), "dir");
    for (const output of ["../escaped.mp4", "outputs/../../escaped.mp4", "escape/escaped.mp4"]) {
      h.files[0].output = output;
      await assert.rejects(h.publish(), /路径穿越|符号链接/);
    }
    assert.deepEqual(await fs.readdir(outside), []);
    await h.assertEmpty();
  });

  it("attempts every rollback even if one removal fails, and exposes both failures", async t => {
    const h = await publicationFixture(t, true);
    const failure = new Error("last stat failed"), rollbackFailure = new Error("first unlink failed");
    const removed = [];
    t.mock.method(h.dependencies, "stat", async target => {
      if (target === h.output(2)) throw failure;
      return fs.stat(target);
    });
    t.mock.method(h.dependencies, "unlink", async target => {
      removed.push(target);
      if (target === h.output(0)) throw rollbackFailure;
      await fs.unlink(target);
    });
    await assert.rejects(h.publish(), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, failure);
      assert.equal(error.errors[0], failure);
      assert.equal(error.errors[1].code, "MEDIA_PUBLICATION_IDENTITY_CONFLICT");
      assert.equal(error.errors[1].cause, rollbackFailure);
      return true;
    });
    assert.deepEqual(removed.sort(), h.files.map((_, index) => h.output(index)).sort());
    assert.deepEqual(await fs.readdir(path.join(h.root, "outputs")), ["video.mp4"]);
  });

  it("retains an unverifiable target and rolls back other files when identity lookup fails", async t => {
    const h = await publicationFixture(t, true);
    const failure = Object.assign(new Error("identity lookup denied"), { code: "EACCES" });
    let rollingBack = false;
    t.mock.method(h.dependencies, "rm", async (file, options) => {
      await fs.rm(file, options);
      rollingBack = true;
      h.controller.abort(h.reason);
    });
    t.mock.method(h.dependencies, "lstat", async (file, options) => {
      if (rollingBack && file === h.output(0)) throw failure;
      return fs.lstat(file, options);
    });
    await assert.rejects(h.publish(), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, h.reason);
      assert.equal(error.errors[1].cause, failure);
      assert.match(error.message, /EACCES/);
      assert.match(error.message, /video\.mp4/);
      return true;
    });
    assert.deepEqual(await fs.readFile(h.output(0)), h.contents[0]);
    assert.deepEqual(await fs.readdir(path.join(h.root, "outputs")), ["video.mp4"]);
  });

  it("rejects a symlink staging source before publishing", async t => {
    const h = await publicationFixture(t, false);
    const source = path.join(h.temporary, h.files[0].source), user = path.join(h.root, "user-file");
    await fs.writeFile(user, "user data");
    await fs.unlink(source);
    await fs.symlink(user, source);
    await assert.rejects(h.publish(), { code: "MEDIA_PUBLICATION_IDENTITY_CONFLICT" });
    await h.assertEmpty();
    assert.equal(await fs.readFile(user, "utf8"), "user data");
  });
});

const mediaToolsRoot = fileURLToPath(new URL("../resources/mediaTools", import.meta.url));
// No downloads/builds or substitute executables: use only verified native staging.
const nativeMedia = process.platform === "darwin" && ["arm64", "x64"].includes(process.arch);
async function editorFixture(t) {
  const tools = verifyMediaTools(mediaToolsRoot, process, { phase: "built" });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "video-edit-integration-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "outputs"));
  // All media is synthesized in this test's private directory; never read user media.
  mediaRun(tools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=160x128:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(root, "input.mp4")]);
  const editor = createToonFactoryVideoEditor({ isDirectoryGranted: directory => directory === root, mediaToolsRoot });
  t.after(() => editor.stop());
  const input = operation => operation === "export"
    ? { operation, directory: root, clips: [{ path: "input.mp4" }], output: "outputs/export.mp4", width: 160, height: 128, fps: 24 }
    : { operation, directory: root, path: "input.mp4", outputDirectory: "outputs" };
  return { root, editor, input };
}

// Observe actual child lifecycle, without replacing executable selection, argv,
// signature verification or spawn behavior. The spawn event is an explicit gate,
// so cancellation always interrupts an active ffmpeg run, never just pre-abort.
function observeRender(t) {
  const children = [];
  let ready;
  const rendering = new Promise(resolve => { ready = resolve; });
  // Node exposes this internal method at runtime but omits it from @types/node.
  const prototype = /** @type {ChildProcess & { spawn(options: { file: string }): number }} */ (ChildProcess.prototype);
  const original = prototype.spawn;
  t.mock.method(prototype, "spawn", function(options) {
    const result = original.call(this, options);
    const child = this;
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    children.push({ child, closed });
    if (path.basename(options.file) === "ffmpeg") child.once("spawn", () => ready(child));
    return result;
  });
  return { children, rendering };
}

describe("video editor with verified staging tools and real temporary media", { skip: nativeMedia ? false : "native macOS mediaTools staging required", concurrency: false, timeout: 60000 }, () => {
  for (const operation of ["export", "separate"]) {
    it(`${operation}: publishes validated media and removes all staging`, async t => {
      const h = await editorFixture(t);
      const result = await h.editor.execute(h.input(operation));
      if (operation === "export") {
        assert.ok(result.bytes > 0);
        assert.equal(result.path, "outputs/export.mp4");
        assert.equal(result.clips, 1);
      } else {
        assert.equal(result.video, "outputs/video.mp4");
        assert.equal(result.audio, "outputs/audio.m4a");
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.root, result.manifest), "utf8")), result);
      }
      assert.deepEqual((await fs.readdir(h.root)).sort(), ["input.mp4", "outputs"]);
    });

    for (const cancellation of ["signal", "stop"]) {
      it(`${operation}: ${cancellation} kills an active render, waits for close and leaves no orphan or output`, async t => {
        const h = await editorFixture(t);
        const observation = observeRender(t);
        const controller = new AbortController(), reason = new Error("external active-run cancellation");
        const running = h.editor.execute(h.input(operation), controller.signal);
        const rejected = assert.rejects(running, cancellation === "signal" ? error => error === reason : /剪辑已停止/);
        const child = await observation.rendering;
        assert.ok(child.pid > 0);
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        await assert.rejects(h.editor.execute({ operation: "probe", directory: h.root, path: "input.mp4" }), /已有剪辑或探测任务/);
        if (cancellation === "signal") controller.abort(reason);
        const stopping = [h.editor.stop(), h.editor.stop()];
        await Promise.all([...stopping, rejected]);
        for (const { child: processChild, closed } of observation.children) {
          await closed;
          assert.ok(processChild.exitCode !== null || processChild.signalCode !== null);
          assert.throws(() => process.kill(processChild.pid, 0), { code: "ESRCH" });
        }
        assert.equal(child.signalCode, "SIGKILL");
        assert.deepEqual(await fs.readdir(path.join(h.root, "outputs")), []);
        assert.deepEqual((await fs.readdir(h.root)).sort(), ["input.mp4", "outputs"]);
        // The previous active slot is released only after process close and cleanup.
        const probe = await h.editor.execute({ operation: "probe", directory: h.root, path: "input.mp4" });
        assert.ok(probe.duration > 0);
        await h.editor.stop();
      });
    }

    it(`${operation}: preserves existing output on failure and clears staging`, async t => {
      const h = await editorFixture(t);
      const name = operation === "export" ? "export.mp4" : "manifest.json";
      const target = path.join(h.root, "outputs", name), original = Buffer.from("existing output");
      await fs.writeFile(target, original);
      await assert.rejects(h.editor.execute(h.input(operation)), operation === "export" ? /输出已存在/ : { code: "EEXIST" });
      assert.deepEqual(await fs.readFile(target), original);
      assert.deepEqual(await fs.readdir(path.join(h.root, "outputs")), [name]);
      assert.deepEqual((await fs.readdir(h.root)).sort(), ["input.mp4", "outputs"]);
    });
  }

  it("keeps authorization, relative path and restricted input boundaries", async t => {
    const h = await editorFixture(t);
    const observation = observeRender(t);
    const unauthorized = createToonFactoryVideoEditor({ isDirectoryGranted: () => false, mediaToolsRoot: path.join(h.root, "nonexistent-tools") });
    await assert.rejects(unauthorized.execute(h.input("export")), /未经 JuggleWork 授权/);
    for (const extra of [{ args: ["-y"] }, { executable: "/bin/sh" }, { filters: "movie=/etc/passwd" }]) {
      await assert.rejects(h.editor.execute({ ...h.input("export"), ...extra }), /无效的剪辑参数/);
    }
    await assert.rejects(h.editor.execute({ ...h.input("export"), clips: [{ path: "../input.mp4" }] }), /路径穿越/);
    await assert.rejects(h.editor.execute({ ...h.input("export"), output: "../escaped.mp4" }), /路径穿越/);
    assert.equal(observation.children.length, 0, "invalid requests never spawn a process");
    assert.deepEqual(await fs.readdir(path.join(h.root, "outputs")), []);
  });
});
