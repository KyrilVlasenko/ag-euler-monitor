import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { auditPublicContent } from "./security.js";
import type { MonitorState } from "./types.js";

export function emptyState(): MonitorState {
  return {
    schema_version: 1,
    updated_at: new Date(0).toISOString(),
    markets: {},
    health: {
      consecutive_degraded_runs: 0,
      degraded_alert_active: false,
      last_degraded_at: null,
      last_restored_at: null,
      last_issues: [],
    },
  };
}

export interface StateLoadResult {
  state: MonitorState;
  valid: boolean;
  reason?: string;
}

export function parseStateText(text: string): MonitorState | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<MonitorState>;
    if (parsed.schema_version !== 1 || !parsed.markets || typeof parsed.markets !== "object" || !parsed.health) return undefined;
    if (!Number.isInteger(parsed.health.consecutive_degraded_runs) || typeof parsed.health.degraded_alert_active !== "boolean") return undefined;
    return parsed as MonitorState;
  } catch {
    return undefined;
  }
}

export async function loadState(path: string): Promise<StateLoadResult> {
  try {
    const parsed = parseStateText(await readFile(path, "utf8"));
    return parsed ? { state: parsed, valid: true } : { state: emptyState(), valid: false, reason: "persistent state is invalid or has an unsupported schema" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: emptyState(), valid: true };
    return { state: emptyState(), valid: false, reason: "persistent state could not be read" };
  }
}

export async function writePublicJson(path: string, value: unknown): Promise<void> {
  auditPublicContent(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writePublicText(path: string, value: string): Promise<void> {
  auditPublicContent(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}
