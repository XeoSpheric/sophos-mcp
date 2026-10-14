// A small, dependency-free stand-in for the slice of zod the tool definitions
// use. Tool files `import * as z from "../schema.ts"` and write the familiar
// chains (`z.string().uuid().optional().describe(...)`); each schema renders
// itself as JSON Schema for tools/list and validates tools/call arguments.
//
// Semantics follow zod 3 where the tools depend on them: no type coercion,
// unknown object keys are stripped, `.default()` fills a missing value,
// `.trim()` / `.toLowerCase()` rewrite the string in chain order, and the
// handler receives the parsed value.

import type { Obj } from "./util.ts";

export interface Issue {
  path: string;
  message: string;
}

/** Thrown by `parse` with every issue found. */
export class SchemaError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "));
    this.issues = issues;
  }
}

/** Sentinel for "this value failed"; the issue is already recorded. */
const FAIL: unique symbol = Symbol("fail");
type Parsed = unknown | typeof FAIL;
type ParseFn = (v: unknown, path: string, issues: Issue[]) => Parsed;

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" && Number.isNaN(v)) return "nan";
  return typeof v;
}

function fail(issues: Issue[], path: string, message: string): typeof FAIL {
  issues.push({ path, message });
  return FAIL;
}

const childPath = (path: string, key: string | number) =>
  typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;

/**
 * Base schema. `T` is the parsed output type; `O` is true when the key may be
 * absent from a parsed object (`.optional()`, not `.default()`).
 */
export class Schema<T = unknown, O extends boolean = false> {
  declare readonly _output: T;
  declare readonly _optional: O;
  protected json: Obj;
  protected steps: ParseFn[];
  protected isOptional = false;
  protected hasDefault = false;
  protected defaultValue: unknown;

  constructor(json: Obj, base: ParseFn) {
    this.json = json;
    this.steps = [base];
  }

