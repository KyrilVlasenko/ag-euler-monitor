import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeposits, criticalThreshold, evaluateMarket, type EngineOptions } from "../src/engine.js";
import { countWords, formatRiskAlert } from "../src/format.js";
import type { EventSummary, MarketSnapshot, MarketState } from "../src/types.js";

const ADDRESS = "0x0000000000000000000000000000000000000001" as const;
const IRM = "0x0000000000000000000000000000000000000010" as const;
const NOW = "2026-08-22T12:00:00.000Z";
const OPTIONS: EngineOptions = {
  materialUtilJumpPp: 2,
  largeEventUsdMin: 50_000,
  largeEventDepositsPct: 2,
  repeatWhileAbove: false,
};

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    key: `1:${ADDRESS}`,
    chain_name: "Ethereum",
    chain_id: 1,
    label: "Test market",
    vault_address: ADDRESS,
    asset_address: "0x0000000000000000000000000000000000000002",
    asset_symbol: "USDC",
    asset_decimals: 6,
    lifecycle_status: "Active",
    observed_at: NOW,
    block_number: "100",
    price_usd: 1,
    price_source: "euler-v3",
    total_assets_raw: "10000000000000",
    deposits_usd: 10_000_000,
    cash_raw: "700000000000",
    total_borrows_raw: "9300000000000",
    available_liquidity_usd: 700_000,
    utilization_pct: 93,
    interest_rate_spy_ray: "1000000000000000000",
    borrow_apy_pct: 4,
    irm_address: IRM,
    irm_type: "linear-kink",
    irm_configuration: { kink: "3865470565" },
    kink_target_pct: 90,
    critical_threshold_pct: 92,
    ...overrides,
  };
}

function state(snap: MarketSnapshot, active = false, lastAlert: number | null = null): MarketState {
  return {
    key: snap.key,
    chain_id: snap.chain_id,
    vault_address: snap.vault_address,
    prior_eligibility: true,
    lifecycle_status: snap.lifecycle_status,
    deposits_usd: snap.deposits_usd,
    total_assets_raw: snap.total_assets_raw,
    total_borrows_raw: snap.total_borrows_raw,
    available_liquidity_usd: snap.available_liquidity_usd,
    utilization_pct: snap.utilization_pct,
    borrow_apy_pct: snap.borrow_apy_pct,
    irm_address: snap.irm_address,
    irm_type: snap.irm_type,
    kink_target_pct: snap.kink_target_pct,
    critical_threshold_pct: snap.critical_threshold_pct,
    block_number: snap.block_number,
    timestamp: snap.observed_at,
    alert_active: active,
    last_alert_timestamp: active ? NOW : null,
    last_alert_utilization_pct: lastAlert,
    most_recent_alert_state: active ? "alerted" : "never",
    previous_successfully_processed_block: snap.block_number,
    snapshot: snap,
  };
}

function events(kind?: "borrow" | "withdrawal" | "interest", raw = 0n): EventSummary {
  const empty = () => ({ raw: 0n, tx_hashes: [] });
  const result: EventSummary = { from_block: 91n, to_block: 100n, borrow: empty(), withdrawal: empty(), interest: empty(), repayment: empty(), deposit: empty(), config: empty() };
  if (kind) result[kind] = { raw, tx_hashes: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] };
  return result;
}

test("6-8. strict deposit cutoff", () => {
  assert.equal(classifyDeposits(19_999, 1), "ineligible");
  assert.equal(classifyDeposits(20_000, 1), "ineligible");
  assert.equal(classifyDeposits(20_001, 1), "eligible");
});
test("9. missing price is unresolved", () => {
  assert.equal(classifyDeposits(1_000_000, undefined), "unresolved");
});

test("10. kink + 2 absolute pp", () => {
  assert.equal(criticalThreshold(90, 2), 92);
});

test("11. baseline-above alert", () => {
  assert.equal(evaluateMarket(undefined, snapshot(), undefined, OPTIONS).notification, "risk_alert");
});

