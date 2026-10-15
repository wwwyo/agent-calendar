// Cloud Logging が読む構造化ログ（1行1 JSON）
export function log(severity: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ severity: severity.toUpperCase(), message, ...fields }));
}
