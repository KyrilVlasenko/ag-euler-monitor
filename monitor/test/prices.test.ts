import assert from "node:assert/strict";
import test from "node:test";
import { parseEulerPriceResponse } from "../src/prices.js";

test("Euler V3 data-array price response is parsed", () => {
  const address = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const prices = parseEulerPriceResponse({ data: [{ chainId: 1, address, priceUsd: 2410.319 }] }, [address]);
  assert.deepEqual(prices.get(address), { price: 2410.319, source: "euler-v3" });
});