test("12. baseline-below silence", () => {
  assert.equal(evaluateMarket(undefined, snapshot({ utilization_pct: 91 }), undefined, OPTIONS).notification, null);
});

test("13. below-to-above crossing", () => {
  const prior = snapshot({ block_number: "90", utilization_pct: 91 });
  assert.equal(evaluateMarket(state(prior), snapshot(), events("borrow", 1_000_000n), OPTIONS).notification, "risk_alert");
});

test("14. elevated market stays silent", () => {
  const prior = snapshot({ block_number: "90", utilization_pct: 93 });
  assert.equal(evaluateMarket(state(prior, true, 93), snapshot({ utilization_pct: 93.5 }), undefined, OPTIONS).notification, null);
});

test("15. recovery/reset", () => {
  const prior = snapshot({ block_number: "90", utilization_pct: 93 });
  const decision = evaluateMarket(state(prior, true, 93), snapshot({ utilization_pct: 91 }), undefined, OPTIONS);
  assert.equal(decision.notification, "recovery");
  assert.equal(decision.nextAlertActive, false);
});

test("16. later recross", () => {
  const prior = snapshot({ block_number: "90", utilization_pct: 91 });
  const recovered = state(prior, false, null);
  recovered.most_recent_alert_state = "recovered";
  assert.equal(evaluateMarket(recovered, snapshot({ utilization_pct: 93 }), events("borrow", 1n), OPTIONS).notification, "risk_alert");
});

test("17. material utilization jump", () => {
  const prior = snapshot({ block_number: "90", utilization_pct: 93 });
  assert.equal(evaluateMarket(state(prior, true, 93), snapshot({ utilization_pct: 95.1 }), undefined, OPTIONS).notification, "risk_alert");
});

test("18. large borrow", () => {
  const prior = snapshot({ block_number: "90", utilization_pct: 93 });
  assert.equal(evaluateMarket(state(prior, true, 93), snapshot(), events("borrow", 250_000_000_000n), OPTIONS).notification, "risk_alert");
});

test("19. large withdrawal", () => {
  const prior = snapshot({ block_number: "90", utilization_pct: 93 });
  assert.equal(evaluateMarket(state(prior, true, 93), snapshot(), events("withdrawal", 250_000_000_000n), OPTIONS).notification, "risk_alert");
});

test("20. IRM/kink change can alert", () => {
  const prior = snapshot({ block_number: "90", utilization_pct: 93 });
  const current = snapshot({ kink_target_pct: 89, critical_threshold_pct: 91, irm_configuration: { kink: "different" } });
  assert.equal(evaluateMarket(state(prior, true, 93), current, events(), OPTIONS).notification, "risk_alert");
});

test("21. alert is at most 150 words", () => {
  const decision = evaluateMarket(undefined, snapshot(), undefined, OPTIONS);
  const message = formatRiskAlert(snapshot(), null, decision.attribution!);
  assert.ok(countWords(message) <= 150);
});

test("22. unknown cause never fabricates transaction hash", () => {
  const decision = evaluateMarket(undefined, snapshot(), undefined, OPTIONS);
  assert.equal(decision.attribution?.cause, "unknown");
  assert.equal(decision.attribution?.transactionHash, undefined);
  assert.doesNotMatch(formatRiskAlert(snapshot(), null, decision.attribution!), /\/tx\/0x/);
});

test("26. 80% manual repeat test", () => {
  const options = { ...OPTIONS, testThresholdPct: 80, repeatWhileAbove: true };
  assert.equal(evaluateMarket(undefined, snapshot({ utilization_pct: 80 }), undefined, options).notification, "risk_alert");
  assert.equal(evaluateMarket(undefined, snapshot({ utilization_pct: 79.9 }), undefined, options).notification, null);
});

test("31. old elevated event is not regenerated", () => {
  const prior = snapshot({ block_number: "90", utilization_pct: 93 });
  assert.equal(evaluateMarket(state(prior, true, 93), snapshot({ utilization_pct: 93 }), undefined, OPTIONS).notification, null);
});
