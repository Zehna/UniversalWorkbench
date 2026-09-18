import { InvalidCredentialsError, type AuthService } from "@uw/auth";
import { LoginRequestSchema, type OwnerPublic } from "@uw/contracts";
import { Router } from "express";
import {
  clearSessionCookie,
  readCookie,
  requireOwner,
  setSessionCookie,
  type SessionCookieConfig,
} from "../middleware/auth.js";

function requestIdDetails(locals: Record<string, unknown>) {
  const requestId = locals.requestId;
  return typeof requestId === "string" ? { requestId } : {};
}

export function createAuthRouter(
  authService: AuthService,
  sessionCookie: SessionCookieConfig,
) {
  const router = Router();

  router.post("/login", async (req, res, next) => {
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message: "Invalid login request",
          ...requestIdDetails(res.locals),
        },
      });
      return;
    }

    try {
      const result = await authService.login(parsed.data);
      setSessionCookie(res, sessionCookie, result.session.raw);
      res.json({ owner: result.owner });
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        res.status(401).json({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid credentials",
            ...requestIdDetails(res.locals),
          },
        });
        return;
      }
      next(error);
    }
  });

  router.get(
    "/session",
    requireOwner(authService, sessionCookie),
    (_req, res) => {
      res.json({ owner: res.locals.owner as OwnerPublic });
    },
  );

  router.post("/logout", async (req, res, next) => {
    try {
      const rawToken = readCookie(req.headers.cookie, sessionCookie.name);
      if (rawToken) await authService.logout(rawToken);
      clearSessionCookie(res, sessionCookie);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
