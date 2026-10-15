export const PREP_DAYS_MAX = 365;

// 記録用カレンダーの notes の「準備: N日前」。命令ではなく、手続きに要る期間という事実として読む
export function parsePrepDays(notes: string): number | undefined {
  const m = notes.match(/^\s*準備\s*[:：]\s*(\d{1,3})\s*日前\s*$/m);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n <= PREP_DAYS_MAX ? n : undefined;
}

// agent が提案した予定に「準備: N日前」が紛れると、承認後にまた準備が発火する。書き込む前に外す
export function stripPrepLines(notes: string): string {
  return notes
    .split("\n")
    .filter((l) => !/^\s*準備\s*[:：]/.test(l))
    .join("\n");
}
