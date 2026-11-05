# Calendar HTTP contract v1

本文件固定 `add-cloud-calendar-core` 的 Desktop/Server wire contract。行为需求仍以 capability specs 为准；实现和 fixture 必须遵守本文件的精确字段、路由、限制与错误码。

## Common rules

- Base path: `/v1`（部署层可在 origin 前增加 `/api` 等 base path）。
- 所有路由要求现有 session 和 organization membership；组织由现有 organization header 选择，body 不接受 organization 或 owner。
- JSON mutation body 最大 1 MiB，使用严格解码：拒绝未知字段、多个 JSON 值和后续阶段字段。
- ID、cursor 和 idempotency key 均为不透明字符串。idempotency key 长度为 1–128。
- 版本、sequence 必须是正安全整数。
- 普通读取不返回 tombstone；删除通过 mutation response 和 changes feed 表达。
- 分页默认 `50`、最大 `100`；`hasMore: true` 时 `nextCursor` 必须是非空字符串。
- 日期范围为 `[startDate, endDateExclusive)`，格式严格为 `YYYY-MM-DD`，最大跨度 `366` 天。
- `calendarId` query 可重复，先去重，最多 `20` 个；未提供表示所有活动个人日历。
- Calendar 名称 1–100 字符；Event 标题 1–500 字符；描述最多 20,000 字符；搜索文本 1–200 字符。
- 颜色为 `null` 或 `#[0-9A-Fa-f]{6}`。
- Instant 和 timestamp 使用带 offset 的 RFC 3339；服务端响应规范化为 UTC `Z`。IANA time zone 长度 1–128 且必须由服务端 tzdb 验证。

## Resources

```ts
type Calendar = {
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

type CalendarEventTime =
  | { kind: "allDay"; startDate: string; endDateExclusive: string }
  | { kind: "timed"; startInstant: string; endInstantExclusive: string; timeZone: string };

type CalendarEvent = {
  id: string;
  organizationId: string;
  ownerMemberId: string;
  calendarId: string;
  title: string;
  description: string;
  time: CalendarEventTime;
  version: number;
  createdAt: string;
  updatedAt: string;
};
```

`time` 必须恰好匹配一个分支。`allDay` 不接受 instant/timeZone 字段；`timed` 不接受日期字段。响应和请求都拒绝未知 `kind` 或分支混合。

## Routes

### Calendars

- `GET /v1/calendars` → `{ items: Calendar[] }`
- `POST /v1/calendars`
  - body: `{ idempotencyKey, name, color? }`
  - response: `{ calendar: Calendar, replayed: boolean }`
- `GET /v1/calendars/:calendarId` → `{ calendar: Calendar }`
- `PATCH /v1/calendars/:calendarId`
  - body: `{ idempotencyKey, expectedVersion, name?, color? }`
  - response: `{ calendar: Calendar, replayed: boolean }`
- `DELETE /v1/calendars/:calendarId`
  - body: `{ idempotencyKey, expectedVersion }`
  - response: `{ tombstone: { entityType: "calendar", entityId, version, deletedAt }, replayed }`

PATCH 必须至少提供一个可修改业务字段。默认 Calendar 不可删除。

### Calendar events

- `GET /v1/calendar-events?startDate&endDateExclusive&calendarId...&cursor&limit`
  - response: `{ items: CalendarEvent[], nextCursor: string | null, hasMore: boolean }`
- `GET /v1/calendar-events/search?q&calendarId...&cursor&limit`
  - response shape 同 range list
- `POST /v1/calendar-events`
  - body: `{ idempotencyKey, calendarId, title, description?, time }`
  - response: `{ event: CalendarEvent, replayed: boolean }`
- `GET /v1/calendar-events/:eventId` → `{ event: CalendarEvent }`
- `PATCH /v1/calendar-events/:eventId`
  - body: `{ idempotencyKey, expectedVersion, calendarId?, title?, description?, time? }`
  - response: `{ event: CalendarEvent, replayed: boolean }`
- `DELETE /v1/calendar-events/:eventId`
  - body: `{ idempotencyKey, expectedVersion }`
  - response: `{ tombstone: { entityType: "event", entityId, version, deletedAt }, replayed }`

### Bootstrap

- `GET /v1/calendar/bootstrap?startDate&endDateExclusive&calendarId...`
- response:

```ts
{
  calendars: Calendar[];
  events: CalendarEvent[];
  coverage: { startDate: string; endDateExclusive: string; calendarIds: string[] };
  cursor: string;
}
```

Bootstrap 是同一一致性快照，返回完整范围，不分页；若候选活动 Event 超过 `5000`，返回 `calendar_result_too_large`，客户端必须缩小范围或筛选而不能把部分结果标为完整。

### Changes

- `GET /v1/calendar/changes?cursor&limit`
- bootstrap 返回的 cursor 可作为起点；缺少 cursor 无效。
- response: `{ items: CalendarChange[], nextCursor: string, hasMore: boolean }`

```ts
type CalendarChange =
  | { sequence: number; kind: "upsert"; entityType: "calendar"; entity: Calendar }
  | { sequence: number; kind: "upsert"; entityType: "event"; entity: CalendarEvent }
  | {
      sequence: number;
      kind: "delete";
      entityType: "calendar" | "event";
      entityId: string;
      version: number;
      deletedAt: string;
    };
```

## Error envelope

沿用 `{ error, message, details }`：

| Code | HTTP | Details |
|---|---:|---|
| `invalid_calendar_request` | 400 | 可选字段错误映射 |
| `calendar_not_found` | 404 | 空；不存在、已删除、跨 owner/组织一致 |
| `calendar_disabled` | 404 | 空，fail closed |
| `calendar_write_disabled` | 403 | 空 |
| `calendar_version_conflict` | 409 | `{ current: Calendar | CalendarEvent }`；若资源已不可见则改为 not found |
| `calendar_idempotency_conflict` | 409 | 空，不回传原作用域内容 |
| `calendar_cursor_resync_required` | 409 | `{ reason: "invalid" | "scope_mismatch" | "expired" | "version_unsupported" }` |
| `calendar_result_too_large` | 422 | `{ limit: 5000 }` |

认证和 membership 错误继续使用现有 401/403 契约。

## Feature capability projection

当前组织能力投影增加：

```ts
{
  calendarEnabled: boolean;
  calendarWriteEnabled: boolean;
}
```

字段缺失或畸形时 Desktop 必须按 `false` 处理。`calendarWriteEnabled` 只有在 `calendarEnabled` 为 true 时才可为 true。disabled gate 不得触发默认 Calendar 惰性创建。
