import { z } from 'zod';
import type { AnthropicClient } from './anthropic-client.js';
import { zodToAnthropicJsonSchema } from './json-schema.js';
import { createAnthropicProvider } from './provider.js';

describe('zodToAnthropicJsonSchema', () => {
  it('keeps closed object properties, required membership and optional properties', () => {
    const schema = z
      .object({ required: z.string(), optional: z.boolean().optional() })
      .strict();
    expect(zodToAnthropicJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        required: { type: 'string' },
        optional: { type: 'boolean' },
      },
      required: ['required'],
      additionalProperties: false,
    });
  });

  it('moves unsupported numeric/string/array constraints into descriptions', () => {
    const schema = z
      .object({
        text: z
          .string()
          .min(10)
          .max(600)
          .regex(/^[A-Z]+$/)
          .describe('Original guidance.'),
        amount: z.number().int().gt(1).max(8).multipleOf(2),
        rows: z
          .array(z.object({ ok: z.boolean() }).strict())
          .min(2)
          .max(7),
      })
      .strict();
    const native = zodToAnthropicJsonSchema(schema);
    expect(native).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['text', 'amount', 'rows'],
      properties: {
        text: {
          type: 'string',
          description:
            'Original guidance.\nLocally enforced constraints: {"minLength":10,"maxLength":600,"pattern":"^[A-Z]+$"}',
        },
        amount: {
          type: 'integer',
          description:
            'Locally enforced constraints: {"exclusiveMinimum":1,"maximum":8,"multipleOf":2}',
        },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
          description:
            'Locally enforced constraints: {"minItems":2,"maxItems":7}',
        },
      },
    });
  });

  it.each([0, 1])(
    'retains supported minItems %p while describing maximum size',
    (minItems) => {
      expect(
        zodToAnthropicJsonSchema(z.array(z.boolean()).min(minItems).max(5)),
      ).toEqual({
        type: 'array',
        items: { type: 'boolean' },
        minItems,
        description: 'Locally enforced constraints: {"maxItems":5}',
      });
    },
  );

  it('supports nullable primitive types and scalar enums/literals', () => {
    enum Status {
      First = 'first',
      Second = 'second',
    }
    const native = zodToAnthropicJsonSchema(
      z
        .object({
          nullable: z.string().nullable(),
          status: z.nativeEnum(Status),
          kind: z.literal('intake'),
          null: z.null(),
          flag: z.literal(true),
        })
        .strict(),
    );
    expect(native).toMatchObject({
      properties: {
        nullable: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['first', 'second'] },
        kind: { type: 'string', const: 'intake' },
        null: { type: 'null' },
        flag: { type: 'boolean', const: true },
      },
      required: ['nullable', 'status', 'kind', 'null', 'flag'],
      additionalProperties: false,
    });
  });

  it('inlines branded IDs and closed discriminated union source references', () => {
    const id = z
      .string()
      .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      .brand<'Id'>();
    const source = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('intake'), id }).strict(),
      z.object({ kind: z.literal('artefact'), id }).strict(),
    ]);
    const native = zodToAnthropicJsonSchema(z.object({ id, source }).strict());
    expect(native).toMatchObject({
      properties: {
        id: { type: 'string', description: expect.stringContaining('pattern') },
        source: {
          anyOf: [
            {
              properties: { kind: { const: 'intake' }, id: { type: 'string' } },
              required: ['kind', 'id'],
              additionalProperties: false,
            },
            {
              properties: {
                kind: { const: 'artefact' },
                id: { type: 'string' },
              },
              required: ['kind', 'id'],
              additionalProperties: false,
            },
          ],
        },
      },
    });
    expect(Object.hasOwn(native, '$schema')).toBe(false);
    expect(JSON.stringify(native)).not.toContain('"$ref"');
  });

  it('permits reused schemas across independent branches without treating reuse as recursion', () => {
    const item = z.object({ text: z.string() }).strict();
    const native = zodToAnthropicJsonSchema(
      z.object({ first: item, second: item }).strict(),
    );
    expect(native).toMatchObject({
      properties: {
        first: { type: 'object', additionalProperties: false },
        second: { type: 'object', additionalProperties: false },
      },
    });
  });

  it('supports nested basic unions without references or type erasure', () => {
    expect(
      zodToAnthropicJsonSchema(
        z.object({ choice: z.union([z.string(), z.number()]) }).strict(),
      ),
    ).toMatchObject({
      properties: { choice: { type: ['string', 'number'] } },
    });
  });

  it('keeps supported string formats and describes unsupported formats', () => {
    const native = zodToAnthropicJsonSchema(
      z
        .object({
          email: z.string().email(),
          time: z.string().datetime(),
          encoded: z.string().base64(),
        })
        .strict(),
    );
    expect(native).toMatchObject({
      properties: {
        email: { type: 'string', format: 'email' },
        time: { type: 'string', format: 'date-time' },
        encoded: {
          type: 'string',
          description: expect.stringContaining('base64'),
        },
      },
    });
  });

  it('does not change the caller schema while normalizing its wire representation', () => {
    const schema = z.object({ text: z.string().min(3).max(5) }).strict();
    zodToAnthropicJsonSchema(schema);
    expect(schema.safeParse({ text: 'a' }).success).toBe(false);
    expect(schema.safeParse({ text: 'sixsix' }).success).toBe(false);
    expect(schema.safeParse({ text: 'okay' }).success).toBe(true);
  });

  const unsupported: ReadonlyArray<readonly [string, z.ZodType]> = [
    ['open record', z.record(z.string())],
    ['passthrough object', z.object({ ok: z.boolean() }).passthrough()],
    ['object catchall', z.object({ ok: z.boolean() }).catchall(z.string())],
    ['tuple', z.tuple([z.string(), z.number()])],
    ['date', z.date()],
    ['bigint', z.bigint()],
    ['undefined', z.undefined()],
    ['unknown', z.unknown()],
    ['any', z.any()],
    ['never', z.never()],
    ['map', z.map(z.string(), z.string())],
    ['set', z.set(z.string())],
    ['function', z.function()],
    ['symbol', z.symbol()],
    ['promise', z.promise(z.string())],
    [
      'recursive/lazy',
      z.lazy(() => z.object({ recursive: z.lazy(() => z.string()) })),
    ],
    [
      'intersection',
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
    ],
    ['transform', z.string().transform((value) => value.length)],
    ['refinement', z.string().refine((value) => value.length > 1)],
    ['default', z.string().default('default')],
    ['catch', z.string().catch('fallback')],
    ['readonly', z.string().readonly()],
    ['pipeline', z.string().pipe(z.string())],
    ['coerced string', z.coerce.string()],
    ['coerced number', z.coerce.number()],
    ['coerced boolean', z.coerce.boolean()],
    ['trim', z.string().trim()],
    ['lowercase', z.string().toLowerCase()],
    ['uppercase', z.string().toUpperCase()],
    ['optional array element', z.array(z.string().optional())],
    ['undefined union branch', z.union([z.string(), z.undefined()])],
  ];

  it.each(unsupported)(
    'rejects unsupported %s shapes before any transport call',
    async (_name, child) => {
      let calls = 0;
      const client: AnthropicClient = {
        messages: {
          create: () => {
            calls += 1;
            return Promise.reject(new Error('dispatch must not occur'));
          },
        },
      };
      const schema = z.object({ child }).strict();
      expect(() => zodToAnthropicJsonSchema(schema)).toThrow(
        'anthropic adapter: unsupported output schema shape',
      );
      await expect(
        createAnthropicProvider({ client, model: 'chosen' }).complete({
          schema,
          messages: [{ role: 'user', content: 'Return a record.' }],
          taskKind: 'analysis',
        }),
      ).rejects.toThrow('anthropic adapter: unsupported output schema shape');
      expect(calls).toBe(0);
    },
  );

  it('rejects top-level optional output that can produce non-JSON undefined', () => {
    expect(() => zodToAnthropicJsonSchema(z.string().optional())).toThrow(
      /unsupported output schema shape/,
    );
  });
});
