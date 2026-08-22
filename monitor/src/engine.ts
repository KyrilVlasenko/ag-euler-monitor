import type { EventSummary, MarketSnapshot, MarketState, PrimaryCause } from "./types.js";

export interface EngineOptions {
  materialUtilJumpPp: number;
  largeEventUsdMin: number;
  largeEventDepositsPct: number;
  testThresholdPct?: number;
  repeatWhileAbove: boolean;
}

export interface CauseAttribution {
  cause: PrimaryCause;
  confidence: "High" | "Medium" | "Low";
  reason?: string;
  amountUsd?: number;
  secondaryAmountUsd?: number;
  transactionHash?: `0x${string}`;
  missingPiece?: string;
}

export interface MarketDecision {
  notification: "risk_alert" | "recovery" | null;
  attribution?: CauseAttribution;
  configChanged: boolean;
  nextAlertActive: boolean;
  lastAlertUtilizationPct: number | null;
}

export function isDepositEligible(depositsUsd: number, minimum = 20_000): boolean {
  return Number.isFinite(depositsUsd) && depositsUsd > minimum;
}

export function classifyDeposits(totalAssetsTokens: number, priceUsd: number | undefined, minimum = 20_000): "eligible" | "ineligible" | "unresolved" {
  if (priceUsd === undefined || !Number.isFinite(priceUsd) || priceUsd <= 0) return "unresolved";
  return isDepositEligible(totalAssetsTokens * priceUsd, minimum) ? "eligible" : "ineligible";
}

export function criticalThreshold(kinkTargetPct: number, offsetPp = 2): number {
  return kinkTargetPct + offsetPp;
}

export function largeEventThreshold(previousDepositsUsd: number, options: Pick<EngineOptions, "largeEventUsdMin" | "largeEventDepositsPct">): number {
  return Math.max(options.largeEventUsdMin, previousDepositsUsd * options.largeEventDepositsPct / 100);
}

function configChanged(previous: MarketSnapshot, current: MarketSnapshot): boolean {
  return previous.irm_address.toLowerCase() !== current.irm_address.toLowerCase()
    || previous.irm_type !== current.irm_type
    || Math.abs(previous.kink_target_pct - current.kink_target_pct) >= 0.0001
    || JSON.stringify(previous.irm_configuration) !== JSON.stringify(current.irm_configuration);
}

function rawUsd(raw: bigint, current: MarketSnapshot): number {
  return Number(raw) / 10 ** current.asset_decimals * current.price_usd;
}

function stateDeltaCandidates(previous: MarketSnapshot, current: MarketSnapshot, thresholdUsd: number): boolean {
  const borrowDelta = Number(BigInt(current.total_borrows_raw) - BigInt(previous.total_borrows_raw)) / 10 ** current.asset_decimals * current.price_usd;
  const liquidityDrop = previous.available_liquidity_usd - current.available_liquidity_usd;
  return borrowDelta >= thresholdUsd || liquidityDrop >= thresholdUsd;
}

export function needsEventInvestigation(previousState: MarketState | undefined, current: MarketSnapshot, options: EngineOptions): boolean {
  const previous = previousState?.snapshot;
  if (!previous || !previousState.prior_eligibility) return current.utilization_pct >= current.critical_threshold_pct;
  const changed = configChanged(previous, current);
  const crossed = previous.utilization_pct < previous.critical_threshold_pct && current.utilization_pct >= current.critical_threshold_pct;
  if (changed || crossed) return true;
  if (!previousState.alert_active) return false;
  const jumped = current.utilization_pct - (previousState.last_alert_utilization_pct ?? previous.utilization_pct) >= options.materialUtilJumpPp;
  const threshold = largeEventThreshold(previous.deposits_usd, options);
  return jumped || stateDeltaCandidates(previous, current, threshold);
}

