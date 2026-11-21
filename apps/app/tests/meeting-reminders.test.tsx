import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let enabled = false;
const teamScope = "team:org:me";
let scope: string | null;
const listeners = new Set<() => void>();
const toggle = (value: boolean) => act(async () => { enabled = value; listeners.forEach(fn => fn()); });
mock.module("../src/react-app/domains/meeting/meeting-preferences", () => ({
  readMeetingPreferences: () => ({ meetingReminders: enabled }),
  updateMeetingPreferences: ({ meetingReminders }: { meetingReminders: boolean }) => toggle(meetingReminders),
  subscribeMeetingPreferences: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
}));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ user: { id: "me" }, activeOrganization: { id: "org" } }),
}));
mock.module("../src/react-app/domains/meeting/meeting-request-scope", () => ({
  useMeetingRequestScope: () => scope,
  isMeetingRequestScopeCurrent: (expectedScope: string) => expectedScope === scope,
}));
const accepted = { id: "accepted", title: "评审", startAt: "", status: "scheduled", organizerId: "other", invites: { me: "accepted" } };
const response = { meetings: [{ ...accepted, id: "pending", invites: { me: "pending" } }, accepted] };
const list = mock(async () => response);
class MeetingRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MeetingRequestError";
  }
}
mock.module("../src/react-app/domains/meeting/api", () => ({ meetingAPI: { list }, MeetingRequestError }));
const { MeetingReminderHost } = await import("../src/react-app/domains/meeting/meeting-reminders");

const browserGlobals = ["window", "sessionStorage"];
let original: (PropertyDescriptor | undefined)[];
let events: EventTarget;
let shown: Map<string, string>;
let tree: ReactTestRenderer | undefined;

beforeEach(() => {
  enabled = true;
  scope = teamScope;
  list.mockReset().mockResolvedValue(response);
  jest.useFakeTimers();
  accepted.startAt = new Date(Date.now()).toISOString();
  response.meetings[0]!.startAt = accepted.startAt;
  events = new EventTarget();
  shown = new Map();
  original = browserGlobals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => shown.get(k), setItem: (k: string, v: string) => shown.set(k, v) } });
});

afterEach(async () => {
  try {
    await act(async () => { tree?.unmount(); });
  } finally {
    tree = undefined;
    jest.useRealTimers();
    browserGlobals.forEach((key, i) => {
      const descriptor = original[i];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  expect(listeners.size).toBe(0);
});

const renderHost = () => act(async () => {
  const host = <MemoryRouter initialEntries={["/settings"]}><MeetingReminderHost /></MemoryRouter>;
  if (tree) tree.update(host);
  else tree = create(host);
});
const meetingChanged = () => act(async () => { events.dispatchEvent(new Event("meeting:changed")); });
const tick = () => act(async () => { jest.advanceTimersByTime(30_000); });

function deferNextList() {
  let finish!: (value: typeof response) => void;
  list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  return () => act(async () => { finish(response); });
}

test("live preference gates polling and delivery; disabling does not consume a pending result or replay a shown card", async () => {
  enabled = false;
  const finish = deferNextList();
  await renderHost();
  await meetingChanged();
  expect(list).not.toHaveBeenCalled();
  await toggle(true);
  expect(list).toHaveBeenCalledTimes(1);
  await toggle(false);
  await meetingChanged();
  await finish();
  expect(list).toHaveBeenCalledTimes(1);
  expect(shown.size).toBe(0);
  expect(tree!.toJSON()).toBeNull();

  await toggle(true);
  expect(tree!.root.findByProps({ role: "status" }).findAllByType("p")[0]!.children).toEqual([accepted.title]);
  expect([...shown.keys()]).toEqual([`meeting.reminder:org:me:accepted:${accepted.startAt}`]);
  await toggle(false);
  expect(tree!.toJSON()).toBeNull();
  await toggle(true);
  expect(tree!.toJSON()).toBeNull();
});

test("waits for a team scope before listing, then starts reminders outside the meeting route", async () => {
  scope = null;
  await renderHost();
  expect(list).not.toHaveBeenCalled();
  await tick();
  await meetingChanged();
  expect(list).not.toHaveBeenCalled();

  scope = teamScope;
  await renderHost();
  expect(list).toHaveBeenCalledTimes(1);
  expect(tree!.root.findByProps({ role: "status" }).findAllByType("p")[0]!.children).toEqual([accepted.title]);
});

test("clearing the scope discards an in-flight reminder and stops polling", async () => {
  const finish = deferNextList();
  await renderHost();
  expect(list).toHaveBeenCalledTimes(1);

  scope = null;
  // The old request can finish before React renders the scope change.
  await finish();
  expect(shown.size).toBe(0);
  expect(tree!.toJSON()).toBeNull();

  await renderHost();
  await tick();
  await meetingChanged();
  expect(list).toHaveBeenCalledTimes(1);
});

test("a 403 stops automatic refresh until a new scope starts polling", async () => {
  list.mockRejectedValueOnce(new MeetingRequestError(403, "Forbidden"));
  await renderHost();
  expect(list).toHaveBeenCalledTimes(1);
  await tick();
  await meetingChanged();
  expect(list).toHaveBeenCalledTimes(1);
  expect(tree!.toJSON()).toBeNull();

  scope = `${teamScope}:new`;
  await renderHost();
  expect(list).toHaveBeenCalledTimes(2);
  expect(tree!.root.findByProps({ role: "status" }).findAllByType("p")[0]!.children).toEqual([accepted.title]);
  await tick();
  expect(list).toHaveBeenCalledTimes(3);
});
