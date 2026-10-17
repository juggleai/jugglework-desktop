import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { TOON_TEXT_OUTPUT_SCHEMAS, type ToonCanvas, type ToonEpisode, type ToonProjectResponse, type ToonTextJob } from "@jugglework/types/toon-factory";

import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import { fitToonCanvasViewport, ToonFactoryWorkbench } from "../src/react-app/domains/toon-factory/toon-factory-workbench";
import { createEpisodeWorkflowSteps } from "../src/react-app/domains/toon-factory/toon-factory-workflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-10-17T10:00:00.000Z";
const REVISION = "a".repeat(64);
const notFound = () => new JuggleWorkServerError(404, "toon_factory_content_not_found", "not found");

function projectResponse(): ToonProjectResponse {
  const episode: ToonEpisode = {
    id: "episode-1",
    title: "Episode 1",
    ordinal: 1,
    canvasId: "episode-1-canvas",
    stages: ["content-script", "assets", "directing-storyboard", "images", "videos", "adoption-delivery"].map((stage) => ({ stage: stage as ToonEpisode["stages"][number]["stage"], status: "draft", updatedAt: NOW })),
    steps: createEpisodeWorkflowSteps(NOW, (key) => key),
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { project: { schemaVersion: 1, id: "project-1", name: "Series", episodes: [episode], createdAt: NOW, updatedAt: NOW }, directory: "toons/series", revision: REVISION };
}

function canvas(): ToonCanvas {
  return { schemaVersion: 1, id: "episode-1-canvas", name: "Episode 1", nodes: [], edges: [], viewport: { x: 14, y: 22, zoom: 1.2 } };
}

function render(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return TestRenderer.create(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const modelCatalog = {
  image: { mode: "text-to-image" as const, models: [] },
  video: { mode: "text-to-video" as const, submissionEnabled: false, blockingReason: "no_video_model_available" as const, models: [] },
};

const workbenchProps = {
  workspaceRoot: "/workspace",
  textModels: [],
  textModelsPending: false,
  onRefreshTextModels: async () => undefined,
  onOpenProviderSettings: () => {},
};

const textJobClient = {
  createToonTextJob: async () => { throw new Error("not configured"); },
  getToonTextJob: async () => { throw new Error("not configured"); },
  cancelToonTextJob: async () => { throw new Error("not configured"); },
  authorizeToonMediaJob: async () => { throw new Error("not configured"); },
  createToonMediaJob: async () => { throw new Error("not configured"); },
  listToonMediaJobs: async () => ({ items: [] }),
  getToonMediaJob: async () => { throw new Error("not configured"); },
  cancelToonMediaJob: async () => { throw new Error("not configured"); },
  reviewToonMediaJob: async () => { throw new Error("not configured"); },
  retryToonMediaJob: async () => { throw new Error("not configured"); },
  getToonDeliveryManifest: async () => ({ manifest: null, path: null, revision: null }),
  createToonDeliveryManifest: async () => { throw new Error("not configured"); },
  downloadToonDeliveryManifest: async () => { throw new Error("not configured"); },
  downloadToonDeliveryArtifact: async () => { throw new Error("not configured"); },
  downloadWorkspaceFile: async () => ({ data: new ArrayBuffer(0), contentType: "application/octet-stream" }),
};

async function waitForTestId(renderer: TestRenderer.ReactTestRenderer, testId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    if (renderer.root.findAllByProps({ "data-testid": testId }).length > 0) return;
  }
  throw new Error(`Timed out waiting for ${testId}: ${JSON.stringify(renderer.toJSON())}`);
}

test("lists, creates, and opens workspace-backed projects", async () => {
  let selected: string | null = null;
  let createdInput: unknown = null;
  const response = projectResponse();
  const client = {
    ...textJobClient,
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async (_workspaceId: string, input: unknown) => { createdInput = input; return response; },
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => { throw notFound(); },
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: "b".repeat(64) }),
    readToonText: async () => { throw notFound(); },
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId={null} visible sidebarOpen onSelectProject={(id) => { selected = id; }} />); });
  try {
    await waitForTestId(renderer!, "toon-project-project-1");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-project-project-1" }).props.onClick(); });
    expect(selected).toBe("project-1");
    expect(renderer!.root.findByProps({ "data-testid": "toon-factory-home" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "toon-project-grid" })).toBeDefined();
    expect(renderer!.root.findByProps({ title: "Add files to the project and the initial assistant turn" }).props.disabled).toBeUndefined();
    expect(renderer!.root.findByProps({ title: "Direct Toonflow conversion is not supported. JuggleWork never starts Toonflow's server or loads its runtime code." }).props.disabled).toBe(true);
    const inputs = renderer!.root.findAllByType("input");
    await act(async () => {
      inputs[0]!.props.onChange({ target: { value: "New series" } });
      inputs[1]!.props.onChange({ target: { value: "toons/new-series" } });
    });
    await act(async () => { await renderer!.root.findByProps({ "data-testid": "toon-factory-create-form" }).props.onSubmit({ preventDefault() {} }); });
    expect(createdInput).toEqual({ name: "New series", directory: "toons/new-series" });
    expect(selected).toBe("project-1");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("initializes a v2 idea with attachments in the project asset catalog and first assistant turn", async () => {
  let uploadInput: { file: File; metadata: Record<string, unknown> } | null = null;
  let assistantInput: Record<string, unknown> | null = null;
  let selected: string | null = null;
  const client = {
    ...textJobClient,
    baseUrl: "http://v2-home.test",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [] }),
    listToonWorkspaceProjects: async () => ({ schemaVersion: 2 as const, items: [] }),
    getToonWorkspaceFeatures: async () => ({ advancedWorkspace: true, v2Read: true as const, v2Export: true as const, automaticDowngrade: false as const, toonflowImport: "disabled" as const }),
    initializeToonWorkspaceProject: async () => ({ operationId: "home-source", payloadHash: REVISION, status: "committed" as const, origin: "human-ui" as const, actor: { kind: "human" as const }, affected: [{ kind: "project" as const, id: "toon-home" }], revisions: {}, committedAt: NOW }),
    executeToonWorkspaceCommand: async () => ({ operationId: "model", payloadHash: REVISION, status: "committed" as const, origin: "human-ui" as const, actor: { kind: "human" as const }, affected: [], revisions: {}, committedAt: NOW }),
    uploadToonProjectAsset: async (_workspaceId: string, _projectId: string, file: File, metadata: Record<string, unknown>) => { uploadInput = { file, metadata }; return { operationId: String(metadata.operationId), payloadHash: REVISION, status: "committed" as const, origin: "human-ui" as const, actor: { kind: "human" as const }, affected: [{ kind: "asset" as const, id: String(metadata.assetId) }], revisions: {}, result: { asset: { id: String(metadata.assetId), title: file.name, checksum: REVISION, mimeType: file.type } }, committedAt: NOW }; },
    createToonAssistantConversation: async (_workspaceId: string, _projectId: string, input: any) => ({ id: "conversation", projectId: "toon-home", title: "Attached idea", model: input.model, visibility: "toon_project_assistant" as const, archived: false, createdAt: NOW, updatedAt: NOW }),
    sendToonAssistantMessage: async (_workspaceId: string, _projectId: string, _conversationId: string, input: Record<string, unknown>) => { assistantInput = input; return { accepted: true, turnId: String(input.turnId), contextDiagnostics: [] }; },
    createToonProject: async () => projectResponse(),
    getToonProject: async () => projectResponse(),
    updateToonProject: async () => projectResponse(),
    readToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    writeToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    readToonText: async () => { throw notFound(); },
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  const textModels = [{ providerID: "provider", modelID: "text", providerName: "Provider", modelName: "Text", providerSource: "api" as const }];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} textModels={textModels} client={client} workspaceId="v2-home" projectId={null} visible sidebarOpen onSelectProject={(id) => { selected = id; }} />); });
  try {
    await waitForTestId(renderer!, "toon-inspiration-composer");
    const inputs = renderer!.root.findAllByType("input");
    await act(async () => {
      inputs.find((input) => input.props["aria-label"] === "Project name")!.props.onChange({ target: { value: "Attached idea" } });
      inputs.find((input) => input.props["aria-label"] === "Project directory")!.props.onChange({ target: { value: "toons/attached" } });
      renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.onChange({ target: { value: "Build from this reference" } });
      renderer!.root.findAllByType("select").find((select) => select.props.value === "")!.props.onChange({ target: { value: "provider\u0000text" } });
      renderer!.root.findAllByType("input").find((input) => input.props.type === "file")!.props.onChange({ target: { files: [new File(["reference"], "reference.txt", { type: "text/plain" })] }, currentTarget: { value: "" } });
    });
    await act(async () => { await renderer!.root.findByProps({ "data-testid": "toon-factory-create-form" }).props.onSubmit({ preventDefault() {} }); });
    expect(uploadInput?.file.name).toBe("reference.txt");
    expect(uploadInput?.metadata).toMatchObject({ filename: "reference.txt", origin: "imported", actor: { kind: "human" } });
    expect(assistantInput).toMatchObject({ text: "Build from this reference", model: { kind: "text", providerID: "provider", modelID: "text" }, attachments: [{ kind: "asset", label: "reference.txt", revision: REVISION }] });
    expect(selected).toBe("toon-home");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("offers a project-home action for project load errors and zero-episode projects", async () => {
  const empty = projectResponse();
  empty.project = { ...empty.project, episodes: [] };
  const selected: Array<string | null> = [];
  let failLoad = true;
  const client = {
    ...textJobClient,
    baseUrl: "http://project-state.test",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [] }),
    createToonProject: async () => empty,
    getToonProject: async () => { if (failLoad) throw new Error("load failed"); return empty; },
    updateToonProject: async () => empty,
    readToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    writeToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    readToonText: async () => { throw notFound(); },
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="project-state" projectId="project-1" visible sidebarOpen onSelectProject={(id) => selected.push(id)} />); });
  try {
    await waitForTestId(renderer!, "toon-factory-workbench");
    await waitForTestId(renderer!, "toon-project-error-back");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-project-error-back" }).props.onClick(); });
    expect(selected).toEqual([null]);
    failLoad = false;
    await act(async () => { await renderer!.root.findByProps({ "data-testid": "toon-main-error-retry" }).props.onClick(); });
    await waitForTestId(renderer!, "toon-zero-episode-back");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("persists the home inspiration into the first episode source node without changing the create protocol", async () => {
  const created = projectResponse();
  created.project = { ...created.project, episodes: [] };
  let createInput: unknown = null;
  let writtenText: { nodeId: string; content: string } | null = null;
  let updatedProject: ToonProjectResponse["project"] | null = null;
  const client = {
    ...textJobClient,
    baseUrl: "http://intent.test",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [] }),
    createToonProject: async (_workspaceId: string, input: unknown) => { createInput = input; return created; },
    getToonProject: async () => created,
    updateToonProject: async (_workspaceId: string, _projectId: string, input: { project: ToonProjectResponse["project"] }) => { updatedProject = input.project; return { ...created, project: input.project, revision: "b".repeat(64) }; },
    readToonCanvas: async () => { throw notFound(); },
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: REVISION }),
    readToonText: async () => { throw notFound(); },
    writeToonText: async (_workspaceId: string, _projectId: string, nodeId: string, input: { content: string }) => { writtenText = { nodeId, content: input.content }; return { nodeId, content: input.content, revision: "c".repeat(64) }; },
    getToonModelCatalog: async () => modelCatalog,
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="intent-workspace" projectId={null} visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-inspiration-composer");
    const inputs = renderer!.root.findAllByType("input");
    await act(async () => {
      inputs[0]!.props.onChange({ target: { value: "Moon Harbor" } });
      inputs[1]!.props.onChange({ target: { value: "toons/moon-harbor" } });
      renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.onChange({ target: { value: "A courier discovers a city hidden in moonlight." } });
    });
    await act(async () => { await renderer!.root.findByProps({ "data-testid": "toon-factory-create-form" }).props.onSubmit({ preventDefault() {} }); });
    expect(createInput).toEqual({ name: "Moon Harbor", directory: "toons/moon-harbor" });
    expect(writtenText?.content).toBe("A courier discovers a city hidden in moonlight.");
    expect(updatedProject?.episodes).toHaveLength(1);
    expect(updatedProject?.episodes[0]?.steps?.find((step) => step.id === "source-material")?.outputRevision).toBe("c".repeat(64));
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("retains the inspiration draft when first-episode initialization fails", async () => {
  const created = projectResponse();
  created.project = { ...created.project, episodes: [] };
  let createCalls = 0;
  let getCalls = 0;
  let setupFails = true;
  const client = {
    ...textJobClient,
    baseUrl: "http://retained-intent.test",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [] }),
    createToonProject: async () => { createCalls += 1; return created; },
    getToonProject: async () => { getCalls += 1; return created; },
    updateToonProject: async () => created,
    readToonCanvas: async () => { throw notFound(); },
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => { if (setupFails) throw new Error("canvas setup failed"); return { canvas: input.canvas, revision: REVISION }; },
    readToonText: async () => { throw notFound(); },
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  const ui = () => <ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="retained-intent-workspace" projectId={null} visible sidebarOpen onSelectProject={() => {}} />;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(ui()); });
  await waitForTestId(renderer!, "toon-inspiration-composer");
  const inputs = renderer!.root.findAllByType("input");
  await act(async () => {
    inputs[0]!.props.onChange({ target: { value: "Retained" } });
    inputs[1]!.props.onChange({ target: { value: "toons/retained" } });
    renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.onChange({ target: { value: "Do not lose this intent" } });
  });
  await act(async () => { await renderer!.root.findByProps({ "data-testid": "toon-factory-create-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { renderer!.unmount(); });

  let restored: TestRenderer.ReactTestRenderer;
  await act(async () => { restored = render(ui()); });
  try {
    await waitForTestId(restored!, "toon-inspiration-input");
    expect(restored!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.value).toBe("Do not lose this intent");
    setupFails = false;
    await act(async () => { await restored!.root.findByProps({ "data-testid": "toon-factory-create-form" }).props.onSubmit({ preventDefault() {} }); });
    expect(createCalls).toBe(1);
    expect(getCalls).toBe(2);
  } finally {
    await act(async () => { restored!.unmount(); });
  }
});

for (const uncertainStage of ["canvas", "text", "project-update"] as const) {
  test(`recovers idempotently when the ${uncertainStage} response fails after success`, async () => {
    const legacyEpisode = projectResponse().project.episodes[0]!;
    let current = { ...projectResponse(), project: { ...projectResponse().project, episodes: [legacyEpisode] } };
    let storedCanvas = canvas();
    let storedText: { nodeId: string; content: string; revision: string } | null = null;
    const calls = { create: 0, canvas: 0, text: 0, update: 0 };
    const failed = new Set<string>();
    const failOnceAfterSuccess = (stage: string) => {
      if (stage !== uncertainStage || failed.has(stage)) return;
      failed.add(stage);
      throw new Error(`${stage} response lost`);
    };
    const client = {
      ...textJobClient,
      baseUrl: `http://uncertain-${uncertainStage}.test`,
      listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: current.project.id, name: current.project.name, directory: current.directory, updatedAt: current.project.updatedAt, episodeCount: current.project.episodes.length, revision: current.revision }] }),
      createToonProject: async () => { calls.create += 1; current = { ...current, project: { ...current.project, episodes: [legacyEpisode] } }; return current; },
      getToonProject: async () => current,
      updateToonProject: async (_workspaceId: string, _projectId: string, input: { project: ToonProjectResponse["project"] }) => {
        calls.update += 1;
        current = { ...current, project: input.project, revision: "d".repeat(64) };
        failOnceAfterSuccess("project-update");
        return current;
      },
      readToonCanvas: async () => ({ canvas: storedCanvas, revision: "b".repeat(64) }),
      writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => {
        calls.canvas += 1;
        storedCanvas = input.canvas;
        failOnceAfterSuccess("canvas");
        return { canvas: storedCanvas, revision: "b".repeat(64) };
      },
      readToonText: async () => {
        if (!storedText) throw notFound();
        return storedText;
      },
      writeToonText: async (_workspaceId: string, _projectId: string, nodeId: string, input: { content: string }) => {
        calls.text += 1;
        storedText = { nodeId, content: input.content, revision: "c".repeat(64) };
        failOnceAfterSuccess("text");
        return storedText;
      },
      getToonModelCatalog: async () => modelCatalog,
    };
    const ui = () => <ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId={`uncertain-${uncertainStage}`} projectId={null} visible sidebarOpen onSelectProject={() => {}} />;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = render(ui()); });
    try {
      await waitForTestId(renderer!, "toon-inspiration-composer");
      const inputs = renderer!.root.findAllByType("input");
      await act(async () => {
        inputs[0]!.props.onChange({ target: { value: "Recovered" } });
        inputs[1]!.props.onChange({ target: { value: `toons/recovered-${uncertainStage}` } });
        renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.onChange({ target: { value: "Recover this exact intent" } });
      });
      await act(async () => { await renderer!.root.findByProps({ "data-testid": "toon-factory-create-form" }).props.onSubmit({ preventDefault() {} }); });
      expect(calls).toEqual({ create: 1, canvas: 1, text: 1, update: 1 });
      expect(current.project.episodes.filter((episode) => episode.id === legacyEpisode.id)).toHaveLength(1);
      expect(current.project.episodes).toHaveLength(2);
      expect(storedCanvas.nodes.filter((node) => node.kind === "text")).toHaveLength(1);
      expect(storedText?.content).toBe("Recover this exact intent");
    } finally {
      await act(async () => { renderer!.unmount(); });
    }
  });
}

