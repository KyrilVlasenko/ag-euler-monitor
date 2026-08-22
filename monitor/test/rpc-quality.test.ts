import assert from "node:assert/strict";
import test from "node:test";
import type { PublicClient } from "viem";
import { detectVault, RpcPool } from "../src/rpc.js";
import type { Address, Hex } from "../src/types.js";

const CHAIN_ID = 130;
const CANARY = "0xbad8b5bdfb2bcbcd78cc9f1573d3aad6e865e752" as Address;
const VAULT = "0x1f3134c3f3f8add904b9635acbefc0ea0d0e1ffc" as Address;
const EARN_FACTORY = "0xd785add5f081f56616898e45b90de307e3dc7d3e" as Address;
const LENS = "0x0000000000000000000000000000000000000100" as Address;
const CODE = "0x6001600055" as Hex;

interface MockEndpoint {
  chainId?: number;
  blockNumber?: bigint;
  canaryCode?: Hex | Error;
  vaultCode?: Hex | Error;
  isProxy?: boolean;
}

function clientFor(mock: MockEndpoint): PublicClient {
  return {
    getChainId: async () => mock.chainId ?? CHAIN_ID,
    getBlockNumber: async () => mock.blockNumber ?? 1_000n,
    getCode: async ({ address }: { address: Address }) => {
      const result = address.toLowerCase() === CANARY.toLowerCase() ? (mock.canaryCode ?? CODE) : (mock.vaultCode ?? CODE);
      if (result instanceof Error) throw result;
      return result;
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "isProxy") return mock.isProxy ?? true;
      if (functionName === "isVault") return false;
      throw new Error(`unexpected ${functionName}`);
    },
  } as unknown as PublicClient;
}

function poolFor(mocks: MockEndpoint[]): RpcPool {
  const clients = mocks.map(clientFor);
  return new RpcPool(CHAIN_ID, mocks.map((_, index) => `https://rpc-${index + 1}.invalid`), {
    confirmationBlocks: 0n,
    clientFactory: (_url, index) => clients[index]!,
  });
}

test("primary empty code and backup code keeps the market in normal vault classification", async () => {
  const pool = poolFor([{ vaultCode: "0x" }, { vaultCode: CODE, isProxy: true }]);
  await pool.initialize(CANARY);
  const verification = await pool.verifyContractCode(VAULT);
  assert.equal(verification.status, "contract");
  assert.deepEqual(verification.emptyCodeEndpoints, [1]);
  assert.deepEqual(verification.codeEndpoints, [2]);

  const detection = await pool.withClient("vault-detection", (client) => detectVault(client, VAULT, {
    eVaultFactory: CANARY,
    eulerEarnFactory: EARN_FACTORY,
    irmLens: LENS,
    utilsLens: LENS,
  }, { blockNumber: verification.blockNumber!, codeSize: verification.codeSize }));
  assert.equal(detection.vaultType, "evault");
  assert.equal(detection.codeExists, true);
  assert.equal(pool.qualitySummary().healthy_endpoints, 1);
});

test("wrong-chain primary endpoint is quarantined before use", async () => {
  const pool = poolFor([{ chainId: 1 }, { vaultCode: CODE }]);
  await pool.initialize(CANARY);
  const verification = await pool.verifyContractCode(VAULT);
  assert.equal(verification.status, "contract");
  assert.deepEqual(verification.codeEndpoints, [2]);
  assert.equal(pool.qualitySummary().quarantined_endpoints, 1);
  assert.ok(pool.qualityFindings().some((finding) => finding.phase === "endpoint-validation" && /wrong chain ID/.test(finding.detail) && finding.resolved_by_fallback));
});

test("primary endpoint with empty canary code is quarantined", async () => {
  const pool = poolFor([{ canaryCode: "0x" }, { canaryCode: CODE, vaultCode: CODE }]);
  await pool.initialize(CANARY);
  assert.equal(pool.qualitySummary().healthy_endpoints, 1);
  assert.equal((await pool.verifyContractCode(VAULT)).status, "contract");
  assert.ok(pool.qualityFindings().some((finding) => finding.phase === "canary" && finding.empty_code_endpoints[0] === 1 && finding.resolved_by_fallback));
});

test("no-code is confirmed only after every healthy endpoint returns empty code", async () => {
  const pool = poolFor([{ vaultCode: "0x" }, { vaultCode: "0x" }]);
  await pool.initialize(CANARY);
  const verification = await pool.verifyContractCode(VAULT);
  assert.equal(verification.status, "confirmed-no-code");
  assert.deepEqual(verification.emptyCodeEndpoints, [1, 2]);
  assert.equal(pool.qualitySummary().confirmed_no_code_markets, 1);
  assert.equal(pool.qualitySummary().quarantined_endpoints, 0);
});

test("one code endpoint error and a second success resolves without degrading market coverage", async () => {
  const pool = poolFor([{ vaultCode: new Error("temporary upstream failure") }, { vaultCode: CODE }]);
  await pool.initialize(CANARY);
  const verification = await pool.verifyContractCode(VAULT);
  assert.equal(verification.status, "contract");
  assert.deepEqual(verification.errorEndpoints, [1]);
  const event = pool.qualityFindings().find((finding) => finding.classification === "rpc-unavailable" && finding.phase === "inventory-code");
  assert.equal(event?.resolved_by_fallback, true);
  assert.equal(pool.qualitySummary().healthy_endpoints, 1);
});

test("conflicting endpoint responses are retained in sanitized quality findings and logs", async () => {
  const pool = poolFor([{ vaultCode: CODE }, { vaultCode: "0x" }]);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  try {
    await pool.initialize(CANARY);
    await pool.verifyContractCode(VAULT, true);
  } finally {
    console.warn = originalWarn;
  }
  const finding = pool.qualityFindings().find((item) => item.classification === "rpc-disagreement");
  assert.deepEqual(finding?.empty_code_endpoints, [2]);
  assert.deepEqual(finding?.code_endpoints, [1]);
  assert.equal(finding?.resolved_by_fallback, true);
  assert.equal(pool.qualitySummary().rpc_disagreement_markets, 1);
  assert.ok(warnings.some((line) => line.includes("[rpc disagreement]") && line.includes("empty_endpoints=2") && line.includes("code_endpoints=1")));
  assert.ok(warnings.every((line) => !line.includes("https://")));
});
