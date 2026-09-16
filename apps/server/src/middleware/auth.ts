import type { AuthService } from "@uw/auth";
import type { OwnerPublic } from "@uw/contracts";
import type { RequestHandler, Response } from "express";

export interface SessionCookieConfig {
  name: string;
  secure: boolean;
  maxAgeSeconds: number;
}

function requestIdFromLocals(locals: Record<string, unknown>): string | undefined {
  return typeof locals.requestId === "string" ? locals.requestId : undefined;
}

function unauthorizedBody(res: Response) {
  const requestId = requestIdFromLocals(res.locals);
  return {
    error: {
      code: "UNAUTHORIZED",
      message: "Authentication required",
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function readCookie(
  cookieHeader: string | undefined,
  cookieName: string,
): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const name = trimmed.slice(0, separator);
    if (name !== cookieName) continue;
    return trimmed.slice(separator + 1);
  }

  return null;
}

export function setSessionCookie(
  res: Response,
  config: SessionCookieConfig,
  rawToken: string,
): void {
  res.cookie(config.name, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.secure,
    maxAge: config.maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(
  res: Response,
  config: SessionCookieConfig,
): void {
  res.clearCookie(config.name, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.secure,
  });
}

export function requireOwner(
  authService: AuthService,
  cookie: SessionCookieConfig,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const rawToken = readCookie(req.headers.cookie, cookie.name);
      if (!rawToken) {
        res.status(401).json(unauthorizedBody(res));
        return;
      }

      const owner = await authService.resolveSession(rawToken);
      if (!owner) {
        res.status(401).json(unauthorizedBody(res));
        return;
      }

      res.locals.owner = owner satisfies OwnerPublic;
      next();
    } catch (error) {
      next(error);
    }
  };
}
