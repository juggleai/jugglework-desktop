import { expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let enabled = false;
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
const startAt = new Date().toISOString();
const accepted = { id: "accepted", title: "评审", startAt, status: "scheduled", organizerId: "other", invites: { me: "accepted" } };
const response = { meetings: [{ ...accepted, id: "pending", invites: { me: "pending" } }, accepted] };
const list = mock(async () => response);
mock.module("../src/react-app/domains/meeting/api", () => ({ meetingAPI: { list } }));
const { MeetingReminderHost } = await import("../src/react-app/domains/meeting/meeting-reminders");

test("live preference gates polling and delivery; disabling does not consume a pending result or replay a shown card", async () => {
  const events = new EventTarget();
  const shown = new Map<string, string>();
  const original = ["window", "sessionStorage"].map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => shown.get(k), setItem: (k: string, v: string) => shown.set(k, v) } });
  let tree: ReactTestRenderer | undefined;
  let finish!: (value: typeof response) => void;
  list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  try {
    await act(async () => { tree = create(<MemoryRouter><MeetingReminderHost /></MemoryRouter>); });
    events.dispatchEvent(new Event("meeting:changed"));
    expect(list).not.toHaveBeenCalled();
    await toggle(true);
    expect(list).toHaveBeenCalledTimes(1);
    await toggle(false);
    events.dispatchEvent(new Event("meeting:changed"));
    await act(async () => { finish(response); });
    expect(list).toHaveBeenCalledTimes(1);
    expect(shown.size).toBe(0);
    expect(tree!.toJSON()).toBeNull();

    await toggle(true);
    expect(tree!.root.findByProps({ role: "status" }).findAllByType("p")[0]!.children).toEqual([accepted.title]);
    expect([...shown.keys()]).toEqual([`meeting.reminder:org:me:accepted:${startAt}`]);
    await toggle(false);
    expect(tree!.toJSON()).toBeNull();
    await toggle(true);
    expect(tree!.toJSON()).toBeNull();
  } finally {
    await act(async () => { tree?.unmount(); });
    ["window", "sessionStorage"].forEach((key, i) => { if (original[i]) Object.defineProperty(globalThis, key, original[i]!); else Reflect.deleteProperty(globalThis, key); });
  }
  expect(listeners.size).toBe(0);
});
