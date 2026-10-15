import { z } from "zod";
import type { NewEvent } from "../calendar/adapter";
import type { Workspace } from "../config";
import { PREP_DAYS_MAX, stripPrepLines } from "../domain/prep";
import { DAY, fromWall, toWall } from "../domain/time";
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
  // カレンダーで選んだ開始（tz の壁時計。datetime-local の値）
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  repeat: z.enum(["none", "daily3", "weekly3"]),
  // 自然言語のまま notes に書く。実行先・agent・prompt は取り込んだときに判定する
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

// 開始は1分後〜30日後。過ぎた時刻の予定は発火しない
const START_MIN_MS = 60 * 1000;
const START_MAX_MS = 30 * DAY;

export function automationEvent(f: z.infer<typeof AutomationForm>, ws: Workspace, now: number, ttlHours: number): NewEvent | string {
  const minute = 60 * 1000;
  const [y, mo, d, h, mi] = f.start.split(/[-T:]/).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || new Date(wall).getUTCDate() !== d) return "開始の日時が読めない";
  const start = fromWall(wall, ws.timeZone);
  if (start < now + START_MIN_MS) return "開始は1分後以降にしてください";
  if (start > now + START_MAX_MS) return "開始は30日以内にしてください";
  // Google Calendar は HOURLY 以下の繰り返しを受け付けない
  const recurrence = f.repeat === "daily3" ? ["RRULE:FREQ=DAILY;COUNT=3"] : f.repeat === "weekly3" ? ["RRULE:FREQ=WEEKLY;COUNT=3"] : undefined;
  const last = start + (f.repeat === "daily3" ? 2 * DAY : f.repeat === "weekly3" ? 14 * DAY : 0);
  return {
    summary: f.title,
    notes: `${f.prompt}\n\n${MARK}`,
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
