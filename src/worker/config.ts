import { homedir } from "node:os";
import { join } from "node:path";
import { LOCAL_CONFIG_PATH, LocalConfigSchema, PROMPT_PLACEHOLDER, type LocalConfig } from "../dispatch/types";

export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

// TOML の文字列を LocalConfig にする。targets の repo の ~ は展開しておく
export function parseLocalConfig(toml: string, home = homedir()): LocalConfig {
  const config = LocalConfigSchema.parse(Bun.TOML.parse(toml));
  for (const t of Object.values(config.targets)) t.repo = expandHome(t.repo, home);
  return config;
}

export async function loadLocalConfig(path = expandHome(LOCAL_CONFIG_PATH)): Promise<LocalConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${path} がない。src/worker/README.md の例から作る`);
  return parseLocalConfig(await file.text());
}

// "{prompt}" と一致する要素だけを prompt で丸ごと置き換える。部分一致は置き換えない（shell は通さない）
export function buildArgv(command: readonly string[], prompt: string): string[] {
  return command.map((a) => (a === PROMPT_PLACEHOLDER ? prompt : a));
}
