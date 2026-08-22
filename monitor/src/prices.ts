import { DEFI_LLAMA_CHAIN } from "./config.js";
import type { Address, PriceSource } from "./types.js";

export interface PriceResult { price: number; source: PriceSource }

export function parseEulerPriceResponse(json: unknown, assets: string[]): Map<string, PriceResult> {
  const result = new Map<string, PriceResult>();
  if (!json || typeof json !== "object") return result;
  const object = json as Record<string, unknown>;
  const requested = new Set(assets.map((asset) => asset.toLowerCase()));
  if (Array.isArray(object.data)) {
    for (const row of object.data) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const address = typeof record.address === "string" ? record.address.toLowerCase() : undefined;
      const price = positiveNumber(record.priceUsd ?? record.price);
      if (address && requested.has(address) && price) result.set(address, { price, source: "euler-v3" });
    }
  }
  for (const address of requested) {
    const prices = object.prices as Record<string, unknown> | undefined;
    const price = positiveNumber(object[address] ?? prices?.[address]);
    if (price) result.set(address, { price, source: "euler-v3" });
  }
  return result;
}

async function fetchJson(url: string, attempts = 3): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "ag-euler-monitor/2" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt + Math.floor(Math.random() * 200)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("price request failed");
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ["price", "priceUsd", "usd", "marketPriceUsd", "value"]) {
    const found = positiveNumber(object[key]);
    if (found) return found;
  }
  return undefined;
}

export async function fetchEulerPrices(baseUrl: string, chainId: number, assets: Address[]): Promise<Map<string, PriceResult>> {
  const unique = [...new Set(assets.map((asset) => asset.toLowerCase()))];
  if (!unique.length) return new Map();
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/v3/prices?chainId=${chainId}&assets=${encodeURIComponent(unique.join(","))}`;
    return parseEulerPriceResponse(await fetchJson(url), unique);
  } catch {
    console.warn(`[price fallback] chain=${chainId} source=euler-v3 unavailable`);
    return new Map();
  }
}

export async function fillDefiLlamaPrices(chainId: number, assets: Address[], existing: Map<string, PriceResult>): Promise<Map<string, PriceResult>> {
  const slug = DEFI_LLAMA_CHAIN[chainId];
  if (!slug) return existing;
  const missing = [...new Set(assets.map((asset) => asset.toLowerCase()))].filter((asset) => !existing.has(asset));
  for (let index = 0; index < missing.length; index += 40) {
    const chunk = missing.slice(index, index + 40);
    const ids = chunk.map((address) => `${slug}:${address}`).join(",");
    try {
      const json = await fetchJson(`https://coins.llama.fi/prices/current/${encodeURIComponent(ids)}`) as { coins?: Record<string, unknown> };
      for (const address of chunk) {
        const price = positiveNumber(json.coins?.[`${slug}:${address}`]);
        if (price) existing.set(address, { price, source: "defillama" });
      }
      console.log(`[price fallback] chain=${chainId} source=defillama requested=${chunk.length}`);
    } catch {
      console.warn(`[price fallback] chain=${chainId} source=defillama unavailable`);
    }
  }
  return existing;
}

export async function getPrices(baseUrl: string, chainId: number, assets: Address[]): Promise<Map<string, PriceResult>> {
  return fillDefiLlamaPrices(chainId, assets, await fetchEulerPrices(baseUrl, chainId, assets));
}
