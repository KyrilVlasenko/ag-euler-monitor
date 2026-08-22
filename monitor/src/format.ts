import { createHash } from "node:crypto";
import { EULER_NETWORK, EXPLORER_TX } from "./config.js";
import type { CauseAttribution } from "./engine.js";
import type { Address, CoverageIssue, MarketSnapshot, NotificationEvent, NotificationFeed, NotificationType } from "./types.js";

const pct = (value: number): string => Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
const money = (value: number): string => {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
};

function safeLabel(value: string, maximum = 32): string {
  return value.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) || "UNKNOWN";
}

export function notificationEventId(type: NotificationType, chainId: number | null, vault: Address | null, discriminator: string): string {
  const digest = createHash("sha256").update(`${type}|${chainId ?? "global"}|${vault?.toLowerCase() ?? "global"}|${discriminator}`).digest("hex");
  return `euler-${type}-${digest.slice(0, 24)}`;
}

function vaultUrl(snapshot: MarketSnapshot): string {
  const network = EULER_NETWORK[snapshot.chain_id];
  return `https://app.euler.finance/vault/${snapshot.vault_address}${network ? `?network=${network}` : ""}`;
}

function txUrl(snapshot: MarketSnapshot, hash?: `0x${string}`): string | undefined {
  const base = EXPLORER_TX[snapshot.chain_id];
  return hash && base ? `${base}${hash}` : undefined;
}

function causeLine(current: MarketSnapshot, previous: MarketSnapshot | null, attribution: CauseAttribution): string {
  switch (attribution.cause) {
    case "config change":
      return `Config change: target moved ${previous ? pct(previous.kink_target_pct) : "n/a"} → ${pct(current.kink_target_pct)}; threshold is ${pct(current.critical_threshold_pct)}.`;
    case "new borrow":
      return `New borrow: ${money(attribution.amountUsd ?? Number.NaN)} borrowed; liquidity is now ${money(current.available_liquidity_usd)}.`;
    case "withdrawal":
      return `Withdrawal: ${money(attribution.amountUsd ?? Number.NaN)} withdrawn; liquidity is now ${money(current.available_liquidity_usd)}.`;
    case "interest accrual":
      return `Interest accrual: debt increased about ${money(attribution.amountUsd ?? Number.NaN)} from proven accrual events.`;
    case "combination":
      return `Combination: ${money(attribution.amountUsd ?? Number.NaN)} new borrow plus ${money(attribution.secondaryAmountUsd ?? Number.NaN)} withdrawal.`;
    case "unknown": {
      const delta = previous ? current.utilization_pct - previous.utilization_pct : Number.NaN;
      return `Unknown: utilization changed ${Number.isFinite(delta) ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp` : "from n/a"}; missing ${attribution.missingPiece ?? "one matching data point"}.`;
    }
  }
}

export function formatRiskAlert(current: MarketSnapshot, previous: MarketSnapshot | null, attribution: CauseAttribution): string {
  const oldUtil = previous ? pct(previous.utilization_pct) : "n/a";
  const oldApy = previous ? pct(previous.borrow_apy_pct) : "n/a";
  const confidence = attribution.confidence === "High" ? "Confidence: High" : `Confidence: ${attribution.confidence} — ${safeLabel(attribution.reason ?? "Limited evidence", 60)}`;
  const links = [vaultUrl(current), txUrl(current, attribution.transactionHash)].filter((value): value is string => !!value).join(" ");
  const message = `🚨 ${safeLabel(current.asset_symbol)} / ${safeLabel(current.chain_name)} — util ${pct(current.utilization_pct)} (was ${oldUtil}), kink ${pct(current.kink_target_pct)}, threshold ${pct(current.critical_threshold_pct)}\n\nCause: ${causeLine(current, previous, attribution)}\n${confidence}\n\nLiquidity left: ${money(current.available_liquidity_usd)} | Borrow APY: ${oldApy} → ${pct(current.borrow_apy_pct)}\nLinks: ${links}`;
  if (countWords(message) > 150) throw new Error("risk alert exceeds 150 words");
  return message;
}

export function formatRecovery(current: MarketSnapshot, previous: MarketSnapshot | null): string {
  return `✅ ${safeLabel(current.asset_symbol)} / ${safeLabel(current.chain_name)} — RECOVERED: util ${pct(current.utilization_pct)} (was ${previous ? pct(previous.utilization_pct) : "n/a"}), below threshold ${pct(current.critical_threshold_pct)}.\nLiquidity available: ${money(current.available_liquidity_usd)} | Borrow APY: ${pct(current.borrow_apy_pct)}\nLinks: ${vaultUrl(current)}`;
}

export function formatHealth(issues: CoverageIssue[], restored: boolean): string {
  if (restored) return "MONITOR RESTORED\nFull required Euler market coverage is available again.";
  const chains = [...new Set(issues.map((issue) => issue.chain_name).filter((value): value is string => !!value))];
  const markets = [...new Set(issues.map((issue) => issue.vault_address).filter((value): value is Address => !!value))].slice(0, 8);
  const sources = [...new Set(issues.map((issue) => issue.source))];
  const reasons = [...new Set(issues.map((issue) => issue.reason))].slice(0, 4);
  return [
    "MONITOR DEGRADED",
    `Affected chains: ${chains.length ? chains.join(", ") : "unknown"}`,
    `Affected markets: ${markets.length ? markets.join(", ") : "unknown"}`,
    `Failed source: ${sources.join(", ")}`,
    `Reason: ${reasons.join("; ")}`,
  ].join("\n");
}

export function makeNotification(type: NotificationType, createdAt: string, message: string, discriminator: string, chainId: number | null = null, vault: Address | null = null): NotificationEvent {
  return { event_id: notificationEventId(type, chainId, vault, discriminator), type, chain_id: chainId, vault, created_at: createdAt, message };
}

export function buildNotificationFeed(runId: string, generatedAt: string, completedAt: string, health: "healthy" | "degraded", notifications: NotificationEvent[]): NotificationFeed {
  return { schema_version: 1, run_id: runId, generated_at: generatedAt, collector_completed_at: completedAt, health, notifications };
}

export function countWords(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}
