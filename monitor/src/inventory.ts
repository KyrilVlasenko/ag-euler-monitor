import { readFile } from "node:fs/promises";
import { CHAIN_IDS } from "./config.js";
import type { Address, InventoryVault, LifecycleDecision } from "./types.js";

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

function cleanCell(value: string): string {
  return value.trim().replace(/^`|`$/g, "").replace(/\s+/g, " ");
}

function normalizeStatus(value?: string): string | undefined {
  return value?.toLowerCase().trim().replace(/[–—]/g, "-").replace(/_/g, " ").replace(/\s+/g, " ") || undefined;
}

export function decideStatus(status?: string): LifecycleDecision {
  const normalized = normalizeStatus(status);
  if (!normalized) return "include-unknown";
  // The inventory uses descriptive suffixes. Only an authoritative leading lifecycle label is decisive.
  if (/^active(?:\b|[-/])/.test(normalized)) return "include-active";
  if (/^(deprecated|inactive|superseded)(?:\b|[-/])/.test(normalized)) return "exclude";
  if (/^zero[- ]assets?(?:\b|[-/])/.test(normalized)) return "exclude";
  return "include-unknown";
}

function parseChainIdTable(lines: string[]): Record<string, number> {
  const result = { ...CHAIN_IDS };
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map(cleanCell).filter(Boolean);
    if (cells.length < 2) continue;
    const chainId = Number(cells[1]?.replace(/`/g, ""));
    if (cells[0] && Number.isInteger(chainId) && chainId > 0) result[cells[0].toLowerCase()] = chainId;
  }
  return result;
}

function sectionChainName(section: string): string {
  return section.replace(/\s+EulerEarn$/i, "").trim();
}

export function parseInventoryText(text: string): InventoryVault[] {
  const lines = text.split(/\r?\n/);
  const chainIds = parseChainIdTable(lines);
  const vaults: InventoryVault[] = [];
  let section = "";
  let headers: string[] = [];

  for (const line of lines) {
    const sectionMatch = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      headers = [];
      continue;
    }
    if (!line.includes("|")) continue;
    const rawCells = line.split("|");
    if (!rawCells[0]?.trim()) rawCells.shift();
    if (!rawCells.at(-1)?.trim()) rawCells.pop();
    const cells = rawCells.map(cleanCell);
    if (!headers.length && cells.some((cell) => /address/i.test(cell))) {
      headers = cells;
      continue;
    }
    if (!headers.length || /^\s*\|?[-:| ]+\|?\s*$/.test(line)) continue;
    const address = line.match(ADDRESS_RE)?.[0] as Address | undefined;
    if (!address) continue;

    const chainName = sectionChainName(section);
    const chainId = chainIds[chainName.toLowerCase()];
    if (!chainId) throw new Error(`Unknown chain section: ${section}`);
    const byHeader = (pattern: RegExp): string | undefined => {
      const index = headers.findIndex((header) => pattern.test(header));
      const value = index >= 0 ? cells[index] : undefined;
      return value || undefined;
    };
    const status = byHeader(/^(status|state|lifecycle)$/i);
    const vaultName = byHeader(/euler vault/i);
    const assetLabel = byHeader(/^asset$/i);
    vaults.push({
      chainName,
      chainId,
      sectionType: /eulerearn/i.test(section) ? "earn" : "evk",
      label: byHeader(/market|cluster|earn vault|label/i) || byHeader(/euler vault/i) || address,
      ...(vaultName ? { vaultName } : {}),
      ...(assetLabel ? { assetLabel } : {}),
      address,
      ...(status ? { status } : {}),
      statusDecision: decideStatus(status),
      rawRow: line,
    });
  }

  const deduped = new Map<string, InventoryVault>();
  for (const vault of vaults) deduped.set(`${vault.chainId}:${vault.address.toLowerCase()}`, vault);
  if (!deduped.size) throw new Error("No Euler vault addresses were parsed from the inventory");
  return [...deduped.values()];
}

async function fetchText(url: string, attempts = 3): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "ag-euler-monitor/2" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt + Math.floor(Math.random() * 250)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`inventory fetch failed after ${attempts} attempts: ${safeReason(lastError)}`);
}

function safeReason(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  if (error instanceof Error && /^HTTP \d+$/.test(error.message)) return error.message;
  return "network error";
}

export async function loadInventory(url: string, path?: string): Promise<InventoryVault[]> {
  const text = path ? await readFile(path, "utf8") : await fetchText(url);
  return parseInventoryText(text);
}
