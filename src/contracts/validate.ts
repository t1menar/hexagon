import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { AgentStatus, Message, Plan, ResultEnvelope } from "./types.js";

const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv2020) => void;

export const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function load<T>(file: string): ValidateFunction<T> {
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), "utf8"));
  return ajv.compile<T>(schema);
}

let cache: {
  status: ValidateFunction<AgentStatus>;
  message: ValidateFunction<Message>;
  plan: ValidateFunction<Plan>;
  result: ValidateFunction<ResultEnvelope>;
} | undefined;

function validators() {
  cache ??= {
    status: load<AgentStatus>("agent-status.v1.schema.json"),
    message: load<Message>("message.v1.schema.json"),
    plan: load<Plan>("plan.v1.schema.json"),
    result: load<ResultEnvelope>("result.v1.schema.json"),
  };
  return cache;
}

export interface Validation { ok: boolean; errors: string[] }

function run<T>(fn: ValidateFunction<T>, data: unknown): Validation {
  const ok = fn(data) as boolean;
  return { ok, errors: ok ? [] : formatErrors(fn.errors ?? []) };
}

export function formatErrors(errors: ErrorObject[]): string[] {
  return errors.map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}${e.params && "allowedValues" in e.params ? ` (${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")})` : ""}`);
}

export const validateStatus = (d: unknown) => run(validators().status, d);
export const validateMessage = (d: unknown) => run(validators().message, d);
export const validatePlan = (d: unknown) => run(validators().plan, d);
export const validateResult = (d: unknown) => run(validators().result, d);

/** Raw schema objects, e.g. to hand to a model as a tool input_schema. */
export function rawSchema(file: "result.v1.schema.json" | "plan.v1.schema.json"): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), "utf8"));
}
