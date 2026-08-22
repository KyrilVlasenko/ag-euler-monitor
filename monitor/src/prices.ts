import { formatUnits, type PublicClient } from "viem";
import { ERC20Abi, UtilsLensAbi } from "./abis.js";
import type { Address, PriceSource, VaultType } from "./types.js";

export interface PriceResult { price: number; source: PriceSource }

const USD_ADDRESS = "0x0000000000000000000000000000000000000348" as Address;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface AssetPriceInfo {
  queryFailure: boolean;
  unitOfAccount: Address;
  amountOutMid: bigint;
}

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

function lensPrice(value: unknown): AssetPriceInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const info = value as Partial<AssetPriceInfo>;
  return typeof info.queryFailure === "boolean" && typeof info.unitOfAccount === "string" && typeof info.amountOutMid === "bigint"
    ? info as AssetPriceInfo
    : undefined;
}

export async function getPrices(baseUrl: string, chainId: number, assets: Address[]): Promise<Map<string, PriceResult>> {
  return fetchEulerPrices(baseUrl, chainId, assets);
}

async function getDirectLensPrice(client: PublicClient, utilsLens: Address, asset: Address): Promise<PriceResult | undefined> {
  const info = lensPrice(await client.readContract({
    address: utilsLens,
    abi: UtilsLensAbi,
    functionName: "getAssetPriceInfo",
    args: [asset, USD_ADDRESS],
  }));
  if (!info || info.queryFailure || info.amountOutMid <= 0n) return undefined;
  const price = Number(formatUnits(info.amountOutMid, 18));
  return Number.isFinite(price) && price > 0 ? { price, source: "euler-onchain" } : undefined;
}

async function getUnitOfAccountUsdRate(client: PublicClient, baseUrl: string, chainId: number, utilsLens: Address, unitOfAccount: Address): Promise<number | undefined> {
  if (unitOfAccount.toLowerCase() === USD_ADDRESS.toLowerCase()) return 1;
  if (unitOfAccount.toLowerCase() === ZERO_ADDRESS) return undefined;

  const v3 = await fetchEulerPrices(baseUrl, chainId, [unitOfAccount]);
  const direct = v3.get(unitOfAccount.toLowerCase());
  if (direct) return direct.price;

  const info = lensPrice(await client.readContract({
    address: utilsLens,
    abi: UtilsLensAbi,
    functionName: "getAssetPriceInfo",
    args: [unitOfAccount, USD_ADDRESS],
  }));
  if (!info || info.queryFailure || info.amountOutMid <= 0n) return undefined;
  const rate = Number(formatUnits(info.amountOutMid, 18));
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

export async function getOnchainVaultPrice(
  client: PublicClient,
  baseUrl: string,
  chainId: number,
  utilsLens: Address,
  vault: Address,
  vaultType: VaultType,
  asset: Address,
): Promise<PriceResult | undefined> {
  // The official SDK routes EulerEarn and other ERC-4626 vaults directly
  // through UtilsLens. EVaults first quote the liability asset in the
  // vault's unit of account, then convert that unit of account to USD.
  if (vaultType !== "evault") return getDirectLensPrice(client, utilsLens, asset);

  const info = lensPrice(await client.readContract({
    address: utilsLens,
    abi: UtilsLensAbi,
    functionName: "getControllerAssetPriceInfo",
    args: [vault, asset],
  }));
  if (!info || info.queryFailure || info.amountOutMid <= 0n) return undefined;
  const uoaDecimals = info.unitOfAccount.toLowerCase() === USD_ADDRESS.toLowerCase()
    ? 18
    : Number(await client.readContract({ address: info.unitOfAccount, abi: ERC20Abi, functionName: "decimals" }));
  const uoaPrice = Number(formatUnits(info.amountOutMid, uoaDecimals));
  const uoaUsdRate = await getUnitOfAccountUsdRate(client, baseUrl, chainId, utilsLens, info.unitOfAccount);
  const price = uoaUsdRate === undefined ? undefined : uoaPrice * uoaUsdRate;
  return price !== undefined && Number.isFinite(price) && price > 0 ? { price, source: "euler-onchain" } : undefined;
}
