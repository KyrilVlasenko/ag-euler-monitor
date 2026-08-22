# AlphaGrowth Euler Monitor Setup

This repository is public. Application code lives on `main`; sanitized collector state and feeds live on `monitor-state`. GitHub Actions collects data and produces notification events. It does not deliver Push or Email notifications.

## Architecture and public-feed safety

The hourly collector:

1. downloads the current inventory from `KyrilVlasenko/ag-euler`;
2. excludes only explicit inactive lifecycle prefixes and fails open on unknown status;
3. detects every contract through Euler's canonical EVault and EulerEarn factories before making type-specific reads;
4. classifies canonical EVaults with no IRM, no debt, and no collateral LTVs as explicitly risk-not-applicable because they cannot borrow in their current configuration;
5. prices applicable vault assets through Euler V3 first, then the canonical controller oracle and UtilsLens with correct unit-of-account-to-USD conversion;
6. retains only applicable markets with deposits strictly above $20,000 and decodes their IRMs through the canonical IRMLens;
7. evaluates crossing, recovery, material-change, and coverage-health state;
8. commits sanitized `state.json`, `latest.json`, `notifications.json`, and `summary.md` to `monitor-state`.

Before public output is written or committed, an allowlist-based audit rejects credential fields, authorization material, private keys, RPC configuration names, obsolete provider fields, and non-public URL hosts. RPC endpoint URLs are never included in snapshots, errors, summaries, or logs. Do not put credentials in code, workflow variables, repository variables, inventory text, or committed files.

## 1. Required GitHub Actions secret

Repository → Settings → Secrets and variables → Actions → New repository secret.

Add exactly one required secret:

- `RPC_URLS_JSON`

It must be a JSON object keyed by numeric chain ID. Each value is an array containing one or more HTTPS read-only RPC endpoints. Endpoint order is failover order.

The current inventory contains these chains:

```json
{
  "1": ["https://YOUR_ETHEREUM_PRIMARY", "https://YOUR_ETHEREUM_BACKUP"],
  "8453": ["https://YOUR_BASE_PRIMARY", "https://YOUR_BASE_BACKUP"],
  "130": ["https://YOUR_UNICHAIN_PRIMARY", "https://YOUR_UNICHAIN_BACKUP"],
  "143": ["https://YOUR_MONAD_PRIMARY", "https://YOUR_MONAD_BACKUP"],
  "42161": ["https://YOUR_ARBITRUM_PRIMARY", "https://YOUR_ARBITRUM_BACKUP"],
  "59144": ["https://YOUR_LINEA_PRIMARY", "https://YOUR_LINEA_BACKUP"]
}
```

One endpoint per chain is accepted, but two independent providers are recommended. Never add wallet keys or transaction-signing credentials. No transaction signing is used.

## 2. Verify workflow permissions

Repository → Settings → Actions → General → Workflow permissions.

Allow GitHub Actions to create and approve commits with read/write repository permission. The workflow requests only `contents: write`, which it needs to update `monitor-state`.

## 3. Run the first dry baseline

Actions → Euler Vault Utilization Monitor → Run workflow:

- `dry_run`: `true` (the default)
- `test_threshold_pct`: blank
- `repeat_while_above`: `false`

The run performs the complete read and decision process, but it cannot update `monitor-state`. Review:

- inventory, lifecycle, risk-not-applicable, deposit-ineligible, deposit-eligible, and fully monitored counts;
- per-chain coverage;
- RPC fallback and price fallback lines;
- IRM or unresolved-data failures;
- the GitHub job summary;
- the 30-day artifact, including `latest.json`, `summary.md`, and `notifications-test.json`.

A dry run that finds a would-be production crossing writes it only to the isolated test feed artifact.

## 4. Create the production baseline

Run the workflow manually again with:

- `dry_run`: `false`
- `test_threshold_pct`: blank
- `repeat_while_above`: `false`

This is a production-mode run and creates or updates `monitor-state`. A first eligible market already at or above its live kink plus 2 percentage points generates one event. A first eligible market below the threshold baselines silently.

Confirm the branch contains:

- `state.json`
- `latest.json`
- `notifications.json`
- `summary.md`

The scheduled workflow then runs hourly at minute 17 UTC. GitHub-hosted runners are used; no local computer is required.

## 5. Production feed URLs

Because this repository is public, the stable HTTPS URLs are:

- Notifications: `https://raw.githubusercontent.com/KyrilVlasenko/ag-euler-monitor/monitor-state/notifications.json`
- Latest snapshot: `https://raw.githubusercontent.com/KyrilVlasenko/ag-euler-monitor/monitor-state/latest.json`

Do not use `main` for feed reads. The files are published only on `monitor-state`.

