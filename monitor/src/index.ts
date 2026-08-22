import { runMonitor } from "./collector.js";
import { loadConfig } from "./config.js";

await runMonitor(loadConfig());
