import assert from "node:assert/strict";
import { criticalThreshold, evaluateMarket, isDepositEligible, needsEventInvestigation, type EngineOptions } from "./engine.js";
import { buildNotificationFeed, formatHealth, formatRecovery, formatRiskAlert, makeNotification } from "./format.js";
import { loadInventory } from "./inventory.js";
import { getOnchainVaultPrice, getPrices } from "./prices.js";
import { borrowApyPct, describeRpcFailure, detectVault, readEvents, readRisk, readStage1, RpcPool, toTokenNumber, utilizationPct, type ContractCodeVerification, type Stage1Read, type VaultDetection } from "./rpc.js";
import { safeErrorReason } from "./security.js";
import { loadState, writePublicJson, writePublicText } from "./state.js";
import { EULER_DEPLOYMENTS, executionMode, FULL_RPC_CODE_CHECKS, marketKey, type MonitorConfig } from "./config.js";
import type {
  Address,
  ChainCoverage,
  CoverageIssue,
  InventoryVault,
  LatestFeed,
  MarketSnapshot,
  MarketState,
  MonitorState,
  NotificationEvent,
  NotificationFeed,
  RiskNotApplicableMarket,
  RpcQualityReport,
} from "./types.js";

interface Stage1Result extends Stage1Read {
  vault: InventoryVault;
  pool: RpcPool;
  detection: VaultDetection;
}

type CandidateOutcome = "pending" | "risk-not-applicable" | "eligibility-unresolved" | "deposit-ineligible" | "monitoring-unresolved" | "fully-monitored";

export class CoverageTracker {
  private readonly outcomes = new Map<string, CandidateOutcome>();
  private readonly candidates = new Map<string, InventoryVault>();

  constructor(private readonly vaults: InventoryVault[]) {
    for (const vault of vaults) {
      if (vault.statusDecision === "exclude") continue;
      const key = marketKey(vault.chainId, vault.address);
      this.candidates.set(key, vault);
      this.outcomes.set(key, "pending");
    }
  }

  mark(vault: InventoryVault, outcome: Exclude<CandidateOutcome, "pending">): void {
    const key = marketKey(vault.chainId, vault.address);
    const current = this.outcomes.get(key);
    if (current !== "pending") throw new Error(`coverage outcome already finalized for ${key}: ${current ?? "missing"}`);
    this.outcomes.set(key, outcome);
  }

  pending(): InventoryVault[] {
    return [...this.candidates.entries()].filter(([key]) => this.outcomes.get(key) === "pending").map(([, vault]) => vault);
  }

  rows(): ChainCoverage[] {
    const result = new Map<number, ChainCoverage>();
    for (const vault of this.vaults) {
      const row = result.get(vault.chainId) ?? {
        chain_id: vault.chainId,
        chain_name: vault.chainName,
        inventory_candidates: 0,
        lifecycle_excluded: 0,
        risk_not_applicable: 0,
        eligibility_unresolved: 0,
        deposit_ineligible: 0,
        deposit_eligible: 0,
        fully_monitored: 0,
        monitoring_unresolved: 0,
        unresolved: 0,
      };
      if (vault.statusDecision === "exclude") {
        row.lifecycle_excluded++;
      } else {
        row.inventory_candidates++;
        const outcome = this.outcomes.get(marketKey(vault.chainId, vault.address));
        if (outcome === "risk-not-applicable") row.risk_not_applicable++;
        else if (outcome === "eligibility-unresolved") row.eligibility_unresolved++;
        else if (outcome === "deposit-ineligible") row.deposit_ineligible++;
        else if (outcome === "monitoring-unresolved") {
          row.deposit_eligible++;
          row.monitoring_unresolved++;
        } else if (outcome === "fully-monitored") {
          row.deposit_eligible++;
          row.fully_monitored++;
        } else {
          throw new Error(`coverage outcome is pending for ${marketKey(vault.chainId, vault.address)}`);
        }
      }
      row.unresolved = row.eligibility_unresolved + row.monitoring_unresolved;
      result.set(vault.chainId, row);
    }
    return [...result.values()].sort((a, b) => a.chain_id - b.chain_id);
  }
}

export interface CoverageTotals {
  risk_not_applicable: number;
  eligibility_unresolved: number;
  deposit_ineligible: number;
  deposit_eligible: number;
  fully_monitored: number;
  monitoring_unresolved: number;
  unresolved: number;
}

