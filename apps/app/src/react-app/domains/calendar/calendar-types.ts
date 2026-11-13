export type Calendar = {
  id: string;
  organizationId: string;
  ownerMemberId: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CalendarEventTime =
  | { kind: "allDay"; startDate: string; endDateExclusive: string }
  | { kind: "timed"; startInstant: string; endInstantExclusive: string; timeZone: string };

export type CalendarEvent = {
  id: string;
  organizationId: string;
  ownerMemberId: string;
  calendarId: string;
  title: string;
  description: string;
  videoConferenceEnabled: boolean;
  time: CalendarEventTime;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CalendarCoverage = {
  startDate: string;
  endDateExclusive: string;
  calendarIds: string[];
};
