// Tool registry: the `registerTool` surface the tool modules were written
// against, the tools/list payload, and tools/call argument validation.

import { log } from "../log.ts";
import { type Shape, type ShapeOutput, SchemaError, parseShapeArgs, shapeToJSONSchema } from "../schema.ts";
import type { Obj } from "../util.ts";
import { type ToolResult, errorResult } from "./helpers.ts";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolConfig<S extends Shape> {
  title?: string;
  description?: string;
  inputSchema?: S;
  annotations?: ToolAnnotations;
}

interface RegisteredTool {
  name: string;
  title: string | undefined;
  description: string | undefined;
  shape: Shape;
  annotations: ToolAnnotations | undefined;
  /** Changes Sophos state: anything not annotated `readOnlyHint: true`. */
  write: boolean;
  handler: (args: any) => Promise<ToolResult>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  registerTool<S extends Shape>(
    name: string,
    config: ToolConfig<S>,
    handler: (args: ShapeOutput<S>) => Promise<ToolResult>,
  ): void {
    if (this.#tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    this.#tools.set(name, {
      name,
      title: config.title,
      description: config.description,
      shape: config.inputSchema ?? {},
      annotations: config.annotations,
      write: config.annotations?.readOnlyHint !== true,
      handler,
    });
  }

  get names(): string[] {
    return [...this.#tools.keys()];
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  isWrite(name: string): boolean {
    return this.#tools.get(name)?.write ?? false;
  }

  /** tools/list payload. Write tools are listed only when writes are allowed. */
  list(allowWrites: boolean): Obj[] {
    return [...this.#tools.values()]
      .filter((t) => allowWrites || !t.write)
      .map((t) => {
        const entry: Obj = { name: t.name };
        if (t.title !== undefined) entry.title = t.title;
        if (t.description !== undefined) entry.description = t.description;
        entry.inputSchema = shapeToJSONSchema(t.shape);
        if (t.annotations) entry.annotations = t.annotations;
        return entry;
      });
  }

  /** tools/call: validate the arguments, refuse writes when disabled, run the handler. */
  async call(name: string, rawArgs: unknown, allowWrites: boolean): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) return errorResult(new Error(`Unknown tool: ${name}`));
    if (tool.write && !allowWrites) {
      return errorResult(
        new Error(`${name} changes Sophos and writes are disabled on this server (ALLOW_WRITES is off).`),
      );
    }
    let args: Obj;
    try {
      args = parseShapeArgs(tool.shape, rawArgs);
    } catch (e) {
      if (e instanceof SchemaError) return errorResult(new Error(`Invalid arguments for tool ${name}: ${e.message}`));
      throw e;
    }
    log.debug(() => `Calling tool: ${name} ${JSON.stringify(args)}`);
    try {
      return await tool.handler(args);
    } catch (e) {
      log.warn(`Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      return errorResult(e);
    }
  }
}
