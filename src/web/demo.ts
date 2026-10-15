import { z } from "zod";
import type { NewEvent } from "../calendar/adapter";
import type { Workspace } from "../config";
import { formatPayload, PREP_DAYS_MAX, stripPrepLines } from "../domain/payload";
import { DAY, toWall } from "../domain/time";
import { DEMO_EXPIRES_TAG } from "../runner";

// デモ用フォームの入力は誰でも書ける。信頼しない入力として長さと値の範囲を絞る
export const TITLE_MAX = 60;
export const DEMO_PROMPT_MAX = 500;
export const DEMO_NOTES_MAX = 300;

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .transform((s) => s.replace(/[\r\n\t]+/g, " "));

export const AutomationForm = z.object({
  title: oneLine(TITLE_MAX),
  startsIn: z.enum(["1", "3", "5", "10", "30"]),
  repeat: z.enum(["none", "daily3", "weekly3"]),
  prompt: z.string().trim().min(1).max(DEMO_PROMPT_MAX),
});

export const DeadlineForm = z.object({
  title: oneLine(TITLE_MAX),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prepDays: z.coerce.number().int().min(0).max(PREP_DAYS_MAX),
  notes: z.string().trim().max(DEMO_NOTES_MAX).default(""),
});

const MARK = "（dashboard のデモ用フォームから追加。一定時間後に自動で消える）";

function expiresAt(now: number, ttlHours: number, lastStart: number): string {
  return new Date(Math.max(now + ttlHours * 60 * 60 * 1000, lastStart + 60 * 60 * 1000)).toISOString();
}

export function automationEvent(f: z.infer<typeof AutomationForm>, ws: Workspace, now: number, ttlHours: number): NewEvent {
  const minute = 60 * 1000;
  const start = Math.ceil((now + Number(f.startsIn) * minute) / minute) * minute;
  // Google Calendar は HOURLY 以下の繰り返しを受け付けない
  const recurrence = f.repeat === "daily3" ? ["RRULE:FREQ=DAILY;COUNT=3"] : f.repeat === "weekly3" ? ["RRULE:FREQ=WEEKLY;COUNT=3"] : undefined;
  const last = start + (f.repeat === "daily3" ? 2 * DAY : f.repeat === "weekly3" ? 14 * DAY : 0);
  return {
    summary: f.title,
    notes: `${formatPayload({ prompt: f.prompt })}\n\n${MARK}`,
    start: { dateTime: new Date(start).toISOString(), timeZone: ws.timeZone },
    end: { dateTime: new Date(start + 15 * minute).toISOString(), timeZone: ws.timeZone },
    recurrence,
    tags: { [DEMO_EXPIRES_TAG]: expiresAt(now, ttlHours, last) },
  };
}

export function deadlineEvent(f: z.infer<typeof DeadlineForm>, ws: Workspace, now: number, ttlHours: number): NewEvent | string {
  const today = new Date(toWall(now, ws.timeZone)).toISOString().slice(0, 10);
  const startWall = Date.parse(`${f.date}T00:00:00Z`);
  if (Number.isNaN(startWall) || f.date < today) return "締切は今日以降の日付にしてください";
  if (startWall - Date.parse(`${today}T00:00:00Z`) > 366 * DAY) return "締切は1年以内の日付にしてください";
  const end = new Date(startWall + DAY).toISOString().slice(0, 10);
  const notes = [`準備: ${f.prepDays}日前`, stripPrepLines(f.notes), MARK].filter(Boolean).join("\n");
  return {
    summary: f.title,
    notes,
    start: { date: f.date },
    end: { date: end },
    tags: { [DEMO_EXPIRES_TAG]: expiresAt(now, ttlHours, now) },
  };
}
