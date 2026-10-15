import { describe, expect, test } from "bun:test";
import type { CalendarEvent } from "../calendar/adapter";
import type { Workspace } from "../config";
import { notesToText } from "./notes";
import { parsePayload, parsePrepDays, stripPrepLines } from "./payload";
import { computeSchedule } from "./schedule";
import { occurrences } from "./time";

const ws: Workspace = {
  id: "demo",
  label: "Demo",
  visibility: "public",
  timeZone: "Asia/Tokyo",
  calendars: { automation: "a", records: "r" },
  allowedCreators: ["me@example.com"],
};

const ev = (p: Partial<CalendarEvent>): CalendarEvent => ({ id: "e1", status: "confirmed", summary: "t", notes: "", tags: {}, creatorEmail: "me@example.com", ...p });

describe("payload", () => {
  test("先頭の front matter を読む", () => {
    const r = parsePayload("\n---\nprompt: 締切を確認して\ntools: [list_deadlines]\n---\nメモ");
    expect(r).toEqual({ ok: true, payload: { prompt: "締切を確認して", tools: ["list_deadlines"] } });
  });
  test("HTML の notes も改行を保って読む", () => {
    expect(parsePayload(notesToText("---<br>prompt: hi<br>---")).ok).toBe(true);
  });
  test("知らない項目・allowlist 外の tool・先頭以外の payload は読まない", () => {
    expect(parsePayload("---\nprompt: x\nrun: rm\n---").ok).toBe(false);
    expect(parsePayload("---\nprompt: x\ntools: [shell]\n---").ok).toBe(false);
    expect(parsePayload("メモ\n---\nprompt: x\n---").ok).toBe(false);
  });
  test("準備: N日前", () => {
    expect(parsePrepDays("書類が要る\n準備：30日前")).toBe(30);
    expect(parsePrepDays("準備は30日前から")).toBeUndefined();
    expect(stripPrepLines("a\n準備: 3日前\nb")).toBe("a\nb");
  });
});

describe("occurrences", () => {
  const from = Date.parse("2026-10-15T00:00:00+09:00");
  test("tz の壁時計で毎日 9:00 に展開し、EXDATE と変更された回を外す", () => {
    const e = ev({
      start: { dateTime: "2026-10-10T09:00:00+09:00", timeZone: "Asia/Tokyo" },
      recurrence: ["RRULE:FREQ=DAILY", "EXDATE;TZID=Asia/Tokyo:20261016T090000"],
    });
    const got = occurrences(e, "Asia/Tokyo", from, from + 4 * 86400000, new Set([Date.parse("2026-10-17T09:00:00+09:00")]));
    expect(got.map((t) => new Date(t).toISOString())).toEqual(["2026-10-15T00:00:00.000Z", "2026-10-18T00:00:00.000Z"]);
  });
});

describe("computeSchedule", () => {
  const now = Date.parse("2026-10-15T12:00:00+09:00");
  test("作成者が allowlist にない・payload が読めない予定は blocked で載る", () => {
    const items = computeSchedule({
      workspace: ws,
      automation: [
        ev({ id: "ok", notes: "---\nprompt: hi\n---", start: { dateTime: "2026-10-15T13:00:00+09:00" } }),
        ev({ id: "who", creatorEmail: "x@example.com", notes: "---\nprompt: hi\n---", start: { dateTime: "2026-10-15T13:00:00+09:00" } }),
        ev({ id: "bad", notes: "hi", start: { dateTime: "2026-10-15T13:00:00+09:00" } }),
      ],
      records: [],
      from: now,
      now,
      horizon: 86400000,
    });
    expect(Object.fromEntries(items.map((i) => [i.eventId, i.blocked ? "blocked" : "ok"]))).toEqual({ ok: "ok", who: "blocked", bad: "blocked" });
  });
  test("準備は何か月先でも拾い、発火日を過ぎて登録されたら late", () => {
    const items = computeSchedule({
      workspace: ws,
      automation: [],
      records: [
        ev({ id: "far", notes: "準備: 30日前", start: { date: "2027-06-01" }, created: "2026-10-01T00:00:00Z" }),
        ev({ id: "late", notes: "準備: 30日前", start: { date: "2026-11-01" }, created: "2026-10-14T00:00:00Z" }),
        ev({ id: "none", start: { date: "2026-11-01" } }),
      ],
      from: now,
      now,
      horizon: 86400000,
    });
    expect(items.map((i) => [i.eventId, i.fireAt, i.late])).toEqual([
      ["late", "2026-10-02T00:00:00.000Z", true],
      ["far", "2027-05-02T00:00:00.000Z", false],
    ]);
  });
});

describe("propose_event の日時", () => {
  test("オフセットなしは workspace の tz の壁時計として読み、読めない形は拒む", async () => {
    const { toEventTime } = await import("../agent/tools");
    expect(toEventTime("2026-10-20T10:00", "Asia/Tokyo")).toEqual({ dateTime: "2026-10-20T01:00:00.000Z", timeZone: "Asia/Tokyo" });
    expect(toEventTime("2026-10-20T10:00:00+09:00", "Asia/Tokyo")).toEqual({ dateTime: "2026-10-20T01:00:00.000Z", timeZone: "Asia/Tokyo" });
    expect(toEventTime("2026-10-20", "Asia/Tokyo")).toEqual({ date: "2026-10-20" });
    expect(toEventTime("Oct 20 2026 10:00", "Asia/Tokyo")).toBeUndefined();
    expect(toEventTime("2026-13-40T25:61", "Asia/Tokyo")).toBeUndefined();
  });
});

describe("Gemini の取り直し", () => {
  test("429・503 だけを取り直し、上限を超えたら投げる", async () => {
    const { withRetry } = await import("../agent/agent");
    let n = 0;
    expect(await withRetry(async () => (++n < 3 ? Promise.reject(Object.assign(new Error("x"), { status: 429 })) : "ok"), [0, 0])).toBe("ok");
    n = 0;
    await expect(withRetry(async () => (++n, Promise.reject(new Error('{"error":{"code":400}}'))), [0, 0])).rejects.toThrow();
    expect(n).toBe(1);
    n = 0;
    await expect(withRetry(async () => (++n, Promise.reject(new Error('{"error":{"code":503}}'))), [0, 0])).rejects.toThrow();
    expect(n).toBe(3);
  });
});
