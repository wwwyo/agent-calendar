import type { AuthClient } from "google-auth-library";
import { bearer } from "../auth";
import type { CalendarAdapter, CalendarEvent, ChangeSet, EventTime, NewEvent } from "./adapter";
import { notesToText } from "../domain/notes";

const BASE = "https://www.googleapis.com/calendar/v3";

type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: EventTime;
  end?: EventTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: EventTime;
  creator?: { email?: string };
  organizer?: { email?: string };
  created?: string;
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
};

function toEvent(e: GoogleEvent): CalendarEvent {
  const status = e.status === "cancelled" || e.status === "tentative" ? e.status : "confirmed";
  return {
    id: e.id,
    status,
    summary: e.summary ?? "",
    notes: notesToText(e.description ?? ""),
    start: pickTime(e.start),
    end: pickTime(e.end),
    recurrence: e.recurrence,
    recurringEventId: e.recurringEventId,
    originalStartTime: pickTime(e.originalStartTime),
    creatorEmail: e.creator?.email,
    organizerEmail: e.organizer?.email,
    created: e.created,
    updated: e.updated,
    tags: e.extendedProperties?.private ?? {},
  };
}

function pickTime(t: EventTime | undefined): EventTime | undefined {
  if (!t) return undefined;
  if ("date" in t && t.date) return { date: t.date };
  if ("dateTime" in t && t.dateTime) return t.timeZone ? { dateTime: t.dateTime, timeZone: t.timeZone } : { dateTime: t.dateTime };
  return undefined;
}

class SyncTokenExpired extends Error {}

// service account に共有されたカレンダーを Calendar API で読む adapter
export class ServiceAccountCalendar implements CalendarAdapter {
  constructor(private readonly auth: AuthClient) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await bearer(this.auth)}`, "Content-Type": "application/json", ...init.headers },
    });
    if (res.status === 410) throw new SyncTokenExpired();
    if (!res.ok) throw new Error(`Calendar API ${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
    return res;
  }

  async listChanges(calendarId: string, syncToken?: string): Promise<ChangeSet> {
    try {
      return await this.list(calendarId, syncToken);
    } catch (e) {
      if (e instanceof SyncTokenExpired && syncToken) return { ...(await this.list(calendarId)), full: true };
      throw e;
    }
  }

  private async list(calendarId: string, syncToken?: string): Promise<ChangeSet> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (;;) {
      // 範囲で切らずに全件を取り、以後は syncToken で差分だけ取る。繰り返し予定は展開せず親と例外の回で持つ
      const q = new URLSearchParams({ maxResults: "2500", singleEvents: "false" });
      if (syncToken) q.set("syncToken", syncToken);
      if (pageToken) q.set("pageToken", pageToken);
      const res = await this.request(`/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      const body = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
      for (const item of body.items ?? []) events.push(toEvent(item));
      if (body.nextPageToken) {
        pageToken = body.nextPageToken;
        continue;
      }
      if (!body.nextSyncToken) throw new Error("Calendar API が nextSyncToken を返さない");
      return { events, nextSyncToken: body.nextSyncToken, full: !syncToken };
    }
  }

  async insertEvent(calendarId: string, event: NewEvent): Promise<CalendarEvent> {
    const res = await this.request(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST",
      body: JSON.stringify({
        summary: event.summary,
        description: event.notes,
        start: event.start,
        end: event.end,
        recurrence: event.recurrence,
        extendedProperties: { private: event.tags },
      }),
    });
    return toEvent((await res.json()) as GoogleEvent);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    } catch (e) {
      // 既に消えている予定は消せたことにする
      if (e instanceof SyncTokenExpired || (e instanceof Error && / 404 /.test(e.message))) return;
      throw e;
    }
  }
}
