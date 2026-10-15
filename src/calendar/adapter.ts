// カレンダーの読み書きの境界。runner は Google の event の形を知らず、この型だけを扱う

export type EventTime = { dateTime: string; timeZone?: string } | { date: string };

export type CalendarEvent = {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary: string;
  // notes をテキストにしたもの（HTML は adapter が外す）
  notes: string;
  start?: EventTime;
  end?: EventTime;
  // RRULE / EXDATE の行
  recurrence?: string[];
  // 繰り返し予定の個別の回（変更・削除された回）
  recurringEventId?: string;
  originalStartTime?: EventTime;
  creatorEmail?: string;
  organizerEmail?: string;
  created?: string;
  updated?: string;
  // runner が付けた印（デモ用フォームで足した予定の削除期限など）
  tags: Record<string, string>;
};

export type ChangeSet = {
  events: CalendarEvent[];
  nextSyncToken: string;
  // syncToken が失効し、全件を取り直した
  full: boolean;
};

export type NewEvent = {
  summary: string;
  notes: string;
  start: EventTime;
  end: EventTime;
  recurrence?: string[];
  tags: Record<string, string>;
};

export interface CalendarAdapter {
  // syncToken がなければ全件、あれば差分を返す
  listChanges(calendarId: string, syncToken?: string): Promise<ChangeSet>;
  insertEvent(calendarId: string, event: NewEvent): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}
