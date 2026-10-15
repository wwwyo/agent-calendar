import { describe, expect, test } from "bun:test";
import type { CalendarEvent } from "../calendar/adapter";
import type { Workspace } from "../config";
import { DEMO_EXPIRES_TAG } from "../runner";
import type { Run } from "../store/store";
import { calendarItems, weekRange } from "./calendar";
import { automationEvent } from "./demo";

const ws: Workspace = {
  id: "demo",
  label: "Demo",
  visibility: "public",
  timeZone: "Asia/Tokyo",
  calendars: { automation: "a", records: "r" },
  allowedCreators: ["me@example.com"],
};
const ev = (p: Partial<CalendarEvent>): CalendarEvent => ({ id: "e1", status: "confirmed", summary: "t", notes: "", tags: {}, creatorEmail: "me@example.com", ...p });
const now = Date.parse("2026-10-15T12:00:00+09:00");

describe("weekRange", () => {
  test("tz の0時から7日を返し、遠すぎる週は拒む", () => {
    const r = weekRange("2026-10-12", ws, now)!;
    expect(new Date(r.from).toISOString()).toBe("2026-10-11T15:00:00.000Z");
    expect(new Date(r.to).toISOString()).toBe("2026-10-18T15:00:00.000Z");
    expect(weekRange("2020-01-01", ws, now)).toBeUndefined();
    expect(weekRange("x", ws, now)?.start).toBe("2026-10-15");
  });
});

describe("calendarItems", () => {
  const { from, to } = weekRange("2026-10-12", ws, now)!;
  test("繰り返しを週の範囲で展開し、セッション・発火しない理由・消せるかを付ける", () => {
    const run: Run = { id: "r1", fireKey: "", kind: "automation", title: "t", eventId: "daily", scheduledAt: "2026-10-15T00:00:00.000Z", startedAt: "2026-10-15T00:00:01.000Z", status: "succeeded", toolCalls: [] };
    const items = calendarItems({
      ws,
      now,
      from,
      to,
      runs: [run],
      automation: [
        ev({ id: "daily", notes: "---\nprompt: hi\n---", start: { dateTime: "2026-10-14T09:00:00+09:00", timeZone: "Asia/Tokyo" }, recurrence: ["RRULE:FREQ=DAILY;COUNT=3"], tags: { [DEMO_EXPIRES_TAG]: "x" } }),
        ev({ id: "who", creatorEmail: "x@example.com", notes: "---\nprompt: hi\n---", start: { dateTime: "2026-10-16T09:00:00+09:00" } }),
      ],
      records: [ev({ id: "due", notes: "準備: 2日前", start: { date: "2026-10-18" } })],
    });
    expect(items.map((i) => [i.role, i.id, i.date ?? i.start, i.sessions.length, !!i.blocked, i.deletable])).toEqual([
      ["automation", "daily", "2026-10-14T00:00:00.000Z", 0, false, true],
      ["automation", "daily", "2026-10-15T00:00:00.000Z", 1, false, true],
      ["automation", "daily", "2026-10-16T00:00:00.000Z", 0, false, true],
      ["automation", "who", "2026-10-16T00:00:00.000Z", 0, true, false],
      ["prep", "due", "2026-10-16T00:00:00.000Z", 0, false, false],
      ["records", "due", "2026-10-18", 0, false, false],
    ]);
  });
});

describe("calendarItems の準備の開始と壊れた終了", () => {
  test("準備の開始にその回のセッションと繰り返しを付け、終了が読めない予定は30分で描く", () => {
    const { from, to } = weekRange("2026-10-12", ws, now)!;
    const run: Run = { id: "p1", fireKey: "", kind: "prep", title: "t", eventId: "due", scheduledAt: "2026-10-16T00:00:00.000Z", startedAt: "2026-10-16T00:00:01.000Z", status: "running", toolCalls: [] };
    const items = calendarItems({
      ws,
      now,
      from,
      to,
      runs: [run],
      automation: [ev({ id: "bad", notes: "---\nprompt: hi\n---", start: { dateTime: "2026-10-16T09:00:00+09:00" }, end: { dateTime: "x" } })],
      records: [ev({ id: "due", notes: "準備: 2日前", start: { date: "2026-10-18" }, recurrence: ["RRULE:FREQ=YEARLY"] })],
    });
    const prep = items.find((i) => i.role === "prep")!;
    expect([prep.recurring, prep.sessions.map((s) => s.id)]).toEqual([true, ["p1"]]);
    expect(items.find((i) => i.id === "bad")!.minutes).toBe(30);
  });
});

describe("フォームの開始", () => {
  const f = { title: "t", repeat: "none" as const, prompt: "p" };
  test("tz の壁時計で読み、1分後〜30日後だけを受け付ける", () => {
    const e = automationEvent({ ...f, start: "2026-10-15T12:05" }, ws, now, 6);
    expect(typeof e !== "string" && e.start).toEqual({ dateTime: "2026-10-15T03:05:00.000Z", timeZone: "Asia/Tokyo" });
    expect(automationEvent({ ...f, start: "2026-10-15T12:00" }, ws, now, 6)).toBeString();
    expect(automationEvent({ ...f, start: "2026-12-01T12:00" }, ws, now, 6)).toBeString();
    expect(automationEvent({ ...f, start: "2026-02-31T12:00" }, ws, now, 6)).toBeString();
  });
});
