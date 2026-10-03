import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);
const DESCRIBED_CONSTRAINTS: ReadonlySet<string> = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'contentEncoding',
  'contentMediaType',
]);

/**
 * Inline a deliberately bounded JSON-shaped Zod subset. Unsupported value
 * constraints become instructions; the original schema remains authoritative
 * during local validation. Unsupported shapes fail before transport dispatch.
 */
export function zodToAnthropicJsonSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  inspectZodSchema(schema, new Set(), false);
  const generated: unknown = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });
  if (!isRecord(generated)) {
    throw unsupportedSchema();
  }
  const { $schema: _schema, ...body } = generated;
  return normaliseSchema(body);
}

function inspectZodSchema(
  schema: z.ZodType,
  ancestors: ReadonlySet<z.ZodType>,
  optionalProperty: boolean,
): void {
  if (ancestors.has(schema)) {
    throw unsupportedSchema();
  }
  const next = new Set(ancestors).add(schema);
  if (schema instanceof z.ZodObject) {
    const object = schema as z.ZodObject<Record<string, z.ZodType>>;
    if (
      object._def.unknownKeys === 'passthrough' ||
      !(object._def.catchall instanceof z.ZodNever)
    ) {
      throw unsupportedSchema();
    }
    for (const child of Object.values(object.shape)) {
      inspectZodSchema(child, next, true);
    }
  } else if (schema instanceof z.ZodArray) {
    inspectZodSchema((schema as z.ZodArray<z.ZodType>).element, next, false);
  } else if (schema instanceof z.ZodOptional) {
    if (!optionalProperty) {
      throw unsupportedSchema();
    }
    inspectZodSchema(
      (schema as z.ZodOptional<z.ZodType>).unwrap(),
      next,
      false,
    );
  } else if (schema instanceof z.ZodNullable) {
    inspectZodSchema(
      (schema as z.ZodNullable<z.ZodType>).unwrap(),
      next,
      optionalProperty,
    );
  } else if (schema instanceof z.ZodBranded) {
    inspectZodSchema(
      (schema as z.ZodBranded<z.ZodType, string>).unwrap(),
      next,
      optionalProperty,
    );
  } else if (schema instanceof z.ZodUnion) {
    const union = schema as z.ZodUnion<[z.ZodType, z.ZodType, ...z.ZodType[]]>;
    for (const child of union.options) {
      inspectZodSchema(child, next, false);
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
      inspectZodSchema(child, next, false);
    }
  } else if (schema instanceof z.ZodString) {
    if (
      schema._def.coerce ||
      schema._def.checks.some(
        (check) =>
          check.kind === 'trim' ||
          check.kind === 'toLowerCase' ||
          check.kind === 'toUpperCase',
      )
    ) {
      throw unsupportedSchema();
    }
  } else if (schema instanceof z.ZodNumber) {
    if (schema._def.coerce) {
      throw unsupportedSchema();
    }
  } else if (schema instanceof z.ZodBoolean) {
    if (schema._def.coerce) {
      throw unsupportedSchema();
    }
  } else if (
    !(schema instanceof z.ZodNull) &&
    !(schema instanceof z.ZodLiteral) &&
    !(schema instanceof z.ZodEnum) &&
    !(schema instanceof z.ZodNativeEnum)
  ) {
    // Includes lazy/recursive, effects/transforms, catch/default, records,
    // tuples, intersections, unknown/any, non-JSON values and containers.
    throw unsupportedSchema();
  }
}

function normaliseSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const constraints: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      DESCRIBED_CONSTRAINTS.has(key) ||
      (key === 'minItems' && value !== 0 && value !== 1)
    ) {
      constraints[key] = value;
    } else if (key === 'format') {
      if (typeof value !== 'string') {
        throw unsupportedSchema();
      }
      if (SUPPORTED_FORMATS.has(value)) {
        result[key] = value;
      } else {
        constraints[key] = value;
      }
    } else if (key === 'properties') {
      if (!isRecord(value)) {
        throw unsupportedSchema();
      }
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => {
          if (!isRecord(child)) {
            throw unsupportedSchema();
          }
          return [name, normaliseSchema(child)];
        }),
      );
    } else if (key === 'items') {
      if (!isRecord(value)) {
        throw unsupportedSchema();
      }
      result[key] = normaliseSchema(value);
    } else if (key === 'anyOf' || key === 'allOf') {
      if (!Array.isArray(value) || value.length === 0) {
        throw unsupportedSchema();
      }
      result[key] = value.map((child: unknown) => {
        if (!isRecord(child)) {
          throw unsupportedSchema();
        }
        return normaliseSchema(child);
      });
    } else if (key === 'additionalProperties') {
      if (value !== false) {
        throw unsupportedSchema();
      }
      result[key] = false;
    } else if (
      key === 'type' ||
      key === 'enum' ||
      key === 'const' ||
      key === 'required' ||
      key === 'description' ||
      key === 'minItems'
    ) {
      assertJsonValue(value);
      result[key] = value;
    } else {
      throw unsupportedSchema();
    }
  }
  if (schema.type === 'object' && result.additionalProperties !== false) {
    throw unsupportedSchema();
  }
  if (Object.keys(constraints).length > 0) {
    for (const value of Object.values(constraints)) {
      assertJsonValue(value);
    }
    const original =
      typeof result.description === 'string' ? `${result.description}\n` : '';
    result.description = `${original}Locally enforced constraints: ${JSON.stringify(constraints)}`;
  }
  if (Object.keys(result).length === 0) {
    throw unsupportedSchema();
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      assertJsonValue(item);
    }
    return;
  }
  throw unsupportedSchema();
}

function unsupportedSchema(): Error {
  return new Error('anthropic adapter: unsupported output schema shape');
}
