# AlphaGrowth Euler Monitor

An hourly, GitHub Actions-hosted monitor for AlphaGrowth-governed Euler markets.

The collector refreshes the authoritative vault inventory, reads eligible market risk data directly from chain, evaluates utilization against each market's live IRM target plus two percentage points, and writes a sanitized notification feed to the public `monitor-state` branch.

GitHub Actions does not deliver user notifications. A separate ChatGPT Scheduled Task consumes the feed and delivers each event once.

See [MONITOR_SETUP.md](MONITOR_SETUP.md) for setup, testing, feed URLs, and operational guidance.
