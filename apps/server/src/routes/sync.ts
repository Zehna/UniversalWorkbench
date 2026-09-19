import type { AuthService } from "@uw/auth";
import type { OwnerPublic } from "@uw/contracts";
import {
  DecimalCursorSchema,
  IdSchema,
  SyncOperationSchema,
} from "@uw/contracts";
import type { SyncService } from "@uw/sync";
import { Router } from "express";
import { z } from "zod";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import { mapDomainError, parseRequest } from "../middleware/validate.js";

interface SyncRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  syncService: SyncService;
}

const RegisterDeviceSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(100),
});

const DeviceParamsSchema = z.object({
  deviceId: IdSchema,
});

const ChangesQuerySchema = z.object({
  cursor: DecimalCursorSchema.default("0"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const OperationsRequestSchema = z.object({
  operations: z.array(SyncOperationSchema).min(1).max(100),
});

function ownerFromLocals(locals: Record<string, unknown>): OwnerPublic {
  return locals.owner as OwnerPublic;
}

export function createSyncRouter(deps: SyncRouterDependencies) {
  const router = Router();
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  router.get("/devices", async (_req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const devices = await deps.syncService.listDevices(owner.id);
      res.json({ devices });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/devices", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const input = parseRequest(RegisterDeviceSchema, req.body);
      const device = await deps.syncService.registerDevice(owner.id, input);
      res.status(201).json({ device });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.delete("/devices/:deviceId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { deviceId } = parseRequest(DeviceParamsSchema, req.params);
      await deps.syncService.revokeDevice(owner.id, deviceId);
      res.status(204).end();
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/changes", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const query = parseRequest(ChangesQuerySchema, req.query);
      const changes = await deps.syncService.listChanges(
        owner.id,
        query.cursor,
        query.limit,
      );
      res.json({ changes });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/operations", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const input = parseRequest(OperationsRequestSchema, req.body);
      const results = await deps.syncService.pushOperations(
        owner.id,
        input.operations,
      );
      res.json({ results });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
