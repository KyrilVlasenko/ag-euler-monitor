import type { Address } from "./types.js";

export interface MonitorConfig {
  inventoryUrl: string;
  inventoryPath?: string;
  minDepositsUsd: number;
  thresholdOffsetPp: number;
  degradedRunsBeforeAlert: number;
  materialUtilJumpPp: number;
  largeEventUsdMin: number;
  largeEventDepositsPct: number;
  stateInputPath: string;
  stateOutputPath: string;
  latestOutputPath: string;
  notificationsOutputPath: string;
  testNotificationsOutputPath: string;
  summaryOutputPath: string;
  dryRun: boolean;
  testThresholdPct?: number;
  repeatWhileAbove: boolean;
  eulerV3Url: string;
  rpcUrls: Record<number, string[]>;
  runId: string;
}

export type ExecutionMode = "production" | "dry-run" | "test";

export function executionMode(dryRun: boolean, testThresholdPct?: number): ExecutionMode {
  if (testThresholdPct !== undefined) return "test";
  return dryRun ? "dry-run" : "production";
}

export function canPersistProduction(dryRun: boolean, testThresholdPct?: number): boolean {
  return executionMode(dryRun, testThresholdPct) === "production";
}

export const INVENTORY_URL = "https://raw.githubusercontent.com/KyrilVlasenko/ag-euler/main/EULER_VAULT_ADDRESSES.md";

function numberEnv(name: string, fallback: string): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

export function parseRpcUrls(value: string): Record<number, string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("RPC_URLS_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RPC_URLS_JSON must be an object keyed by chain ID");
  }
  const result: Record<number, string[]> = {};
  for (const [rawChainId, rawEndpoints] of Object.entries(parsed)) {
    const chainId = Number(rawChainId);
    const endpoints = typeof rawEndpoints === "string" ? [rawEndpoints] : rawEndpoints;
    if (!Number.isInteger(chainId) || chainId <= 0 || !Array.isArray(endpoints) || endpoints.length === 0) {
      throw new Error(`Invalid RPC_URLS_JSON entry for chain ${rawChainId}`);
    }
    const clean = endpoints.map((endpoint) => {
      if (typeof endpoint !== "string" || !/^https:\/\//i.test(endpoint)) {
        throw new Error(`Chain ${rawChainId} RPC endpoints must be HTTPS URLs`);
      }
      return endpoint;
    });
    result[chainId] = [...new Set(clean)];
  }
  return result;
}

export function loadConfig(): MonitorConfig {
  const testValue = process.env.TEST_THRESHOLD_PCT?.trim();
  const testThresholdPct = testValue ? Number(testValue) : undefined;
  if (testThresholdPct !== undefined && (!Number.isFinite(testThresholdPct) || testThresholdPct < 0 || testThresholdPct > 100)) {
    throw new Error("TEST_THRESHOLD_PCT must be between 0 and 100");
  }
  return {
    inventoryUrl: process.env.INVENTORY_URL || INVENTORY_URL,
    ...(process.env.INVENTORY_PATH ? { inventoryPath: process.env.INVENTORY_PATH } : {}),
    minDepositsUsd: numberEnv("MIN_DEPOSITS_USD", "20000"),
    thresholdOffsetPp: numberEnv("THRESHOLD_OFFSET_PP", "2"),
    degradedRunsBeforeAlert: numberEnv("DEGRADED_RUNS_BEFORE_ALERT", "2"),
    materialUtilJumpPp: numberEnv("MATERIAL_UTIL_JUMP_PP", "2"),
    largeEventUsdMin: numberEnv("LARGE_EVENT_USD_MIN", "50000"),
    largeEventDepositsPct: numberEnv("LARGE_EVENT_DEPOSITS_PCT", "2"),
    stateInputPath: process.env.STATE_INPUT_PATH || "runtime/previous-state.json",
    stateOutputPath: process.env.STATE_OUTPUT_PATH || "runtime/state.json",
    latestOutputPath: process.env.LATEST_OUTPUT_PATH || "runtime/latest.json",
    notificationsOutputPath: process.env.NOTIFICATIONS_OUTPUT_PATH || "runtime/notifications.json",
    testNotificationsOutputPath: process.env.TEST_NOTIFICATIONS_OUTPUT_PATH || "runtime/notifications-test.json",
    summaryOutputPath: process.env.SUMMARY_OUTPUT_PATH || "runtime/summary.md",
    dryRun: (process.env.DRY_RUN || "false").toLowerCase() === "true",
    ...(testThresholdPct === undefined ? {} : { testThresholdPct }),
    repeatWhileAbove: (process.env.REPEAT_WHILE_ABOVE || "false").toLowerCase() === "true",
    eulerV3Url: process.env.EULER_V3_URL || "https://v3.euler.finance",
    rpcUrls: parseRpcUrls(process.env.RPC_URLS_JSON || "{}"),
    runId: process.env.GITHUB_RUN_ID || `local-${Date.now()}`,
  };
}

export const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  unichain: 130,
  monad: 143,
  arbitrum: 42161,
  "arbitrum one": 42161,
  linea: 59144,
};

export const DEFI_LLAMA_CHAIN: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  130: "unichain",
  143: "monad",
  42161: "arbitrum",
  59144: "linea",
};

export const EULER_NETWORK: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  130: "unichain",
  143: "monad",
  42161: "arbitrum",
  59144: "linea",
};

export const EXPLORER_TX: Record<number, string> = {
  1: "https://etherscan.io/tx/",
  8453: "https://basescan.org/tx/",
  130: "https://uniscan.xyz/tx/",
  143: "https://monadscan.com/tx/",
  42161: "https://arbiscan.io/tx/",
  59144: "https://lineascan.build/tx/",
};

export function marketKey(chainId: number, address: Address): string {
  return `${chainId}:${address.toLowerCase()}`;
}
