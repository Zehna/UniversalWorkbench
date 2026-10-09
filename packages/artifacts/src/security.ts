import { createHash } from "node:crypto";

/** Strict upper bound for any single artifact payload (10 MiB). */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/** Cap for inline JSON payloads persisted from execution outputs. */
export const MAX_INLINE_JSON_BYTES = 512 * 1024;

export const SUPPORTED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "application/json",
  "text/plain",
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export class InvalidArtifactContentError extends Error {
  constructor(message = "Artifact content does not match declared type") {
    super(message);
    this.name = "InvalidArtifactContentError";
  }
}

export class ArtifactTooLargeError extends Error {
  constructor(sizeBytes: number, maxBytes: number) {
    super(
      `Artifact size ${sizeBytes} bytes exceeds limit of ${maxBytes} bytes`,
    );
    this.name = "ArtifactTooLargeError";
  }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  return (
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  );
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Sniff the MIME type of a buffer from its magic bytes / structure.
 * Returns null when the content is empty or not recognized.
 */
export function sniffMimeType(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;
  if (startsWith(bytes, PNG_MAGIC)) return "image/png";
  if (startsWith(bytes, JPEG_MAGIC)) return "image/jpeg";
  if (isWebp(bytes)) return "image/webp";
  if (startsWith(bytes, PDF_MAGIC)) return "application/pdf";

  // Binary content (NUL byte) that is not a known binary format is unknown.
  if (bytes.includes(0x00)) return null;

  const text = decodeStrictUtf8(bytes);
  if (text === null) return null;

  const trimmed = text.trim();
  if (trimmed.length === 0) return "text/plain";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "application/json";
    } catch {
      // Falls through to text/plain check below.
    }
  }
  return "text/plain";
}

function normalizeDeclaredMime(declaredMime: string): string {
  return declaredMime.trim().toLowerCase().split(";")[0]!.trim();
}

/**
 * Verify that raw bytes match the declared MIME type via magic-byte sniffing.
 * Returns false for unknown/unsupported declared types or mismatched content.
 */
export function verifyMimeType(
  bytes: Uint8Array,
  declaredMime: string,
): boolean {
  const normalized = normalizeDeclaredMime(declaredMime);
  if (
    !(SUPPORTED_MIME_TYPES as readonly string[]).includes(normalized)
  ) {
    return false;
  }
  if (bytes.byteLength === 0) return false;
  const detected = sniffMimeType(bytes);
  return detected === normalized;
}

/**
 * Strip path components, null bytes, control characters, and unsafe
 * characters from a user-supplied filename. Never returns a path separator,
 * a dot-only name, or an empty string — falls back to "file".
 */
export function sanitizeFilename(name: string): string {
  // Strip NUL bytes first, then treat backslashes as separators.
  const withoutNul = name.replace(/\0/g, "");
  const lastSegment = withoutNul.split("/").pop()?.split("\\").pop() ?? "";
  // Remove ASCII control characters entirely (not replaced with _).
  // eslint-disable-next-line no-control-regex
  const withoutControls = lastSegment.replace(/[\x00-\x1f\x7f]/g, "");
  const trimmed = withoutControls.trim();
  // Strip leading dots to avoid hidden files / dot-dot traversal residue.
  const withoutLeadingDots = trimmed.replace(/^\.+/g, "");
  // Keep only safe characters; everything else becomes _.
  const safe = withoutLeadingDots.replace(/[^A-Za-z0-9._-]/g, "_");
  // Collapse repeated underscores for readability, then trim edge punctuation.
  const collapsed = safe.replace(/_+/g, "_").replace(/^[_\-.]+|[_\-.]+$/g, "");
  if (collapsed.length === 0) return "file";

  if (collapsed.length <= 255) return collapsed;
  // Preserve the extension when truncating to 255 bytes-safe chars.
  const dot = collapsed.lastIndexOf(".");
  if (dot > 0 && collapsed.length - dot <= 16) {
    const ext = collapsed.slice(dot);
    const base = collapsed.slice(0, 255 - ext.length);
    return `${base}${ext}`;
  }
  return collapsed.slice(0, 255);
}

/** Compute the lowercase hex sha256 of a payload. */
export function computeSha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Throw when a payload size is out of bounds. */
export function assertSizeWithinLimit(
  sizeBytes: number,
  maxBytes: number = MAX_ARTIFACT_BYTES,
): void {
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new RangeError(`Invalid artifact size: ${sizeBytes}`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError(`Invalid size limit: ${maxBytes}`);
  }
  if (sizeBytes > maxBytes) {
    throw new ArtifactTooLargeError(sizeBytes, maxBytes);
  }
}

export interface ValidateArtifactUploadOptions {
  filename?: string;
  maxBytes?: number;
}

export interface ValidatedArtifactUpload {
  checksumSha256: string;
  sizeBytes: number;
  detectedMime: string;
  sanitizedFilename?: string;
}

/**
 * Validate a full artifact upload: size bounds, magic-byte content check,
 * sha256 checksum, and optional filename sanitization.
 */
export function validateArtifactUpload(
  bytes: Uint8Array,
  declaredMime: string,
  options: ValidateArtifactUploadOptions = {},
): ValidatedArtifactUpload {
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  assertSizeWithinLimit(bytes.byteLength, maxBytes);
  if (!verifyMimeType(bytes, declaredMime)) {
    throw new InvalidArtifactContentError(
      `Artifact content does not match declared MIME type ${declaredMime}`,
    );
  }
  const detected = sniffMimeType(bytes);
  if (detected === null) {
    throw new InvalidArtifactContentError(
      "Unable to determine artifact content type",
    );
  }
  return {
    checksumSha256: computeSha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    detectedMime: detected,
    ...(options.filename !== undefined
      ? { sanitizedFilename: sanitizeFilename(options.filename) }
      : {}),
  };
}
