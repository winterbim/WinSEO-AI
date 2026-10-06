// ─── SSRF Guard ───
// Blueprint §12.2 — multi-layer SSRF protection for crawler
// OWASP SSRF Prevention Cheat Sheet [S27]

import { isIP } from "node:net";

// IP ranges to block
// Per Blueprint: loopback, RFC1918, link-local, multicast, unspecified, CGNAT, metadata endpoints

interface IpBlockRange {
  description: string;
  check: (ip: string) => boolean;
}

const IP_BLOCK_RANGES: IpBlockRange[] = [
  {
    description: "IPv4 loopback (127.0.0.0/8)",
    check: (ip) => ip.startsWith("127."),
  },
  {
    description: "IPv6 loopback (::1)",
    check: (ip) => ip === "::1" || ip === "0:0:0:0:0:0:0:1",
  },
  {
    description: "Unspecified (0.0.0.0/8)",
    check: (ip) => ip.startsWith("0."),
  },
  {
    description: "RFC1918 Class A (10.0.0.0/8)",
    check: (ip) => ip.startsWith("10."),
  },
  {
    description: "RFC1918 Class B (172.16.0.0/12)",
    check: (ip) => {
      if (!ip.startsWith("172.")) return false;
      const second = parseInt(ip.split(".")[1] ?? "", 10);
      return second >= 16 && second <= 31;
    },
  },
  {
    description: "RFC1918 Class C (192.168.0.0/16)",
    check: (ip) => ip.startsWith("192.168."),
  },
  {
    description: "Link-local (169.254.0.0/16)",
    check: (ip) => ip.startsWith("169.254."),
  },
  {
    description: "CGNAT (100.64.0.0/10)",
    check: (ip) => {
      if (!ip.startsWith("100.")) return false;
      const second = parseInt(ip.split(".")[1] ?? "", 10);
      return second >= 64 && second <= 127;
    },
  },
  {
    description: "Multicast (224.0.0.0/4)",
    check: (ip) => {
      const first = parseInt(ip.split(".")[0] ?? "", 10);
      return first >= 224 && first <= 239;
    },
  },
];

// Allowed protocols
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Known cloud metadata hostnames & dangerous hostnames
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "::1",
  "metadata.google.internal",
  "metadata.google.com",
  "169.254.169.254", // already covered by link-local, defense in depth
]);

const MAX_REDIRECTS = 5;

export class SsrfError extends Error {
  readonly url: string;

  constructor(message: string, url: string) {
    super(`SSRF blocked: ${message} (${url})`);
    this.name = "SsrfError";
    this.url = url;
  }
}

/**
 * Validate a hostname against the IP blocklist.
 * Performs DNS resolution and checks every resolved IP.
 * The actual DNS lookup happens at connection time (in fetchWithSsrfGuard).
 */
export function isPrivateIp(ip: string): { blocked: boolean; reason?: string } {
  // Strip IPv6 brackets if present
  const clean = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;

  if (!isIP(clean)) {
    return { blocked: true, reason: `Not a valid IP: ${ip}` };
  }

  // IPv6-specific checks
  if (isIP(clean) === 6) {
    const normalized = clean.toLowerCase();
    const mappedIpv4 = extractMappedIpv4(normalized);
    if (mappedIpv4) return isPrivateIp(mappedIpv4);
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
      return { blocked: true, reason: "IPv6 loopback" };
    }
    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") {
      return { blocked: true, reason: "IPv6 unspecified" };
    }
    if (/^fe[89ab][0-9a-f]:/i.test(normalized)) {
      return { blocked: true, reason: "IPv6 link-local (fe80::/10)" };
    }
    if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) {
      return { blocked: true, reason: "IPv6 unique-local (fc00::/7)" };
    }
    if (/^ff[0-9a-f]{2}:/i.test(normalized)) {
      return { blocked: true, reason: "IPv6 multicast" };
    }
    return { blocked: false };
  }

  // IPv4 checks
  for (const range of IP_BLOCK_RANGES) {
    if (range.check(clean)) {
      return { blocked: true, reason: range.description };
    }
  }

  return { blocked: false };
}

function extractMappedIpv4(ip: string): string | null {
  const prefix = "::ffff:";
  if (!ip.startsWith(prefix)) return null;
  const tail = ip.slice(prefix.length);
  if (isIP(tail) === 4) return tail;
  const groups = tail.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  const high = Number.parseInt(groups[0] ?? "", 16);
  const low = Number.parseInt(groups[1] ?? "", 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Validate a hostname at the name level (before DNS).
 */
export function validateHostname(hostname: string): {
  valid: boolean;
  reason?: string;
} {
  // Strip IPv6 brackets for matching
  const clean =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  if (BLOCKED_HOSTNAMES.has(clean.toLowerCase())) {
    return { valid: false, reason: `Blocked hostname: ${hostname}` };
  }

  // Reject bare IP addresses in hostname position (defense in depth)
  if (isIP(clean)) {
    const ipCheck = isPrivateIp(clean);
    if (ipCheck.blocked) {
      return { valid: false, reason: ipCheck.reason };
    }
  }

  return { valid: true };
}

/**
 * Full SSRF guard for a URL. Call before every fetch, including redirects.
 */
export function guardUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError("Invalid URL", url);
  }

  // Protocol allowlist (defense in depth — normalizer also checks)
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SsrfError(`Protocol ${parsed.protocol} not allowed`, url);
  }

  // No embedded credentials
  if (parsed.username || parsed.password) {
    throw new SsrfError("URL must not contain credentials", url);
  }

  // Validate hostname
  const hostCheck = validateHostname(parsed.hostname);
  if (!hostCheck.valid) {
    throw new SsrfError(hostCheck.reason ?? "Hostname blocked", url);
  }

  // If the hostname is already an IP, validate it directly
  if (isIP(parsed.hostname)) {
    const ipCheck = isPrivateIp(parsed.hostname);
    if (ipCheck.blocked) {
      throw new SsrfError(ipCheck.reason ?? "IP blocked", url);
    }
  }
}

/**
 * Maximum number of redirects to follow.
 */
export { MAX_REDIRECTS };
