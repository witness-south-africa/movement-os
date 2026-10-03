import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { OpenAiResponsesError } from './responses-client.js';

const MAX_DEPTH = 9;
const MAX_NODES = 1_000;
const MAX_SCHEMA_BYTES = 65_536;
const SUPPORTED_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);
const VALUE_KEYWORDS = new Set([
  'type',
  'enum',
  'required',
  'description',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
]);

/** Required, closed object-root subset; the original Zod schema stays authoritative. */
export function zodToOpenAiResponsesJsonSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) {
    throw unsupported();
  }
  inspect(schema, new Set(), { nodes: 0 }, 0);
  const generated: unknown = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  });
  if (!isRecord(generated)) {
    throw unsupported();
  }
  const { $schema: _ignored, ...body } = generated;
  const result = normalise(body, { enumValues: 0 });
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SCHEMA_BYTES) {
    throw unsupported();
  }
  return result;
}

function inspect(
  schema: z.ZodType,
  ancestors: ReadonlySet<z.ZodType>,
  budget: { nodes: number },
  depth: number,
): void {
  budget.nodes += 1;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES || ancestors.has(schema)) {
    throw unsupported();
  }
  const next = new Set(ancestors).add(schema);
  const visit = (child: z.ZodType) => inspect(child, next, budget, depth + 1);
  if (schema instanceof z.ZodObject) {
    const object = schema as z.ZodObject<Record<string, z.ZodType>>;
    if (
      object._def.unknownKeys === 'passthrough' ||
      !(object._def.catchall instanceof z.ZodNever)
    ) {
      throw unsupported();
    }
    for (const child of Object.values(object.shape)) {
      visit(child);
    }
  } else if (schema instanceof z.ZodArray) {
    visit((schema as z.ZodArray<z.ZodType>).element);
  } else if (schema instanceof z.ZodNullable) {
    visit((schema as z.ZodNullable<z.ZodType>).unwrap());
  } else if (schema instanceof z.ZodBranded) {
    visit((schema as z.ZodBranded<z.ZodType, string>).unwrap());
  } else if (schema instanceof z.ZodUnion) {
    for (const child of (schema as z.ZodUnion<[z.ZodType, z.ZodType]>)
      .options) {
      visit(child);
    }
  } else if (schema instanceof z.ZodDiscriminatedUnion) {
    const union = schema as z.ZodDiscriminatedUnion<
      string,
      [
        z.ZodDiscriminatedUnionOption<string>,
        ...z.ZodDiscriminatedUnionOption<string>[],
      ]
    >;
    for (const child of union.options) {
      visit(child);
    }
  } else if (schema instanceof z.ZodString) {
    if (
      schema._def.coerce ||
      schema._def.checks.some(
        (check) =>
          check.kind === 'trim' ||
          check.kind === 'toLowerCase' ||
          check.kind === 'toUpperCase' ||
          (check.kind === 'regex' && check.regex.flags.length > 0),
      )
    ) {
      throw unsupported();
    }
  } else if (schema instanceof z.ZodNumber || schema instanceof z.ZodBoolean) {
    if (schema._def.coerce) {
      throw unsupported();
    }
  } else if (schema instanceof z.ZodLiteral) {
    assertJson(schema.value);
  } else if (
    !(schema instanceof z.ZodNull) &&
    !(schema instanceof z.ZodEnum) &&
    !(schema instanceof z.ZodNativeEnum)
  ) {
    // Optional, defaults, effects, recursion and non-JSON containers cannot be
    // represented honestly by this strict required-property subset.
    throw unsupported();
  }
}

function normalise(
  schema: Record<string, unknown>,
  budget: { enumValues: number },
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') {
      if (!isRecord(value)) {
        throw unsupported();
      }
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => {
          if (!isRecord(child)) {
            throw unsupported();
          }
          return [name, normalise(child, budget)];
        }),
      );
    } else if (key === 'items') {
      if (!isRecord(value)) {
        throw unsupported();
      }
      result[key] = normalise(value, budget);
    } else if (key === 'anyOf') {
      if (!Array.isArray(value) || value.length < 1) {
        throw unsupported();
      }
      result[key] = value.map((child: unknown) => {
        if (!isRecord(child)) {
          throw unsupported();
        }
        return normalise(child, budget);
      });
    } else if (key === 'additionalProperties') {
      if (value !== false) {
        throw unsupported();
      }
      result[key] = false;
    } else if (key === 'const') {
      assertJson(value);
      budget.enumValues += 1;
      result.enum = [value];
    } else if (key === 'enum') {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        (value.length > 250 && JSON.stringify(value).length > 15_000)
      ) {
        throw unsupported();
      }
      budget.enumValues += value.length;
      assertJson(value);
      result[key] = value;
    } else if (key === 'format') {
      if (typeof value !== 'string' || !SUPPORTED_FORMATS.has(value)) {
        throw unsupported();
      }
      result[key] = value;
    } else if (VALUE_KEYWORDS.has(key)) {
      assertJson(value);
      result[key] = value;
    } else {
      throw unsupported();
    }
  }
  if (budget.enumValues > 1_000) {
    throw unsupported();
  }
  if (result.type === 'object') {
    if (result.additionalProperties !== false || !isRecord(result.properties)) {
      throw unsupported();
    }
    const names = Object.keys(result.properties);
    const required = result.required ?? [];
    if (
      !Array.isArray(required) ||
      required.length !== names.length ||
      names.some((name) => !required.includes(name))
    ) {
      throw unsupported();
    }
    // OpenAI requires required even for an object without properties.
    result.required = names;
  }
  if (Object.keys(result).length === 0) {
    throw unsupported();
  }
  return result;
}

function assertJson(value: unknown): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value as unknown[]) {
      assertJson(child);
    }
    return;
  }
  throw unsupported();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unsupported(): OpenAiResponsesError {
  return new OpenAiResponsesError('unsupported_request');
}
