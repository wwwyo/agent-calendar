// Google Calendar の notes は Web UI で編集すると HTML になる。改行を保ったままテキストにする
export function notesToText(html: string): string {
  let text = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6])>/gi, "\n");
  // 1回では「<<b>script>」のような入れ子からタグが組み上がる。消えなくなるまで繰り返す
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(/<[^<>]*>/g, "");
  }
  // entity はタグを消した後に戻す。戻した < > は文字として渡し、タグとしては読まない
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\r\n?/g, "\n");
}
