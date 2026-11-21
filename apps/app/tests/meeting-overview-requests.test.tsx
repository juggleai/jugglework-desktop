import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { writeDenSettings, writeDenUserId, type DenOrgSummary } from "../src/app/lib/den";

const team: DenOrgSummary = { id: "team-a", name: "Team", slug: "team", role: "member", kind: "organization" };
const personal: DenOrgSummary = { ...team, id: "personal_a", slug: "personal", kind: "personal" };
let organization: DenOrgSummary | null;
let signedIn: boolean;
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ isSignedIn: signedIn, activeOrganization: organization, user: { id: "user-a" } }),
}));
const { useMeetingRequestScope } = await import("../src/react-app/domains/meeting/meeting-request-scope");
const { useMeetingOverview } = await import("../src/react-app/domains/meeting/use-meeting-overview");

const from = new Date("2026-11-01T00:00:00Z");
const to = new Date("2026-12-01T00:00:00Z");
function Harness({ active }: { active: boolean }) {
  const scope = useMeetingRequestScope();
  return scope ? <Overview key={scope} active={active} scope={scope} /> : null;
}
function Overview({ active, scope }: { active: boolean; scope: string }) {
  const { items, error, refresh } = useMeetingOverview({ active, scope, from, to });
  return <button onClick={refresh}>{error || items.map(item => item.title).join(",")}</button>;
}

let tree: ReactTestRenderer | undefined;
let events: EventTarget;
let previousWindow: PropertyDescriptor | undefined;
let previousActEnvironment: PropertyDescriptor | undefined;
const recordRequests = () => spyOn(globalThis, "fetch").mockImplementation(async (input) => success(input));
let fetchMock: ReturnType<typeof recordRequests>;
const success = (input: RequestInfo | URL, title = "Team meeting") => Response.json(
  String(input).endsWith("/settings") ? { ready: true } : { meetings: [{ id: "meeting-a", title }] },
);

beforeEach(() => {
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  events = new EventTarget();
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(events, { localStorage, setInterval, clearInterval }) });
  fetchMock = recordRequests();
  organization = team;
  signedIn = true;
  writeDenUserId("user-a");
  setOrganization(team.id);
  jest.useFakeTimers();
  Object.assign(events, { setInterval, clearInterval });
});

afterEach(async () => {
  try {
    await act(async () => tree?.unmount());
  } finally {
    tree = undefined;
    jest.useRealTimers();
    fetchMock.mockRestore();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousActEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
});

function setOrganization(activeOrgId: string | null) {
  writeDenSettings({ baseUrl: "https://meetings.example.test", authToken: "fixture-session", activeOrgId });
}
async function render(active: boolean) {
  await act(async () => {
    const element = <StrictMode><Harness active={active} /></StrictMode>;
    if (tree) tree.update(element);
    else tree = create(element);
  });
}
async function triggerAutomaticRefresh() {
  await act(async () => {
    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("meeting:changed"));
    jest.advanceTimersByTime(30_000);
  });
}

test("only a visible overview with a confirmed team scope fetches, once under StrictMode", async () => {
  await render(false);
  await triggerAutomaticRefresh();
  expect(fetchMock).not.toHaveBeenCalled();

  await act(async () => setOrganization(null)); // A menu fallback still points to Team.
  await render(true);
  expect(fetchMock).not.toHaveBeenCalled();

  organization = personal;
  await act(async () => setOrganization(personal.id));
  await render(true);
  await triggerAutomaticRefresh();
  expect(fetchMock).not.toHaveBeenCalled();

  organization = { ...team, kind: undefined };
  await act(async () => setOrganization(team.id));
  await render(true);
  expect(fetchMock).not.toHaveBeenCalled();

  organization = team;
  await render(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    "/jwork/api/v1/meetings/settings", "/jwork/api/v1/meetings",
  ]);
  await render(false);
  await triggerAutomaticRefresh();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("switching scopes aborts an older overview and ignores the late response", async () => {
  let finish!: (response: Response) => void;
  let oldSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementationOnce(async (input, init) => {
    oldSignal = init?.signal;
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  fetchMock.mockImplementationOnce(async (input) => success(input, "Old organization"));
  await render(true);

  organization = { ...team, id: "team-b" };
  await act(async () => setOrganization(organization!.id));
  await render(true);
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ ready: true })));
  expect(tree!.root.findByType("button").children).toEqual(["Team meeting"]);
});

test("a meeting 403 pauses automatic refresh, but a manual refresh can recover", async () => {
  fetchMock.mockImplementationOnce(async () => Response.json({ error: "feature_unavailable_for_scope" }, { status: 403 }));
  await render(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(tree!.root.findByType("button").children).toEqual(["个人工作区不支持视频会议。"]);
  await triggerAutomaticRefresh();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => tree!.root.findByType("button").props.onClick());
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(tree!.root.findByType("button").children).toEqual(["Team meeting"]);
});
