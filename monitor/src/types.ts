export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type LifecycleDecision = "include-active" | "include-unknown" | "exclude";

export interface InventoryVault {
  chainName: string;
  chainId: number;
  sectionType: "evk" | "earn" | "unknown";
  label: string;
  vaultName?: string;
  assetLabel?: string;
  address: Address;
  status?: string;
  statusDecision: LifecycleDecision;
  rawRow: string;
}

export type PriceSource = "euler-v3" | "euler-onchain";
export type VaultType = "evault" | "euler-earn" | "erc4626" | "non-vault";
export type IrmKind = "linear-kink" | "linear-kinky" | "adaptive-target" | "unknown-kink";

export interface MarketSnapshot {
  key: string;
  chain_name: string;
  chain_id: number;
  label: string;
  vault_address: Address;
  asset_address: Address;
  asset_symbol: string;
  asset_decimals: number;
  lifecycle_status: string | null;
  observed_at: string;
  block_number: string;
  price_usd: number;
  price_source: PriceSource;
  total_assets_raw: string;
  deposits_usd: number;
  cash_raw: string;
  total_borrows_raw: string;
  available_liquidity_usd: number;
  utilization_pct: number;
  interest_rate_spy_ray: string;
  borrow_apy_pct: number;
  irm_address: Address;
  irm_type: IrmKind;
  irm_configuration: Record<string, string>;
  kink_target_pct: number;
  critical_threshold_pct: number;
}

export type AlertStateLabel = "never" | "alerted" | "recovered";

export interface MarketState {
  key: string;
  chain_id: number;
  vault_address: Address;
  prior_eligibility: boolean;
  lifecycle_status: string | null;
  deposits_usd: number | null;
  total_assets_raw: string | null;
  total_borrows_raw: string | null;
  available_liquidity_usd: number | null;
  utilization_pct: number | null;
  borrow_apy_pct: number | null;
  irm_address: Address | null;
  irm_type: IrmKind | null;
  kink_target_pct: number | null;
  critical_threshold_pct: number | null;
  block_number: string | null;
  timestamp: string;
  alert_active: boolean;
  last_alert_timestamp: string | null;
  last_alert_utilization_pct: number | null;
  most_recent_alert_state: AlertStateLabel;
  previous_successfully_processed_block: string | null;
  snapshot: MarketSnapshot | null;
}

export interface CoverageIssue {
  chain_id: number | null;
  chain_name: string | null;
  vault_address: Address | null;
  source: "inventory" | "rpc" | "price" | "irm" | "events" | "state" | "collector";
  reason: string;
}

export interface HealthState {
  consecutive_degraded_runs: number;
  degraded_alert_active: boolean;
  last_degraded_at: string | null;
  last_restored_at: string | null;
  last_issues: CoverageIssue[];
}

export interface MonitorState {
  schema_version: 1;
  updated_at: string;
  markets: Record<string, MarketState>;
  health: HealthState;
}

export interface EventAmounts {
  raw: bigint;
  tx_hashes: Hex[];
}

export interface EventSummary {
  from_block: bigint;
  to_block: bigint;
  borrow: EventAmounts;
  withdrawal: EventAmounts;
  interest: EventAmounts;
  repayment: EventAmounts;
  deposit: EventAmounts;
  config: EventAmounts;
}

export type PrimaryCause = "withdrawal" | "new borrow" | "interest accrual" | "config change" | "combination" | "unknown";

export type NotificationType = "risk_alert" | "recovery" | "monitor_degraded" | "monitor_restored";

export interface NotificationEvent {
  event_id: string;
  type: NotificationType;
  chain_id: number | null;
  vault: Address | null;
  created_at: string;
  message: string;
}

export interface NotificationFeed {
  schema_version: 1;
  run_id: string;
  generated_at: string;
  collector_completed_at: string;
  health: "healthy" | "degraded";
  notifications: NotificationEvent[];
}

export interface ChainCoverage {
  chain_id: number;
  chain_name: string;
  inventory_candidates: number;
  lifecycle_excluded: number;
  risk_not_applicable: number;
  eligibility_unresolved: number;
  deposit_ineligible: number;
  deposit_eligible: number;
  fully_monitored: number;
  monitoring_unresolved: number;
  unresolved: number;
}

export interface RiskNotApplicableMarket {
  chain_id: number;
  chain_name: string;
  vault_address: Address;
  vault_type: VaultType;
  block_number: string;
  reason: string;
  interest_rate_model: Address;
  total_borrows_raw: string;
  collateral_count: number;
  borrow_cap: string;
}

export type RpcQualityClassification = "confirmed-no-code" | "rpc-disagreement" | "rpc-unavailable" | "unsupported-contract";

export interface RpcQualityFinding {
  chain_id: number;
  address: Address | null;
  phase: "endpoint-validation" | "canary" | "inventory-code" | "contract-classification";
  classification: RpcQualityClassification;
  resolved_by_fallback: boolean;
  block_number: string | null;
  code_endpoints: number[];
  empty_code_endpoints: number[];
  error_endpoints: number[];
  detail: string;
}

export interface RpcChainQuality {
  chain_id: number;
  configured_endpoints: number;
  healthy_endpoints: number;
  quarantined_endpoints: number;
  confirmed_no_code_markets: number;
  rpc_disagreement_markets: number;
  rpc_unavailable_events: number;
  unsupported_contracts: number;
}

export interface RpcQualityReport {
  chains: RpcChainQuality[];
  findings: RpcQualityFinding[];
}

export interface LatestFeed {
  schema_version: 1;
  run_id: string;
  generated_at: string;
  collector_completed_at: string;
  health: "healthy" | "degraded";
  mode: "production" | "dry-run" | "test";
  production_state_safe: boolean;
  config: {
    min_deposits_usd: number;
    threshold_offset_pp: number;
    test_threshold_pct: number | null;
  };
  inventory: {
    source_url: string;
    total: number;
    lifecycle_excluded: number;
    candidates: number;
    risk_not_applicable: number;
    eligibility_unresolved: number;
    deposit_ineligible: number;
    deposit_eligible: number;
    fully_monitored: number;
    monitoring_unresolved: number;
    unresolved: number;
  };
  coverage: ChainCoverage[];
  rpc_quality: RpcQualityReport;
  risk_not_applicable_markets: RiskNotApplicableMarket[];
  issues: CoverageIssue[];
  markets: MarketSnapshot[];
}
