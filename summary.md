# Euler monitor — 2026-11-04T18:00:02.589Z
- Mode: production
- Inventory rows: 104
- Lifecycle excluded: 32
- Risk not applicable: 7
- Eligibility unresolved: 12
- Deposit ineligible: 28
- Deposit eligible: 25
- Fully monitored: 25
- Monitoring unresolved: 0
- Total unresolved: 12
- Coverage: degraded
- Notifications generated: 0
- Feed output: notifications.json

- Chain 1: 5/5 eligible markets monitored; risk not applicable 1; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0
- Chain 130: 7/7 eligible markets monitored; risk not applicable 0; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0
- Chain 143: 0/0 eligible markets monitored; risk not applicable 0; eligibility unresolved 12; monitoring unresolved 0; total unresolved 12
- Chain 8453: 11/11 eligible markets monitored; risk not applicable 6; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0
- Chain 42161: 0/0 eligible markets monitored; risk not applicable 0; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0
- Chain 59144: 2/2 eligible markets monitored; risk not applicable 0; eligibility unresolved 0; monitoring unresolved 0; total unresolved 0

## RPC quality
- Chain 1: endpoints 2/2 healthy, 0 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 0; unsupported contracts 0
- Chain 130: endpoints 3/3 healthy, 0 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 0; unsupported contracts 0
- Chain 143: endpoints 2/4 healthy, 2 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 2; unsupported contracts 0
- Chain 8453: endpoints 3/3 healthy, 0 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 0; unsupported contracts 0
- Chain 59144: endpoints 3/3 healthy, 0 quarantined; confirmed no-code 0; RPC disagreements 0; RPC unavailable events 0; unsupported contracts 0
- Chain 143 chain endpoint: rpc-unavailable; phase endpoint-validation; fallback resolved true; block unavailable; code endpoints []; empty endpoints []; error endpoints [2]; endpoint 2 failed chain ID or block-number validation
- Chain 143 chain endpoint: rpc-unavailable; phase endpoint-validation; fallback resolved true; block unavailable; code endpoints []; empty endpoints []; error endpoints [3]; endpoint 3 failed chain ID or block-number validation

## Risk not applicable (live canonical configuration)
- 1 0xbd858dcee56df1f0cba44e6f5a469fbfec0246cd: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0x24d633664aea3f551b2fa34fa66dd1ba52a33933: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0x2645cbaf62f2f336b0e988375d7e6bcab66a296c: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0x81744b5b5527852832f2dd3554c191d3b1342108: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0xd54d33da9c326aee7513cefdeda5c93a41809cad: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0xd864d46c62685a6062a722afd7c8c978c410aaaf: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0
- 8453 0xfab9af50f7a1cfe201cae1c15fcfddae7705ccd3: canonical EVault has no IRM, no debt, and no configured collateral LTVs; IRM 0x0000000000000000000000000000000000000000; borrows 0; collateral LTVs 0

## Coverage issues
- 143 0x438cedce647491b1d93a73d491ec19a50194c222 [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0x75b6c392f778b8bcf9bdb676f8f128b4dd49ac19 [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0x7ad9f09b431a4c5f4cba809d449fde842192f9ec [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0x7a81a1613d50fff334027aad76f2416368f6050f [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0x2067936155c7db57b1cdcf776b04b9678c245626 [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0x5795130bfb9232c7500c6e57a96fdd18bfa60436 [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0xf3e55a17c4c59cb70ea44973795fa8f3c3baad72 [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0x248c74aa002a571c340a3d894aaf294884a49be1 [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0xc4fabe0b5a280163ab47e3162689a278c81df3f9 [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0xf18f3bc9440ad7940e6e2a86fd0c724add2dd0aa [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0x7cc566d100e81a9708fd23b18f6b92d3249430c9 [rpc] deposit-stage RPC read failed: InvalidInputRpcError
- 143 0x6f63732bbbb1780e546c6183c187957b63e1c9d4 [rpc] deposit-stage RPC read failed: InvalidInputRpcError
