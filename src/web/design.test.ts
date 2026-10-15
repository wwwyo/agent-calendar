import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("design.css は design.md の css block と一致する", () => {
  const md = readFileSync(new URL("../../design.md", import.meta.url), "utf8");
  const blocks = [...md.matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1]);
  expect(readFileSync(new URL("./design.css", import.meta.url), "utf8")).toBe(blocks.join("\n"));
});
