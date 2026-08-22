const ALLOWED_PUBLIC_HOSTS = new Set([
  "raw.githubusercontent.com",
  "app.euler.finance",
  "etherscan.io",
  "basescan.org",
  "uniscan.xyz",
  "monadscan.com",
  "arbiscan.io",
  "lineascan.build",
]);

const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/authorization\s*[:=]/i, "authorization data"],
  [/bearer\s+[a-z0-9._~-]+/i, "bearer credential"],
  [/(api[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]/i, "credential field"],
  [/RPC_URLS_JSON/, "RPC environment field"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
];

export function safeErrorReason(error: unknown, fallback: string): string {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    chain.push(current);
    current = (current as { original?: unknown; cause?: unknown }).original ?? (current as { cause?: unknown }).cause;
  }
  const errors = chain.filter((value): value is Error => value instanceof Error);
  if (errors.some((value) => value.name === "AbortError")) return `${fallback}: timeout`;
  const messages = errors.map((value) => value.message).join(" ");
  if (/unsupported IRM|no live kink|kink scale|target scale/i.test(messages)) return `${fallback}: unsupported live IRM target`;
  if (/no RPC endpoints/i.test(messages)) return `${fallback}: no RPC endpoints configured`;
  if (/HTTP \d+/.test(messages)) return `${fallback}: ${messages.match(/HTTP \d+/)?.[0]}`;
  if (errors.length) {
    const underlying = errors.at(-1)!;
    return `${fallback}: ${safeClassName(underlying.name)}`;
  }
  return fallback;
}

function safeClassName(value: string): string {
  return /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(value) ? value : "operation failed";
}

export function auditPublicContent(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const [pattern, description] of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) throw new Error(`public output rejected: contains ${description}`);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    let hostname: string;
    try {
      hostname = new URL(match[0].replace(/[),.;]+$/, "")).hostname.toLowerCase();
    } catch {
      throw new Error("public output rejected: malformed URL");
    }
    if (!ALLOWED_PUBLIC_HOSTS.has(hostname)) throw new Error(`public output rejected: non-allowlisted URL host ${hostname}`);
  }
}
