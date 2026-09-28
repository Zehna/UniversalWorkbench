import { Router } from "express";
import type { AuthService } from "@uw/auth";
import type { ToolRegistry } from "@uw/tools";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";

export function createToolsRouter(deps: {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  registry: ToolRegistry;
  grantedPermissions?: readonly string[];
}) {
  const router = Router();
  router.use(requireOwner(deps.authService, deps.sessionCookie));
  router.get("/", (_req, res) => {
    res.json({
      tools: deps.registry.list(),
      grantedPermissions: deps.grantedPermissions ?? [],
    });
  });
  return router;
}
