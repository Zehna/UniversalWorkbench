import { describe, expect, it } from "vitest";
import {
  SafeEgressPolicy,
  isPublicAddress,
  ToolExecutionError,
} from "../src/index.js";

describe("safe public HTTP egress policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])("blocks non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/file",
    "http://user:pass@example.com/",
    "https://example.com/?api_key=secret",
    "https://example.com/?access_token=secret",
    "https://example.com/?password=secret",
    "https://example.com/?X-Amz-Signature=secret",
    "https://example.com/?X-Goog-Credential=secret",
  ])("rejects unsafe URL %s", (url) => {
    const policy = new SafeEgressPolicy();
    expect(() => policy.validateUrl(url)).toThrow(ToolExecutionError);
  });

  it("allows ordinary public HTTP/HTTPS URLs without credential material", () => {
    const policy = new SafeEgressPolicy();
    expect(policy.validateUrl("https://example.com/data?q=history").hostname).toBe(
      "example.com",
    );
    expect(policy.validateUrl("http://example.com:8080/data").port).toBe("8080");
  });

  it.each([
    "Authorization",
    "Cookie",
    "Proxy-Authorization",
    "X-API-Key",
    "Api-Key",
    "X-Auth-Token",
    "X-Access-Token",
  ])("rejects credential-bearing request header %s", (name) => {
    const policy = new SafeEgressPolicy();
    expect(() => policy.validateHeaders({ [name]: "secret" })).toThrow(
      ToolExecutionError,
    );
  });

  it("accepts non-credential request headers", () => {
    const policy = new SafeEgressPolicy();
    expect(
      policy.validateHeaders({
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Request-ID": "request-1",
      }),
    ).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-request-id": "request-1",
    });
  });
});
