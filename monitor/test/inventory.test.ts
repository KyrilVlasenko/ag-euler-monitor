import assert from "node:assert/strict";
import test from "node:test";
import { marketKey } from "../src/config.js";
import { decideStatus, parseInventoryText } from "../src/inventory.js";

const INVENTORY = `# AlphaGrowth Euler Vault Addresses
| Chain | Chain ID | EVK vaults |
| --- | ---: | ---: |
| Ethereum | \`1\` | 3 |
| Base | \`8453\` | 2 |

## Ethereum
| Market / cluster | Euler vault | Asset | Address | Status |
| --- | --- | --- | --- | --- |
| A | eUSDC | USDC | \`0x0000000000000000000000000000000000000001\` | Active |
| B | eUSDT | USDT | \`0x0000000000000000000000000000000000000002\` | Deprecated/unlisted; matured |
| C | eWETH | WETH | \`0x0000000000000000000000000000000000000003\` | Review; operations enabled, zero assets |

### Base EulerEarn
| Earn vault | Asset | Address | Status |
| --- | --- | --- | --- |
| AlphaGrowth Earn | USDC | \`0x0000000000000000000000000000000000000004\` | Active and owned |
`;

test("1. Markdown inventory parsing", () => {
  const rows = parseInventoryText(INVENTORY);
  assert.equal(rows.length, 4);
  assert.equal(rows[0]?.chainId, 1);
  assert.equal(rows[3]?.chainId, 8453);
  assert.equal(rows[3]?.sectionType, "earn");
});
test("2. address+chain identity", () => {
  assert.equal(marketKey(1, "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"), "1:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  assert.notEqual(marketKey(1, "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"), marketKey(8453, "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"));
});

test("3. inactive status filtering accepts descriptive suffixes", () => {
  for (const status of ["Deprecated", "Deprecated/unlisted; matured", "Inactive to new activity", "Superseded/unlisted", "zero-asset", "zero assets at snapshot"]) {
    assert.equal(decideStatus(status), "exclude", status);
  }
});

test("4. active replacement inclusion", () => {
  assert.equal(decideStatus("Active replacement"), "include-active");
  assert.equal(decideStatus("Active replacement; live product"), "include-active");
});

test("5. missing/unknown status fail-open", () => {
  assert.equal(decideStatus(undefined), "include-unknown");
  assert.equal(decideStatus("Review; operations enabled, zero assets"), "include-unknown");
  assert.equal(decideStatus("Pending ownership transfer"), "include-unknown");
});
