import { createPublicClient, formatUnits, http, type PublicClient } from "viem";
import { AdaptiveIrmAbi, ERC20Abi, EVaultAbi, KinkyIrmAbi, LinearIrmAbi } from "./abis.js";
import type { Address, EventAmounts, EventSummary, Hex, IrmKind } from "./types.js";

const SECONDS_PER_YEAR = 365.2425 * 86_400;
const RAY = 1e27;
const UINT32_MAX = 4_294_967_295n;

export interface IrmResult {
  kind: IrmKind;
  targetPct: number;
  configuration: Record<string, string>;
}

export interface RiskRead {
  blockNumber: bigint;
  totalAssets: bigint;
  cash: bigint;
  borrows: bigint;
  interestRate: bigint;
  irm: Address;
  irmInfo: IrmResult;
}

export function createClient(url: string): PublicClient {
  return createPublicClient({
    transport: http(url, { timeout: 20_000, retryCount: 0, batch: { batchSize: 40, wait: 20 } }),
  });
}

export async function runWithFailover<T>(
  endpointCount: number,
  operation: (endpointIndex: number) => Promise<T>,
  onFallback?: (failedIndex: number, nextIndex: number) => void,
  attemptsPerEndpoint = 2,
): Promise<T> {
  if (endpointCount < 1) throw new Error("no RPC endpoints configured");
  let lastError: unknown;
  for (let index = 0; index < endpointCount; index++) {
    for (let attempt = 0; attempt < attemptsPerEndpoint; attempt++) {
      try {
        return await operation(index);
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attemptsPerEndpoint) {
          const delayMs = 400 * 2 ** attempt + Math.floor(Math.random() * 250);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    if (index + 1 < endpointCount) onFallback?.(index, index + 1);
  }
  throw lastError instanceof Error ? lastError : new Error("all RPC endpoints failed");
}

export class RpcPool {
  private readonly clients: PublicClient[];

  constructor(readonly chainId: number, endpoints: string[]) {
    this.clients = endpoints.map(createClient);
  }

  async withClient<T>(label: string, operation: (client: PublicClient) => Promise<T>): Promise<T> {
    return runWithFailover(
      this.clients.length,
      (index) => operation(this.clients[index]!),
      (failed, next) => console.warn(`[rpc fallback] chain=${this.chainId} operation=${label} endpoint=${failed + 1}->${next + 1}`),
    );
  }
}

export async function readStage1(client: PublicClient, vault: Address): Promise<{
  blockNumber: bigint;
  asset: Address;
  decimals: number;
  symbol: string;
  totalAssets: bigint;
}> {
  const blockNumber = await client.getBlockNumber();
  const asset = await client.readContract({ address: vault, abi: EVaultAbi, functionName: "asset", blockNumber }) as Address;
  const [decimals, symbol, totalAssets] = await Promise.all([
    client.readContract({ address: asset, abi: ERC20Abi, functionName: "decimals", blockNumber }),
    client.readContract({ address: asset, abi: ERC20Abi, functionName: "symbol", blockNumber }).catch(() => "UNKNOWN"),
    client.readContract({ address: vault, abi: EVaultAbi, functionName: "totalAssets", blockNumber }),
  ]);
  return { blockNumber, asset, decimals: Number(decimals), symbol: String(symbol), totalAssets: totalAssets as bigint };
}

function targetFromRaw(value: bigint): number | undefined {
  if (value < 0n) return undefined;
  if (value <= UINT32_MAX) return Number(value) / Number(UINT32_MAX) * 100;
  if (value <= 1_000_000_000_000_000_000n) return Number(value) / 1e18 * 100;
  return undefined;
}

async function optionalRead(client: PublicClient, address: Address, abi: typeof LinearIrmAbi | typeof KinkyIrmAbi | typeof AdaptiveIrmAbi, functionName: string, blockNumber: bigint): Promise<bigint | string | undefined> {
  try {
    return await client.readContract({ address, abi, functionName: functionName as never, blockNumber }) as bigint | string;
  } catch {
    return undefined;
  }
}

export async function readIrm(client: PublicClient, irm: Address, blockNumber: bigint): Promise<IrmResult> {
  // Probe the supported target families together so JSON-RPC batching keeps request volume low.
  const [name, target, kink] = await Promise.all([
    optionalRead(client, irm, LinearIrmAbi, "name", blockNumber),
    optionalRead(client, irm, AdaptiveIrmAbi, "TARGET_UTILIZATION", blockNumber),
    optionalRead(client, irm, LinearIrmAbi, "kink", blockNumber),
  ]);
  if (typeof target === "bigint") {
    const targetPct = targetFromRaw(target);
    if (targetPct !== undefined) {
      const fields = ["INITIAL_RATE_AT_TARGET", "MIN_RATE_AT_TARGET", "MAX_RATE_AT_TARGET", "CURVE_STEEPNESS", "ADJUSTMENT_SPEED"] as const;
      const values = await Promise.all(fields.map((field) => optionalRead(client, irm, AdaptiveIrmAbi, field, blockNumber)));
      return {
        kind: "adaptive-target",
        targetPct,
        configuration: Object.fromEntries([
          ["name", typeof name === "string" ? name : "IRMAdaptiveCurve"],
          ["target_utilization", target.toString()],
          ...fields.map((field, index) => [field.toLowerCase(), typeof values[index] === "bigint" ? values[index]!.toString() : "unavailable"]),
        ]),
      };
    }
  }

  if (typeof kink !== "bigint") throw new Error("unsupported IRM: no live kink or target utilization");
  const targetPct = targetFromRaw(kink);
  if (targetPct === undefined) throw new Error("unsupported IRM kink scale");
  const [baseRate, slope, shape, cutoff, slope1, slope2] = await Promise.all([
    optionalRead(client, irm, LinearIrmAbi, "baseRate", blockNumber),
    optionalRead(client, irm, KinkyIrmAbi, "slope", blockNumber),
    optionalRead(client, irm, KinkyIrmAbi, "shape", blockNumber),
    optionalRead(client, irm, KinkyIrmAbi, "cutoff", blockNumber),
    optionalRead(client, irm, LinearIrmAbi, "slope1", blockNumber),
    optionalRead(client, irm, LinearIrmAbi, "slope2", blockNumber),
  ]);
  const isKinky = [baseRate, slope, shape, cutoff].every((value) => typeof value === "bigint");
  const isLinear = [baseRate, slope1, slope2].every((value) => typeof value === "bigint");
  const kind: IrmKind = isKinky ? "linear-kinky" : isLinear ? "linear-kink" : "unknown-kink";
  const parameterEntries = isKinky
    ? [["baseRate", baseRate], ["slope", slope], ["shape", shape], ["cutoff", cutoff]]
    : isLinear
      ? [["baseRate", baseRate], ["slope1", slope1], ["slope2", slope2]]
      : [["baseRate", baseRate]];
  return {
    kind,
    targetPct,
    configuration: Object.fromEntries([
      ["name", typeof name === "string" ? name : kind === "linear-kinky" ? "IRMLinearKinky" : kind === "linear-kink" ? "IRMLinearKink" : "unknown"],
      ["kink", kink.toString()],
      ...parameterEntries.map(([field, value]) => [field as string, typeof value === "bigint" ? value.toString() : "unavailable"]),
    ]),
  };
}

export async function readRisk(client: PublicClient, vault: Address): Promise<RiskRead> {
  const blockNumber = await client.getBlockNumber();
  const [totalAssets, cash, borrows, interestRate, irm] = await Promise.all([
    client.readContract({ address: vault, abi: EVaultAbi, functionName: "totalAssets", blockNumber }),
    client.readContract({ address: vault, abi: EVaultAbi, functionName: "cash", blockNumber }),
    client.readContract({ address: vault, abi: EVaultAbi, functionName: "totalBorrows", blockNumber }),
    client.readContract({ address: vault, abi: EVaultAbi, functionName: "interestRate", blockNumber }),
    client.readContract({ address: vault, abi: EVaultAbi, functionName: "interestRateModel", blockNumber }),
  ]);
  const irmInfo = await readIrm(client, irm as Address, blockNumber);
  return { blockNumber, totalAssets: totalAssets as bigint, cash: cash as bigint, borrows: borrows as bigint, interestRate: interestRate as bigint, irm: irm as Address, irmInfo };
}

function aggregate(logs: readonly { args?: unknown; transactionHash?: Hex | null }[]): EventAmounts {
  let raw = 0n;
  const txHashes: Hex[] = [];
  for (const log of logs) {
    const args = log.args as { assets?: bigint } | undefined;
    raw += args?.assets ?? 0n;
    if (log.transactionHash) txHashes.push(log.transactionHash);
  }
  return { raw, tx_hashes: [...new Set(txHashes)] };
}

export async function readEvents(client: PublicClient, vault: Address, fromBlock: bigint, toBlock: bigint): Promise<EventSummary> {
  const empty = (): EventAmounts => ({ raw: 0n, tx_hashes: [] });
  if (fromBlock > toBlock) return { from_block: fromBlock, to_block: toBlock, borrow: empty(), withdrawal: empty(), interest: empty(), repayment: empty(), deposit: empty(), config: empty() };
  const [borrows, withdrawals, interests, repayments, deposits, configs] = await Promise.all([
    client.getContractEvents({ address: vault, abi: EVaultAbi, eventName: "Borrow", fromBlock, toBlock }),
    client.getContractEvents({ address: vault, abi: EVaultAbi, eventName: "Withdraw", fromBlock, toBlock }),
    client.getContractEvents({ address: vault, abi: EVaultAbi, eventName: "InterestAccrued", fromBlock, toBlock }),
    client.getContractEvents({ address: vault, abi: EVaultAbi, eventName: "Repay", fromBlock, toBlock }),
    client.getContractEvents({ address: vault, abi: EVaultAbi, eventName: "Deposit", fromBlock, toBlock }),
    client.getContractEvents({ address: vault, abi: EVaultAbi, eventName: "GovSetInterestRateModel", fromBlock, toBlock }),
  ]);
  const configTxs = configs.map((log) => ({ ...log, args: { assets: 0n } }));
  return {
    from_block: fromBlock,
    to_block: toBlock,
    borrow: aggregate(borrows),
    withdrawal: aggregate(withdrawals),
    interest: aggregate(interests),
    repayment: aggregate(repayments),
    deposit: aggregate(deposits),
    config: { raw: BigInt(configs.length), tx_hashes: aggregate(configTxs).tx_hashes },
  };
}

export function toTokenNumber(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

export function utilizationPct(cash: bigint, borrows: bigint): number {
  const total = cash + borrows;
  return total === 0n ? 0 : Number((borrows * 1_000_000n) / total) / 10_000;
}

export function borrowApyPct(spyRay: bigint): number {
  const spy = Number(spyRay) / RAY;
  if (!Number.isFinite(spy) || spy < 0) return Number.NaN;
  return Math.expm1(SECONDS_PER_YEAR * Math.log1p(spy)) * 100;
}
