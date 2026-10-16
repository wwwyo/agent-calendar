import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// 行頭の fence だけを見て、言語の大文字小文字・末尾の空白・CRLF を許す。
// 本文の改行コードは LF に寄せてから比べる（書式の揺れで派生物の同期テストを落とさないため）。
const CSS_BLOCK = /^ {0,3}`{3,}css[^\S\n]*\r?\n([\s\S]*?)^ {0,3}`{3,}[^\S\n]*\r?$/gim;
const stripCr = (s: string) => s.replace(/\r\n?/g, "\n");

test("design.css は design.md の css block と一致する", () => {
  const md = readFileSync(new URL("../../design.md", import.meta.url), "utf8");
  const blocks = [...md.matchAll(CSS_BLOCK)].map((m) => stripCr(m[1]!));
  expect(stripCr(readFileSync(new URL("./design.css", import.meta.url), "utf8"))).toBe(blocks.join("\n"));
});