## 6. Run the isolated 80% test

Actions → Euler Vault Utilization Monitor → Run workflow:

- `dry_run`: `true`
- `test_threshold_pct`: `80`
- `repeat_while_above`: `true`

Every currently eligible market with deposits strictly above $20,000 and utilization at least 80% produces a test notification on every manual execution. Results appear in logs, the job summary, and artifact file `notifications-test.json`.

Any run with a test threshold is isolated regardless of the dry-run selection. It cannot update production crossing state or the production feed.

## 7. Logs, artifacts, and health

Each run logs inventory counts, lifecycle decisions, deposit eligibility, fully monitored counts, per-chain coverage, RPC fallback activity by endpoint number, price fallback activity, IRM failures, alert decisions, and feed output. Endpoint URLs and raw exceptions are not logged.

Artifacts retain useful run files for 30 days. Production outputs also remain in the `monitor-state` Git history.

Incomplete required coverage is never treated as a safe market. Every inventory candidate has exactly one mutually exclusive outcome: risk-not-applicable, eligibility-unresolved, deposit-ineligible, monitoring-unresolved, or fully-monitored. Per-chain and global counters are asserted to reconcile before output is written. A missing RPC, price, IRM target, event query needed for attribution, unsupported contract type, or unreadable eligible market marks the run degraded. After two consecutive degraded production runs, the feed emits one `monitor_degraded` event. It stays silent on subsequent degraded runs, then emits one `monitor_restored` event when full coverage returns.

Risk-not-applicable is not a safety classification. It is used only when live canonical EVault reads simultaneously show no interest-rate model, zero debt, and no configured collateral LTVs. Such a vault has no contract-level borrow utilization or kink. This configuration is rechecked every run, so adding an IRM, debt, or collateral LTV immediately moves the vault back into strict eligibility and monitoring coverage.

Malformed or unreadable persistent state is treated more strictly: market-transition notifications are suppressed, an immediate stable degraded event is produced, and the workflow preserves the existing `state.json` instead of replacing it with a fresh baseline.

## 8. Troubleshooting degraded coverage

- `missing RPC configuration`: add an endpoint array for the reported chain ID.
- `deposit-stage RPC read failed`: verify chain ID, endpoint health, and read permissions.
- `USD price unavailable`: Euler V3 and the canonical on-chain Euler oracle/Lens route could not establish the asset price; the vault remains unresolved rather than excluded. Symbols and names never imply a $1 price.
- `live IRM read failed`: canonical IRMLens could not type or decode an IRM with a meaningful utilization kink/target; add verified support before claiming full coverage.
- `event query failed`: an alert candidate could not be fully attributed; check log-range support and provider limits.
- `unsupported/non-vault contract`: the address was not recognized by the canonical factories and did not expose the required ERC-4626 surface; it remains unresolved.
- stale inventory/feed: inspect the workflow run and GitHub schedule status.

An active EulerEarn row that becomes deposit-eligible will correctly appear as unresolved until every allocated underlying EVault strategy is covered. EulerEarn is an ERC-4626 aggregate with no contract-level borrow utilization or IRM; excluding the aggregate without checking its strategies would hide the lending risk rather than resolve it.

## 9. Adding a new chain

The inventory is refreshed every run. If a new chain appears, the next run fails open and reports degraded coverage. Add the chain ID and one or more endpoints to `RPC_URLS_JSON`. Code changes may also be needed for its DefiLlama slug, Euler vault link network name, and transaction explorer. Do not suppress the degraded state until direct reads and live IRM resolution work.

## ChatGPT Scheduled Task Setup

ChatGPT—not GitHub Actions—delivers Push/Email notifications. Create an hourly ChatGPT Scheduled Task with Push and/or Email delivery enabled in ChatGPT and use this suggested prompt:

> Every hour, fetch `https://raw.githubusercontent.com/KyrilVlasenko/ag-euler-monitor/monitor-state/notifications.json`. Treat it as the authoritative collector notification feed; do not redo Euler calculations. Validate `schema_version`, `run_id`, `generated_at`, and `collector_completed_at`. Remember every delivered `event_id` across runs. Deliver the exact `message` for each notification whose `event_id` has not previously been delivered, then remember that ID. Never deliver the same event ID twice. If `notifications` is empty, stay silent. If the feed cannot be fetched, is invalid, or `collector_completed_at` is more than 2 hours old, send one collector-stale warning and do not repeat that warning until either the feed recovers or its stale status materially changes. Once the feed is current again, clear the stale-warning state. Do not notify merely because a previously delivered event remains visible.

The task should poll hourly. GitHub Actions remains responsible only for collection, validation, persistent crossing state, and feed generation.
