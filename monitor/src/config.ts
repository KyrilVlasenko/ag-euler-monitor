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

export interface EulerDeployment {
  eVaultFactory: Address;
  eulerEarnFactory: Address;
  irmLens: Address;
  utilsLens: Address;
}

// Canonical deployments from euler-xyz/euler-interfaces. These addresses are
// bytecode-verified there against their source commits and audited baselines.
export const EULER_DEPLOYMENTS: Record<number, EulerDeployment> = {
  1: {
    eVaultFactory: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e",
    eulerEarnFactory: "0x59709B029B140C853FE28d277f83C3a65e308aF4",
    irmLens: "0xC828534733Cc201cC0ab4523c7B89db54Bf71fF7",
    utilsLens: "0xF5868adEedAa9Dd070e86BB40D981590C86db5A2",
  },
  130: {
    eVaultFactory: "0xbAd8b5BDFB2bcbcd78Cc9f1573D3Aad6E865e752",
    eulerEarnFactory: "0xD785adD5F081F56616898E45b90dE307e3DC7d3E",
    irmLens: "0xd70cfe1F8a04A069898bAA381b34D4f7a4AaC803",
    utilsLens: "0x6D35dDA5FBD7E69AbcA96601A8b6A91a5c9cec7e",
  },
  143: {
    eVaultFactory: "0xba4Dd672062dE8FeeDb665DD4410658864483f1E",
    eulerEarnFactory: "0xF463d4Acb650cc6C4E1D6cD4D0d1b0cb224094cF",
    irmLens: "0xbB3a53e161d7E1dB8096E5c20DE942AB6c516c24",
    utilsLens: "0xa1E7569ec75dEBA8aaeBC858af03078CBDDD13EC",
  },
  8453: {
    eVaultFactory: "0x7F321498A801A191a93C840750ed637149dDf8D0",
    eulerEarnFactory: "0x75F49a2621b6DeC6a5baB22ce961bF3e676EFAE6",
    irmLens: "0xff00Fa8C5050973Cb02bC2c1ac74Cfced1cfFB84",
    utilsLens: "0x81DB178AE24b78d9dE7144a6f198deD9A98Ee753",
  },
  42161: {
    eVaultFactory: "0x78Df1CF5bf06a7f27f2ACc580B934238C1b80D50",
    eulerEarnFactory: "0xB9B5d62B9fE9E1B505466e75817aB178A1D2ec9d",
    irmLens: "0x4c7d467e3193DA860764468156D0b69Fef4036AF",
    utilsLens: "0x7A6A3EE0520c8ef1f92cb38360D1c8363Bf5dd64",
  },
  59144: {
    eVaultFactory: "0x84711986Fd3BF0bFe4a8e6d7f4E22E67f7f27F04",
    eulerEarnFactory: "0x377879A039343FEc7564e54616e519328951DA6D",
    irmLens: "0x8B8459B6DCAFbD72C42a2b2B0F3B2C903c19EC84",
    utilsLens: "0x0a2FAcd62C113815ACF8dDF7BE766C7Bc656D7Ff",
  },
};

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
