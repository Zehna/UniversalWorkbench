import { isIP } from "node:net";
import { ToolExecutionError } from "../../errors.js";

const credentialQueryKeys = new Set([
  "apikey",
  "accesstoken",
  "authtoken",
  "authorization",
  "auth",
  "clientsecret",
  "credential",
  "credentials",
  "key",
  "password",
  "passwd",
  "secret",
  "sig",
  "signature",
  "token",
]);

const forbiddenRequestHeaders = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
]);

const credentialResponseHeaders = new Set([
  "set-cookie",
  "set-cookie2",
  "proxy-authenticate",
  "www-authenticate",
  "authorization",
  "proxy-authorization",
]);

function normalizeCredentialName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function unsafe(message: string): never {
  throw new ToolExecutionError({
    code: "UNSAFE_EGRESS",
    message,
    retrySafe: false,
  });
}

function parseIpv4(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return null;
  }

  return (
    parts[0]! * 2 ** 24 +
    parts[1]! * 2 ** 16 +
    parts[2]! * 2 ** 8 +
    parts[3]!
  );
}

function ipv4InCidr(address: number, network: number, prefix: number): boolean {
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(address / blockSize) === Math.floor(network / blockSize);
}

const blockedIpv4Cidrs = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const blockedIpv4Ranges = blockedIpv4Cidrs.map(([network, prefix]) => {
  const parsed = parseIpv4(network);
  if (parsed === null) throw new Error(`Invalid IPv4 CIDR constant: ${network}`);
  return { network: parsed, prefix };
});

function normalizeIpLiteral(address: string): string {
  const withoutBrackets =
    address.startsWith("[") && address.endsWith("]")
      ? address.slice(1, -1)
      : address;
  const zone = withoutBrackets.indexOf("%");
  return zone >= 0 ? withoutBrackets.slice(0, zone) : withoutBrackets;
}

function ipv6ToBigInt(address: string): bigint | null {
  let normalized = normalizeIpLiteral(address).toLowerCase();
  if (isIP(normalized) !== 6) return null;

  const tail = normalized.slice(normalized.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const ipv4 = parseIpv4(tail);
    if (ipv4 === null) return null;
    const high = Math.floor(ipv4 / 2 ** 16).toString(16);
    const low = (ipv4 % 2 ** 16).toString(16);
    normalized = `${normalized.slice(0, normalized.lastIndexOf(":"))}:${high}:${low}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const parts =
    halves.length === 2
      ? [...left, ...Array.from({ length: missing }, () => "0"), ...right]
      : left;
  if (parts.length !== 8) return null;

  let result = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(part, 16));
  }
  return result;
}

function ipv6InCidr(
  address: bigint,
  network: bigint,
  prefix: number,
): boolean {
  const shift = BigInt(128 - prefix);
  return address >> shift === network >> shift;
}

function ipv6Network(address: string): bigint {
  const parsed = ipv6ToBigInt(address);
  if (parsed === null) throw new Error(`Invalid IPv6 CIDR constant: ${address}`);
  return parsed;
}

const globalIpv6 = { network: ipv6Network("2000::"), prefix: 3 };
const blockedIpv6Cidrs = [
  { network: ipv6Network("2001::"), prefix: 23 },
  { network: ipv6Network("2001:db8::"), prefix: 32 },
  { network: ipv6Network("2002::"), prefix: 16 },
  { network: ipv6Network("3fff::"), prefix: 20 },
];

export function isPublicAddress(address: string): boolean {
  const normalized = normalizeIpLiteral(address);
  const family = isIP(normalized);

  if (family === 4) {
    const parsed = parseIpv4(normalized);
    if (parsed === null) return false;
    return !blockedIpv4Ranges.some(({ network, prefix }) =>
      ipv4InCidr(parsed, network, prefix),
    );
  }

  if (family === 6) {
    const parsed = ipv6ToBigInt(normalized);
    if (parsed === null) return false;
    if (!ipv6InCidr(parsed, globalIpv6.network, globalIpv6.prefix)) {
      return false;
    }
    return !blockedIpv6Cidrs.some(({ network, prefix }) =>
      ipv6InCidr(parsed, network, prefix),
    );
  }

  return false;
}

function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  const compact = normalizeCredentialName(name);
  return (
    forbiddenRequestHeaders.has(lower) ||
    compact.includes("apikey") ||
    compact.endsWith("authtoken") ||
    compact.endsWith("accesstoken") ||
    compact.includes("clientsecret") ||
    compact === "secret" ||
    compact === "password"
  );
}

export class SafeEgressPolicy {
  validateUrl(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ToolExecutionError({
        code: "VALIDATION",
        message: "HTTP URL is invalid",
        retrySafe: false,
      });
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      unsafe("Only HTTP and HTTPS destinations are allowed");
    }
    if (url.username || url.password) {
      unsafe("URL userinfo credentials are not allowed");
    }

    for (const key of url.searchParams.keys()) {
      if (credentialQueryKeys.has(normalizeCredentialName(key))) {
        unsafe("Credential-like query parameters are not allowed");
      }
    }

    const literal = normalizeIpLiteral(url.hostname);
    if (isIP(literal) !== 0 && !isPublicAddress(literal)) {
      unsafe("Destination address is not public");
    }

    url.hash = "";
    return url;
  }

  validateHeaders(
    headers: Record<string, string> = {},
  ): Record<string, string> {
    const safe: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (isCredentialHeader(name)) {
        unsafe(`Request header ${name} is not allowed`);
      }
      if (/[
]/.test(name) || /[
]/.test(value)) {
        throw new ToolExecutionError({
          code: "VALIDATION",
          message: "HTTP headers cannot contain line breaks",
          retrySafe: false,
        });
      }
      safe[name.toLowerCase()] = value;
    }
    safe["accept-encoding"] = "identity";
    return safe;
  }

  sanitizeResponseHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, string> {
    const safe: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (
        credentialResponseHeaders.has(lower) ||
        value === undefined ||
        lower === "connection" ||
        lower === "transfer-encoding"
      ) {
        continue;
      }
      safe[lower] = Array.isArray(value) ? value.join(", ") : value;
    }
    return safe;
  }
}
