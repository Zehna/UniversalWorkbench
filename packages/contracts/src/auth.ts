import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.js";

export const UsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);

export const PasswordSchema = z.string().min(12).max(128);

export const OwnerPublicSchema = z.object({
  id: IdSchema,
  username: UsernameSchema,
  createdAt: IsoDateTimeSchema,
});

export const SetupOwnerRequestSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
});

export const LoginRequestSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
});

export type OwnerPublic = z.infer<typeof OwnerPublicSchema>;
export type SetupOwnerRequest = z.infer<typeof SetupOwnerRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
