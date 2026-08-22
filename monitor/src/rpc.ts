import { createPublicClient, decodeAbiParameters, formatUnits, http, type PublicClient } from "viem";
import { ERC20Abi, EulerEarnFactoryAbi, EVaultAbi, GenericFactoryAbi, IrmLensAbi } from "./abis.js";
import type { EulerDeployment } from "./config.js";
import type { Address, EventAmounts, EventSummary, Hex, IrmKind, VaultType } from "./types.js";

const SECONDS_PER_YEAR = 365.2425 * 86_400;
const RAY = 1e27;
const UINT32_MAX = 4_294_967_295n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

class ContractReadFailure extends Error {
  constructor(readonly functionAttempted: string, readonly original: unknown) {
    super(`contract read failed: ${functionAttempted}`);
    this.name = "ContractReadFailure";
  }
}

export class RpcOperationError extends Error {
  constructor(
    readonly operation: string,
    readonly rpcAttempts: number,
    readonly fallbackAttempts: number,
    readonly endpointsTried: number,
    readonly original: unknown,
  ) {
    super(`RPC operation failed: ${operation}`);
    this.name = "RpcOperationError";
  }
}

export interface RpcFailureDiagnostic {
  operation: string;
  functionAttempted: string;
  shortMessage: string;
  cause: string;
  rpcAttempts: number;
  fallbackAttempts: number;
  endpointsTried: number;
}

function sanitizedDiagnosticText(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .split(/\r?\n/, 1)[0]!
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/([?&](?:key|token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 240);
}

function errorName(value: unknown): string {
  if (!value || typeof value !== "object") return "operation failed";
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(name) ? name : "operation failed";
}

export function describeRpcFailure(error: unknown): RpcFailureDiagnostic {
  const rpc = error instanceof RpcOperationError ? error : undefined;
  const wrapped = rpc?.original ?? error;
  const read = wrapped instanceof ContractReadFailure ? wrapped : undefined;
  const original = read?.original ?? wrapped;
  const shortMessage = sanitizedDiagnosticText((original as { shortMessage?: unknown } | undefined)?.shortMessage, errorName(original));
  const causeValue = (original as { cause?: unknown } | undefined)?.cause;
  const cause = causeValue && typeof causeValue === "object"
    ? sanitizedDiagnosticText((causeValue as { shortMessage?: unknown; message?: unknown }).shortMessage ?? (causeValue as { message?: unknown }).message, errorName(causeValue))
    : errorName(original);
  return {
    operation: rpc?.operation ?? "unknown",
    functionAttempted: read?.functionAttempted ?? "unknown",
    shortMessage,
    cause,
    rpcAttempts: rpc?.rpcAttempts ?? 1,
    fallbackAttempts: rpc?.fallbackAttempts ?? 0,
    endpointsTried: rpc?.endpointsTried ?? 1,
  };
}

async function taggedRead<T>(functionAttempted: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ContractReadFailure(functionAttempted, error);
  }
}

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
  onAttemptFailure?: (endpointIndex: number, attempt: number) => void,
): Promise<T> {
  if (endpointCount < 1) throw new Error("no RPC endpoints configured");
  let lastError: unknown;
  for (let index = 0; index < endpointCount; index++) {
    for (let attempt = 0; attempt < attemptsPerEndpoint; attempt++) {
      try {
        return await operation(index);
      } catch (error) {
        lastError = error;
        onAttemptFailure?.(index, attempt);
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
    let rpcAttempts = 0;
    let fallbackAttempts = 0;
    const endpoints = new Set<number>();
    try {
      return await runWithFailover(
        this.clients.length,
        (index) => {
          rpcAttempts++;
          endpoints.add(index);
          return operation(this.clients[index]!);
        },
        (failed, next) => {
          fallbackAttempts++;
          console.warn(`[rpc fallback] chain=${this.chainId} operation=${label} endpoint=${failed + 1}->${next + 1}`);
        },
      );
    } catch (error) {
      throw new RpcOperationError(label, rpcAttempts, fallbackAttempts, endpoints.size, error);
    }
  }
}

export interface VaultDetection {
  blockNumber: bigint;
  vaultType: VaultType;
  codeExists: boolean;
  codeSize: number;
}

export async function detectVault(client: PublicClient, vault: Address, deployment: EulerDeployment): Promise<VaultDetection> {
  const blockNumber = await taggedRead("eth_blockNumber", () => client.getBlockNumber());
  const code = await taggedRead("eth_getCode", () => client.getCode({ address: vault, blockNumber }));
  const codeSize = code ? Math.max(0, (code.length - 2) / 2) : 0;
  if (!codeSize) return { blockNumber, vaultType: "non-vault", codeExists: false, codeSize };

  const isEVault = await taggedRead("GenericFactory.isProxy", () => client.readContract({ address: deployment.eVaultFactory, abi: GenericFactoryAbi, functionName: "isProxy", args: [vault], blockNumber }) as Promise<boolean>);
  if (isEVault) return { blockNumber, vaultType: "evault", codeExists: true, codeSize };
  const isEulerEarn = await taggedRead("EulerEarnFactory.isVault", () => client.readContract({ address: deployment.eulerEarnFactory, abi: EulerEarnFactoryAbi, functionName: "isVault", args: [vault], blockNumber }) as Promise<boolean>);
  if (isEulerEarn) return { blockNumber, vaultType: "euler-earn", codeExists: true, codeSize };

  try {
    await Promise.all([
      taggedRead("ERC4626.asset", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "asset", blockNumber })),
      taggedRead("ERC4626.totalAssets", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "totalAssets", blockNumber })),
    ]);
    return { blockNumber, vaultType: "erc4626", codeExists: true, codeSize };
  } catch {
    return { blockNumber, vaultType: "non-vault", codeExists: true, codeSize };
  }
}

