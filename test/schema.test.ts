// src/schema.ts: the zod-shaped schema builder behind every tool's
// inputSchema. JSON Schema output for tools/list, and validation that keeps
// zod 3's semantics where the tools rely on them.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as z from "../src/schema.ts";

const parse = (shape: z.Shape, v: unknown) => z.parseShapeArgs(shape, v);
const issues = (shape: z.Shape, v: unknown): string => {
  try {
    z.parseShapeArgs(shape, v);
  } catch (e) {
    if (e instanceof z.SchemaError) return e.message;
    throw e;
  }
  throw new Error("expected a SchemaError");
};

test("JSON Schema for a tool shape", () => {
  const shape = {
    tenant_id: z.string().uuid().optional().describe("Tenant"),
    limit: z.number().int().min(1).max(100).optional().default(50).describe("Limit"),
    kind: z.enum(["a", "b"]).describe("Kind"),
    ids: z.array(z.string().uuid()).min(1).max(5),
    when: z.string().datetime({ offset: true }),
    id: z.union([z.literal(10), z.literal(14)]),
    settings: z.record(z.unknown()).optional(),
    rule: z.object({ name: z.string(), enabled: z.boolean().optional() }),
    url: z.string().url().startsWith("https://"),
  };
  assert.deepEqual(z.shapeToJSONSchema(shape), {
    type: "object",
    properties: {
      tenant_id: { type: "string", format: "uuid", description: "Tenant" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "Limit" },
      kind: { type: "string", enum: ["a", "b"], description: "Kind" },
      ids: { type: "array", items: { type: "string", format: "uuid" }, minItems: 1, maxItems: 5 },
      when: { type: "string", format: "date-time" },
      id: { type: "number", enum: [10, 14] },
      settings: { type: "object", additionalProperties: {} },
      rule: {
        type: "object",
        properties: { name: { type: "string" }, enabled: { type: "boolean" } },
        required: ["name"],
        additionalProperties: false,
      },
      url: { type: "string", format: "uri", pattern: "^https://" },
    },
    required: ["kind", "ids", "when", "id", "rule", "url"],
    additionalProperties: false,
  });
});

test("defaults fill in, unknown keys are dropped, no coercion", () => {
  const shape = {
    limit: z.number().int().optional().default(50),
    tags: z.array(z.string()).default([]),
    name: z.string().trim().toLowerCase().min(2),
    n: z.coerce.number().int(),
  };
  const out = parse(shape, { name: "  AbC ", extra: 1, n: "7" });
  assert.deepEqual(out, { limit: 50, tags: [], name: "abc", n: 7 });
  // the default is a fresh copy every time
  (out.tags as string[]).push("x");
  assert.deepEqual(parse(shape, { name: "ab", n: 1 }).tags, []);
  assert.match(issues({ n: z.number() }, { n: "7" }), /n: Expected number, received string/);
  assert.match(issues({ b: z.boolean() }, { b: "true" }), /b: Expected boolean, received string/);
});

test("every issue is reported with its path", () => {
  const shape = {
    tenant_id: z.string().uuid(),
    limit: z.number().int().max(100),
    kind: z.enum(["a", "b"]),
    rows: z.array(z.object({ id: z.string().uuid() })),
    code: z.string().regex(/^[A-Z]+$/, "code must be upper case"),
    when: z.string().datetime({ offset: true, message: "needs an offset" }),
  };
  const message = issues(shape, { tenant_id: "x", limit: 1.5, kind: "c", rows: [{ id: "nope" }], code: "abc", when: "2026-10-08T02:00:00" });
  assert.equal(
    message,
    [
      "tenant_id: Invalid uuid",
      "limit: Expected integer, received float",
      "kind: Invalid enum value. Expected 'a' | 'b', received 'c'",
      "rows[0].id: Invalid uuid",
      "code: code must be upper case",
      "when: needs an offset",
    ].join("; "),
  );
  assert.match(issues(shape, {}), /^tenant_id: Required; limit: Required/);
});

test("datetime, email, url, literals and unions", () => {
  const when = { when: z.string().datetime({ offset: true }) };
  for (const ok of ["2026-10-08T02:00:00Z", "2026-10-08T02:00:00+10:00", "2026-10-08T02:00:00.123-05:30", "2026-10-08T02:00Z"]) {
    assert.deepEqual(parse(when, { when: ok }), { when: ok }, ok);
  }
  assert.match(issues({ when: z.string().datetime() }, { when: "2026-10-08T02:00:00+10:00" }), /Invalid datetime/);
  assert.match(issues({ e: z.string().email() }, { e: "nope" }), /Invalid email/);
  assert.deepEqual(parse({ e: z.string().email() }, { e: "a.b@example.com" }), { e: "a.b@example.com" });
  assert.match(issues({ u: z.string().url() }, { u: "not a url" }), /Invalid url/);
  const id = { id: z.union([z.literal(10), z.literal(14)]) };
  assert.deepEqual(parse(id, { id: 14 }), { id: 14 });
  assert.match(issues(id, { id: 11 }), /id: Invalid input/);
});

test("z.infer gives the parsed type", () => {
  const schema = z.object({ id: z.string(), n: z.number().optional() });
  const value: z.infer<typeof schema> = schema.parse({ id: "a", extra: true });
  assert.deepEqual(value, { id: "a" });
});
