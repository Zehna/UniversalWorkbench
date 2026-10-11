import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { OwnerPublic } from "@uw/contracts";
import { IdSchema } from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { AuditRepository } from "@uw/core";
import {
  countVaultRows,
  createVaultStore,
  getVaultKeyringStatus,
  VaultNotFoundError,
  VaultUnavailableError,
  VaultValidationError,
  VAULT_NAME_PATTERN,
  VAULT_VALUE_MAX_BYTES,
  VAULT_VALUE_MIN_BYTES,
} from "@uw/database";
import { redactSecrets } from "@uw/shared";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import {
  HttpError,
  mapDomainError,
  parseRequest,
} from "../middleware/validate.js";
import { z } from "zod";

type VaultPool = Parameters<typeof createVaultStore>[0];

interface VaultRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  pool: VaultPool;
  /** Optional audit sink for destructive vault events; skipped when absent. */
  audit?: AuditRepository;
}

function ownerFromLocals(locals: Record<string, unknown>): OwnerPublic {
  return locals.owner as OwnerPublic;
}

const PutBodySchema = z.strictObject({
  value: z.string(),
});

function mapVaultError(error: unknown, secretValue?: string): unknown {
  const known =
    typeof secretValue === "string" && secretValue.length > 0
      ? [secretValue]
      : [];
  if (error instanceof VaultUnavailableError) {
    return new HttpError(503, "VAULT_UNAVAILABLE", "Vault is unavailable");
  }
  if (error instanceof VaultNotFoundError) {
    return new HttpError(404, "NOT_FOUND", "Secret not found");
  }
  if (error instanceof VaultValidationError) {
    return new HttpError(400, "BAD_REQUEST", "Invalid vault request");
  }
  // Never forward a raw unexpected Error: it may carry plaintext or an API
  // key in `message`/`stack`/`cause`. Scrub first (redactSecrets now clones
  // Error instances instead of passing them through), then collapse to a
  // generic 500 so nothing internal reaches the client.
  redactSecrets(error, known);
  return new HttpError(500, "INTERNAL_ERROR", "Unexpected failure");
}

export function createVaultRouter(deps: VaultRouterDependencies) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  router.get("/health", async (_req, res, next) => {
    try {
      const status = getVaultKeyringStatus();
      const rowCount = await countVaultRows(deps.pool);
      res.json({
        configured: status.configured,
        newestVersion: status.newestVersion,
        rowCount,
      });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/", async (_req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const store = createVaultStore(deps.pool);
      const secrets = await store.list(owner.id);
      res.json({ secrets });
    } catch (error) {
      next(mapVaultError(error));
    }
  });

  router.put("/:name", async (req, res, next) => {
    const rawValue: unknown = (req.body as { value?: unknown } | undefined)
      ?.value;
    const rawName: unknown = req.params.name;
    try {
      const name = typeof rawName === "string" ? rawName : "";
      if (!VAULT_NAME_PATTERN.test(name)) {
        throw new HttpError(400, "BAD_REQUEST", "Invalid secret name");
      }
      const { value } = parseRequest(PutBodySchema, req.body);
      const byteLength = Buffer.byteLength(value, "utf8");
      if (byteLength > VAULT_VALUE_MAX_BYTES) {
        throw new HttpError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Secret value exceeds 8 KiB",
        );
      }
      if (byteLength < VAULT_VALUE_MIN_BYTES) {
        throw new HttpError(400, "BAD_REQUEST", "Invalid vault request");
      }
      const owner = ownerFromLocals(res.locals);
      const store = createVaultStore(deps.pool);
      await store.put(owner.id, name, value);
      res.json({ name });
    } catch (error) {
      if (error instanceof HttpError) {
        next(error);
        return;
      }
      next(
        mapVaultError(
          error,
          typeof rawValue === "string" ? rawValue : undefined,
        ),
      );
    }
  });

  router.delete("/:name", async (req, res, next) => {
    try {
      const name = typeof req.params.name === "string" ? req.params.name : "";
      if (!VAULT_NAME_PATTERN.test(name)) {
        throw new HttpError(400, "BAD_REQUEST", "Invalid secret name");
      }
      const owner = ownerFromLocals(res.locals);
      const store = createVaultStore(deps.pool);
      // Concealment: a missing row, another owner's row, or an undecryptable
      // row all surface as 404 with zero plaintext.
      const existing = await store
        .get(owner.id, name)
        .catch((error: unknown) => {
          if (error instanceof VaultNotFoundError) return null;
          throw error;
        });
      if (existing === null) {
        throw new HttpError(404, "NOT_FOUND", "Secret not found");
      }
      // Destructive guard: the caller must echo the secret name back as
      // ?confirm=<name>. Existence is checked first so cross-owner
      // concealment stays 404 regardless of confirmation.
      const confirm =
        typeof req.query.confirm === "string" ? req.query.confirm : undefined;
      if (confirm !== name) {
        throw new HttpError(
          400,
          "CONFIRMATION_REQUIRED",
          "Secret deletion requires ?confirm=<name>",
        );
      }
      await store.remove(owner.id, name);
      if (deps.audit) {
        const requestId = res.locals.requestId;
        const traceId =
          typeof requestId === "string" && IdSchema.safeParse(requestId).success
            ? requestId
            : randomUUID();
        await deps.audit.record({
          id: randomUUID(),
          actorId: owner.id,
          action: "vault.secret.delete",
          targetType: "vault-secret",
          targetId: name,
          traceId,
          metadata: {},
          createdAt: new Date(),
        });
      }
      res.json({ deleted: true });
    } catch (error) {
      if (error instanceof HttpError) {
        next(error);
        return;
      }
      next(mapVaultError(error));
    }
  });

  return router;
}