export function attributeCause(previous: MarketSnapshot | null, current: MarketSnapshot, events: EventSummary | undefined, changed: boolean): CauseAttribution {
  if (changed) {
    return {
      cause: "config change",
      confidence: "High",
      ...(events?.config.tx_hashes[0] ? { transactionHash: events.config.tx_hashes[0] } : {}),
    };
  }
  if (!previous) return { cause: "unknown", confidence: "Low", reason: "No prior observation", missingPiece: "a prior utilization observation" };
  if (!events) return { cause: "unknown", confidence: "Low", reason: "Event logs unavailable", missingPiece: "vault event logs for the observation interval" };

  const borrowUsd = rawUsd(events.borrow.raw, current);
  const withdrawalUsd = rawUsd(events.withdrawal.raw, current);
  const interestUsd = rawUsd(events.interest.raw, current);
  const ordered = [
    { cause: "new borrow" as const, usd: borrowUsd, tx: events.borrow.tx_hashes[0] },
    { cause: "withdrawal" as const, usd: withdrawalUsd, tx: events.withdrawal.tx_hashes[0] },
  ].sort((a, b) => b.usd - a.usd);
  if (ordered[0]!.usd > 0 && ordered[1]!.usd >= ordered[0]!.usd * 0.35) {
    return {
      cause: "combination",
      confidence: "High",
      amountUsd: borrowUsd,
      secondaryAmountUsd: withdrawalUsd,
      ...(events.borrow.tx_hashes[0] ?? events.withdrawal.tx_hashes[0] ? { transactionHash: events.borrow.tx_hashes[0] ?? events.withdrawal.tx_hashes[0] } : {}),
    };
  }
  if (ordered[0]!.usd > 0) {
    return {
      cause: ordered[0]!.cause,
      confidence: "High",
      amountUsd: ordered[0]!.usd,
      ...(ordered[0]!.tx ? { transactionHash: ordered[0]!.tx } : {}),
    };
  }
  if (interestUsd > 0) {
    return {
      cause: "interest accrual",
      confidence: "High",
      amountUsd: interestUsd,
      ...(events.interest.tx_hashes[0] ? { transactionHash: events.interest.tx_hashes[0] } : {}),
    };
  }
  return { cause: "unknown", confidence: "Medium", reason: "No matching event", missingPiece: "a matching on-chain vault event" };
}

export function evaluateMarket(previousState: MarketState | undefined, current: MarketSnapshot, events: EventSummary | undefined, options: EngineOptions): MarketDecision {
  const previous = previousState?.snapshot ?? null;
  const changed = previous ? configChanged(previous, current) : false;
  const threshold = options.testThresholdPct ?? current.critical_threshold_pct;

  if (options.testThresholdPct !== undefined && options.repeatWhileAbove) {
    const above = current.utilization_pct >= threshold;
    return {
      notification: above ? "risk_alert" : null,
      ...(above ? { attribution: attributeCause(previous, current, events, changed) } : {}),
      configChanged: changed,
      nextAlertActive: previousState?.alert_active ?? false,
      lastAlertUtilizationPct: previousState?.last_alert_utilization_pct ?? null,
    };
  }

  const firstEligible = !previous || !previousState?.prior_eligibility;
  let notification: "risk_alert" | "recovery" | null = null;
  if (firstEligible) {
    if (current.utilization_pct >= threshold) notification = "risk_alert";
  } else if (previousState.alert_active) {
    if (current.utilization_pct < threshold) {
      notification = "recovery";
    } else {
      const jumped = current.utilization_pct - (previousState.last_alert_utilization_pct ?? previous.utilization_pct) >= options.materialUtilJumpPp;
      const eventThreshold = largeEventThreshold(previous.deposits_usd, options);
      const largeBorrow = !!events && rawUsd(events.borrow.raw, current) >= eventThreshold;
      const largeWithdrawal = !!events && rawUsd(events.withdrawal.raw, current) >= eventThreshold;
      if (jumped || changed || largeBorrow || largeWithdrawal) notification = "risk_alert";
    }
  } else {
    const crossed = previous.utilization_pct < previous.critical_threshold_pct && current.utilization_pct >= threshold;
    if (crossed) notification = "risk_alert";
  }

  const active = current.utilization_pct >= threshold;
  return {
    notification,
    ...(notification === "risk_alert" ? { attribution: attributeCause(previous, current, events, changed) } : {}),
    configChanged: changed,
    nextAlertActive: active,
    lastAlertUtilizationPct: notification === "risk_alert" ? current.utilization_pct : active ? previousState?.last_alert_utilization_pct ?? null : null,
  };
}
