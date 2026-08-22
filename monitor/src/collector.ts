import { criticalThreshold, evaluateMarket, isDepositEligible, needsEventInvestigation, type EngineOptions } from "./engine.js";
import { buildNotificationFeed, formatHealth, formatRecovery, formatRiskAlert, makeNotification } from "./format.js";
import { loadInventory } from "./inventory.js";
import { getPrices } from "./prices.js";
import { readEvents, readRisk, readStage1, RpcPool, toTokenNumber, utilizationPct, borrowApyPct } from "./rpc.js";
import { safeErrorReason } from "./security.js";
import { loadState, writePublicJson, writePublicText } from "./state.js";
import { executionMode, marketKey, type MonitorConfig } from "./config.js";
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
} from "./types.js";

interface Stage1Result {
  vault: InventoryVault;
  pool: RpcPool;
  asset: Address;
  decimals: number;
  symbol: string;
  totalAssets: bigint;
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

function makeCoverage(vaults: InventoryVault[]): Map<number, ChainCoverage> {
  const result = new Map<number, ChainCoverage>();
  for (const vault of vaults) {
    const existing = result.get(vault.chainId) ?? {
      chain_id: vault.chainId,
      chain_name: vault.chainName,
      inventory_candidates: 0,
      lifecycle_excluded: 0,
      deposit_eligible: 0,
      fully_monitored: 0,
      unresolved: 0,
    };
    if (vault.statusDecision === "exclude") existing.lifecycle_excluded++;
    else existing.inventory_candidates++;
    result.set(vault.chainId, existing);
  }
  return result;
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
  const engineOptions: EngineOptions = {
    materialUtilJumpPp: config.materialUtilJumpPp,
    largeEventUsdMin: config.largeEventUsdMin,
    largeEventDepositsPct: config.largeEventDepositsPct,
    ...(config.testThresholdPct === undefined ? {} : { testThresholdPct: config.testThresholdPct }),
    repeatWhileAbove: config.repeatWhileAbove,
  };
  if (!productionStateSafe) issues.push(issueFor(undefined, "state", loadedState.reason ?? "persistent state is invalid"));

  let inventory: InventoryVault[] = [];
  let coverage = new Map<number, ChainCoverage>();
  try {
    inventory = await loadInventory(config.inventoryUrl, config.inventoryPath);
    coverage = makeCoverage(inventory);
    const inventoryKeys = new Set(inventory.map((vault) => marketKey(vault.chainId, vault.address)));
    for (const key of Object.keys(next.markets)) if (!inventoryKeys.has(key)) delete next.markets[key];
    const excluded = inventory.filter((vault) => vault.statusDecision === "exclude");
    const candidates = inventory.filter((vault) => vault.statusDecision !== "exclude");
    for (const vault of excluded) next.markets[marketKey(vault.chainId, vault.address)] = ineligibleState(vault, null, null, startedAt, previous.markets[marketKey(vault.chainId, vault.address)]);
    console.log(`[inventory] total=${inventory.length} lifecycle_excluded=${excluded.length} candidates=${candidates.length}`);

    const stage1 = (await mapLimit(candidates, 8, async (vault): Promise<Stage1Result | null> => {
      const endpoints = config.rpcUrls[vault.chainId];
      if (!endpoints?.length) {
        issues.push(issueFor(vault, "rpc", "missing RPC configuration"));
        coverage.get(vault.chainId)!.unresolved++;
        return null;
      }
      const pool = new RpcPool(vault.chainId, endpoints);
      try {
        const result = await pool.withClient("deposit-gate", (client) => readStage1(client, vault.address));
        return { vault, pool, asset: result.asset, decimals: result.decimals, symbol: result.symbol, totalAssets: result.totalAssets };
      } catch (error) {
        const reason = safeErrorReason(error, "deposit-stage RPC read failed");
        issues.push(issueFor(vault, "rpc", reason));
        coverage.get(vault.chainId)!.unresolved++;
        console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=rpc reason=${reason}`);
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
      const price = prices.get(vault.chainId)?.get(stage.asset.toLowerCase());
      if (!price) {
        const reason = "USD price unavailable; eligibility unresolved";
        issues.push(issueFor(vault, "price", reason));
        coverage.get(vault.chainId)!.unresolved++;
        console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=price reason=unavailable`);
        return;
      }
      const gateDepositsUsd = toTokenNumber(stage.totalAssets, stage.decimals) * price.price;
      if (!isDepositEligible(gateDepositsUsd, config.minDepositsUsd)) {
        next.markets[key] = ineligibleState(vault, gateDepositsUsd, stage.totalAssets.toString(), startedAt, priorState);
        console.log(`[deposit gate] chain=${vault.chainId} vault=${vault.address.toLowerCase()} eligible=false deposits_usd=${gateDepositsUsd.toFixed(2)}`);
        return;
      }
      coverage.get(vault.chainId)!.deposit_eligible++;

      try {
        const risk = await stage.pool.withClient("risk-and-live-irm", (client) => readRisk(client, vault.address));
        const depositsUsd = toTokenNumber(risk.totalAssets, stage.decimals) * price.price;
        if (!isDepositEligible(depositsUsd, config.minDepositsUsd)) {
          next.markets[key] = ineligibleState(vault, depositsUsd, risk.totalAssets.toString(), startedAt, priorState);
          coverage.get(vault.chainId)!.deposit_eligible--;
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
        const completeIrmCoverage = risk.irmInfo.kind !== "unknown-kink";
        if (!completeIrmCoverage) {
          issues.push(issueFor(vault, "irm", "live kink found but IRM type/configuration is incomplete"));
          coverage.get(vault.chainId)!.unresolved++;
        }

        let events;
        if (needsEventInvestigation(priorState, snapshot, engineOptions) && priorState?.previous_successfully_processed_block) {
          try {
            events = await stage.pool.withClient("alert-event-attribution", (client) => readEvents(client, vault.address, BigInt(priorState.previous_successfully_processed_block!) + 1n, risk.blockNumber));
          } catch (error) {
            const reason = safeErrorReason(error, "event query failed");
            issues.push(issueFor(vault, "events", reason));
            coverage.get(vault.chainId)!.unresolved++;
            console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=events reason=${reason}`);
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
        if (completeIrmCoverage) coverage.get(vault.chainId)!.fully_monitored++;
        console.log(`[decision] chain=${vault.chainId} vault=${vault.address.toLowerCase()} util=${snapshot.utilization_pct.toFixed(2)} threshold=${(config.testThresholdPct ?? threshold).toFixed(2)} result=${decision.notification ?? "silent"}`);
      } catch (error) {
        const source: CoverageIssue["source"] = /IRM|kink|target/i.test(error instanceof Error ? error.message : "") ? "irm" : "rpc";
        const reason = safeErrorReason(error, source === "irm" ? "live IRM read failed" : "risk-stage RPC read failed");
        issues.push(issueFor(vault, source, reason));
        coverage.get(vault.chainId)!.unresolved++;
        console.error(`[coverage] chain=${vault.chainId} vault=${vault.address.toLowerCase()} source=${source} reason=${reason}`);
      }
    });
  } catch (error) {
    const reason = safeErrorReason(error, "inventory/collector failure");
    issues.push(issueFor(undefined, "inventory", reason));
    console.error(`[coverage] source=inventory reason=${reason}`);
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
  const coverageRows = [...coverage.values()].sort((a, b) => a.chain_id - b.chain_id);
  for (const row of coverageRows) console.log(`[chain coverage] chain=${row.chain_id} candidates=${row.inventory_candidates} eligible=${row.deposit_eligible} monitored=${row.fully_monitored} unresolved=${row.unresolved}`);

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
      deposit_eligible: coverageRows.reduce((sum, row) => sum + row.deposit_eligible, 0),
      fully_monitored: snapshots.length,
    },
    coverage: coverageRows,
    issues,
    markets: snapshots.sort((a, b) => a.key.localeCompare(b.key)),
  };
  const feed: NotificationFeed = buildNotificationFeed(config.runId, startedAt, completedAt, health, notifications);
  const summary = [
    `# Euler monitor — ${startedAt}`,
    `- Mode: ${mode}`,
    `- Inventory rows: ${inventory.length}`,
    `- Lifecycle excluded: ${lifecycleExcluded}`,
    `- Deposit eligible: ${latest.inventory.deposit_eligible}`,
    `- Fully monitored: ${snapshots.length}`,
    `- Coverage: ${health}`,
    `- Notifications generated: ${notifications.length}`,
    `- Feed output: ${mode === "production" ? "notifications.json" : "notifications-test.json"}`,
    "",
    ...coverageRows.map((row) => `- Chain ${row.chain_id}: ${row.fully_monitored}/${row.deposit_eligible} eligible markets monitored; unresolved ${row.unresolved}`),
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