export function assertCoverageInvariants(rows: ChainCoverage[]): CoverageTotals {
  for (const row of rows) {
    assert.equal(row.inventory_candidates, row.risk_not_applicable + row.eligibility_unresolved + row.deposit_ineligible + row.deposit_eligible, `chain ${row.chain_id}: every candidate must have exactly one outcome`);
    assert.equal(row.deposit_eligible, row.fully_monitored + row.monitoring_unresolved, `chain ${row.chain_id}: every eligible market must be monitored or unresolved`);
    assert.equal(row.unresolved, row.eligibility_unresolved + row.monitoring_unresolved, `chain ${row.chain_id}: unresolved counters must reconcile`);
  }
  const sum = (field: keyof CoverageTotals): number => rows.reduce((total, row) => total + row[field], 0);
  const totals: CoverageTotals = {
    risk_not_applicable: sum("risk_not_applicable"),
    eligibility_unresolved: sum("eligibility_unresolved"),
    deposit_ineligible: sum("deposit_ineligible"),
    deposit_eligible: sum("deposit_eligible"),
    fully_monitored: sum("fully_monitored"),
    monitoring_unresolved: sum("monitoring_unresolved"),
    unresolved: sum("unresolved"),
  };
  const globalFullyMonitored = totals.fully_monitored;
  const perChainFullyMonitored = rows.reduce((total, row) => total + row.fully_monitored, 0);
  assert.equal(globalFullyMonitored, perChainFullyMonitored, "globalFullyMonitored === sum(perChainFullyMonitored)");
  assert.equal(totals.deposit_eligible, totals.fully_monitored + totals.monitoring_unresolved, "global eligible counters must reconcile");
  assert.equal(totals.unresolved, totals.eligibility_unresolved + totals.monitoring_unresolved, "global unresolved counters must reconcile");
  return totals;
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

function ineligibleState(vault: InventoryVault, depositsUsd: number | null, totalAssetsRaw: string | null, now: string, prior?: MarketState): MarketState {
  const key = marketKey(vault.chainId, vault.address);
  return {
    key,
    chain_id: vault.chainId,
    vault_address: vault.address.toLowerCase() as Address,
    prior_eligibility: false,
    lifecycle_status: vault.status ?? null,
    deposits_usd: depositsUsd,
    total_assets_raw: totalAssetsRaw,
    total_borrows_raw: null,
    available_liquidity_usd: null,
    utilization_pct: null,
    borrow_apy_pct: null,
    irm_address: null,
    irm_type: null,
    kink_target_pct: null,
    critical_threshold_pct: null,
    block_number: null,
    timestamp: now,
    alert_active: false,
    last_alert_timestamp: prior?.last_alert_timestamp ?? null,
    last_alert_utilization_pct: null,
    most_recent_alert_state: prior?.most_recent_alert_state ?? "never",
    previous_successfully_processed_block: prior?.previous_successfully_processed_block ?? null,
    snapshot: null,
  };
}

function issueFor(vault: InventoryVault | undefined, source: CoverageIssue["source"], reason: string): CoverageIssue {
  return {
    chain_id: vault?.chainId ?? null,
    chain_name: vault?.chainName ?? null,
    vault_address: vault?.address.toLowerCase() as Address | undefined ?? null,
    source,
    reason,
  };
}

export function updateHealth(previous: MonitorState, next: MonitorState, issues: CoverageIssue[], now: string, threshold: number, notifications: NotificationEvent[]): void {
  if (issues.length) {
    const consecutive = previous.health.consecutive_degraded_runs + 1;
    const shouldAlert = consecutive >= threshold && !previous.health.degraded_alert_active;
    next.health = {
      consecutive_degraded_runs: consecutive,
      degraded_alert_active: previous.health.degraded_alert_active || shouldAlert,
      last_degraded_at: shouldAlert ? now : previous.health.last_degraded_at,
      last_restored_at: previous.health.last_restored_at,
      last_issues: issues,
    };
    if (shouldAlert) notifications.push(makeNotification("monitor_degraded", now, formatHealth(issues, false), `degraded:${consecutive}:${issues.map((issue) => `${issue.chain_id}:${issue.vault_address}:${issue.source}`).sort().join("|")}`));
    return;
  }
  if (previous.health.degraded_alert_active) {
    notifications.push(makeNotification("monitor_restored", now, formatHealth([], true), `restored:${previous.health.last_degraded_at ?? previous.updated_at}`));
  }
  next.health = {
    consecutive_degraded_runs: 0,
    degraded_alert_active: false,
    last_degraded_at: previous.health.last_degraded_at,
    last_restored_at: previous.health.degraded_alert_active ? now : previous.health.last_restored_at,
    last_issues: [],
  };
}

function marketStateFromSnapshot(previous: MarketState | undefined, snapshot: MarketSnapshot, notification: "risk_alert" | "recovery" | null, active: boolean, lastAlertUtilizationPct: number | null, now: string): MarketState {
  return {
    key: snapshot.key,
    chain_id: snapshot.chain_id,
    vault_address: snapshot.vault_address,
    prior_eligibility: true,
    lifecycle_status: snapshot.lifecycle_status,
    deposits_usd: snapshot.deposits_usd,
    total_assets_raw: snapshot.total_assets_raw,
    total_borrows_raw: snapshot.total_borrows_raw,
    available_liquidity_usd: snapshot.available_liquidity_usd,
    utilization_pct: snapshot.utilization_pct,
    borrow_apy_pct: snapshot.borrow_apy_pct,
    irm_address: snapshot.irm_address,
    irm_type: snapshot.irm_type,
    kink_target_pct: snapshot.kink_target_pct,
    critical_threshold_pct: snapshot.critical_threshold_pct,
    block_number: snapshot.block_number,
    timestamp: snapshot.observed_at,
    alert_active: active,
    last_alert_timestamp: notification === "risk_alert" ? now : previous?.last_alert_timestamp ?? null,
    last_alert_utilization_pct: lastAlertUtilizationPct,
    most_recent_alert_state: notification === "risk_alert" ? "alerted" : notification === "recovery" ? "recovered" : previous?.most_recent_alert_state ?? "never",
    previous_successfully_processed_block: snapshot.block_number,
    snapshot,
  };
}

function logRpcDiagnostic(vault: InventoryVault, error: unknown, detection?: VaultDetection): void {
  const detail = describeRpcFailure(error);
  const vaultType = detection?.vaultType ?? "unknown";
  const codeExists = detection?.codeExists === undefined ? "unknown" : String(detection.codeExists);
  const codeSize = detection?.codeSize ?? -1;
  console.error(
    `[rpc diagnostic] chain=${vault.chainId} vault=${vault.address.toLowerCase()} vault_type=${vaultType} code_exists=${codeExists} code_size=${codeSize} operation=${detail.operation} function=${detail.functionAttempted} short_message=${JSON.stringify(detail.shortMessage)} cause=${JSON.stringify(detail.cause)} rpc_attempts=${detail.rpcAttempts} fallback_attempts=${detail.fallbackAttempts} endpoints_tried=${detail.endpointsTried}`,
  );
}

export async function runMonitor(config: MonitorConfig): Promise<void> {
  const startedAt = new Date().toISOString();
  const mode = executionMode(config.dryRun, config.testThresholdPct);
  const loadedState = await loadState(config.stateInputPath);
  const previous = loadedState.state;
  const productionStateSafe = loadedState.valid;
  const next = structuredClone(previous);
  next.updated_at = startedAt;
  const notifications: NotificationEvent[] = [];
  const issues: CoverageIssue[] = [];
  const snapshots: MarketSnapshot[] = [];
  const riskNotApplicableMarkets: RiskNotApplicableMarket[] = [];
  const rpcPools = new Map<number, RpcPool>();
  const codeVerifications = new Map<string, ContractCodeVerification>();
  const engineOptions: EngineOptions = {
    materialUtilJumpPp: config.materialUtilJumpPp,
    largeEventUsdMin: config.largeEventUsdMin,
    largeEventDepositsPct: config.largeEventDepositsPct,
    ...(config.testThresholdPct === undefined ? {} : { testThresholdPct: config.testThresholdPct }),
    repeatWhileAbove: config.repeatWhileAbove,
  };
  if (!productionStateSafe) issues.push(issueFor(undefined, "state", loadedState.reason ?? "persistent state is invalid"));

  let inventory: InventoryVault[] = [];
  let coverage: CoverageTracker | undefined;
  try {
    inventory = await loadInventory(config.inventoryUrl, config.inventoryPath);
    coverage = new CoverageTracker(inventory);
    const coverageTracker = coverage;
    const inventoryKeys = new Set(inventory.map((vault) => marketKey(vault.chainId, vault.address)));
    for (const key of Object.keys(next.markets)) if (!inventoryKeys.has(key)) delete next.markets[key];
    const excluded = inventory.filter((vault) => vault.statusDecision === "exclude");
    const candidates = inventory.filter((vault) => vault.statusDecision !== "exclude");
    for (const vault of excluded) next.markets[marketKey(vault.chainId, vault.address)] = ineligibleState(vault, null, null, startedAt, previous.markets[marketKey(vault.chainId, vault.address)]);
    console.log(`[inventory] total=${inventory.length} lifecycle_excluded=${excluded.length} candidates=${candidates.length}`);

    for (const chainId of [...new Set(candidates.map((vault) => vault.chainId))].sort((a, b) => a - b)) {
      const endpoints = config.rpcUrls[chainId];
      const deployment = EULER_DEPLOYMENTS[chainId];
      if (!endpoints?.length || !deployment) continue;
      const pool = new RpcPool(chainId, endpoints);
      await pool.initialize(deployment.eVaultFactory);
      rpcPools.set(chainId, pool);
      const fullChecks = new Set((FULL_RPC_CODE_CHECKS[chainId] ?? []).map((address) => address.toLowerCase()));
      const chainCandidates = candidates.filter((candidate) => candidate.chainId === chainId);
      for (const vault of chainCandidates) {
        codeVerifications.set(marketKey(chainId, vault.address), await pool.verifyContractCode(vault.address, fullChecks.has(vault.address.toLowerCase())));
        fullChecks.delete(vault.address.toLowerCase());
      }
      for (const address of fullChecks) await pool.verifyContractCode(address as Address, true);
    }

    const stage1 = (await mapLimit(candidates, 8, async (vault): Promise<Stage1Result | null> => {
      const endpoints = config.rpcUrls[vault.chainId];
      if (!endpoints?.length) {
        issues.push(issueFor(vault, "rpc", "missing RPC configuration"));
        coverageTracker.mark(vault, "eligibility-unresolved");
        return null;
      }
      const deployment = EULER_DEPLOYMENTS[vault.chainId];
      if (!deployment) {
        issues.push(issueFor(vault, "collector", "missing canonical Euler deployment metadata"));
        coverageTracker.mark(vault, "eligibility-unresolved");
        return null;
      }
      const pool = rpcPools.get(vault.chainId);
      if (!pool) {
        issues.push(issueFor(vault, "rpc", "RPC pool unavailable after endpoint validation"));
        coverageTracker.mark(vault, "eligibility-unresolved");
        return null;
      }
      const verification = codeVerifications.get(marketKey(vault.chainId, vault.address));
      if (!verification || verification.status === "rpc-unavailable" || verification.blockNumber === null) {
        const reason = "RPC unavailable during multi-endpoint code verification; code existence unresolved";
        issues.push(issueFor(vault, "rpc", reason));
        coverageTracker.mark(vault, "eligibility-unresolved");
        console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=rpc classification=rpc-unavailable reason=${reason}`);
        return null;
      }
      if (verification.status === "confirmed-no-code") {
        const reason = `confirmed no-code across all healthy RPCs at block ${verification.blockNumber}; endpoints=${verification.emptyCodeEndpoints.join(",")}`;
        issues.push(issueFor(vault, "collector", reason));
        coverageTracker.mark(vault, "eligibility-unresolved");
        console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=collector classification=confirmed-no-code reason=${reason}`);
        return null;
      }
      let detection: VaultDetection | undefined;
      try {
        detection = await pool.withClient("vault-detection", (client) => detectVault(client, vault.address, deployment, { blockNumber: verification.blockNumber!, codeSize: verification.codeSize }));
        if (detection.vaultType === "non-vault") {
          pool.recordUnsupportedContract(vault.address, detection.blockNumber);
          const reason = `genuine unsupported contract; code_exists=${detection.codeExists} code_size=${detection.codeSize}`;
          issues.push(issueFor(vault, "collector", reason));
          coverageTracker.mark(vault, "eligibility-unresolved");
          console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=collector reason=${reason}`);
          return null;
        }
        const result = await pool.withClient("deposit-gate", (client) => readStage1(client, vault.address, detection!));
        if (!result.riskApplicable) {
          coverageTracker.mark(vault, "risk-not-applicable");
          riskNotApplicableMarkets.push({
            chain_id: vault.chainId,
            chain_name: vault.chainName,
            vault_address: vault.address.toLowerCase() as Address,
            vault_type: detection.vaultType,
            block_number: result.blockNumber.toString(),
            reason: result.riskNotApplicableReason!,
            interest_rate_model: result.interestRateModel!.toLowerCase() as Address,
            total_borrows_raw: result.totalBorrows!.toString(),
            collateral_count: result.collateralCount!,
            borrow_cap: result.borrowCap!.toString(),
          });
          next.markets[marketKey(vault.chainId, vault.address)] = ineligibleState(vault, null, result.totalAssets.toString(), startedAt, previous.markets[marketKey(vault.chainId, vault.address)]);
          console.log(`[risk applicability] chain=${vault.chainId} vault=${vault.address.toLowerCase()} vault_type=${detection.vaultType} applicable=false reason=${result.riskNotApplicableReason} code_size=${detection.codeSize} borrow_cap=${result.borrowCap?.toString() ?? "unknown"}`);
          return null;
        }
        return { vault, pool, detection, ...result };
      } catch (error) {
        const reason = safeErrorReason(error, "deposit-stage RPC read failed");
        issues.push(issueFor(vault, "rpc", reason));
        coverageTracker.mark(vault, "eligibility-unresolved");
        console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=rpc reason=${reason}`);
        logRpcDiagnostic(vault, error, detection);
        return null;
      }
    })).filter((value): value is Stage1Result => value !== null);

    const prices = new Map<number, Map<string, Awaited<ReturnType<typeof getPrices>> extends Map<string, infer P> ? P : never>>();
    for (const chainId of [...new Set(stage1.map((result) => result.vault.chainId))]) {
      const assets = stage1.filter((result) => result.vault.chainId === chainId).map((result) => result.asset);
      prices.set(chainId, await getPrices(config.eulerV3Url, chainId, assets));
    }

    await mapLimit(stage1, 6, async (stage): Promise<void> => {
      const { vault } = stage;
      const key = marketKey(vault.chainId, vault.address);
      const priorState = previous.markets[key];
      const deployment = EULER_DEPLOYMENTS[vault.chainId]!;
      let price = prices.get(vault.chainId)?.get(stage.asset.toLowerCase());
      if (!price) {
        try {
          price = await stage.pool.withClient("onchain-price", (client) => getOnchainVaultPrice(client, config.eulerV3Url, vault.chainId, deployment.utilsLens, vault.address, stage.detection.vaultType, stage.asset));
          if (price) console.log(`[price fallback] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=euler-onchain`);
        } catch (error) {
          const reason = safeErrorReason(error, "on-chain USD price read failed");
          issues.push(issueFor(vault, "price", reason));
          coverageTracker.mark(vault, "eligibility-unresolved");
          console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=price reason=${reason}`);
          logRpcDiagnostic(vault, error, stage.detection);
          return;
        }
      }
      if (!price) {
        const reason = "USD price unavailable; eligibility unresolved";
        issues.push(issueFor(vault, "price", reason));
        coverageTracker.mark(vault, "eligibility-unresolved");
        console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=price reason=unavailable`);
        return;
      }
      const gateDepositsUsd = toTokenNumber(stage.totalAssets, stage.decimals) * price.price;
      if (!isDepositEligible(gateDepositsUsd, config.minDepositsUsd)) {
        next.markets[key] = ineligibleState(vault, gateDepositsUsd, stage.totalAssets.toString(), startedAt, priorState);
        coverageTracker.mark(vault, "deposit-ineligible");
        console.log(`[deposit gate] chain=${vault.chainId} vault=${vault.address.toLowerCase()} eligible=false deposits_usd=${gateDepositsUsd.toFixed(2)}`);
        return;
      }

      if (stage.detection.vaultType !== "evault") {
        const reason = stage.detection.vaultType === "euler-earn"
          ? "EulerEarn aggregate has no contract-level utilization kink; allocated underlying EVault strategy coverage is required"
          : "eligible non-EVault ERC4626 contract has no supported utilization/kink semantics";
        issues.push(issueFor(vault, "collector", reason));
        coverageTracker.mark(vault, "monitoring-unresolved");
        console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=collector vault_type=${stage.detection.vaultType} reason=${reason}`);
        return;
      }

      try {
        const risk = await stage.pool.withClient("risk-and-live-irm", (client) => readRisk(client, vault.address, deployment.irmLens));
        const depositsUsd = toTokenNumber(risk.totalAssets, stage.decimals) * price.price;
        if (!isDepositEligible(depositsUsd, config.minDepositsUsd)) {
          next.markets[key] = ineligibleState(vault, depositsUsd, risk.totalAssets.toString(), startedAt, priorState);
          coverageTracker.mark(vault, "deposit-ineligible");
          return;
        }
        const threshold = criticalThreshold(risk.irmInfo.targetPct, config.thresholdOffsetPp);
        const snapshot: MarketSnapshot = {
          key,
          chain_name: vault.chainName,
          chain_id: vault.chainId,
          label: vault.label,
          vault_address: vault.address.toLowerCase() as Address,
          asset_address: stage.asset.toLowerCase() as Address,
          asset_symbol: stage.symbol,
          asset_decimals: stage.decimals,
          lifecycle_status: vault.status ?? null,
          observed_at: startedAt,
          block_number: risk.blockNumber.toString(),
          price_usd: price.price,
          price_source: price.source,
          total_assets_raw: risk.totalAssets.toString(),
          deposits_usd: depositsUsd,
          cash_raw: risk.cash.toString(),
          total_borrows_raw: risk.borrows.toString(),
          available_liquidity_usd: toTokenNumber(risk.cash, stage.decimals) * price.price,
          utilization_pct: utilizationPct(risk.cash, risk.borrows),
          interest_rate_spy_ray: risk.interestRate.toString(),
          borrow_apy_pct: borrowApyPct(risk.interestRate),
          irm_address: risk.irm.toLowerCase() as Address,
          irm_type: risk.irmInfo.kind,
          irm_configuration: risk.irmInfo.configuration,
          kink_target_pct: risk.irmInfo.targetPct,
          critical_threshold_pct: threshold,
        };
        snapshots.push(snapshot);
        let monitoringUnresolved = false;

        let events;
        if (needsEventInvestigation(priorState, snapshot, engineOptions) && priorState?.previous_successfully_processed_block) {
          try {
            events = await stage.pool.withClient("alert-event-attribution", (client) => readEvents(client, vault.address, BigInt(priorState.previous_successfully_processed_block!) + 1n, risk.blockNumber));
          } catch (error) {
            const reason = safeErrorReason(error, "event query failed");
            issues.push(issueFor(vault, "events", reason));
            monitoringUnresolved = true;
            console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=events reason=${reason}`);
            logRpcDiagnostic(vault, error, stage.detection);
          }
        }
        const decision = evaluateMarket(priorState, snapshot, events, engineOptions);
        if (!productionStateSafe && decision.notification) {
          console.warn(`[decision] chain=${vault.chainId} vault=${vault.address.toLowerCase()} result=suppressed-invalid-state`);
        } else if (decision.notification === "risk_alert") {
          const message = formatRiskAlert(snapshot, priorState?.snapshot ?? null, decision.attribution!);
          notifications.push(makeNotification("risk_alert", startedAt, message, `${snapshot.block_number}:${snapshot.irm_address}:${snapshot.critical_threshold_pct}`, snapshot.chain_id, snapshot.vault_address));
        } else if (decision.notification === "recovery") {
          const message = formatRecovery(snapshot, priorState?.snapshot ?? null);
          notifications.push(makeNotification("recovery", startedAt, message, `${snapshot.block_number}:${snapshot.critical_threshold_pct}`, snapshot.chain_id, snapshot.vault_address));
        }
        next.markets[key] = marketStateFromSnapshot(priorState, snapshot, decision.notification, decision.nextAlertActive, decision.lastAlertUtilizationPct, startedAt);
        coverageTracker.mark(vault, monitoringUnresolved ? "monitoring-unresolved" : "fully-monitored");
        console.log(`[decision] chain=${vault.chainId} vault=${vault.address.toLowerCase()} util=${snapshot.utilization_pct.toFixed(2)} threshold=${(config.testThresholdPct ?? threshold).toFixed(2)} result=${decision.notification ?? "silent"}`);
      } catch (error) {
        const diagnostic = describeRpcFailure(error);
        const source: CoverageIssue["source"] = /IRM|kink|target/i.test(`${diagnostic.operation} ${diagnostic.functionAttempted} ${diagnostic.shortMessage}`) ? "irm" : "rpc";
        const reason = safeErrorReason(error, source === "irm" ? "live IRM read failed" : "risk-stage RPC read failed");
        issues.push(issueFor(vault, source, reason));
        coverageTracker.mark(vault, "monitoring-unresolved");
        console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=${source} reason=${reason}`);
        logRpcDiagnostic(vault, error, stage.detection);
      }
    });
  } catch (error) {
    const reason = safeErrorReason(error, "inventory/collector failure");
    issues.push(issueFor(undefined, "inventory", reason));
    console.error(`[coverage] source=inventory reason=${reason}`);
  }

  if (coverage) {
    for (const vault of coverage.pending()) {
      coverage.mark(vault, "eligibility-unresolved");
      issues.push(issueFor(vault, "collector", "candidate left without a final coverage outcome"));
    }
  }
  const coverageRows = coverage?.rows() ?? [];
  let coverageTotals: CoverageTotals = {
    risk_not_applicable: 0,
    eligibility_unresolved: 0,
    deposit_ineligible: 0,
    deposit_eligible: 0,
    fully_monitored: 0,
    monitoring_unresolved: 0,
    unresolved: 0,
  };
  try {
    coverageTotals = assertCoverageInvariants(coverageRows);
    assert.equal(coverageTotals.risk_not_applicable, riskNotApplicableMarkets.length, "risk-not-applicable detail rows must reconcile with coverage counters");
    assert.ok(coverageTotals.fully_monitored <= snapshots.length, "fully monitored count cannot exceed successful snapshots");
  } catch (error) {
    const reason = error instanceof Error ? `coverage accounting invariant failed: ${error.message}` : "coverage accounting invariant failed";
    issues.push(issueFor(undefined, "collector", reason));
    console.error(`[coverage invariant] ${reason}`);
  }

  if (productionStateSafe) {
    updateHealth(previous, next, issues, startedAt, config.degradedRunsBeforeAlert, notifications);
  } else {
    next.health = {
      consecutive_degraded_runs: config.degradedRunsBeforeAlert,
      degraded_alert_active: true,
      last_degraded_at: startedAt,
      last_restored_at: null,
      last_issues: issues,
    };
    notifications.push(makeNotification("monitor_degraded", startedAt, formatHealth(issues, false), "persistent-state-invalid"));
  }
  const completedAt = new Date().toISOString();
  const health = issues.length ? "degraded" : "healthy";
  const lifecycleExcluded = inventory.filter((vault) => vault.statusDecision === "exclude").length;
  for (const row of coverageRows) console.log(`[chain coverage] chain=${row.chain_id} candidates=${row.inventory_candidates} risk_not_applicable=${row.risk_not_applicable} eligibility_unresolved=${row.eligibility_unresolved} ineligible=${row.deposit_ineligible} eligible=${row.deposit_eligible} monitored=${row.fully_monitored} monitoring_unresolved=${row.monitoring_unresolved} unresolved=${row.unresolved}`);
  const rpcQuality: RpcQualityReport = {
    chains: [...rpcPools.values()].map((pool) => pool.qualitySummary()).sort((a, b) => a.chain_id - b.chain_id),
    findings: [...rpcPools.values()].flatMap((pool) => pool.qualityFindings()).sort((a, b) => `${a.chain_id}:${a.address ?? ""}:${a.phase}`.localeCompare(`${b.chain_id}:${b.address ?? ""}:${b.phase}`)),
  };
  for (const chain of rpcQuality.chains) console.log(`[rpc quality] chain=${chain.chain_id} configured=${chain.configured_endpoints} healthy=${chain.healthy_endpoints} quarantined=${chain.quarantined_endpoints} confirmed_no_code=${chain.confirmed_no_code_markets} disagreements=${chain.rpc_disagreement_markets} unavailable_events=${chain.rpc_unavailable_events} unsupported=${chain.unsupported_contracts}`);

  const latest: LatestFeed = {
    schema_version: 1,
    run_id: config.runId,
    generated_at: startedAt,
    collector_completed_at: completedAt,
    health,
    mode,
    production_state_safe: productionStateSafe,
    config: { min_deposits_usd: config.minDepositsUsd, threshold_offset_pp: config.thresholdOffsetPp, test_threshold_pct: config.testThresholdPct ?? null },
    inventory: {
      source_url: config.inventoryUrl,
      total: inventory.length,
      lifecycle_excluded: lifecycleExcluded,
      candidates: inventory.length - lifecycleExcluded,
      risk_not_applicable: coverageTotals.risk_not_applicable,
      eligibility_unresolved: coverageTotals.eligibility_unresolved,
      deposit_ineligible: coverageTotals.deposit_ineligible,
      deposit_eligible: coverageTotals.deposit_eligible,
      fully_monitored: coverageTotals.fully_monitored,
      monitoring_unresolved: coverageTotals.monitoring_unresolved,
      unresolved: coverageTotals.unresolved,
    },
    coverage: coverageRows,
    rpc_quality: rpcQuality,
    risk_not_applicable_markets: riskNotApplicableMarkets.sort((a, b) => `${a.chain_id}:${a.vault_address}`.localeCompare(`${b.chain_id}:${b.vault_address}`)),
    issues,
    markets: snapshots.sort((a, b) => a.key.localeCompare(b.key)),
  };
  const feed: NotificationFeed = buildNotificationFeed(config.runId, startedAt, completedAt, health, notifications);
  const summary = [
    `# Euler monitor — ${startedAt}`,
    `- Mode: ${mode}`,
    `- Inventory rows: ${inventory.length}`,
    `- Lifecycle excluded: ${lifecycleExcluded}`,
    `- Risk not applicable: ${latest.inventory.risk_not_applicable}`,
    `- Eligibility unresolved: ${latest.inventory.eligibility_unresolved}`,
    `- Deposit ineligible: ${latest.inventory.deposit_ineligible}`,
    `- Deposit eligible: ${latest.inventory.deposit_eligible}`,
    `- Fully monitored: ${latest.inventory.fully_monitored}`,
    `- Monitoring unresolved: ${latest.inventory.monitoring_unresolved}`,
    `- Total unresolved: ${latest.inventory.unresolved}`,
    `- Coverage: ${health}`,
    `- Notifications generated: ${notifications.length}`,
    `- Feed output: ${mode === "production" ? "notifications.json" : "notifications-test.json"}`,
    "",
    ...coverageRows.map((row) => `- Chain ${row.chain_id}: ${row.fully_monitored}/${row.deposit_eligible} eligible markets monitored; risk not applicable ${row.risk_not_applicable}; eligibility unresolved ${row.eligibility_unresolved}; monitoring unresolved ${row.monitoring_unresolved}; total unresolved ${row.unresolved}`),
    "",
    "## RPC quality",
    ...rpcQuality.chains.map((chain) => `- Chain ${chain.chain_id}: endpoints ${chain.healthy_endpoints}/${chain.configured_endpoints} healthy, ${chain.quarantined_endpoints} quarantined; confirmed no-code ${chain.confirmed_no_code_markets}; RPC disagreements ${chain.rpc_disagreement_markets}; RPC unavailable events ${chain.rpc_unavailable_events}; unsupported contracts ${chain.unsupported_contracts}`),
    ...rpcQuality.findings.map((finding) => `- Chain ${finding.chain_id} ${finding.address ?? "chain endpoint"}: ${finding.classification}; phase ${finding.phase}; fallback resolved ${finding.resolved_by_fallback}; block ${finding.block_number ?? "unavailable"}; code endpoints [${finding.code_endpoints.join(",")}]; empty endpoints [${finding.empty_code_endpoints.join(",")}]; error endpoints [${finding.error_endpoints.join(",")}]; ${finding.detail}`),
    ...(riskNotApplicableMarkets.length ? ["", "## Risk not applicable (live canonical configuration)", ...riskNotApplicableMarkets.map((market) => `- ${market.chain_id} ${market.vault_address}: ${market.reason}; IRM ${market.interest_rate_model}; borrows ${market.total_borrows_raw}; collateral LTVs ${market.collateral_count}`)] : []),
    ...(issues.length ? ["", "## Coverage issues", ...issues.map((issue) => `- ${issue.chain_id ?? "global"} ${issue.vault_address ?? ""} [${issue.source}] ${issue.reason}`)] : []),
    ...(notifications.length ? ["", "## Would-be/new notifications", ...notifications.map((notification) => `\n${notification.message}\n`)] : []),
  ].join("\n") + "\n";

  await writePublicJson(config.stateOutputPath, next);
  await writePublicJson(config.latestOutputPath, latest);
  await writePublicJson(mode === "production" ? config.notificationsOutputPath : config.testNotificationsOutputPath, feed);
  await writePublicText(config.summaryOutputPath, summary);
  console.log(`[feed] mode=${mode} health=${health} notifications=${notifications.length}`);
  if (mode !== "production") console.log("[isolation] production state/feed persistence is disabled for this run mode");
  if (issues.length) process.exitCode = 2;
}