export interface Stage1Read {
  blockNumber: bigint;
  asset: Address;
  decimals: number;
  symbol: string;
  totalAssets: bigint;
  riskApplicable: boolean;
  riskNotApplicableReason?: string;
  interestRateModel?: Address;
  totalBorrows?: bigint;
  collateralCount?: number;
  borrowCap?: bigint;
}

export async function readStage1(client: PublicClient, vault: Address, detection: VaultDetection): Promise<Stage1Read> {
  const blockNumber = detection.blockNumber;
  const asset = await taggedRead("ERC4626.asset", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "asset", blockNumber })) as Address;
  const [decimals, symbol, totalAssets] = await Promise.all([
    taggedRead("ERC20.decimals", () => client.readContract({ address: asset, abi: ERC20Abi, functionName: "decimals", blockNumber })),
    taggedRead("ERC20.symbol", () => client.readContract({ address: asset, abi: ERC20Abi, functionName: "symbol", blockNumber })).catch(() => "UNKNOWN"),
    taggedRead("ERC4626.totalAssets", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "totalAssets", blockNumber })),
  ]);
  if (detection.vaultType !== "evault") {
    return { blockNumber, asset, decimals: Number(decimals), symbol: String(symbol), totalAssets: totalAssets as bigint, riskApplicable: true };
  }

  const [interestRateModel, totalBorrows, collateralList, caps] = await Promise.all([
    taggedRead("EVault.interestRateModel", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "interestRateModel", blockNumber })),
    taggedRead("EVault.totalBorrows", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "totalBorrows", blockNumber })),
    taggedRead("EVault.LTVList", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "LTVList", blockNumber })),
    taggedRead("EVault.caps", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "caps", blockNumber })),
  ]);
  const irm = interestRateModel as Address;
  const borrows = totalBorrows as bigint;
  const collaterals = collateralList as Address[];
  const [, rawBorrowCap] = caps as readonly [number, number];
  const borrowCap = resolveAmountCap(rawBorrowCap);
  const nonBorrowable = irm.toLowerCase() === ZERO_ADDRESS && borrows === 0n && collaterals.length === 0;
  return {
    blockNumber,
    asset,
    decimals: Number(decimals),
    symbol: String(symbol),
    totalAssets: totalAssets as bigint,
    riskApplicable: !nonBorrowable,
    ...(nonBorrowable ? { riskNotApplicableReason: "canonical EVault has no IRM, no debt, and no configured collateral LTVs" } : {}),
    interestRateModel: irm,
    totalBorrows: borrows,
    collateralCount: collaterals.length,
    borrowCap,
  };
}

