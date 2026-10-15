import { describe, expect, test } from "bun:test";
import { isSameOrigin, readLimited, scriptJson, TooLarge, WindowLimiter } from "./http";
import { notesToText } from "./domain/notes";
import { renderSessionPage, renderSessionsPage } from "./web/dashboard";
import type { Workspace } from "./config";

const post = (headers: Record<string, string>) => new Request("http://internal/w/demo/demo/deadline", { method: "POST", headers });

describe("isSameOrigin", () => {
  test("Sec-Fetch-Site が same-origin のものだけを受ける", () => {
    expect(isSameOrigin(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(post({ "sec-fetch-site": "cross-site", origin: "https://a.run.app", host: "a.run.app" }))).toBe(false);
    expect(isSameOrigin(post({ "sec-fetch-site": "same-site" }))).toBe(false);
  });
  test("Sec-Fetch-Site が無ければ Origin の host を Host と比べ、どちらも無いものは受けない", () => {
    expect(isSameOrigin(post({ origin: "https://a.run.app", host: "a.run.app" }))).toBe(true);
    expect(isSameOrigin(post({ origin: "https://evil.example", host: "a.run.app" }))).toBe(false);
    expect(isSameOrigin(post({ origin: "null", host: "a.run.app" }))).toBe(false);
    expect(isSameOrigin(post({ host: "a.run.app" }))).toBe(false);
  });
});

describe("readLimited", () => {
  test("上限までは読み、Content-Length か実際の大きさが超えたら TooLarge", async () => {
    expect(await readLimited(new Request("http://x", { method: "POST", body: "a=1" }), 10)).toBe("a=1");
    await expect(readLimited(new Request("http://x", { method: "POST", body: "x".repeat(11) }), 10)).rejects.toBeInstanceOf(TooLarge);
    const lying = new Request("http://x", { method: "POST", headers: { "content-length": "1" }, body: new Blob(["x".repeat(100)]).stream() });
    await expect(readLimited(lying, 10)).rejects.toBeInstanceOf(TooLarge);
  });
});

describe("WindowLimiter", () => {
  test("窓の中で key ごとに上限まで通し、窓が変わると数え直す", () => {
    const l = new WindowLimiter(2, 1000);
    expect([l.hit("a", 0), l.hit("a", 1), l.hit("a", 2), l.hit("b", 3)]).toEqual([true, true, false, true]);
    expect(l.hit("a", 1000)).toBe(true);
  });
});

const ws: Workspace = { id: "demo", label: "Demo", visibility: "public", timeZone: "Asia/Tokyo", calendars: { automation: "a", records: "r" }, allowedCreators: [], allowLocal: false };

describe("inline script への埋め込み", () => {
  test("scriptJson は < > & と U+2028/2029 を escape し、JSON としては同じ値に戻る", () => {
    const v = "</script><script>alert(1)</script>&\u2028\u2029";
    const out = scriptJson(v);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toBe(v);
  });
  test("セッションの id に </script> があっても script を閉じない", () => {
    const page = renderSessionPage(ws, "</script><script>alert(1)</script>");
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).not.toContain("<script>alert(1)");
    expect(renderSessionsPage(ws).match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("notesToText", () => {
  test("入れ子で組み上がるタグも消し、改行を保つ", () => {
    expect(notesToText("<<b>script>alert(1)<</b>/script>")).toBe("alert(1)");
    expect(notesToText("<scr<script>ipt>x")).toBe("x");
    expect(notesToText("<p>準備: 30日前</p>写真<br>申請書")).toBe("準備: 30日前\n写真\n申請書");
  });
  test("entity はタグを消した後に文字へ戻す（タグとしては読まない）", () => {
    expect(notesToText("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
    expect(notesToText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });
});
