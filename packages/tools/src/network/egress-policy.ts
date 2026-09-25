import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export class EgressPolicyError extends Error {
  constructor(
    public readonly code: "EGRESS_BLOCKED" | "DNS_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "EgressPolicyError";
  }
}

export interface EgressPolicy {
  assertAllowed(url: URL): Promise<void>;
  resolveAllowed(url: URL): Promise<readonly string[]>;
}

function deny(): never {
  throw new EgressPolicyError(
    "EGRESS_BLOCKED",
    "Outbound destination is not permitted",
  );
}

function publicIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Words(ip: string): number[] | null {
  if (ip.includes("%")) return null;
  let source = ip.toLowerCase();
  const ipv4Tail = source.slice(source.lastIndexOf(":") + 1);
  if (ipv4Tail.includes(".")) {
    if (isIP(ipv4Tail) !== 4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = ipv4Tail.split(".").map(Number);
    source =
      source.slice(0, source.lastIndexOf(":") + 1) +
      (a * 256 + b).toString(16) +
      ":" +
      (c * 256 + d).toString(16);
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
  ) {
    return null;
  }
  return groups.map((part) => Number.parseInt(part, 16));
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return publicIpv4(ip);
  if (family !== 6) return false;
  const groups = ipv6Words(ip);
  if (!groups) return false;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return publicIpv4([g >> 8, g & 255, h >> 8, h & 255].join("."));
  }
  // Only ordinary global unicast; exclude tunnel, documentation and ORCHID ranges.
  if (a < 0x2000 || a >= 0x4000 || a === 0x2002) return false;
  if (
    a === 0x2001 &&
    (b === 0 ||
      b === 0x0db8 ||
      (b & 0xfff0) === 0x0010 ||
      (b & 0xfff0) === 0x0020)
  ) {
    return false;
  }
  return true;
}

function validatedHost(url: URL): string {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    deny();
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !host ||
    host.length > 253 ||
    (isIP(host) === 0 && !host.includes(".")) ||
    /(?:^|\.)(?:localhost|local|internal|lan|test|invalid|onion|example)$/.test(
      host,
    ) ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".arpa")
  ) {
    deny();
  }
  return host;
}

export function createEgressPolicy(
  options: { resolver?: DnsResolver } = {},
): EgressPolicy {
  const resolver =
    options.resolver ??
    (async (name: string) =>
      (await lookup(name, { all: true, verbatim: true })).map(
        (record) => record.address,
      ));

  async function resolveAllowed(url: URL): Promise<readonly string[]> {
    const hostname = validatedHost(url);
    if (isIP(hostname)) {
      if (!isPublicAddress(hostname)) deny();
      return Object.freeze([hostname]);
    }
    let addresses: readonly string[];
    try {
      addresses = await resolver(hostname);
    } catch {
      throw new EgressPolicyError(
        "DNS_FAILURE",
        "Outbound hostname could not be resolved",
      );
    }
    if (
      !Array.isArray(addresses) ||
      addresses.length === 0 ||
      addresses.some(
        (address) => typeof address !== "string" || !isPublicAddress(address),
      )
    ) {
      deny();
    }
    return Object.freeze([...addresses]);
  }

  return {
    async assertAllowed(url) {
      await resolveAllowed(url);
    },
    resolveAllowed,
  };
}
