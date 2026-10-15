import { RRule } from "rrule";
import type { CalendarEvent, EventTime } from "../calendar/adapter";

const DAY = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

// tz での壁時計の時刻を UTC として表した ms（rrule は tz を持たない日時で計算させる）
export function toWall(instant: number, tz: string): number {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return wall + (instant % 1000);
}

export function fromWall(wall: number, tz: string): number {
  const guess = wall - (toWall(wall, tz) - wall);
  return wall - (toWall(guess, tz) - guess);
}

function dateToWall(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

export function isAllDay(t: EventTime): t is { date: string } {
  return "date" in t;
}

export function startInstant(t: EventTime, tz: string): number {
  return isAllDay(t) ? fromWall(dateToWall(t.date), tz) : Date.parse(t.dateTime);
}

export function eventTz(t: EventTime | undefined, fallback: string): string {
  return t && !isAllDay(t) && t.timeZone ? t.timeZone : fallback;
}

// EXDATE の値を時刻にする。値は UTC（…Z）、TZID 付きの壁時計、日付だけのいずれか
function parseIcalTime(value: string, tz: string): number | undefined {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return undefined;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return m[7] ? wall : fromWall(wall, tz);
}

function exdates(lines: string[], tz: string): Set<number> {
  const out = new Set<number>();
  for (const line of lines) {
    if (!line.startsWith("EXDATE")) continue;
    const [head, values] = line.split(":", 2) as [string, string | undefined];
    const tzid = head.match(/TZID=([^;]+)/)?.[1] ?? tz;
    for (const v of values?.split(",") ?? []) {
      const t = parseIcalTime(v.trim(), tzid);
      if (t !== undefined) out.add(t);
    }
  }
  return out;
}

const MAX_OCCURRENCES = 200;

// 予定の回の開始時刻のうち (from, to] に入るものを返す。繰り返し予定は RRULE を tz の壁時計で展開し、EXDATE と除外する回を外す
export function occurrences(event: CalendarEvent, fallbackTz: string, from: number, to: number, exclude: Set<number> = new Set()): number[] {
  if (!event.start) return [];
  const tz = eventTz(event.start, fallbackTz);
  const start = startInstant(event.start, tz);
  const rules = (event.recurrence ?? []).filter((l) => l.startsWith("RRULE:"));
  if (rules.length === 0) return start > from && start <= to && !exclude.has(start) ? [start] : [];

  const ex = exdates(event.recurrence ?? [], tz);
  const out = new Set<number>();
  for (const line of rules) {
    const opts = RRule.parseString(line.slice("RRULE:".length));
    if (opts.until) opts.until = new Date(toWall(opts.until.getTime(), tz));
    const rule = new RRule({ ...opts, dtstart: new Date(toWall(start, tz)), tzid: null });
    const walls = rule.between(new Date(toWall(from, tz) - DAY), new Date(toWall(to, tz) + DAY), true);
    for (const w of walls) {
      const t = fromWall(w.getTime(), tz);
      if (t > from && t <= to && !ex.has(t) && !exclude.has(t)) out.add(t);
      if (out.size >= MAX_OCCURRENCES) break;
    }
  }
  return [...out].sort((a, b) => a - b);
}

export { DAY };
