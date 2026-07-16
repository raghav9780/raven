/**
 * validate.ts — generic, schema-driven argument validation run BEFORE a tool
 * executes (see ADR-0025). It walks the tool's own `inputSchema` (no per-tool
 * code), so adding a tool needs zero changes here. On failure it returns a
 * uniform, model-actionable message naming the exact field + expected type —
 * instead of each tool hand-rolling its own ("old_string must not be empty").
 *
 * It can also append a per-tool DISAMBIGUATION hint (supplied by the caller from
 * the tool's own `disambiguationHint`), so the model self-heals toward the right
 * tool next turn — WITHOUT this generic module knowing any tool name.
 */

import type { JsonObject, JsonSchema, JsonValue } from '../contracts.ts';

/** A validation failure: which field, and a human/model-readable reason. */
export interface ValidationError {
  message: string;
}

/**
 * Coerce a single string value toward a schema's declared scalar type — but ONLY
 * when the string parses cleanly and unambiguously ("3"→3, "true"→true,
 * "null"→null). Anything ambiguous is returned unchanged so `validateArgs` can
 * still flag a genuine type error. Recurses into arrays. Local models frequently
 * stringify scalars ({"timeout":"5000"}); this repairs that generically.
 */
function coerceValue(schema: JsonSchema, value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return schema.type === 'array' && schema.items
      ? value.map((item) => coerceValue(schema.items as JsonSchema, item))
      : value;
  }
  if (typeof value !== 'string') return value;
  const s = value.trim();
  switch (schema.type) {
    case 'number': {
      const n = Number(s);
      return s !== '' && Number.isFinite(n) ? n : value;
    }
    case 'integer': {
      const n = Number(s);
      return s !== '' && Number.isInteger(n) ? n : value;
    }
    case 'boolean': {
      if (/^true$/i.test(s)) return true;
      if (/^false$/i.test(s)) return false;
      return value;
    }
    case 'null':
      return s.toLowerCase() === 'null' ? null : value;
    default:
      return value;
  }
}

/**
 * Return a shallow copy of `args` with each top-level value coerced toward its
 * declared type in `schema.properties` (see `coerceValue`). Schema-driven and
 * per-tool-agnostic; unknown keys and object-typed schemas pass through
 * untouched. Run BEFORE `validateArgs` so a stringified scalar validates.
 */
export function coerceArgs(schema: JsonSchema, args: JsonObject): JsonObject {
  if (schema.type && schema.type !== 'object') return args;
  const props = schema.properties;
  if (!props) return args;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    const propSchema = props[key];
    out[key] = propSchema ? coerceValue(propSchema, value) : value;
  }
  return out;
}

function jsTypeOf(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** True when `value` satisfies the schema's declared JSON `type` (loosely: an
 *  integer is a number; anyOf/enum/untyped schemas pass this coarse check). */
function typeMatches(schema: JsonSchema, value: JsonValue): boolean {
  if (!schema.type) return true;
  const actual = jsTypeOf(value);
  if (schema.type === 'integer') return actual === 'number' && Number.isInteger(value);
  if (schema.type === 'number') return actual === 'number';
  return actual === schema.type;
}

/**
 * Validate `args` against `schema` for tool `toolName`. Returns undefined when
 * valid, or a ValidationError with a corrective, tool-aware message. Only the
 * top level is checked (required keys, declared types, and — when
 * `additionalProperties:false` — unknown keys); that covers every real misuse we
 * see without a full JSON-Schema engine.
 */
export function validateArgs(
  toolName: string,
  schema: JsonSchema,
  args: JsonObject,
  disambiguationHint?: string,
): ValidationError | undefined {
  if (schema.type && schema.type !== 'object') return undefined;
  const props = schema.properties ?? {};
  const hint = disambiguationHint ? `\n${disambiguationHint}` : '';

  // 1) Missing required fields (the #1 failure — e.g. edit without old_string).
  for (const key of schema.required ?? []) {
    const present = key in args && args[key] !== undefined && args[key] !== null;
    if (!present) {
      const expected = props[key]?.type ?? 'value';
      return {
        message:
          `${toolName}: missing required field "${key}" (${expected}).${hint}`,
      };
    }
  }

  // 2) Wrong-typed provided fields.
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const propSchema = props[key];
    if (propSchema && !typeMatches(propSchema, value)) {
      return {
        message:
          `${toolName}: field "${key}" should be ${propSchema.type} but got ` +
          `${jsTypeOf(value)}.${hint}`,
      };
    }
  }

  // 3) Unknown fields when the schema is closed — a strong signal of tool
  //    confusion (e.g. passing `content` to `edit`), so surface the hint.
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter((k) => !(k in props));
    if (unknown.length > 0) {
      return {
        message:
          `${toolName}: unexpected field${unknown.length === 1 ? '' : 's'} ` +
          `${unknown.map((k) => `"${k}"`).join(', ')}. Allowed: ` +
          `${Object.keys(props).join(', ') || '(none)'}.${hint}`,
      };
    }
  }

  return undefined;
}
