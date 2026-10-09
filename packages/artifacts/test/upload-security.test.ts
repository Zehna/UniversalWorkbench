import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertSizeWithinLimit,
  computeSha256Hex,
  MAX_ARTIFACT_BYTES,
  sanitizeFilename,
  sniffMimeType,
  validateArtifactUpload,
  verifyMimeType,
} from "../src/security.js";

const enc = new TextEncoder();

function pngBytes(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);
}

function jpegBytes(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}

function webpBytes(): Uint8Array {
  // RIFF....WEBP
  const header = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00];
  const webp = [0x57, 0x45, 0x42, 0x50];
  return Uint8Array.from([...header, ...webp, 0x56, 0x50, 0x38]);
}

function pdfBytes(): Uint8Array {
  return enc.encode("%PDF-1.7\n%test\n");
}

describe("sniffMimeType", () => {
  it("detects png magic bytes", () => {
    expect(sniffMimeType(pngBytes())).toBe("image/png");
  });

  it("detects jpeg magic bytes", () => {
    expect(sniffMimeType(jpegBytes())).toBe("image/jpeg");
  });

  it("detects webp magic bytes", () => {
    expect(sniffMimeType(webpBytes())).toBe("image/webp");
  });

  it("detects pdf magic bytes", () => {
    expect(sniffMimeType(pdfBytes())).toBe("application/pdf");
  });

  it("detects json payloads", () => {
    expect(sniffMimeType(enc.encode('{"a":1}'))).toBe("application/json");
  });

  it("detects plain text", () => {
    expect(sniffMimeType(enc.encode("hello world"))).toBe("text/plain");
  });

  it("returns null for empty or unknown binary", () => {
    expect(sniffMimeType(new Uint8Array(0))).toBeNull();
    expect(sniffMimeType(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});

describe("verifyMimeType", () => {
  it("accepts valid uploads with matching declared type", () => {
    expect(verifyMimeType(pngBytes(), "image/png")).toBe(true);
    expect(verifyMimeType(jpegBytes(), "image/jpeg")).toBe(true);
    expect(verifyMimeType(webpBytes(), "image/webp")).toBe(true);
    expect(verifyMimeType(pdfBytes(), "application/pdf")).toBe(true);
    expect(verifyMimeType(enc.encode('{"a":1}'), "application/json")).toBe(
      true,
    );
    expect(verifyMimeType(enc.encode("hello world"), "text/plain")).toBe(true);
  });

  it("rejects invalid magic bytes for declared type", () => {
    // PNG bytes claimed as JPEG
    expect(verifyMimeType(pngBytes(), "image/jpeg")).toBe(false);
    // Executable/script masquerading as PNG
    expect(verifyMimeType(enc.encode("#!/bin/sh\nevil"), "image/png")).toBe(
      false,
    );
    // Binary blob claimed as JSON
    expect(
      verifyMimeType(Uint8Array.from([0x00, 0x01, 0x02]), "application/json"),
    ).toBe(false);
    // Truncated / malformed JSON claimed as JSON
    expect(verifyMimeType(enc.encode("{not json"), "application/json")).toBe(
      false,
    );
  });

  it("is case-insensitive and trims the declared type", () => {
    expect(verifyMimeType(pngBytes(), "  IMAGE/PNG ")).toBe(true);
  });

  it("rejects unknown declared types", () => {
    expect(verifyMimeType(enc.encode("hello"), "application/x-evil")).toBe(
      false,
    );
  });
});

describe("sanitizeFilename", () => {
  it("strips directory traversal attempts", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\windows\\system32")).toBe("system32");
    expect(sanitizeFilename("/absolute/path/file.txt")).toBe("file.txt");
    expect(sanitizeFilename("a/b/c.txt")).toBe("c.txt");
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename(".")).toBe("file");
  });

  it("removes null bytes and control characters", () => {
    expect(sanitizeFilename("evil\u0000.png")).toBe("evil.png");
    expect(sanitizeFilename("a\u0001b.txt")).toBe("ab.txt");
  });

  it("falls back for empty or dot-only names", () => {
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("   ")).toBe("file");
    expect(sanitizeFilename("...")).toBe("file");
  });

  it("replaces unsafe characters and enforces length", () => {
    expect(sanitizeFilename("my doc?.pdf")).toBe("my_doc_.pdf");
    const long = `${"a".repeat(300)}.txt`;
    const sanitized = sanitizeFilename(long);
    expect(sanitized.length).toBeLessThanOrEqual(255);
    expect(sanitized.endsWith(".txt")).toBe(true);
  });

  it("strips leading dots to avoid hidden files", () => {
    expect(sanitizeFilename("...secret")).toBe("secret");
    expect(sanitizeFilename(".hidden")).toBe("hidden");
  });
});

describe("checksums and size limits", () => {
  it("computes sha256 hex checksums", () => {
    const bytes = enc.encode("hello");
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(computeSha256Hex(bytes)).toBe(expected);
    expect(computeSha256Hex(bytes)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces size limit bounds", () => {
    expect(() => assertSizeWithinLimit(10, 100)).not.toThrow();
    expect(() => assertSizeWithinLimit(101, 100)).toThrow(/exceeds/i);
    expect(() => assertSizeWithinLimit(-1, 100)).toThrow();
    expect(MAX_ARTIFACT_BYTES).toBeGreaterThan(0);
  });

  it("validates a full upload and returns checksum metadata", () => {
    const bytes = enc.encode('{"hello":"world"}');
    const result = validateArtifactUpload(bytes, "application/json", {
      filename: "../../uploads/report.json",
      maxBytes: 1024,
    });
    expect(result.checksumSha256).toBe(computeSha256Hex(bytes));
    expect(result.sizeBytes).toBe(bytes.byteLength);
    expect(result.detectedMime).toBe("application/json");
    expect(result.sanitizedFilename).toBe("report.json");
  });

  it("rejects mismatched content and oversized uploads", () => {
    expect(() =>
      validateArtifactUpload(pngBytes(), "image/jpeg", { maxBytes: 1024 }),
    ).toThrow(/mime|magic|content/i);
    expect(() =>
      validateArtifactUpload(enc.encode("hi"), "text/plain", {
        maxBytes: 1,
      }),
    ).toThrow(/exceeds|too large/i);
  });
});
