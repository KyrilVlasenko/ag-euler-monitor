import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, type PublicClient } from "viem";
import { CoverageTracker, assertCoverageInvariants } from "../src/collector.js";
import { getOnchainVaultPrice } from "../src/prices.js";
import { describeRpcFailure, detectVault, readIrm, readRisk, readStage1, resolveAmountCap, type VaultDetection } from "../src/rpc.js";
import type { Address, ChainCoverage, InventoryVault } from "../src/types.js";

const VAULT = "0x5795130bfb9232c7500c6e57a96fdd18bfa60436" as Address;
const ASSET = "0x2daa146dfb7eaef0038f9f15b2ec1e4de003f72b" as Address;
const IRM = "0xf8d1c8155b9cb872af36a14fbdb137dfe2071078" as Address;
const LENS = "0x0000000000000000000000000000000000000100" as Address;
const USD = "0x0000000000000000000000000000000000000348" as Address;

function publicClient(readContract: (args: { functionName: string; address: Address }) => Promise<unknown>): PublicClient {
  return { readContract } as unknown as PublicClient;
}

test("canonical IRMLens decodes both affected Base IRMLinearKink configurations", async () => {
  const cases = [
    { slope1: 537392971n, slope2: 80854019228n, kink: 3435973836n, target: 80 },
    { slope1: 863499190n, slope2: 85875829549n, kink: 4080218931n, target: 95 },
  ];
  for (const current of cases) {
    const params = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [0n, current.slope1, current.slope2, current.kink],
    );
    const client = publicClient(async () => ({ interestRateModel: IRM, interestRateModelType: 1, interestRateModelParams: params }));
    const result = await readIrm(client, IRM, 1n, LENS);
    assert.equal(result.kind, "linear-kink");
    assert.ok(Math.abs(result.targetPct - current.target) < 0.000001);
    assert.equal(result.configuration.slope_1, current.slope1.toString());
    assert.equal(result.configuration.slope_2, current.slope2.toString());
  }
});

test("canonical collateral-only EVault is explicitly risk-not-applicable without using its symbol or price", async () => {
  const detection: VaultDetection = { blockNumber: 100n, vaultType: "evault", codeExists: true, codeSize: 163 };
  const client = publicClient(async ({ functionName }) => {
    if (functionName === "asset") return ASSET;
    if (functionName === "decimals") return 18;
    if (functionName === "symbol") return "wnAUSD-wnUSDC-wnUSDT0";
    if (functionName === "totalAssets") return 21_033n * 10n ** 18n;
    if (functionName === "interestRateModel") return "0x0000000000000000000000000000000000000000";
    if (functionName === "totalBorrows") return 0n;
    if (functionName === "LTVList") return [];
    if (functionName === "caps") return [0, 0] as const;
    throw new Error(`unexpected ${functionName}`);
  });
  const result = await readStage1(client, VAULT, detection);
  assert.equal(result.riskApplicable, false);
  assert.equal(result.totalBorrows, 0n);
  assert.equal(result.collateralCount, 0);
  assert.equal(result.borrowCap, (1n << 256n) - 1n);
  assert.match(result.riskNotApplicableReason ?? "", /no IRM, no debt, and no configured collateral LTVs/);
});

test("the Monad failure address is detected as a canonical EVault before any EVault-only read", async () => {
  let earnFactoryCalled = false;
  const client = {
    getBlockNumber: async () => 100n,
    getCode: async () => "0x6001600055",
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "isProxy") return true;
      if (functionName === "isVault") earnFactoryCalled = true;
      return false;
    },
  } as unknown as PublicClient;
  const detection = await detectVault(client, VAULT, { eVaultFactory: LENS, eulerEarnFactory: LENS, irmLens: LENS, utilsLens: LENS });
  assert.deepEqual(detection, { blockNumber: 100n, vaultType: "evault", codeExists: true, codeSize: 5 });
  assert.equal(earnFactoryCalled, false);
});

test("EVault AmountCap zero-mantissa value resolves to a zero borrow cap", () => {
  assert.equal(resolveAmountCap(18), 0n);
  assert.equal(resolveAmountCap(0), (1n << 256n) - 1n);
});

test("EVault on-chain pricing uses controller quote when UoA is virtual USD", async () => {
  const client = publicClient(async ({ functionName }) => {
    assert.equal(functionName, "getControllerAssetPriceInfo");
    return { queryFailure: false, unitOfAccount: USD, amountOutMid: 1_095_000_000_000_000_000n };
  });
  const result = await getOnchainVaultPrice(client, "https://v3.euler.finance", 8453, LENS, VAULT, "evault", ASSET);
  assert.deepEqual(result, { price: 1.095, source: "euler-onchain" });
});

