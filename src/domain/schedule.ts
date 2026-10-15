import type { CalendarEvent } from "../calendar/adapter";
import type { Workspace } from "../config";
import type { ReadyDispatch, StoredEvent } from "../dispatch/types";
import { parsePrepDays } from "./prep";
import { DAY, eventTz, fromWall, isAllDay, occurrences, startInstant, toWall } from "./time";

export type FireItem = {
  key: string;
  kind: "automation" | "prep";
  eventId: string;
  title: string;
  fireAt: string;
  // automation: 回の開始時刻。prep: 締切の開始時刻
  occurrenceStart: string;
  // automation: 判定結果（実行先・agent・target・prompt）。blocked の回は持たない
  dispatch?: ReadyDispatch;
  prepDays?: number;
  // 予定を足した時点で発火日を過ぎていた
  late?: boolean;
  // 発火させない理由。時刻が来たら実行せずに記録だけ残す
  blocked?: string;
};

// 全日の締切の準備は、発火日の朝に始める
const ALL_DAY_PREP_HOUR = 9;
// 繰り返しの締切は、次の回をこの先まで探す
const PREP_LOOKAHEAD = 400 * DAY;

export function isAllowedCreator(e: CalendarEvent, ws: Workspace): boolean {
  const allowed = new Set(ws.allowedCreators.map((x) => x.toLowerCase()));
  return [e.creatorEmail, e.organizerEmail].some((x) => x && allowed.has(x.toLowerCase()));
}

export function exceptionsByMaster(events: CalendarEvent[], tz: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const e of events) {
    if (!e.recurringEventId || !e.originalStartTime) continue;
    const set = out.get(e.recurringEventId) ?? new Set();
    set.add(startInstant(e.originalStartTime, eventTz(e.originalStartTime, tz)));
    out.set(e.recurringEventId, set);
  }
  return out;
}

// 個別に変更された回は、親ではなくその回の内容（notes・作成者）で扱う
function singles<T extends CalendarEvent>(events: T[]): T[] {
  return events.filter((e) => e.status !== "cancelled");
}

// 予定を発火させない理由。作成者・判定の順に見る
export function automationBlocked(e: StoredEvent, ws: Workspace): string | undefined {
  if (!isAllowedCreator(e, ws)) return `作成者 ${e.creatorEmail ?? "(不明)"} が allowlist にない`;
  const d = e.dispatch;
  if (!d || d.eventUpdated !== (e.updated ?? "")) return "判定がまだ済んでいない";
  if (d.status === "blocked") return d.reason;
  return undefined;
}

function readyDispatch(e: StoredEvent): ReadyDispatch | undefined {
  const d = e.dispatch;
  if (d?.status !== "ready") return undefined;
  return { status: "ready", executor: d.executor, agent: d.agent, ...(d.target ? { target: d.target } : {}), prompt: d.prompt };
}

function automationItems(events: StoredEvent[], ws: Workspace, from: number, to: number): FireItem[] {
  const ex = exceptionsByMaster(events, ws.timeZone);
  const items: FireItem[] = [];
  for (const e of singles(events)) {
    const blocked = automationBlocked(e, ws);
    const dispatch = blocked ? undefined : readyDispatch(e);
    for (const t of occurrences(e, ws.timeZone, from, to, ex.get(e.id))) {
      const iso = new Date(t).toISOString();
      items.push({
        key: `auto:${e.id}:${iso}`,
        kind: "automation",
        eventId: e.id,
        title: e.summary,
        fireAt: iso,
        occurrenceStart: iso,
        ...(dispatch ? { dispatch } : {}),
        ...(blocked ? { blocked } : {}),
      });
    }
  }
  return items;
}

function prepFireAt(e: CalendarEvent, start: number, days: number, tz: string): number {
  if (e.start && isAllDay(e.start)) {
    const wall = toWall(start, tz) - days * DAY + ALL_DAY_PREP_HOUR * 60 * 60 * 1000;
    return fromWall(wall, tz);
  }
  return start - days * DAY;
}

function prepItems(events: CalendarEvent[], ws: Workspace, now: number): FireItem[] {
  const ex = exceptionsByMaster(events, ws.timeZone);
  const items: FireItem[] = [];
  for (const e of singles(events)) {
    const days = parsePrepDays(e.notes);
    if (days === undefined) continue;
    // 範囲で切らない。過ぎていない次の回を、何か月先でも拾う
    const [next] = occurrences(e, ws.timeZone, now, now + PREP_LOOKAHEAD, ex.get(e.id));
    if (next === undefined) continue;
    const tz = eventTz(e.start, ws.timeZone);
    const fireAt = prepFireAt(e, next, days, tz);
    const iso = new Date(fireAt).toISOString();
    items.push({
      key: `prep:${e.id}:${iso}`,
      kind: "prep",
      eventId: e.id,
      title: e.summary,
      fireAt: iso,
      occurrenceStart: new Date(next).toISOString(),
      prepDays: days,
      late: e.created ? Date.parse(e.created) > fireAt : undefined,
    });
  }
  return items;
}

// automation は (from, now + horizon] の回を、準備は未来の締切すべてを発火予定にする
export function computeSchedule(input: {
  workspace: Workspace;
  automation: StoredEvent[];
  records: CalendarEvent[];
  from: number;
  now: number;
  horizon: number;
}): FireItem[] {
  const items = [
    ...automationItems(input.automation, input.workspace, input.from, input.now + input.horizon),
    ...prepItems(input.records, input.workspace, input.now),
  ];
  return items.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
}
