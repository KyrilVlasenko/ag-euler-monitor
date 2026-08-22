import { createPublicClient, decodeAbiParameters, formatUnits, http, type PublicClient } from "viem";
import { ERC20Abi, EulerEarnFactoryAbi, EVaultAbi, GenericFactoryAbi, IrmLensAbi } from "./abis.js";
import type { EulerDeployment } from "./config.js";
import type { Address, EventAmounts, EventSummary, Hex, IrmKind, RpcChainQuality, RpcQualityFinding, VaultType } from "./types.js";

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

function bytecodeSize(code: Hex | undefined): number {
  return code && code !== "0x" ? Math.max(0, (code.length - 2) / 2) : 0;
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
  private readonly endpoints: Array<{
    index: number;
    client: PublicClient;
    status: "pending" | "healthy" | "quarantined";
    blockNumber?: bigint;
    quarantineReason?: string;
  }>;
  private readonly findings: RpcQualityFinding[] = [];
  private initialized = false;
  private commonConfirmedBlock?: bigint;
  private readonly confirmationBlocks: bigint;

  constructor(
    readonly chainId: number,
    endpointUrls: string[],
    options: { clientFactory?: (url: string, index: number) => PublicClient; confirmationBlocks?: bigint } = {},
  ) {
    const clientFactory = options.clientFactory ?? ((url: string) => createClient(url));
    this.confirmationBlocks = options.confirmationBlocks ?? 12n;
    this.endpoints = endpointUrls.map((url, index) => ({ index, client: clientFactory(url, index), status: "pending" }));
  }

  private healthy() {
    return this.endpoints.filter((endpoint) => endpoint.status === "healthy");
  }

  private quarantine(index: number, reason: string): void {
    const endpoint = this.endpoints[index];
    if (!endpoint || endpoint.status === "quarantined") return;
    endpoint.status = "quarantined";
    endpoint.quarantineReason = reason;
    console.warn(`[rpc quarantine] chain=${this.chainId} endpoint=${index + 1} reason=${reason}`);
  }

  private addFinding(finding: Omit<RpcQualityFinding, "chain_id">): void {
    this.findings.push({ chain_id: this.chainId, ...finding });
  }

  async initialize(canary: Address): Promise<void> {
    if (this.initialized) return;
    await Promise.all(this.endpoints.map(async (endpoint) => {
      try {
        const actualChainId = await endpoint.client.getChainId();
        if (actualChainId !== this.chainId) {
          this.quarantine(endpoint.index, `wrong-chain expected=${this.chainId} actual=${actualChainId}`);
          this.addFinding({
            address: null,
            phase: "endpoint-validation",
            classification: "rpc-unavailable",
            resolved_by_fallback: false,
            block_number: null,
            code_endpoints: [],
            empty_code_endpoints: [],
            error_endpoints: [endpoint.index + 1],
            detail: `endpoint ${endpoint.index + 1} returned wrong chain ID`,
          });
          return;
        }
        endpoint.blockNumber = await endpoint.client.getBlockNumber();
        endpoint.status = "healthy";
      } catch (error) {
        this.quarantine(endpoint.index, `validation-failed error=${errorName(error)}`);
        this.addFinding({
          address: null,
          phase: "endpoint-validation",
          classification: "rpc-unavailable",
          resolved_by_fallback: false,
          block_number: null,
          code_endpoints: [],
          empty_code_endpoints: [],
          error_endpoints: [endpoint.index + 1],
          detail: `endpoint ${endpoint.index + 1} failed chain ID or block-number validation`,
        });
      }
    }));

    const validated = this.healthy();
    if (validated.length) {
      const minimumBlock = validated.reduce((minimum, endpoint) => endpoint.blockNumber! < minimum ? endpoint.blockNumber! : minimum, validated[0]!.blockNumber!);
      this.commonConfirmedBlock = minimumBlock > this.confirmationBlocks ? minimumBlock - this.confirmationBlocks : 0n;
      await Promise.all(validated.map(async (endpoint) => {
        try {
          const code = await endpoint.client.getCode({ address: canary, blockNumber: this.commonConfirmedBlock! });
          if (bytecodeSize(code) > 0) return;
          this.quarantine(endpoint.index, "canary-empty-code");
          this.addFinding({
            address: canary.toLowerCase() as Address,
            phase: "canary",
            classification: "rpc-unavailable",
            resolved_by_fallback: false,
            block_number: this.commonConfirmedBlock!.toString(),
            code_endpoints: [],
            empty_code_endpoints: [endpoint.index + 1],
            error_endpoints: [],
            detail: `endpoint ${endpoint.index + 1} returned empty code for the canonical chain canary`,
          });
        } catch (error) {
          this.quarantine(endpoint.index, `canary-read-failed error=${errorName(error)}`);
          this.addFinding({
            address: canary.toLowerCase() as Address,
            phase: "canary",
            classification: "rpc-unavailable",
            resolved_by_fallback: false,
            block_number: this.commonConfirmedBlock!.toString(),
            code_endpoints: [],
            empty_code_endpoints: [],
            error_endpoints: [endpoint.index + 1],
            detail: `endpoint ${endpoint.index + 1} failed the canonical chain canary read`,
          });
        }
      }));
    }
    this.initialized = true;
    const validationRecovered = this.healthy().length > 0;
    for (const finding of this.findings) {
      if (finding.phase === "endpoint-validation" || finding.phase === "canary") finding.resolved_by_fallback = validationRecovered;
    }
    console.log(`[rpc validation] chain=${this.chainId} configured=${this.endpoints.length} healthy=${this.healthy().length} quarantined=${this.endpoints.length - this.healthy().length} common_confirmed_block=${this.commonConfirmedBlock?.toString() ?? "unavailable"}`);
  }

  async withClient<T>(label: string, operation: (client: PublicClient) => Promise<T>): Promise<T> {
    if (!this.initialized) throw new Error("RPC pool must be validated before use");
    const healthy = this.healthy();
    if (!healthy.length) throw new RpcOperationError(label, 0, 0, 0, new Error("no healthy RPC endpoints available"));
    let rpcAttempts = 0;
    let fallbackAttempts = 0;
    const endpoints = new Set<number>();
    try {
      return await runWithFailover(
        healthy.length,
        (index) => {
          rpcAttempts++;
          const endpoint = healthy[index]!;
          endpoints.add(endpoint.index);
          return operation(endpoint.client);
        },
        (failed, next) => {
          fallbackAttempts++;
          console.warn(`[rpc fallback] chain=${this.chainId} operation=${label} endpoint=${healthy[failed]!.index + 1}->${healthy[next]!.index + 1}`);
        },
      );
    } catch (error) {
      throw new RpcOperationError(label, rpcAttempts, fallbackAttempts, endpoints.size, error);
    }
  }

  async verifyContractCode(address: Address, queryAllHealthy = false): Promise<ContractCodeVerification> {
    if (!this.initialized) throw new Error("RPC pool must be validated before code verification");
    const healthy = this.healthy();
    const blockNumber = this.commonConfirmedBlock;
    if (!healthy.length || blockNumber === undefined) {
      this.addFinding({
        address: address.toLowerCase() as Address,
        phase: "inventory-code",
        classification: "rpc-unavailable",
        resolved_by_fallback: false,
        block_number: null,
        code_endpoints: [],
        empty_code_endpoints: [],
        error_endpoints: healthy.map((endpoint) => endpoint.index + 1),
        detail: "no validated healthy RPC endpoint was available for code verification",
      });
      return { status: "rpc-unavailable", blockNumber: null, codeSize: 0, codeEndpoints: [], emptyCodeEndpoints: [], errorEndpoints: healthy.map((endpoint) => endpoint.index + 1) };
    }

    const codeResults: Array<{ endpoint: number; codeSize: number }> = [];
    const errorEndpoints: number[] = [];
    const query = async (endpoint: (typeof healthy)[number]): Promise<void> => {
      try {
        const code = await endpoint.client.getCode({ address, blockNumber });
        codeResults.push({ endpoint: endpoint.index, codeSize: bytecodeSize(code) });
      } catch {
        errorEndpoints.push(endpoint.index);
      }
    };

    await query(healthy[0]!);
    if (queryAllHealthy || !codeResults[0]?.codeSize || errorEndpoints.length) {
      for (const endpoint of healthy.slice(1)) await query(endpoint);
    }

    const codeEndpoints = codeResults.filter((result) => result.codeSize > 0).map((result) => result.endpoint);
    const emptyEndpoints = codeResults.filter((result) => result.codeSize === 0).map((result) => result.endpoint);
    if (queryAllHealthy) {
      console.log(`[rpc full code check] chain=${this.chainId} vault=${address.toLowerCase()} block=${blockNumber} code_endpoints=${codeEndpoints.map((index) => index + 1).join(",") || "none"} empty_endpoints=${emptyEndpoints.map((index) => index + 1).join(",") || "none"} error_endpoints=${errorEndpoints.map((index) => index + 1).join(",") || "none"}`);
    }
    if (codeEndpoints.length) {
      if (emptyEndpoints.length) {
        for (const index of emptyEndpoints) this.quarantine(index, `anomalous-empty-code address=${address.toLowerCase()}`);
        this.addFinding({
          address: address.toLowerCase() as Address,
          phase: "inventory-code",
          classification: "rpc-disagreement",
          resolved_by_fallback: true,
          block_number: blockNumber.toString(),
          code_endpoints: codeEndpoints.map((index) => index + 1),
          empty_code_endpoints: emptyEndpoints.map((index) => index + 1),
          error_endpoints: errorEndpoints.map((index) => index + 1),
          detail: "empty code from one endpoint contradicted non-empty code from another; empty-code endpoint quarantined",
        });
        console.warn(`[rpc disagreement] chain=${this.chainId} vault=${address.toLowerCase()} block=${blockNumber} empty_endpoints=${emptyEndpoints.map((index) => index + 1).join(",")} code_endpoints=${codeEndpoints.map((index) => index + 1).join(",")}`);
      }
      if (errorEndpoints.length) {
        for (const index of errorEndpoints) this.quarantine(index, `inventory-code-read-failed address=${address.toLowerCase()}`);
        this.addFinding({
          address: address.toLowerCase() as Address,
          phase: "inventory-code",
          classification: "rpc-unavailable",
          resolved_by_fallback: true,
          block_number: blockNumber.toString(),
          code_endpoints: codeEndpoints.map((index) => index + 1),
          empty_code_endpoints: emptyEndpoints.map((index) => index + 1),
          error_endpoints: errorEndpoints.map((index) => index + 1),
          detail: "an endpoint failed code verification; another validated endpoint returned contract code",
        });
      }
      const codeSize = codeResults.find((result) => result.codeSize > 0)!.codeSize;
      return { status: "contract", blockNumber, codeSize, codeEndpoints: codeEndpoints.map((index) => index + 1), emptyCodeEndpoints: emptyEndpoints.map((index) => index + 1), errorEndpoints: errorEndpoints.map((index) => index + 1) };
    }

    if (errorEndpoints.length) {
      for (const index of errorEndpoints) this.quarantine(index, `inventory-code-read-failed address=${address.toLowerCase()}`);
      this.addFinding({
        address: address.toLowerCase() as Address,
        phase: "inventory-code",
        classification: "rpc-unavailable",
        resolved_by_fallback: false,
        block_number: blockNumber.toString(),
        code_endpoints: [],
        empty_code_endpoints: emptyEndpoints.map((index) => index + 1),
        error_endpoints: errorEndpoints.map((index) => index + 1),
        detail: "code existence is unresolved because not every healthy endpoint completed the read",
      });
      return { status: "rpc-unavailable", blockNumber, codeSize: 0, codeEndpoints: [], emptyCodeEndpoints: emptyEndpoints.map((index) => index + 1), errorEndpoints: errorEndpoints.map((index) => index + 1) };
    }

    this.addFinding({
      address: address.toLowerCase() as Address,
      phase: "inventory-code",
      classification: "confirmed-no-code",
      resolved_by_fallback: false,
      block_number: blockNumber.toString(),
      code_endpoints: [],
      empty_code_endpoints: emptyEndpoints.map((index) => index + 1),
      error_endpoints: [],
      detail: "every validated healthy RPC endpoint returned empty code at the common confirmed block",
    });
    return { status: "confirmed-no-code", blockNumber, codeSize: 0, codeEndpoints: [], emptyCodeEndpoints: emptyEndpoints.map((index) => index + 1), errorEndpoints: [] };
  }

  recordUnsupportedContract(address: Address, blockNumber: bigint): void {
    this.addFinding({
      address: address.toLowerCase() as Address,
      phase: "contract-classification",
      classification: "unsupported-contract",
      resolved_by_fallback: false,
      block_number: blockNumber.toString(),
      code_endpoints: [],
      empty_code_endpoints: [],
      error_endpoints: [],
      detail: "contract code exists, but canonical factories and the supported ERC-4626 interface did not recognize the contract",
    });
  }

  qualityFindings(): RpcQualityFinding[] {
    return this.findings.map((finding) => structuredClone(finding));
  }

  qualitySummary(): RpcChainQuality {
    const distinctAddresses = (classification: RpcQualityFinding["classification"]): number => new Set(this.findings.filter((finding) => finding.classification === classification && finding.address).map((finding) => finding.address)).size;
    return {
      chain_id: this.chainId,
      configured_endpoints: this.endpoints.length,
      healthy_endpoints: this.healthy().length,
      quarantined_endpoints: this.endpoints.length - this.healthy().length,
      confirmed_no_code_markets: distinctAddresses("confirmed-no-code"),
      rpc_disagreement_markets: distinctAddresses("rpc-disagreement"),
      rpc_unavailable_events: this.findings.filter((finding) => finding.classification === "rpc-unavailable").length,
      unsupported_contracts: distinctAddresses("unsupported-contract"),
    };
  }
}

export interface ContractCodeVerification {
  status: "contract" | "confirmed-no-code" | "rpc-unavailable";
  blockNumber: bigint | null;
  codeSize: number;
  codeEndpoints: number[];
  emptyCodeEndpoints: number[];
  errorEndpoints: number[];
}

export interface VaultDetection {
  blockNumber: bigint;
  vaultType: VaultType;
  codeExists: boolean;
  codeSize: number;
}

export async function detectVault(client: PublicClient, vault: Address, deployment: EulerDeployment, verified?: { blockNumber: bigint; codeSize: number }): Promise<VaultDetection> {
  const blockNumber = verified?.blockNumber ?? await taggedRead("eth_blockNumber", () => client.getBlockNumber());
  const codeSize = verified?.codeSize ?? bytecodeSize(await taggedRead("eth_getCode", () => client.getCode({ address: vault, blockNumber })));
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
