import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const path = new URL("../../.github/workflows/euler-utilization-monitor.yml", import.meta.url);
const document = parse(await readFile(path, "utf8")) as Record<string, unknown>;
if (!document.name || !document.on || !document.jobs) throw new Error("workflow is missing required top-level keys");
const on = document.on as Record<string, unknown>;
const schedule = on.schedule as Array<{ cron?: string }> | undefined;
if (schedule?.[0]?.cron !== "17 * * * *") throw new Error("workflow schedule must be 17 * * * *");
const dispatch = on.workflow_dispatch as { inputs?: Record<string, { default?: unknown }> } | undefined;
if (dispatch?.inputs?.dry_run?.default !== true) throw new Error("manual dry_run must default true");
console.log("[workflow validation] YAML and required monitor settings are valid");
