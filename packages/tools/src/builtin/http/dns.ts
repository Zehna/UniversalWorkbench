import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ToolExecutionError } from "../../errors.js";
import { isPublicAddress } from "./policy.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

const systemLookup: DnsLookup = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records
    .filter(
      (record): record is { address: string; family: 4 | 6 } =>
        record.family === 4 || record.family === 6,
    )
    .map((record) => ({
      address: record.address,
      family: record.family,
    }));
};

export class SafeDnsResolver {
  constructor(readonly lookupHost: DnsLookup = systemLookup) {}

  async resolvePublic(hostname: string): Promise<ResolvedAddress[]> {
    const normalized = normalizeHostname(hostname);
    const literalFamily = isIP(normalized);
    const records =
      literalFamily === 4 || literalFamily === 6
        ? [
            {
              address: normalized,
              family: literalFamily,
            } satisfies ResolvedAddress,
          ]
        : await this.lookupHost(normalized);

    if (records.length === 0) {
      throw new Error("DNS resolution returned no addresses");
    }

    if (records.some((record) => !isPublicAddress(record.address))) {
      throw new ToolExecutionError({
        code: "UNSAFE_EGRESS",
        message: "DNS resolution included a non-public address",
        retrySafe: false,
      });
    }

    return records.map((record) => ({ ...record }));
  }
}
