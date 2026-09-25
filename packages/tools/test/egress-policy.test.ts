import { describe, expect, it, vi } from "vitest";
import {
  createEgressPolicy,
  EgressPolicyError,
  isPublicAddress,
} from "../src/network/egress-policy.js";

describe("policy-gated HTTP egress", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/",
    "https://user:password@example.com/",
    "http://localhost/",
    "http://local/",
    "http://host.internal/",
    "http://host.local/",
    "http://host.home.arpa/",
    "http://metadata.google.internal/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.0.2/",
    "http://192.168.5.2/",
    "http://169.254.169.254/",
    "http://100.64.0.1/",
    "http://198.19.1.1/",
    "http://192.0.2.3/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[2001:db8::1]/",
    "http://[2002:c0a8:101::]/",
  ])("rejects forbidden targets: %s", async (raw) => {
    const resolver = vi.fn(async () => ["93.184.216.34"]);
    await expect(
      createEgressPolicy({ resolver }).assertAllowed(new URL(raw)),
    ).rejects.toBeInstanceOf(EgressPolicyError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("allows routable literals without external DNS", async () => {
    const resolver = vi.fn(async () => ["93.184.216.34"]);
    const policy = createEgressPolicy({ resolver });
    await expect(
      policy.resolveAllowed(new URL("https://8.8.8.8/")),
    ).resolves.toEqual(["8.8.8.8"]);
    await expect(
      policy.resolveAllowed(new URL("https://[2606:4700:4700::1111]/")),
    ).resolves.toEqual(["2606:4700:4700::1111"]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("fails closed if any DNS answer is restricted", async () => {
    const resolver = vi.fn(async () => ["93.184.216.34", "10.0.0.7"]);
    await expect(
      createEgressPolicy({ resolver }).resolveAllowed(
        new URL("https://example.com/"),
      ),
    ).rejects.toMatchObject({ code: "EGRESS_BLOCKED" });
    expect(resolver).toHaveBeenCalledWith("example.com");
  });

  it("does not accept empty or failing DNS resolutions", async () => {
    await expect(
      createEgressPolicy({ resolver: async () => [] }).assertAllowed(
        new URL("https://example.com/"),
      ),
    ).rejects.toMatchObject({ code: "EGRESS_BLOCKED" });
    await expect(
      createEgressPolicy({
        resolver: async () => {
          throw new Error("secret from DNS");
        },
      }).assertAllowed(new URL("https://example.com/")),
    ).rejects.toMatchObject({
      code: "DNS_FAILURE",
      message: "Outbound hostname could not be resolved",
    });
  });

  it("returns immutable validated DNS records", async () => {
    const answers = ["93.184.216.34", "2606:4700::1111"];
    const result = await createEgressPolicy({
      resolver: async () => answers,
    }).resolveAllowed(new URL("https://example.com/"));
    answers.push("10.0.0.1");
    expect(result).toEqual(["93.184.216.34", "2606:4700::1111"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["8.8.8.8", true],
    ["93.184.216.34", true],
    ["2606:4700:4700::1111", true],
    ["::ffff:93.184.216.34", true],
    ["::ffff:127.0.0.1", false],
    ["::", false],
    ["::1", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["2001:db8::1", false],
    ["2002:c0a8:101::", false],
    ["169.254.169.254", false],
    ["192.0.2.3", false],
    ["203.0.113.3", false],
  ])("classifies IP %s as public=%s", (ip, allowed) => {
    expect(isPublicAddress(ip)).toBe(allowed);
  });
});