test("EVault on-chain pricing converts non-USD UoA through V3 first", async () => {
  const unit = "0x0000000000000000000000000000000000000200" as Address;
  const client = publicClient(async ({ functionName }) => {
    if (functionName === "getControllerAssetPriceInfo") return { queryFailure: false, unitOfAccount: unit, amountOutMid: 1_500_000n };
    if (functionName === "decimals") return 6;
    throw new Error(`unexpected ${functionName}`);
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ [unit.toLowerCase()]: { price: 2 } }), { status: 200 });
  try {
    const result = await getOnchainVaultPrice(client, "https://v3.euler.finance", 143, LENS, VAULT, "evault", ASSET);
    assert.deepEqual(result, { price: 3, source: "euler-onchain" });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("EVault non-USD UoA pricing falls back to canonical UtilsLens", async () => {
  const unit = "0x0000000000000000000000000000000000000200" as Address;
  const client = publicClient(async ({ functionName }) => {
    if (functionName === "getControllerAssetPriceInfo") return { queryFailure: false, unitOfAccount: unit, amountOutMid: 1_500_000n };
    if (functionName === "decimals") return 6;
    if (functionName === "getAssetPriceInfo") return { queryFailure: false, unitOfAccount: USD, amountOutMid: 2_000_000_000_000_000_000n };
    throw new Error(`unexpected ${functionName}`);
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  try {
    const result = await getOnchainVaultPrice(client, "https://v3.euler.finance", 143, LENS, VAULT, "evault", ASSET);
    assert.deepEqual(result, { price: 3, source: "euler-onchain" });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("EulerEarn/other ERC4626 pricing uses direct UtilsLens and never assumes stable value from a symbol", async () => {
  const unavailable = publicClient(async () => ({ queryFailure: true, unitOfAccount: USD, amountOutMid: 0n }));
  assert.equal(await getOnchainVaultPrice(unavailable, "https://v3.euler.finance", 143, LENS, VAULT, "euler-earn", ASSET), undefined);

  const priced = publicClient(async ({ functionName }) => {
    assert.equal(functionName, "getAssetPriceInfo");
    return { queryFailure: false, unitOfAccount: USD, amountOutMid: 1_013_500_000_000_000_000n };
  });
  assert.deepEqual(await getOnchainVaultPrice(priced, "https://v3.euler.finance", 143, LENS, VAULT, "euler-earn", ASSET), { price: 1.0135, source: "euler-onchain" });
});

function inventory(chainId: number, suffix: string): InventoryVault {
  return {
    chainName: `chain-${chainId}`,
    chainId,
    sectionType: "evk",
    label: suffix,
    address: `0x${suffix.padStart(40, "0")}` as Address,
    statusDecision: "include-active",
    rawRow: suffix,
  };
}

test("coverage counters are mutually exclusive and global fully-monitored equals the per-chain sum", () => {
  const vaults = [inventory(1, "1"), inventory(1, "2"), inventory(143, "3"), inventory(143, "4")];
  const tracker = new CoverageTracker(vaults);
  tracker.mark(vaults[0]!, "fully-monitored");
  tracker.mark(vaults[1]!, "deposit-ineligible");
  tracker.mark(vaults[2]!, "fully-monitored");
  tracker.mark(vaults[3]!, "risk-not-applicable");
  const rows = tracker.rows();
  const totals = assertCoverageInvariants(rows);
  assert.equal(totals.fully_monitored, 2);
  assert.equal(rows.reduce((sum, row) => sum + row.fully_monitored, 0), 2);
  assert.equal(totals.unresolved, 0);
});

test("misleading eligibility/unresolved coverage cannot pass the invariant", () => {
  const row: ChainCoverage = {
    chain_id: 143,
    chain_name: "Monad",
    inventory_candidates: 2,
    lifecycle_excluded: 0,
    risk_not_applicable: 0,
    eligibility_unresolved: 1,
    deposit_ineligible: 0,
    deposit_eligible: 1,
    fully_monitored: 1,
    monitoring_unresolved: 0,
    unresolved: 0,
  };
  assert.throws(() => assertCoverageInvariants([row]), /unresolved counters must reconcile/);
});

test("failed EVault function diagnostics identify the function and redact RPC URLs", async () => {
  const failure = new Error("contract execution failed") as Error & { shortMessage: string; cause: Error };
  failure.name = "ContractFunctionExecutionError";
  failure.shortMessage = "Execution reverted while calling RPC";
  failure.cause = new Error("request failed at https://provider.invalid/private-token");
  const client = {
    getBlockNumber: async () => 100n,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "cash") throw failure;
      if (functionName === "interestRateModel") return IRM;
      return 0n;
    },
  } as unknown as PublicClient;
  await assert.rejects(async () => readRisk(client, VAULT, LENS), (error) => {
    const diagnostic = describeRpcFailure(error);
    assert.equal(diagnostic.functionAttempted, "EVault.cash");
    assert.equal(diagnostic.shortMessage, "Execution reverted while calling RPC");
    assert.doesNotMatch(diagnostic.cause, /provider\.invalid|private-token/);
    return true;
  });
});
