import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createManualSessionCreationRegistry, manualSessionCreationKey } from "../src/react-app/shell/manual-session-creation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the actual route callback with controlled dependencies, rather than
// asserting source strings. No React mount or network/server is required.
function routeCallback(name: string, dependencies: Record<string, unknown>, route = "session-route") {
  const source = readFileSync(new URL(`../src/react-app/shell/${route}.tsx`, import.meta.url), "utf8");
  const file = ts.createSourceFile("route.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      callback = node.initializer.arguments[0].getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!callback) throw new Error(`Missing callback ${name}`);
  const js = ts.transpile(`const callback = ${callback};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(dependencies), `${js}; return callback;`)(...Object.values(dependencies));
}

describe("manual creation singleflight", () => {
  test("reserves synchronously, reuses exact promise and first intent, independent runtimes/workspaces", async () => {
    const registry = createManualSessionCreationRegistry();
    const gate = deferred<string>();
    let posts = 0;
    let generations = 0;
    const effects: string[] = [];
    const key = manualSessionCreationKey("http://runtime/", "a");
    const first = registry.run(key, async () => {
      generations++;
      posts++;
      const id = await gate.promise;
      effects.push("first draft/group");
      return id;
    });
    expect(registry.pending(key)).toBe(true);
    const second = registry.run(manualSessionCreationKey("http://runtime", "a"), async () => {
      posts++;
      effects.push("clobber");
      return "wrong";
    });
    expect(second).toBe(first);
    expect(await registry.run(manualSessionCreationKey("http://runtime", "b"), async () => "b")).toBe("b");
    expect(await registry.run(manualSessionCreationKey("http://other", "a"), async () => "other")).toBe("other");
    expect(posts).toBe(1);
    expect(generations).toBe(1);
    gate.resolve("session");
    expect(await second).toBe("session");
    expect(effects).toEqual(["first draft/group"]);
    expect(registry.pending(key)).toBe(false);
  });

  test("rejection releases reservation and notifies subscribers", async () => {
    const registry = createManualSessionCreationRegistry();
    const gate = deferred<string>();
    const states: boolean[] = [];
    const unsubscribe = registry.subscribe(() => states.push(registry.pending("a")));
    const first = registry.run("a", () => gate.promise);
    expect(registry.run("a", async () => "wrong")).toBe(first);
    gate.reject(new Error("timeout"));
    await expect(first).rejects.toThrow("timeout");
    expect(states).toEqual([true, false]);
    expect(await registry.run("a", async () => "retry")).toBe("retry");
    unsubscribe();
  });

  test("settings palette joins the shared flight without another POST or navigation", async () => {
    const registry = createManualSessionCreationRegistry();
    const gate = deferred<string>();
    const first = registry.run(manualSessionCreationKey("runtime", "a"), () => gate.promise);
    let posts = 0;
    let navigations = 0;
    const create = routeCallback("handleCreatePaletteSession", {
      manualSessionCreation: registry, manualSessionCreationKey,
      opencodeBaseUrl: "runtime", selectedWorkspaceId: "a", selectedWorkspaceRoot: "/a",
      selectedWorkspaceEndpoint: null,
      opencodeClient: { session: { create: () => { posts++; } } },
      navigate: () => { navigations++; },
    }, "settings-route");
    expect(create()).toBe(first);
    gate.resolve("session");
    expect(await first).toBe("session");
    expect(posts).toBe(0);
    expect(navigations).toBe(0);
  });

  test.each([false, true])("actual task handler coalesces before activation; setup failure=%s never repeats POST", async (setupFailure) => {
    const activation = deferred<boolean>();
    const post = deferred<{ data: { id: string } }>();
    let posts = 0;
    const effects: unknown[] = [];
    const generation = { current: 0 };
    const noop = () => {};
    const deps = {
      manualSessionCreation: createManualSessionCreationRegistry(), manualSessionCreationKey,
      workspaces: [{ id: "a", path: "/a" }], baseUrl: "runtime", loading: false,
      retryingWorkspaceIds: [], selectedWorkspaceId: "b", activatingWorkspaceId: null,
      workspaceActivationErrorId: null, workspaceNavigationGenerationRef: generation,
      endpointForWorkspace: () => ({ opencodeBaseUrl: "runtime", token: "test" }),
      activateWorkspaceForNavigation: () => activation.promise,
      createClient: () => ({ session: { create: () => { posts++; return post.promise; } } }),
      unwrap: (value: { data: unknown }) => value.data,
      toast: { info: noop, dismiss: noop, error: noop },
      setErrorsByWorkspaceId: noop, setRouteError: noop,
      saveSessionDraft: (...args: unknown[]) => {
        effects.push(args);
        if (setupFailure) throw new Error("draft storage failed");
      },
      sessionManagementStore: { getState: () => ({ assignGroup: (...args: unknown[]) => effects.push(args) }) },
      captureAnalyticsEvent: noop, taskCreateUnavailableToastId: () => "toast",
      writeLastSessionFor: noop, rememberPendingCreatedSession: noop,
      setSessionsByWorkspaceId: noop, setLegacySelectedWorkspaceId: noop,
      writeActiveWorkspaceId: noop, openSessionForNavigation: noop,
      refreshRouteState: noop, describeRouteError: String, describeTaskCreateError: String,
      isTransientStartupError: () => false,
    };
    const create = routeCallback("handleCreateTaskInWorkspace", deps);
    const first = create("a", { prompt: "first", groupId: "one" });
    const second = create("a", { prompt: "second", groupId: "two" });
    expect(second).toBe(first);
    await Promise.resolve();
    expect(generation.current).toBe(1);
    activation.resolve(true);
    await Promise.resolve();
    expect(posts).toBe(1);
    post.resolve({ data: { id: "session" } });
    expect(await first).toBe("session");
    expect(posts).toBe(1);
    expect(effects).toEqual([["a", "session", { text: "first", mode: "prompt" }], ...(!setupFailure ? [["a", "session", "one"]] : [])]);
  });

  test.each([false, true])("adding folder opens empty workspace without session POST; stale=%s", async (stale) => {
    const registration = deferred<unknown>();
    const generation = { current: 0 };
    const effects: unknown[] = [];
    const noop = () => {};
    const create = routeCallback("handleCreateWorkspace", {
      workspaceNavigationGenerationRef: generation,
      setCreateWorkspaceBusy: noop, setCreateWorkspaceError: (error: unknown) => { if (error) throw error; },
      folderNameFromPath: () => "folder", client: {},
      createLocalWorkspaceForRuntime: () => registration.promise,
      isDesktopRuntime: () => true,
      ensureDesktopLocalJuggleWorkConnection: async () => { effects.push("runtime"); },
      setCreateWorkspaceOpen: noop,
      local: { setPrefs: (update: (prefs: object) => unknown) => effects.push(update({})) },
      refreshRouteState: async () => {}, setLegacySelectedWorkspaceId: noop,
      writeActiveWorkspaceId: noop,
      writeWorkspaceProjectDimension: (...args: unknown[]) => effects.push(args),
      captureAnalyticsEvent: (...args: unknown[]) => effects.push(args),
      navigateToWorkspaceSession: (...args: unknown[]) => effects.push(args),
      describeWorkspaceCreateError: String,
      createClient: () => { throw new Error("Must not create first session"); },
    });
    const result = create("starter", "/folder", { projectLabel: " Project " });
    if (stale) generation.current++;
    registration.resolve({ list: { workspaces: [] }, workspaceId: "a", workspace: { id: "a" } });
    await result;
    expect(effects).toEqual([
      "runtime", { hasCompletedOnboarding: true },
      ["a", { label: "Project" }], ["workspace_created", { workspace_type: "local" }],
      ...(!stale ? [["a", null, { replace: true }]] : []),
    ]);
  });
});
