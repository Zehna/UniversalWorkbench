import {
  AuthAlreadyInitializedError,
  type AuthService,
} from "@uw/auth";
import { SetupOwnerRequestSchema } from "@uw/contracts";
import { Router } from "express";
import {
  setSessionCookie,
  type SessionCookieConfig,
} from "../middleware/auth.js";

export function createSetupRouter(
  authService: AuthService,
  sessionCookie: SessionCookieConfig,
) {
  const router = Router();

  router.get("/status", async (_req, res, next) => {
    try {
      res.json({ initialized: await authService.isInitialized() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/owner", async (req, res, next) => {
    const parsed = SetupOwnerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid setup request" },
      });
      return;
    }

    try {
      const result = await authService.setupOwner(parsed.data);
      setSessionCookie(res, sessionCookie, result.session.raw);
      res.status(201).json({ owner: result.owner });
    } catch (error) {
      if (error instanceof AuthAlreadyInitializedError) {
        res.status(409).json({
          error: {
            code: "ALREADY_INITIALIZED",
            message: "Owner account is already initialized",
          },
        });
        return;
      }
      next(error);
    }
  });

  return router;
}
