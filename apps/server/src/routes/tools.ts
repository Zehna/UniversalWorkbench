import type { AuthService } from "@uw/auth";
import { ContextTypeSchema } from "@uw/contracts";
import type { ToolRegistry } from "@uw/tools";
import { Router } from "express";
import { z } from "zod";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import { parseRequest } from "../middleware/validate.js";

interface ToolsRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  toolRegistry: ToolRegistry;
}

const CompatibilityRequestSchema = z.object({
  type: ContextTypeSchema,
});

export function createToolsRouter(deps: ToolsRouterDependencies) {
  const router = Router();
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  router.get("/", (_req, res) => {
    res.json({ tools: deps.toolRegistry.list() });
  });

  router.post("/compatibility", (req, res, next) => {
    try {
      const input = parseRequest(CompatibilityRequestSchema, req.body);
      res.json({
        targets: deps.toolRegistry.compatibleTargets(input.type),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