  protected clone(): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(c, this);
    c.json = { ...this.json };
    c.steps = [...this.steps];
    return c;
  }

  /** Append a check or rewrite that runs after the earlier ones. */
  protected step(fn: ParseFn, json: Obj = {}): this {
    const c = this.clone();
    c.steps.push(fn);
    Object.assign(c.json, json);
    return c;
  }

  describe(description: string): this {
    const c = this.clone();
    c.json.description = description;
    return c;
  }

  optional(): Schema<T | undefined, true> {
    const c = this.clone();
    c.isOptional = true;
    return c as unknown as Schema<T | undefined, true>;
  }

  default(value: Exclude<T, undefined>): Schema<Exclude<T, undefined>, false> {
    const c = this.clone();
    c.isOptional = true;
    c.hasDefault = true;
    c.defaultValue = value;
    c.json.default = value;
    return c as unknown as Schema<Exclude<T, undefined>, false>;
  }

  /** True when an object may omit this key. */
  get acceptsMissing(): boolean {
    return this.isOptional;
  }

  /** JSON Schema for this value. */
  toJSONSchema(): Obj {
    return { ...this.json };
  }

  /** Internal: parse with a path and an issue sink. */
  run(v: unknown, path: string, issues: Issue[]): Parsed {
    if (v === undefined) {
      if (this.hasDefault) return structuredClone(this.defaultValue);
      if (this.isOptional) return undefined;
      return fail(issues, path, "Required");
    }
    let cur: Parsed = v;
    for (const fn of this.steps) {
      cur = fn(cur, path, issues);
      if (cur === FAIL) return FAIL;
    }
    return cur;
  }

  /** Validate `v`; throws SchemaError listing every issue. */
  parse(v: unknown): T {
    const issues: Issue[] = [];
    const out = this.run(v, "", issues);
    if (out === FAIL || issues.length) throw new SchemaError(issues);
    return out as T;
  }
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class StringSchema extends Schema<string> {
  constructor() {
    super({ type: "string" }, (v, path, issues) =>
      typeof v === "string" ? v : fail(issues, path, `Expected string, received ${typeName(v)}`),
    );
  }

  private check(ok: (s: string) => boolean, message: string, json: Obj = {}): this {
    return this.step((v, path, issues) => (ok(v as string) ? v : fail(issues, path, message)), json);
  }

  uuid(): this {
    return this.check((s) => UUID.test(s), "Invalid uuid", { format: "uuid" });
  }

  email(): this {
    return this.check((s) => EMAIL.test(s), "Invalid email", { format: "email" });
  }

  url(): this {
    return this.check(
      (s) => {
        try {
          new URL(s);
          return true;
        } catch {
          return false;
        }
      },
      "Invalid url",
      { format: "uri" },
    );
  }

  regex(re: RegExp, message = "Invalid"): this {
    return this.check((s) => {
      re.lastIndex = 0;
      return re.test(s);
    }, message, { pattern: re.source });
  }

  startsWith(prefix: string): this {
    return this.check((s) => s.startsWith(prefix), `Invalid input: must start with "${prefix}"`, {
      pattern: `^${escapeRegex(prefix)}`,
    });
  }

  min(n: number, message?: string): this {
    return this.check((s) => s.length >= n, message ?? `String must contain at least ${n} character(s)`, { minLength: n });
  }

  max(n: number, message?: string): this {
    return this.check((s) => s.length <= n, message ?? `String must contain at most ${n} character(s)`, { maxLength: n });
  }

  /**
   * ISO 8601 date and time. Without `offset` only a `Z` suffix is accepted;
   * with it, an explicit `+hh:mm` offset too.
   */
  datetime(options: { offset?: boolean; message?: string } = {}): this {
    const zone = options.offset ? "(Z|[+-]\\d{2}(:?\\d{2})?)" : "Z";
    const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?${zone}$`);
    return this.check((s) => re.test(s), options.message ?? "Invalid datetime", { format: "date-time" });
  }

  trim(): this {
    return this.step((v) => (v as string).trim());
  }

  toLowerCase(): this {
    return this.step((v) => (v as string).toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Numbers, booleans, literals, enums
// ---------------------------------------------------------------------------

export class NumberSchema extends Schema<number> {
  /** `coerce` runs `Number(v)` first, as `z.coerce.number()` does. */
  constructor(coerce = false) {
    super({ type: "number" }, (v, path, issues) => {
      const n = coerce ? Number(v) : v;
      return typeof n === "number" && Number.isFinite(n) ? n : fail(issues, path, `Expected number, received ${typeName(n)}`);
    });
  }

  int(): this {
    const c = this.step((v, path, issues) =>
      Number.isInteger(v) ? v : fail(issues, path, "Expected integer, received float"),
    );
    c.json.type = "integer";
    return c;
  }

  min(n: number, message?: string): this {
    return this.step(
      (v, path, issues) => ((v as number) >= n ? v : fail(issues, path, message ?? `Number must be greater than or equal to ${n}`)),
      { minimum: n },
    );
  }

  max(n: number, message?: string): this {
    return this.step(
      (v, path, issues) => ((v as number) <= n ? v : fail(issues, path, message ?? `Number must be less than or equal to ${n}`)),
      { maximum: n },
    );
  }
}

export class BooleanSchema extends Schema<boolean> {
  constructor() {
    super({ type: "boolean" }, (v, path, issues) =>
      typeof v === "boolean" ? v : fail(issues, path, `Expected boolean, received ${typeName(v)}`),
    );
  }
}

export class LiteralSchema<L extends string | number | boolean> extends Schema<L> {
  readonly value: L;
  constructor(value: L) {
    super({ type: typeof value, const: value }, (v, path, issues) =>
      v === value ? v : fail(issues, path, `Invalid literal value, expected ${JSON.stringify(value)}`),
    );
    this.value = value;
  }
}

export class EnumSchema<E extends string> extends Schema<E> {
  readonly options: readonly E[];
  constructor(values: readonly E[]) {
    super({ type: "string", enum: [...values] }, (v, path, issues) =>
      typeof v === "string" && (values as readonly string[]).includes(v)
        ? v
        : fail(issues, path, `Invalid enum value. Expected ${values.map((x) => `'${x}'`).join(" | ")}, received ${typeof v === "string" ? `'${v}'` : typeName(v)}`),
    );
    this.options = values;
  }
}

// ---------------------------------------------------------------------------
// Composites
// ---------------------------------------------------------------------------

export type AnySchema = Schema<any, boolean>;
export type Shape = Record<string, AnySchema>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Parsed type of a schema (zod's `z.infer`). */
export type Infer<S> = S extends Schema<infer T, boolean> ? T : never;

/** Parsed type of an object shape: optional schemas become optional keys. */
export type ShapeOutput<S extends Shape> = Simplify<
  { [K in keyof S as S[K] extends Schema<any, true> ? never : K]: Infer<S[K]> } & {
    [K in keyof S as S[K] extends Schema<any, true> ? K : never]?: Infer<S[K]>;
  }
>;

export class ArraySchema<I extends AnySchema> extends Schema<Infer<I>[]> {
  readonly element: I;
  constructor(element: I) {
    super({ type: "array", items: element.toJSONSchema() }, (v, path, issues) => {
      if (!Array.isArray(v)) return fail(issues, path, `Expected array, received ${typeName(v)}`);
      const out: unknown[] = [];
      let bad = false;
      v.forEach((item, i) => {
        const r = element.run(item, childPath(path, i), issues);
        if (r === FAIL) bad = true;
        else out.push(r);
      });
      return bad ? FAIL : out;
    });
    this.element = element;
  }

  min(n: number, message?: string): this {
    return this.step(
      (v, path, issues) => ((v as unknown[]).length >= n ? v : fail(issues, path, message ?? `Array must contain at least ${n} element(s)`)),
      { minItems: n },
    );
  }

  max(n: number, message?: string): this {
    return this.step(
      (v, path, issues) => ((v as unknown[]).length <= n ? v : fail(issues, path, message ?? `Array must contain at most ${n} element(s)`)),
      { maxItems: n },
    );
  }
}

/** JSON Schema for an object shape (also the tools/list `inputSchema`). */
export function shapeToJSONSchema(shape: Shape): Obj {
  const properties: Obj = {};
  const required: string[] = [];
  for (const [k, s] of Object.entries(shape)) {
    properties[k] = s.toJSONSchema();
    if (!s.acceptsMissing) required.push(k);
  }
  const out: Obj = { type: "object", properties };
  if (required.length) out.required = required;
  out.additionalProperties = false;
  return out;
}

/** Parse an object against a shape: unknown keys are dropped. */
function parseShape(shape: Shape, v: unknown, path: string, issues: Issue[]): Parsed {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return fail(issues, path, `Expected object, received ${typeName(v)}`);
  }
  const src = v as Obj;
  const out: Obj = {};
  let bad = false;
  for (const [k, s] of Object.entries(shape)) {
    const r = s.run(src[k], childPath(path, k), issues);
    if (r === FAIL) bad = true;
    else if (r !== undefined) out[k] = r;
  }
  return bad ? FAIL : out;
}

export class ObjectSchema<S extends Shape> extends Schema<ShapeOutput<S>> {
  readonly shape: S;
  constructor(shape: S) {
    super(shapeToJSONSchema(shape), (v, path, issues) => parseShape(shape, v, path, issues));
    this.shape = shape;
  }
}

/** Parse tool arguments against a raw shape (the `inputSchema` of a tool). */
export function parseShapeArgs<S extends Shape>(shape: S, v: unknown): ShapeOutput<S> {
  const issues: Issue[] = [];
  const out = parseShape(shape, v ?? {}, "", issues);
  if (out === FAIL || issues.length) throw new SchemaError(issues);
  return out as ShapeOutput<S>;
}

export class RecordSchema<V extends AnySchema> extends Schema<Record<string, Infer<V>>> {
  constructor(value: V) {
    super({ type: "object", additionalProperties: value.toJSONSchema() }, (v, path, issues) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        return fail(issues, path, `Expected object, received ${typeName(v)}`);
      }
      const out: Obj = {};
      let bad = false;
      for (const [k, item] of Object.entries(v as Obj)) {
        const r = value.run(item, childPath(path, k), issues);
        if (r === FAIL) bad = true;
        else out[k] = r;
      }
      return bad ? FAIL : out;
    });
  }
}

export class UnionSchema<U extends readonly AnySchema[]> extends Schema<Infer<U[number]>> {
  constructor(options: U) {
    const literals = options.every((o) => o instanceof LiteralSchema) ? (options as unknown as LiteralSchema<any>[]) : undefined;
    const types = literals ? [...new Set(literals.map((l) => typeof l.value))] : [];
    const json: Obj =
      literals && types.length === 1
        ? { type: types[0], enum: literals.map((l) => l.value) }
        : { anyOf: options.map((o) => o.toJSONSchema()) };
    super(json, (v, path, issues) => {
      for (const o of options) {
        const scratch: Issue[] = [];
        const r = o.run(v, path, scratch);
        if (r !== FAIL && !scratch.length) return r;
      }
      return fail(issues, path, "Invalid input");
    });
  }
}

export class UnknownSchema extends Schema<unknown> {
  constructor() {
    super({}, (v) => v);
  }
}

// ---------------------------------------------------------------------------
// The `z.*` constructors
// ---------------------------------------------------------------------------

export const string = () => new StringSchema();
export const number = () => new NumberSchema();
export const boolean = () => new BooleanSchema();
export const coerce = { number: () => new NumberSchema(true) };
export const unknown = () => new UnknownSchema();
export const literal = <L extends string | number | boolean>(value: L) => new LiteralSchema(value);
export const array = <I extends AnySchema>(element: I) => new ArraySchema(element);
export const object = <S extends Shape>(shape: S) => new ObjectSchema(shape);
export const record = <V extends AnySchema>(value: V) => new RecordSchema(value);
export const union = <U extends readonly [AnySchema, ...AnySchema[]]>(options: U) => new UnionSchema(options);

function enumOf<U extends string, T extends Readonly<[U, ...U[]]>>(values: T): EnumSchema<T[number]> {
  return new EnumSchema<T[number]>(values);
}

export { enumOf as enum };
export type { Infer as infer };