export function resolveAmountCap(raw: number | bigint): bigint {
  const value = BigInt(raw);
  if (value === 0n) return (1n << 256n) - 1n;
  return 10n ** (value & 63n) * (value >> 6n) / 100n;
}

function targetFromRaw(value: bigint): number | undefined {
  if (value < 0n) return undefined;
  if (value <= UINT32_MAX) return Number(value) / Number(UINT32_MAX) * 100;
  if (value <= 1_000_000_000_000_000_000n) return Number(value) / 1e18 * 100;
  return undefined;
}

export async function readIrm(client: PublicClient, irm: Address, blockNumber: bigint, irmLens: Address): Promise<IrmResult> {
  if (irm.toLowerCase() === ZERO_ADDRESS) throw new Error("unsupported IRM: zero address has no utilization target");
  const info = await taggedRead("IRMLens.getInterestRateModelInfo", () => client.readContract({
    address: irmLens,
    abi: IrmLensAbi,
    functionName: "getInterestRateModelInfo",
    args: [irm],
    blockNumber,
  })) as { interestRateModel: Address; interestRateModelType: number; interestRateModelParams: Hex };
  if (info.interestRateModel.toLowerCase() !== irm.toLowerCase()) throw new Error("unsupported IRM: canonical lens address mismatch");

  if (info.interestRateModelType === 1) {
    const [baseRate, slope1, slope2, kink] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      info.interestRateModelParams,
    );
    const targetPct = targetFromRaw(kink);
    if (targetPct === undefined) throw new Error("unsupported IRM kink scale");
    return { kind: "linear-kink", targetPct, configuration: { name: "IRMLinearKink", base_rate: baseRate.toString(), slope_1: slope1.toString(), slope_2: slope2.toString(), kink: kink.toString() } };
  }
  if (info.interestRateModelType === 2) {
    const [target, initial, min, max, steepness, speed] = decodeAbiParameters(
      [{ type: "int256" }, { type: "int256" }, { type: "int256" }, { type: "int256" }, { type: "int256" }, { type: "int256" }],
      info.interestRateModelParams,
    );
    const targetPct = targetFromRaw(target);
    if (targetPct === undefined) throw new Error("unsupported IRM target scale");
    return { kind: "adaptive-target", targetPct, configuration: { name: "IRMAdaptiveCurve", target_utilization: target.toString(), initial_rate_at_target: initial.toString(), min_rate_at_target: min.toString(), max_rate_at_target: max.toString(), curve_steepness: steepness.toString(), adjustment_speed: speed.toString() } };
  }
  if (info.interestRateModelType === 3) {
    const [baseRate, slope, shape, kink, cutoff] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      info.interestRateModelParams,
    );
    const targetPct = targetFromRaw(kink);
    if (targetPct === undefined) throw new Error("unsupported IRM kink scale");
    return { kind: "linear-kinky", targetPct, configuration: { name: "IRMLinearKinky", base_rate: baseRate.toString(), slope: slope.toString(), shape: shape.toString(), kink: kink.toString(), cutoff: cutoff.toString() } };
  }
  throw new Error(`unsupported IRM: canonical type ${info.interestRateModelType} has no utilization kink/target`);
}

export async function readRisk(client: PublicClient, vault: Address, irmLens: Address): Promise<RiskRead> {
  const blockNumber = await taggedRead("eth_blockNumber", () => client.getBlockNumber());
  const [totalAssets, cash, borrows, interestRate, irm] = await Promise.all([
    taggedRead("EVault.totalAssets", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "totalAssets", blockNumber })),
    taggedRead("EVault.cash", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "cash", blockNumber })),
    taggedRead("EVault.totalBorrows", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "totalBorrows", blockNumber })),
    taggedRead("EVault.interestRate", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "interestRate", blockNumber })),
    taggedRead("EVault.interestRateModel", () => client.readContract({ address: vault, abi: EVaultAbi, functionName: "interestRateModel", blockNumber })),
  ]);
  const irmInfo = await readIrm(client, irm as Address, blockNumber, irmLens);
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
