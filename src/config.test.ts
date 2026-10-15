import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const ws = (p: Record<string, unknown>) => ({
  id: "me",
  label: "Me",
  visibility: "private",
  calendars: { automation: "a", records: "r" },
  allowedCreators: ["me@example.com"],
  ...p,
});
const load = (...workspaces: unknown[]) => loadConfig({ GCP_PROJECT: "p", TICK_AUTH: "none", WORKSPACES: JSON.stringify(workspaces) });

describe("loadConfig の組の検証", () => {
  test("allowLocal は既定で false、private で人だけが書ける組なら許す", () => {
    expect(load(ws({})).workspaces[0]!.allowLocal).toBe(false);
    expect(load(ws({ allowLocal: true })).workspaces[0]!.allowLocal).toBe(true);
  });
  test("公開の組と、service account が書ける組では local を許さない", () => {
    expect(() => load(ws({ allowLocal: true, visibility: "public" }))).toThrow("private");
    expect(() => load(ws({ allowLocal: true, allowedCreators: ["me@example.com", "runner@p.iam.gserviceaccount.com"] }))).toThrow("service account");
    // local を許さなければ、デモの組のように service account を含めてよい
    expect(() => load(ws({ visibility: "public", allowedCreators: ["runner@p.iam.gserviceaccount.com"] }))).not.toThrow();
  });
  test("起動用・記録用・メインのカレンダー ID が重なる組は拒む", () => {
    expect(() => load(ws({ calendars: { automation: "a", records: "a" } }))).toThrow("重複");
    expect(() => load(ws({ calendars: { automation: "a", records: "r", main: "r" } }))).toThrow("重複");
  });
});
