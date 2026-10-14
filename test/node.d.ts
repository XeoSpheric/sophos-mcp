// The slice of Node's API the tests use (avoids depending on @types/node).

declare module "node:test" {
  type Fn = () => void | Promise<void>;
  export function test(name: string, fn: Fn): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: Fn): Promise<void>;
  export function beforeEach(fn: Fn): void;
  export function afterEach(fn: Fn): void;
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
    doesNotMatch(value: string, regexp: RegExp, message?: string): void;
    throws(fn: () => unknown, error?: RegExp | Function | object, message?: string): void;
    rejects(promise: Promise<unknown> | (() => Promise<unknown>), error?: RegExp | Function | object, message?: string): Promise<void>;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}

declare module "node:module" {
  interface LoadResult {
    format?: string;
    source?: string;
    shortCircuit?: boolean;
  }
  export function registerHooks(hooks: {
    load?: (url: string, context: object, nextLoad: (url: string, context: object) => LoadResult) => LoadResult;
  }): void;
}
