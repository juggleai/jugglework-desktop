import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h)");
const timeZone = z.string().trim().min(1).max(64);
const contactRef = z.string().trim().regex(/^contact:[0-9a-z]+:.+$/, "must be a ref from contacts.search").max(300);
const chatRef = z.string().trim().regex(/^(contact|group):[0-9a-z]+:.+$/, "must be a ref from contacts.search or chats.search").max(300);

/** Arguments the model may give for a calendar event; never a calendar owner, org or API path. */
export const calendarPrepareArgs = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  allDay: z.boolean().optional(),
  date,
  endDate: date.optional(),
  startTime: time.optional(),
  endTime: time.optional(),
  timeZone: timeZone.optional(),
  attendees: z.array(contactRef).max(50).optional(),
  calendarId: z.string().trim().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.allDay) {
    if (value.startTime || value.endTime) ctx.addIssue({ code: "custom", message: "all-day events take no startTime/endTime" });
  } else if (!value.startTime || !value.endTime) {
    ctx.addIssue({ code: "custom", message: "timed events need startTime and endTime" });
  }
});

export const meetingPrepareArgs = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional(),
  immediate: z.boolean(),
  date: date.optional(),
  startTime: time.optional(),
  durationMinutes: z.number().int().min(5).max(1440).optional(),
  timeZone: timeZone.optional(),
  invitees: z.array(contactRef).max(100).optional(),
  /** Off unless the user asked: notifying sends a meeting card to every invitee. */
  notifyInvitees: z.boolean().optional(),
  /** Chats that also receive the meeting card after the meeting exists. */
  shareTo: z.array(chatRef).max(10).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.immediate && (!value.date || !value.startTime))
    ctx.addIssue({ code: "custom", message: "scheduled meetings need date and startTime" });
  if (value.immediate && (value.date || value.startTime))
    ctx.addIssue({ code: "custom", message: "instant meetings start now; omit date and startTime" });
  if (value.notifyInvitees && !value.invitees?.length)
    ctx.addIssue({ code: "custom", message: "notifyInvitees needs invitees" });
});

export const imPrepareArgs = z.object({
  to: chatRef,
  text: z.string().min(1).max(2000).refine((value) => value.trim().length > 0, "text is empty"),
}).strict();

export const chatsSearchArgs = z.object({
  query: z.string().trim().min(1).max(100),
}).strict();

export type NativeWriteAction = "calendar.create" | "meeting.create" | "im.send";
