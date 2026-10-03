import { z } from 'zod';
import { zodToOpenAiResponsesJsonSchema } from './responses-json-schema.js';

describe('Responses strict JSON schema subset', () => {
  it('inlines required closed objects, arrays, primitives and nullable fields', () => {
    const schema = z.object({
      record: z.object({
        text: z.string().min(3).max(20),
        count: z.number().int().min(0),
      }),
      tags: z
        .array(z.enum(['a', 'b']))
        .min(1)
        .max(4),
      ok: z.boolean(),
      absent: z.string().nullable(),
      exact: z.literal('fixed'),
    });
    const converted = zodToOpenAiResponsesJsonSchema(schema);
    expect(converted).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['record', 'tags', 'ok', 'absent', 'exact'],
      properties: {
        record: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'count'],
          properties: {
            text: { type: 'string', minLength: 3, maxLength: 20 },
            count: { type: 'integer', minimum: 0 },
          },
        },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string', enum: ['a', 'b'] },
        },
        exact: { type: 'string', enum: ['fixed'] },
      },
    });
    expect(JSON.stringify(converted)).not.toMatch(/\$schema|\$ref|definitions/);
  });

  it('handles nested object unions and branded JSON values without making properties optional', () => {
    const converted = zodToOpenAiResponsesJsonSchema(
      z.object({
        id: z
          .string()
          .regex(/^[A-Z]+$/)
          .brand<'ID'>(),
        choice: z.union([
          z.object({ kind: z.literal('a'), value: z.number() }),
          z.object({ kind: z.literal('b'), value: z.string() }),
        ]),
      }),
    );
    expect(converted).toMatchObject({
      required: ['id', 'choice'],
      properties: {
        id: { type: 'string', pattern: '^[A-Z]+$' },
        choice: {
          anyOf: [
            { additionalProperties: false, required: ['kind', 'value'] },
            { additionalProperties: false, required: ['kind', 'value'] },
          ],
        },
      },
    });
  });

  it('represents an empty object with an explicit empty required array', () => {
    expect(zodToOpenAiResponsesJsonSchema(z.object({}))).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
      required: [],
    });
  });

  const recursive: z.ZodType = z.lazy(() => z.object({ child: recursive }));
  it.each([
    ['primitive root', z.string()],
    ['array root', z.array(z.string())],
    [
      'union root',
      z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
    ],
    ['optional', z.object({ value: z.string().optional() })],
    [
      'nullable optional',
      z.object({ value: z.string().optional().nullable() }),
    ],
    ['default', z.object({ value: z.string().default('x') })],
    ['catch', z.object({ value: z.string().catch('x') })],
    [
      'transform',
      z.object({ value: z.string().transform((value) => value.length) }),
    ],
    [
      'refinement effects',
      z.object({ value: z.string().refine((value) => value.length > 1) }),
    ],
    ['preprocess', z.object({ value: z.preprocess(String, z.string()) })],
    ['string coercion', z.object({ value: z.coerce.string() })],
    ['number coercion', z.object({ value: z.coerce.number() })],
    ['boolean coercion', z.object({ value: z.coerce.boolean() })],
    ['trim', z.object({ value: z.string().trim() })],
    ['case conversion', z.object({ value: z.string().toLowerCase() })],
    ['unsupported URI format', z.object({ value: z.string().url() })],
    ['regex flags', z.object({ value: z.string().regex(/value/i) })],
    ['open object', z.object({ value: z.string() }).passthrough()],
    ['catchall object', z.object({ value: z.string() }).catchall(z.number())],
    ['record', z.object({ value: z.record(z.string()) })],
    ['tuple', z.object({ value: z.tuple([z.string()]) })],
    [
      'intersection',
      z.object({
        value: z.intersection(
          z.object({ a: z.string() }),
          z.object({ b: z.string() }),
        ),
      }),
    ],
    ['any', z.object({ value: z.any() })],
    ['unknown', z.object({ value: z.unknown() })],
    ['date', z.object({ value: z.date() })],
    ['bigint', z.object({ value: z.bigint() })],
    ['non JSON literal', z.object({ value: z.literal(undefined) })],
    ['recursive', z.object({ value: recursive })],
  ])('rejects %s without a misleading conversion', (_label, schema) => {
    expect(() => zodToOpenAiResponsesJsonSchema(schema as z.ZodType)).toThrow(
      'openai responses adapter: unsupported_request',
    );
  });

  it('bounds nested depth before conversion', () => {
    let nested: z.ZodType = z.string();
    for (let index = 0; index < 20; index += 1) {
      nested = z.object({ child: nested });
    }
    expect(() => zodToOpenAiResponsesJsonSchema(nested)).toThrow(
      'unsupported_request',
    );
  });

  it('bounds schema size even when a description is oversized', () => {
    expect(() =>
      zodToOpenAiResponsesJsonSchema(
        z.object({
          value: z.string().describe('x'.repeat(70_000)),
        }),
      ),
    ).toThrow('unsupported_request');
  });

  it('bounds total enum values before dispatch', () => {
    const values: [string, ...string[]] = [
      'first',
      ...Array.from({ length: 1_000 }, (_, index) => `v${String(index)}`),
    ];
    expect(() =>
      zodToOpenAiResponsesJsonSchema(z.object({ value: z.enum(values) })),
    ).toThrow('unsupported_request');
  });
});