test("does not navigate after creation when the page became hidden and offers continuation on return", async () => {
  const response = projectResponse();
  response.project = { ...response.project, episodes: [] };
  let resolveCreate: ((value: ToonProjectResponse) => void) | null = null;
  const createPromise = new Promise<ToonProjectResponse>((resolve) => { resolveCreate = resolve; });
  const selected: Array<string | null> = [];
  const client = {
    ...textJobClient,
    baseUrl: "http://hidden-create.test",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [] }),
    createToonProject: async () => createPromise,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    writeToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    readToonText: async () => { throw notFound(); },
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const ui = (visible: boolean) => <QueryClientProvider client={queryClient}><ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="hidden-create" projectId={null} visible={visible} sidebarOpen onSelectProject={(id) => selected.push(id)} /></QueryClientProvider>;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(ui(true)); });
  try {
    await waitForTestId(renderer!, "toon-inspiration-composer");
    const inputs = renderer!.root.findAllByType("input");
    await act(async () => {
      inputs[0]!.props.onChange({ target: { value: "Background project" } });
      inputs[1]!.props.onChange({ target: { value: "toons/background" } });
    });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-factory-create-form" }).props.onSubmit({ preventDefault() {} }); });
    await act(async () => { renderer!.update(ui(false)); resolveCreate!(response); await createPromise; });
    expect(selected).toEqual([]);
    await act(async () => { renderer!.update(ui(true)); });
    await waitForTestId(renderer!, "toon-project-created");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-project-created" }).findByType("button").props.onClick(); });
    expect(selected).toEqual(["project-1"]);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("resets and restores the keyed home draft when the workspace or endpoint changes", async () => {
  const baseClient = {
    ...textJobClient,
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [] }),
    createToonProject: async () => projectResponse(),
    getToonProject: async () => projectResponse(),
    updateToonProject: async () => projectResponse(),
    readToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    writeToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    readToonText: async () => { throw notFound(); },
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const ui = (workspaceId: string, baseUrl = "http://scope-draft.test") => <QueryClientProvider client={queryClient}><ToonFactoryWorkbench {...workbenchProps} client={{ ...baseClient, baseUrl }} workspaceId={workspaceId} projectId={null} visible sidebarOpen onSelectProject={() => {}} /></QueryClientProvider>;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(ui("scope-one")); });
  try {
    await waitForTestId(renderer!, "toon-inspiration-input");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.onChange({ target: { value: "only workspace one" } }); });
    await act(async () => { renderer!.update(ui("scope-two")); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.value).toBe("");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.onChange({ target: { value: "only workspace two" } }); });
    await act(async () => { renderer!.update(ui("scope-one", "http://another-endpoint.test")); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.value).toBe("");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.onChange({ target: { value: "only endpoint two" } }); });
    await act(async () => { renderer!.update(ui("scope-one")); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-inspiration-input" }).props.value).toBe("only workspace one");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("supports the floating assistant, empty-canvas actions, double-click creation, and real zoom controls", async () => {
  const response = projectResponse();
  const writes: ToonCanvas[] = [];
  const client = {
    ...textJobClient,
    baseUrl: "http://workspace-ui.test",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => { writes.push(input.canvas); return { canvas: input.canvas, revision: REVISION }; },
    readToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-ui" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-canvas-empty");
    expect(renderer!.root.findByProps({ "data-testid": "toon-project-workspace" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "toon-assistant-panel" })).toBeDefined();
    const emptyActions = renderer!.root.findByProps({ "data-testid": "toon-canvas-empty" }).findAllByType("button");
    expect(emptyActions).toHaveLength(2);
    expect(emptyActions.every((button) => button.props.disabled)).toBe(true);

    const controls = renderer!.root.findByProps({ "data-testid": "toon-canvas-controls" });
    expect(renderer!.root.findByProps({ title: "Canvas help is not available yet." }).props.disabled).toBe(true);
    await act(async () => { controls.findByProps({ "data-testid": "toon-canvas-zoom-in" }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-canvas-zoom-reset" }).children.join("")).toBe("130%");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-canvas-zoom-out" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-canvas-zoom-reset" }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-canvas-zoom-reset" }).children.join("")).toBe("100%");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-canvas-fit" }).props.onClick(); });

    const assistantToggle = renderer!.root.findByProps({ "data-testid": "toon-assistant-toggle" });
    await act(async () => { assistantToggle.props.onClick(); });
    expect(renderer!.root.findAllByProps({ "data-testid": "toon-assistant-panel" })).toHaveLength(0);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-assistant-toggle" }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-assistant-panel" })).toBeDefined();

    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-node-canvas" }).props.onDoubleClick({ target: { closest: () => null } }); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-node-text" })).toBeDefined();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
    expect(writes.length).toBeGreaterThan(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("fits widely distributed nodes into the available centered viewport", () => {
  const nodes = [
    { id: "left", kind: "text" as const, position: { x: -900, y: -100 }, handles: [], data: { contentRef: "content/nodes/left.md" as const } },
    { id: "right", kind: "text" as const, position: { x: 1_900, y: 500 }, handles: [], data: { contentRef: "content/nodes/right.md" as const } },
  ];
  const viewport = fitToonCanvasViewport(nodes, 1_200, 800, 360);
  expect(viewport.zoom).toBeCloseTo(712 / 3_020, 5);
  const left = nodes[0]!.position.x * viewport.zoom + viewport.x;
  const right = (nodes[1]!.position.x + 220) * viewport.zoom + viewport.x;
  expect(left).toBeGreaterThanOrEqual(63);
  expect(right).toBeLessThanOrEqual(1_200 - 360 - 63);
  expect((left + right) / 2).toBeCloseTo((1_200 - 360) / 2, 5);
});

test("adds a text node when building the canvas even if another node already exists", async () => {
  const response = projectResponse();
  const imageNode = { id: "image", kind: "image-generation" as const, position: { x: 20, y: 30 }, handles: [], data: { label: "Image" } };
  const client = {
    ...textJobClient,
    baseUrl: "http://assistant-text.test",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: { ...canvas(), nodes: [imageNode] }, revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: REVISION }),
    readToonText: async () => { throw notFound(); },
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="assistant-workspace" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-node-image-generation");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-assistant-build-canvas" }).props.onClick(); });
    expect(renderer!.root.findAllByProps({ "data-testid": "toon-node-text" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "data-testid": "toon-node-image-generation" })).toHaveLength(1);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("restores canvas viewport and selection state, then debounces a typed canvas save", async () => {
  const response = projectResponse();
  const initialCanvas = { ...canvas(), nodes: [{ id: "existing", kind: "text" as const, position: { x: 20, y: 30 }, handles: [{ id: "text-out", direction: "source" as const, dataType: "text" as const }], data: { contentRef: "content/nodes/existing.md" } }], selectedNodeId: "existing" };
  const writes: Array<{ canvas: ToonCanvas; expectedRevision?: string }> = [];
  const client = {
    ...textJobClient,
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: initialCanvas, revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas; expectedRevision?: string }) => { writes.push(input); return { canvas: input.canvas, revision: "b".repeat(64) }; },
    readToonText: async () => ({ nodeId: "existing", content: "draft", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "existing", content: "draft", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-node-text");
    expect(renderer!.root.findByProps({ "data-testid": "toon-node-text" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "toon-text-editor" })).toBeDefined();
    const toolbar = renderer!.root.findByProps({ "data-testid": "toon-canvas-bottom-toolbar" });
    await act(async () => { toolbar.findByProps({ "aria-label": "Add node" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-add-node-video-generation" }).props.onClick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.expectedRevision).toBe(REVISION);
    expect(writes[0]!.canvas.viewport).toEqual({ x: 14, y: 22, zoom: 1.2 });
    expect(writes[0]!.canvas.nodes.some((node) => node.kind === "video-generation")).toBe(true);
    expect(writes[0]!.canvas.selectedNodeId).toMatch(/^video-generation-/);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("selects and moves a node with the keyboard", async () => {
  const response = projectResponse();
  const initialCanvas = { ...canvas(), nodes: [{ id: "existing", kind: "text" as const, position: { x: 20, y: 30 }, handles: [], data: { contentRef: "content/nodes/existing.md" as const } }] };
  const client = {
    ...textJobClient,
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: initialCanvas, revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: REVISION }),
    readToonText: async () => ({ nodeId: "existing", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "existing", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-node-text");
    const node = renderer!.root.findByProps({ "data-testid": "toon-node-text" });
    expect(node.props.tabIndex).toBe(0);
    await act(async () => { node.props.onKeyDown({ key: "Enter", preventDefault() {} }); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-node-text" }).props["aria-pressed"]).toBe(true);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-node-text" }).props.onKeyDown({ key: "ArrowRight", shiftKey: false, preventDefault() {} }); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-node-text" }).props.style.transform).toContain("28px");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("flushes an external text draft before switching nodes", async () => {
  const response = projectResponse();
  const first = { id: "first", kind: "text" as const, position: { x: 20, y: 30 }, handles: [], data: { contentRef: "content/nodes/first.md" as const } };
  const second = { id: "second", kind: "text" as const, position: { x: 300, y: 30 }, handles: [], data: { contentRef: "content/nodes/second.md" as const } };
  const initialCanvas = { ...canvas(), nodes: [first, second], selectedNodeId: first.id };
  const order: string[] = [];
  const client = {
    ...textJobClient,
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => { order.push("workflow"); return { ...response, revision: "c".repeat(64) }; },
    readToonCanvas: async () => ({ canvas: initialCanvas, revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: REVISION }),
    readToonText: async (_workspaceId: string, _projectId: string, nodeId: string) => ({ nodeId, content: "", revision: REVISION }),
    writeToonText: async (_workspaceId: string, _projectId: string, nodeId: string, input: { content: string }) => { order.push(`text:${nodeId}:${input.content}`); return { nodeId, content: input.content, revision: "b".repeat(64) }; },
    getToonModelCatalog: async () => modelCatalog,
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-text-draft");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-text-draft" }).props.onChange({ target: { value: "draft before switch" } }); });
    const nodes = renderer!.root.findAllByProps({ "data-testid": "toon-node-text" });
    await act(async () => { nodes[1]!.props.onPointerDown({ stopPropagation() {}, currentTarget: { setPointerCapture() {} }, pointerId: 1, clientX: 0, clientY: 0 }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(order).toEqual(["text:first:draft before switch", "workflow"]);
    expect(renderer!.root.findAllByProps({ "data-testid": "toon-node-text" })[1]!.props["aria-pressed"]).toBe(true);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("shows blocking model states and persists an explicit selection with the project revision", async () => {
  const response = projectResponse();
  const updates: Array<{ project: ToonProjectResponse["project"]; expectedRevision?: string }> = [];
  const selected = {
    ...response,
    project: {
      ...response.project,
      selectedModels: { text: { kind: "text" as const, providerID: "text-provider", modelID: "text-model" } },
    },
    revision: "b".repeat(64),
  };
  const client = {
    ...textJobClient,
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async (_workspaceId: string, _projectId: string, input: { project: ToonProjectResponse["project"]; expectedRevision?: string }) => { updates.push(input); return selected; },
    readToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: REVISION }),
    readToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
  };
  const textModels = [{ providerID: "text-provider", modelID: "text-model", providerName: "Text Provider", modelName: "Text Model", providerSource: "api" as const }];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} textModels={textModels} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-model-settings");
    expect(renderer!.root.findByProps({ "data-testid": "toon-factory-stage-images" }).props["aria-label"]).toBe("Images: In progress");
    expect(renderer!.root.findByProps({ "data-testid": "toon-factory-stage-images" }).props.title).toBe("Images");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-factory-stage-images" }).props.onClick(); });
    await waitForTestId(renderer!, "toon-model-block-no_image_model_available");
    expect(renderer!.root.findByProps({ "data-testid": "toon-model-block-no_image_model_available" })).toBeDefined();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-model-settings" }).findByType("button").props.onClick(); });
    const selects = renderer!.root.findByProps({ "data-testid": "toon-model-settings-panel" }).findAllByType("select");
    await act(async () => { selects[0]!.props.onChange({ target: { value: "text-provider\u0000text-model" } }); });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      expectedRevision: REVISION,
      project: { selectedModels: { text: { kind: "text", providerID: "text-provider", modelID: "text-model" } } },
    });
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("requires exact-request approval and recovers a server-owned job after unmount", async () => {
  const response = projectResponse();
  response.project.episodes[0]!.steps = response.project.episodes[0]!.steps!.map((step) => step.id === "source-material" ? { ...step, status: "approved" } : step);
  response.project.selectedModels = { text: { kind: "text", providerID: "text-provider", modelID: "text-model" } };
  const textNode = {
    id: "script-node", kind: "text" as const, position: { x: 20, y: 30 }, handles: [],
    data: { contentRef: "content/nodes/script-node.md" as const },
  };
  const initialCanvas = { ...canvas(), nodes: [textNode], selectedNodeId: textNode.id };
  let createdInput: Record<string, unknown> | null = null;
  let terminal = false;
  const baseJob: ToonTextJob = {
    schemaVersion: 1, id: "text-job-1", workspaceId: "workspace-1", projectId: "project-1",
    episodeId: "episode-1", canvasId: "episode-1-canvas", nodeId: "script-node", stage: "content-script",
    action: "script", selectedModel: { kind: "text", providerID: "text-provider", modelID: "text-model" },
    outputSchema: TOON_TEXT_OUTPUT_SCHEMAS.script,
    requestSnapshot: {
      projectId: "project-1", action: "script", prompt: "Write the pilot", episodeId: "episode-1",
      canvasId: "episode-1-canvas", nodeId: "script-node", stage: "content-script",
      selectedModel: { kind: "text", providerID: "text-provider", modelID: "text-model" },
      outputSchema: TOON_TEXT_OUTPUT_SCHEMAS.script, contentApproved: true,
    },
    status: "queued", createdAt: NOW, updatedAt: NOW,
  };
  const recoverable = projectResponse();
  recoverable.project.episodes[0]!.steps = recoverable.project.episodes[0]!.steps!.map((step) => step.id === "source-material" ? { ...step, status: "approved" } : step);
  recoverable.project.selectedModels = response.project.selectedModels;
  recoverable.project.episodes[0]!.steps = recoverable.project.episodes[0]!.steps!.map((step) => step.id === "episode-script" ? { ...step, status: "queued", generationJobId: baseJob.id } : step);
  const completed: ToonTextJob = {
    ...baseJob, status: "completed", completedAt: NOW,
    result: {
      workflowRecordId: "result-1", resultRef: "generations/manifests/text-job-1.json",
      contentRef: "content/nodes/script-node.text-job-1.md", outputRevision: "b".repeat(64),
      output: { title: "Pilot", logline: "A beginning", scenes: [{ id: "scene-1", heading: "INT.", summary: "Start", dialogue: [{ speaker: "A", line: "Hi" }] }] },
    },
  };
  const client = {
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => terminal ? recoverable : response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: initialCanvas, revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: REVISION }),
    readToonText: async () => ({ nodeId: "script-node", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "script-node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
    createToonTextJob: async (_workspaceId: string, _projectId: string, input: Record<string, unknown>) => { createdInput = input; return { job: baseJob }; },
    getToonTextJob: async () => ({ job: completed }),
    cancelToonTextJob: async () => ({ job: { ...baseJob, status: "cancelled" as const } }),
  };
  const props = { ...workbenchProps, textModels: [{ providerID: "text-provider", modelID: "text-model", providerName: "Text", modelName: "Model", providerSource: "api" as const }] };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...props} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  await waitForTestId(renderer!, "toon-text-generation");
  const run = renderer!.root.findByProps({ "data-testid": "toon-text-run" });
  expect(run.props.disabled).toBe(true);
  await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-text-prompt" }).props.onChange({ target: { value: "Write the pilot" } }); });
  expect(renderer!.root.findByProps({ "data-testid": "toon-text-request-preview" }).children.join("")).toContain("Write the pilot");
  await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-text-content-approval" }).props.onChange({ target: { checked: true } }); });
  expect(renderer!.root.findByProps({ "data-testid": "toon-text-run" }).props.disabled).toBe(false);
  await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-text-prompt" }).props.onChange({ target: { value: "Write a different pilot" } }); });
  expect(renderer!.root.findByProps({ "data-testid": "toon-text-run" }).props.disabled).toBe(true);
  await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-text-prompt" }).props.onChange({ target: { value: "Write the pilot" } }); });
  expect(renderer!.root.findByProps({ "data-testid": "toon-text-run" }).props.disabled).toBe(false);
  await act(async () => { await renderer!.root.findByProps({ "data-testid": "toon-text-run" }).props.onClick(); });
  expect(createdInput).toMatchObject({ action: "script", prompt: "Write the pilot", contentApproved: true });
  await act(async () => { renderer!.unmount(); });

  terminal = true;
  let recovered: TestRenderer.ReactTestRenderer;
  await act(async () => { recovered = render(<ToonFactoryWorkbench {...props} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(recovered!, "toon-text-job-result");
    expect(recovered!.root.findByProps({ "data-testid": "toon-text-job-result" })).toBeDefined();
  } finally {
    await act(async () => { recovered!.unmount(); });
  }
});

test("suspends retained text/media/delivery queries and preview downloads while hidden", async () => {
  const response = projectResponse();
  response.project.selectedModels = { text: { kind: "text", providerID: "text-provider", modelID: "text-model" } };
  response.project.episodes[0]!.steps = response.project.episodes[0]!.steps!.map((step) => step.id === "episode-script" ? { ...step, generationJobId: "job-1" } : step);
  const textNode = { id: "script-node", kind: "text" as const, position: { x: 20, y: 30 }, handles: [], data: { contentRef: "content/nodes/script-node.md" as const } };
  const hiddenCanvas = { ...canvas(), nodes: [textNode], selectedNodeId: textNode.id };
  const calls = { textJob: 0, mediaJobs: 0, manifest: 0, download: 0 };
  const client = {
    ...textJobClient,
    baseUrl: "http://hidden.test",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: hiddenCanvas, revision: REVISION }),
    writeToonCanvas: async () => ({ canvas: hiddenCanvas, revision: REVISION }),
    readToonText: async () => ({ nodeId: "script-node", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "script-node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
    getToonTextJob: async () => { calls.textJob += 1; throw new Error("must stay suspended"); },
    listToonMediaJobs: async () => { calls.mediaJobs += 1; return { items: [] }; },
    getToonDeliveryManifest: async () => { calls.manifest += 1; return { manifest: null, path: null, revision: null }; },
    downloadWorkspaceFile: async () => { calls.download += 1; return { data: new ArrayBuffer(0), contentType: "image/png" }; },
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId="project-1" visible={false} sidebarOpen onSelectProject={() => {}} />); });
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(calls).toEqual({ textJob: 0, mediaJobs: 0, manifest: 0, download: 0 });
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("revokes loaded media preview blobs and stops polling after a retained page is hidden", async () => {
  const response = projectResponse();
  response.project.selectedModels = { image: { kind: "image", providerID: "images", modelID: "painter" } };
  const imageNode = { id: "image-node", kind: "image-generation" as const, position: { x: 20, y: 30 }, handles: [], data: { label: "Hero" } };
  const imageCanvas = { ...canvas(), nodes: [imageNode], selectedNodeId: imageNode.id };
  const job = {
    schemaVersion: 1 as const, id: "image-job", workspaceId: "workspace-1", projectId: "project-1", episodeId: "episode-1", canvasId: "episode-1-canvas", nodeId: "image-node", stepId: "image-candidates", kind: "image" as const,
    requestSnapshot: { requestId: "request-1", projectId: "project-1", episodeId: "episode-1", canvasId: "episode-1-canvas", nodeId: "image-node", stepId: "image-candidates", plan: { kind: "image" as const, model: { kind: "image" as const, providerID: "images", modelID: "painter" }, object: "Hero", quantity: 1, prompt: "Hero", referencePaths: [], referenceScope: "workspace" as const, mode: "text-to-image" as const, size: "1024x1024", executionCount: 1, knownCost: null } },
    requestHash: REVISION, authorization: { id: "auth-1", scopeHash: REVISION, authorizedAt: NOW }, status: "awaiting-review" as const,
    candidates: [{ id: "candidate-1", ordinal: 1, status: "awaiting-review" as const, runtime: "openai-image-generation" as const, artifact: { scope: "workspace" as const, path: "artifacts/hero.png", mimeType: "image/png", bytes: 8 }, provenance: { model: { kind: "image" as const, providerID: "images", modelID: "painter" }, prompt: "Hero", mode: "text-to-image", referencePaths: [], referenceScope: "workspace" as const, parameters: {} }, review: { decision: "pending" as const }, createdAt: NOW, updatedAt: NOW }],
    createdAt: NOW, updatedAt: NOW,
  };
  let listCalls = 0;
  let downloads = 0;
  const revoked: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:preview-1" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => revoked.push(url) });
  const client = {
    ...textJobClient,
    baseUrl: "http://preview.test",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: imageCanvas, revision: REVISION }),
    writeToonCanvas: async () => ({ canvas: imageCanvas, revision: REVISION }),
    readToonText: async () => ({ nodeId: "image-node", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "image-node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => ({ image: { mode: "text-to-image" as const, models: [{ ref: { providerID: "images", modelID: "painter" }, providerName: "Images", modelName: "Painter", capabilities: { textToImage: true } }] }, video: modelCatalog.video }),
    listToonMediaJobs: async () => { listCalls += 1; return { items: [job] }; },
    downloadWorkspaceFile: async () => { downloads += 1; return { data: new Uint8Array([0x89, 0x50]).buffer, contentType: "image/png", filename: null }; },
  };
  const ui = (visible: boolean) => <ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId="project-1" visible={visible} sidebarOpen onSelectProject={() => {}} />;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(ui(true)); });
  try {
    await waitForTestId(renderer!, "toon-node-image-generation");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-factory-stage-images" }).props.onClick(); });
    await waitForTestId(renderer!, "toon-media-candidate-candidate-1");
    for (let attempt = 0; attempt < 20 && downloads === 0; attempt += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(downloads).toBe(1);
    await act(async () => { renderer!.update(<QueryClientProvider client={(renderer!.root.findByType(QueryClientProvider).props.client)}>{ui(false)}</QueryClientProvider>); });
    const callsWhenHidden = listCalls;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_050)); });
    expect(listCalls).toBe(callsWhenHidden);
    expect(downloads).toBe(1);
    expect(revoked).toContain("blob:preview-1");
  } finally {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
    await act(async () => { renderer!.unmount(); });
  }
});

test("previews an exact media plan and invalidates scoped authorization when the plan changes", async () => {
  const response = projectResponse();
  response.project.episodes[0]!.steps = response.project.episodes[0]!.steps!.map((step) => ["storyboard", "asset-plan"].includes(step.id) ? { ...step, status: "approved" } : step);
  response.project.selectedModels = { image: { kind: "image", providerID: "images", modelID: "painter" } };
  const imageNode = { id: "image-node", kind: "image-generation" as const, position: { x: 20, y: 30 }, handles: [], data: { label: "Hero" } };
  const imageCanvas = { ...canvas(), nodes: [imageNode], selectedNodeId: imageNode.id };
  let authorizedInput: Record<string, unknown> | null = null;
  const client = {
    ...textJobClient,
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: imageCanvas, revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: REVISION }),
    readToonText: async () => ({ nodeId: "image-node", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "image-node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => ({
      image: { mode: "text-to-image" as const, models: [{ ref: { providerID: "images", modelID: "painter" }, providerName: "Images", modelName: "Painter", capabilities: { protocol: "openai" as const, textToImage: true } }] },
      video: modelCatalog.video,
    }),
    authorizeToonMediaJob: async (_workspaceId: string, _projectId: string, input: Record<string, unknown>) => {
      authorizedInput = input;
      return { requestSnapshot: { ...input, projectId: "project-1" }, requestHash: "b".repeat(64), planFingerprint: "b".repeat(64), planSummary: (input as any).plan, authorizationId: "authorization-1", expiresAt: NOW };
    },
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-node-image-generation");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-factory-stage-images" }).props.onClick(); });
    await waitForTestId(renderer!, "toon-media-generation");
    await act(async () => {
      renderer!.root.findByProps({ "data-testid": "toon-media-object" }).props.onChange({ target: { value: "Hero portrait" } });
      renderer!.root.findByProps({ "data-testid": "toon-media-prompt" }).props.onChange({ target: { value: "Cinematic hero portrait" } });
      renderer!.root.findByProps({ "data-testid": "toon-media-execution-count" }).props.onChange({ target: { value: "2" } });
    });
    const preview = renderer!.root.findByProps({ "data-testid": "toon-media-plan-preview" }).children.join("");
    expect(preview).toContain("Cinematic hero portrait");
    expect(preview).toContain("Compute consumption unknown");
    expect(preview).toContain('"executionCount": 2');
    await act(async () => { await renderer!.root.findByProps({ "data-testid": "toon-media-authorize" }).props.onClick(); });
    expect(authorizedInput).toMatchObject({ plan: { model: { providerID: "images", modelID: "painter" }, object: "Hero portrait", executionCount: 2, size: "1024x1024" } });
    expect(renderer!.root.findByProps({ "data-testid": "toon-media-submit" }).props.disabled).toBe(false);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-media-prompt" }).props.onChange({ target: { value: "Changed prompt" } }); });
    expect(renderer!.root.findByProps({ "data-testid": "toon-media-submit" }).props.disabled).toBe(true);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("ignores an authorization response after the exact media plan changes", async () => {
  const response = projectResponse();
  response.project.episodes[0]!.steps = response.project.episodes[0]!.steps!.map((step) => ["storyboard", "asset-plan"].includes(step.id) ? { ...step, status: "approved" } : step);
  response.project.selectedModels = { image: { kind: "image", providerID: "images", modelID: "painter" } };
  const imageNode = { id: "image-node", kind: "image-generation" as const, position: { x: 20, y: 30 }, handles: [], data: { label: "Hero" } };
  let resolveAuthorization!: (value: any) => void;
  const client = {
    ...textJobClient,
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: { ...canvas(), nodes: [imageNode], selectedNodeId: imageNode.id }, revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: REVISION }),
    readToonText: async () => ({ nodeId: "image-node", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "image-node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => ({ image: { mode: "text-to-image" as const, models: [{ ref: { providerID: "images", modelID: "painter" }, providerName: "Images", modelName: "Painter", capabilities: { protocol: "openai" as const, textToImage: true } }] }, video: modelCatalog.video }),
    authorizeToonMediaJob: async (_workspaceId: string, _projectId: string, input: any) => new Promise((resolve) => { resolveAuthorization = resolve; }).then(() => ({ requestSnapshot: { ...input, projectId: "project-1" }, requestHash: "b".repeat(64), planFingerprint: "b".repeat(64), planSummary: input.plan, authorizationId: "late-authorization", expiresAt: NOW })),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer, "toon-node-image-generation");
    await act(async () => { renderer.root.findByProps({ "data-testid": "toon-factory-stage-images" }).props.onClick(); });
    await waitForTestId(renderer, "toon-media-generation");
    await act(async () => {
      renderer.root.findByProps({ "data-testid": "toon-media-object" }).props.onChange({ target: { value: "Hero" } });
      renderer.root.findByProps({ "data-testid": "toon-media-prompt" }).props.onChange({ target: { value: "Original" } });
    });
    await act(async () => { renderer.root.findByProps({ "data-testid": "toon-media-authorize" }).props.onClick(); });
    await act(async () => { renderer.root.findByProps({ "data-testid": "toon-media-prompt" }).props.onChange({ target: { value: "Changed while authorizing" } }); });
    await act(async () => { resolveAuthorization(undefined); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(renderer.root.findByProps({ "data-testid": "toon-media-submit" }).props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ "data-testid": "toon-media-authorized-plan-summary" })).toHaveLength(0);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test("shows adopted outputs, omissions, safe download affordances, and truthful out-of-scope delivery labels", async () => {
  const response = projectResponse();
  response.project.episodes[0]!.steps = response.project.episodes[0]!.steps!.map((step) => step.id === "video-clips" ? {
    ...step,
    status: "adopted",
    resultAdoptions: [{ id: "adoption-1", resultId: "candidate-1", artifactPath: "artifacts/clip.mp4", artifactScope: "workspace", adoptedAt: NOW }],
  } : step);
  const manifest = {
    schemaVersion: 1 as const, manifestVersion: 1 as const, id: "manifest-1", projectId: "project-1", episodeId: "episode-1", createdAt: NOW,
    artifacts: [{ id: "adoption-1", kind: "video" as const, path: "artifacts/clip.mp4", scope: "workspace" as const, mimeType: "video/mp4", bytes: 12, adoptionId: "adoption-1", generationRecordId: "job-1", candidateId: "candidate-1", provenance: { model: { kind: "video" as const, providerID: "provider", modelID: "model" }, prompt: "clip prompt", mode: "text-to-video", referencePaths: [], referenceScope: "workspace" as const, parameters: {} } }],
    omissions: [{ kind: "image" as const, code: "no_adopted_output" as const, reason: "No image output has been adopted for this episode." }],
    deliveryType: "adopted-media-and-manifest" as const,
    composition: { status: "not-produced" as const, excludedCapabilities: ["timeline", "composition", "subtitles", "audio-mixing"] as const },
  };
  let stored: typeof manifest | null = null;
  const client = {
    ...textJobClient,
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    writeToonCanvas: async (_workspaceId: string, _projectId: string, _canvasId: string, input: { canvas: ToonCanvas }) => ({ canvas: input.canvas, revision: REVISION }),
    readToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
    getToonDeliveryManifest: async () => ({ manifest: stored, path: stored ? "toons/series/exports/episodes/episode-1/delivery-manifest.json" : null, revision: stored ? "b".repeat(64) : null }),
    createToonDeliveryManifest: async () => { stored = manifest; return { manifest, path: "toons/series/exports/episodes/episode-1/delivery-manifest.json", revision: "b".repeat(64) }; },
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-factory-stage-adoption-delivery");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-factory-stage-adoption-delivery" }).props.onClick(); });
    await waitForTestId(renderer!, "toon-create-manifest");
    const truthful = renderer!.root.findByProps({ "data-testid": "toon-delivery-out-of-scope" }).children.join("");
    expect(truthful).toContain("No composed film or complete-film export is claimed");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Timeline editing, composition, subtitles, and audio mixing are out of scope");
    await act(async () => { await renderer!.root.findByProps({ "data-testid": "toon-create-manifest" }).props.onClick(); });
    await waitForTestId(renderer!, "toon-delivery-artifacts");
    const deliveryJson = JSON.stringify(renderer!.toJSON());
    expect(deliveryJson).toContain("Adopted clip");
    expect(deliveryJson).toContain("artifacts/clip.mp4");
    expect(deliveryJson).toContain("No output has been adopted");
    expect(renderer!.root.findByProps({ "data-testid": "toon-download-manifest" })).toBeDefined();
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("marks an older delivery manifest stale and blocks download", async () => {
  const response = projectResponse();
  response.project.episodes[0]!.steps = response.project.episodes[0]!.steps!.map((step) => step.id === "video-clips" ? {
    ...step,
    status: "adopted",
    resultAdoptions: [{ id: "adoption-1", resultId: "candidate-1", artifactPath: "artifacts/clip.mp4", artifactScope: "workspace", adoptedAt: "2026-10-17T12:00:00.000Z" }],
  } : step);
  const manifest = {
    schemaVersion: 1 as const, manifestVersion: 1 as const, id: "manifest-1", projectId: "project-1", episodeId: "episode-1", createdAt: NOW,
    artifacts: [], omissions: [], deliveryType: "adopted-media-and-manifest" as const,
    composition: { status: "not-produced" as const, excludedCapabilities: ["timeline", "composition", "subtitles", "audio-mixing"] as const },
  };
  const client = {
    ...textJobClient,
    baseUrl: "http://127.0.0.1:8787",
    listToonProjects: async () => ({ schemaVersion: 1 as const, items: [{ id: "project-1", name: "Series", directory: "toons/series", updatedAt: NOW, episodeCount: 1, revision: REVISION }] }),
    createToonProject: async () => response,
    getToonProject: async () => response,
    updateToonProject: async () => response,
    readToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    writeToonCanvas: async () => ({ canvas: canvas(), revision: REVISION }),
    readToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    writeToonText: async () => ({ nodeId: "node", content: "", revision: REVISION }),
    getToonModelCatalog: async () => modelCatalog,
    getToonDeliveryManifest: async () => ({ manifest, path: "exports/manifest.json", revision: REVISION }),
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = render(<ToonFactoryWorkbench {...workbenchProps} client={client} workspaceId="workspace-1" projectId="project-1" visible sidebarOpen onSelectProject={() => {}} />); });
  try {
    await waitForTestId(renderer!, "toon-factory-stage-adoption-delivery");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "toon-factory-stage-adoption-delivery" }).props.onClick(); });
    await waitForTestId(renderer!, "toon-delivery-stale");
    expect(renderer!.root.findByProps({ "data-testid": "toon-download-manifest" }).props.disabled).toBe(true);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});
