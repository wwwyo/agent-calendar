import type { CalendarEvent } from "../calendar/adapter";
import type { Workspace } from "../config";
import type { ReadyDispatch, StoredEvent } from "../dispatch/types";
import { automationBlocked, computeSchedule, exceptionsByMaster, NOT_JUDGED } from "../domain/schedule";
import { DAY, eventTz, fromWall, isAllDay, occurrences, toWall } from "../domain/time";
import { DEMO_EXPIRES_TAG } from "../runner";
import type { Run } from "../store/store";

export type CalendarItem = {
  role: "automation" | "records" | "prep";
  // 消すときに使う予定の id（繰り返しなら親）
  id: string;
  title: string;
  start: string;
  // 全日の予定は tz での日付
  date?: string;
  minutes: number;
  notes: string;
  recurring: boolean;
  // デモの印がある予定だけ dashboard から消せる
  deletable: boolean;
  expiresAt?: string;
  blocked?: string;
  // 起動用の予定が判定を待っている（足した直後・変えた直後）。発火しないとは出さない
  judging?: boolean;
  // 起動用の予定の判定結果。発火の前に実行先・agent・target・prompt を確かめられるようにする
  dispatch?: Omit<ReadyDispatch, "status">;
  sessions: { id: string; status: Run["status"]; startedAt: string }[];
};

const day = (t: number, tz: string) => new Date(toWall(t, tz)).toISOString().slice(0, 10);

// [from, to) に入る回を、起動用・記録用の予定と、準備が始まる時刻に分けて返す
export function calendarItems(input: { ws: Workspace; automation: StoredEvent[]; records: CalendarEvent[]; runs: Run[]; from: number; to: number; now: number }): CalendarItem[] {
  const { ws, from, to } = input;
  const runsOf = (pred: (r: Run) => boolean) => input.runs.filter(pred).map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt }));
  const items: CalendarItem[] = [];
  for (const [role, events] of [["automation", input.automation], ["records", input.records]] as const) {
    const ex = exceptionsByMaster(events, ws.timeZone);
    for (const e of events as StoredEvent[]) {
      if (e.status === "cancelled" || !e.start) continue;
      const reason = role === "automation" ? automationBlocked(e, ws) : undefined;
      const judging = reason === NOT_JUDGED;
      const blocked = judging ? undefined : reason;
      const d = !reason && e.dispatch?.status === "ready" ? e.dispatch : undefined;
      const dispatch = d ? { executor: d.executor, agent: d.agent, ...(d.target ? { target: d.target } : {}), prompt: d.prompt } : undefined;
      const allDay = isAllDay(e.start);
      // 終了が読めない予定は30分として描く
      const span = e.end && !isAllDay(e.end) && !isAllDay(e.start) ? (Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime)) / 60000 : NaN;
      const minutes = Number.isFinite(span) && span > 0 ? Math.max(15, span) : 30;
      for (const t of occurrences(e, ws.timeZone, from - 1, to - 1, ex.get(e.id))) {
        const iso = new Date(t).toISOString();
        items.push({
          role,
          id: e.id,
          title: e.summary,
          start: iso,
          date: allDay ? day(t, eventTz(e.start, ws.timeZone)) : undefined,
          minutes,
          notes: e.notes,
          recurring: !!e.recurrence?.length,
          deletable: !!e.tags[DEMO_EXPIRES_TAG],
          expiresAt: e.tags[DEMO_EXPIRES_TAG],
          blocked,
          ...(judging ? { judging } : {}),
          dispatch,
          sessions: role === "automation" ? runsOf((r) => r.kind === "automation" && r.eventId === e.id && r.scheduledAt === iso) : runsOf((r) => r.kind === "prep" && r.eventId === e.id),
        });
      }
    }
  }
  // 準備が始まる時刻（まだ来ていない次の回の分）
  const prep = computeSchedule({ workspace: ws, automation: [], records: input.records, from: input.now, now: input.now, horizon: 0 });
  for (const p of prep) {
    const t = Date.parse(p.fireAt);
    if (t < from || t >= to) continue;
    const e = input.records.find((x) => x.id === p.eventId);
    items.push({
      role: "prep",
      id: p.eventId,
      title: p.title,
      start: p.fireAt,
      minutes: 30,
      notes: e?.notes ?? "",
      recurring: !!e?.recurrence?.length,
      deletable: !!e?.tags[DEMO_EXPIRES_TAG],
      expiresAt: e?.tags[DEMO_EXPIRES_TAG],
      sessions: runsOf((r) => r.kind === "prep" && r.eventId === p.eventId && r.scheduledAt === p.fireAt),
    });
  }
  return items.sort((a, b) => a.start.localeCompare(b.start));
}

// 表示する週の範囲。日付は tz の壁時計で読み、今日の前後に制限する
export function weekRange(start: string | null, ws: Workspace, now: number): { from: number; to: number; start: string } | undefined {
  const today = Date.parse(`${day(now, ws.timeZone)}T00:00:00Z`);
  const wall = start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? Date.parse(`${start}T00:00:00Z`) : today;
  if (Number.isNaN(wall) || wall < today - 35 * DAY || wall > today + 400 * DAY) return undefined;
  return { from: fromWall(wall, ws.timeZone), to: fromWall(wall + 7 * DAY, ws.timeZone), start: new Date(wall).toISOString().slice(0, 10) };
}
