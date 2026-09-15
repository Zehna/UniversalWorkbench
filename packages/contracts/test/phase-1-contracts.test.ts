import { describe, expect, it } from "vitest";
import {
  CreateNoteRequestSchema,
  CreateProjectRequestSchema,
  IdSchema,
  LoginRequestSchema,
  SetupOwnerRequestSchema,
  UpdateNoteRequestSchema,
} from "../src/index.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

 describe("phase 1 contracts", () => {
  it("accepts UUID identifiers and rejects arbitrary strings", () => {
    expect(IdSchema.safeParse(UUID_A).success).toBe(true);
    expect(IdSchema.safeParse("not-an-id").success).toBe(false);
  });

  it("requires owner passwords between 12 and 128 characters", () => {
    expect(
      SetupOwnerRequestSchema.safeParse({
        username: "owner",
        password: "long-password",
      }).success,
    ).toBe(true);
    expect(
      SetupOwnerRequestSchema.safeParse({ username: "owner", password: "short" })
        .success,
    ).toBe(false);
    expect(
      LoginRequestSchema.safeParse({ username: "owner", password: "x".repeat(129) })
        .success,
    ).toBe(false);
  });

  it("bounds project names to 1..120 characters", () => {
    expect(CreateProjectRequestSchema.safeParse({ name: "History" }).success).toBe(
      true,
    );
    expect(CreateProjectRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(
      CreateProjectRequestSchema.safeParse({ name: "x".repeat(121) }).success,
    ).toBe(false);
  });

  it("bounds note titles to 1..200 characters", () => {
    expect(
      CreateNoteRequestSchema.safeParse({ title: "Sources", body: "Draft" })
        .success,
    ).toBe(true);
    expect(
      CreateNoteRequestSchema.safeParse({ title: "x".repeat(201), body: "Draft" })
        .success,
    ).toBe(false);
  });

  it("requires a base revision when updating a note", () => {
    expect(
      UpdateNoteRequestSchema.safeParse({
        title: "Sources",
        body: "Second draft",
        baseRevisionId: UUID_A,
      }).success,
    ).toBe(true);
    expect(
      UpdateNoteRequestSchema.safeParse({ title: "Sources", body: "Second draft" })
        .success,
    ).toBe(false);
  });
});
