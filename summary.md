# Euler monitor — 2026-09-23T23:44:06.060Z
- Mode: production
- Inventory rows: 104
- Lifecycle excluded: 32
- Risk not applicable: 14
- Eligibility unresolved: 0
- Deposit ineligible: 26
- Deposit eligible: 32
- Fully monitored: 32
- Monitoring unresolved: 0
- Total unresolved: 0
- Coverage: healthy
- Notifications generated: 2
- Feed output: notifications.json

- Chain 1: 7/7 eligible markets monitored; risk not applicable 1; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0
- Chain 130: 8/8 eligible markets monitored; risk not applicable 0; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0
- Chain 143: 1/1 eligible markets monitored; risk not applicable 7; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0
- Chain 8453: 13/13 eligible markets monitored; risk not applicable 6; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0
- Chain 42161: 0/0 eligible markets monitored; risk not applicable 0; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0
- Chain 59144: 3/3 eligible markets monitored; risk not applicable 0; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0

## RPC quality
- Chain 1: endpoints 2/2 healthy, 0 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 0; unsupported contracts 0
- Chain 130: endpoints 3/3 healthy, 0 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 0; unsupported contracts 0
- Chain 143: endpoints 3/4 healthy, 1 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 1; unsupported contracts 0
- Chain 8453: endpoints 3/3 healthy, 0 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 0; unsupported contracts 0
- Chain 59144: endpoints 3/3 healthy, 0 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 0; unsupported contracts 0
- Chain 143 chain endpoint: rpc-unavailable; phase endpoint-validation; fallback resolved true; block unavailable; code endpoints []; empty endpoints []; error endpoints [4]; endpoint 4 failed chain ID or block-number validation

## Risk not applicable (live canonical configuration)
- 1 0xbd858dcee56df1f0cba44e6f5a469fbfec0246cd: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 143 0x2067936155c7db57b1cdcf776b04b9678c245626: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 143 0x5795130bfb9232c7500c6e57a96fdd18bfa60436: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 143 0x7a81a1613d50fff334027aad76f2416368f6050f: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 143 0x7ad9f09b431a4c5f4cba809d449fde842192f9ec: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 143 0xc4fabe0b5a280163ab47e3162689a278c81df3f9: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 143 0xf18f3bc9440ad7940e6e2a86fd0c724add2dd0aa: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 143 0xf3e55a17c4c59cb70ea44973795fa8f3c3baad72: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0x24d633664aea3f551b2fa34fa66dd1ba52a33933: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0x2645cbaf62f2f336b0e988375d7e6bcab66a296c: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0x81744b5b5527852832f2dd3554c191d3b1342108: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0xd54d33da9c326aee7513cefdeda5c93a41809cad: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0xd864d46c62685a6062a722afd7c8c978c410aaaf: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0xfab9af50f7a1cfe201cae1c15fcfddae7705ccd3: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0

## Would-be/new notifications

🚨 USDC / Base — util 95.2% (was 91.6%), kink 90.0%, threshold 92.0%

Cause: Withdrawal: $20.1k withdrawn; liquidity is now $11.8k.
Confidence: High

Liquidity left: $11.8k | Borrow APY: 10.8% → 22.7%
Links: https://app.euler.finance/vault/0x0a1a3b5f2041f33522c4efc754a7d096f880ee16?network=base https://basescan.org/tx/0xb939d236c8eef00c65ba8a23b0fcc610bb04dd1bf551d435095a49d1d982e38f


🚨 USDC / Base — util 97.2% (was 94.8%), kink 95.0%, threshold 97.0%

Cause: Withdrawal: $17.2k withdrawn; liquidity is now $12.8k.
Confidence: High

Liquidity left: $12.8k | Borrow APY: 11.7% → 44.2%
Links: https://app.euler.finance/vault/0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e?network=base https://basescan.org/tx/0xf3bfb2c8af5c48a2741706f383edb5b5f9438eabc74b4cd3a60109eb78e10aa1

