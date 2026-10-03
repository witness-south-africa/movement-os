import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createFakeProvider,
  createProviderRouter,
  ProviderRoutingConfigSchema,
  type AgentTaskKind,
  type LlmProviderId,
  type ProviderRegistry,
} from '../index.js';

function routing(
  analysis: LlmProviderId = 'xai',
  challenge: LlmProviderId = 'openai',
) {
  return {
    version: 1,
    lanes: { 'sensitive-intake': null, analysis, challenge },
  };
}

function adapters() {
  const xai = createFakeProvider({
    id: 'xai',
    produce: (schema) => schema.parse({ ok: true }),
  });
  const openai = createFakeProvider({
    id: 'openai',
    produce: (schema) => schema.parse({ ok: true }),
  });
  const analysisCalls = jest.spyOn(xai, 'complete');
  const challengeCalls = jest.spyOn(openai, 'complete');
  return { providers: { xai, openai }, analysisCalls, challengeCalls };
}

describe('provider routing', () => {
  it('validates the checked-in secret-free example and selects real adapters without calling them', () => {
    const example: unknown = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../config/provider-routing.example.json'),
        'utf8',
      ),
    );
    const { providers, analysisCalls, challengeCalls } = adapters();
    const router = createProviderRouter({ config: example, providers });
    expect(router.config).toEqual(routing());
    expect(router.resolve('analysis')).toBe(providers.xai);
    expect(router.resolve('challenge')).toBe(providers.openai);
    expect(analysisCalls).not.toHaveBeenCalled();
    expect(challengeCalls).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { ...routing(), version: 2 },
    { ...routing(), apiKey: 'not-a-routing-field' },
    { version: 1, lanes: { analysis: 'xai', challenge: 'openai' } },
    { version: 1, lanes: { 'sensitive-intake': null, analysis: 'xai' } },
    { ...routing(), lanes: { ...routing().lanes, analysis: 'grok' } },
    { ...routing(), lanes: { ...routing().lanes, challenge: 'OpenAI' } },
    { ...routing(), lanes: { ...routing().lanes, drafting: 'xai' } },
    ...(['local', 'openai', 'xai'] as const).map((id) => ({
      ...routing(),
      lanes: { ...routing().lanes, 'sensitive-intake': id },
    })),
    routing('xai', 'xai'),
  ])(
    'refuses invalid or unsafe routing config before either call: %p',
    (config) => {
      const { providers, analysisCalls, challengeCalls } = adapters();
      expect(() => createProviderRouter({ config, providers })).toThrow();
      expect(analysisCalls).not.toHaveBeenCalled();
      expect(challengeCalls).not.toHaveBeenCalled();
    },
  );

  it('allows explicit reverse pairing without substituting providers', () => {
    const { providers } = adapters();
    const router = createProviderRouter({
      config: routing('openai', 'xai'),
      providers,
    });
    expect(router.resolve('analysis')).toBe(providers.openai);
    expect(router.resolve('challenge')).toBe(providers.xai);
  });

  it('refuses the disabled sensitive lane without dispatch or fallback', () => {
    const { providers, analysisCalls, challengeCalls } = adapters();
    const router = createProviderRouter({ config: routing(), providers });
    expect(() => router.resolve('sensitive-intake')).toThrow(
      'sensitive-intake routing is disabled',
    );
    expect(analysisCalls).not.toHaveBeenCalled();
    expect(challengeCalls).not.toHaveBeenCalled();
  });

  it.each(['drafting', 'Analysis', ''])(
    'refuses unknown task %p at the runtime boundary',
    (task) => {
      const { providers, analysisCalls, challengeCalls } = adapters();
      const router = createProviderRouter({ config: routing(), providers });
      expect(() => router.resolve(task as AgentTaskKind)).toThrow();
      expect(analysisCalls).not.toHaveBeenCalled();
      expect(challengeCalls).not.toHaveBeenCalled();
    },
  );

  it.each(['xai', 'openai'] as const)(
    'requires own registry entry for %s before any call',
    (id) => {
      const { providers, analysisCalls, challengeCalls } = adapters();
      const registry: Partial<typeof providers> = { ...providers };
      Reflect.deleteProperty(registry, id);
      expect(() =>
        createProviderRouter({ config: routing(), providers: registry }),
      ).toThrow(`configured provider is unavailable: ${id}`);
      expect(analysisCalls).not.toHaveBeenCalled();
      expect(challengeCalls).not.toHaveBeenCalled();
    },
  );

  it.each(['anthropic', 'local'] as const)(
    'does not treat reserved %s ID as an installed adapter',
    (id) => {
      const { providers, analysisCalls, challengeCalls } = adapters();
      expect(ProviderRoutingConfigSchema.safeParse(routing(id)).success).toBe(
        true,
      );
      expect(() =>
        createProviderRouter({ config: routing(id), providers }),
      ).toThrow(`configured provider is unavailable: ${id}`);
      expect(analysisCalls).not.toHaveBeenCalled();
      expect(challengeCalls).not.toHaveBeenCalled();
    },
  );

  it('refuses inherited registry entries', () => {
    const { providers, analysisCalls, challengeCalls } = adapters();
    const inherited = Object.create(providers) as ProviderRegistry;
    expect(() =>
      createProviderRouter({ config: routing(), providers: inherited }),
    ).toThrow('configured provider is unavailable: xai');
    expect(analysisCalls).not.toHaveBeenCalled();
    expect(challengeCalls).not.toHaveBeenCalled();
  });

  it.each([null, undefined])(
    'refuses malformed own registry value %p',
    (value) => {
      const { providers, analysisCalls, challengeCalls } = adapters();
      const malformed = {
        ...providers,
        xai: value,
      } as unknown as ProviderRegistry;
      expect(() =>
        createProviderRouter({ config: routing(), providers: malformed }),
      ).toThrow('configured provider is unavailable: xai');
      expect(analysisCalls).not.toHaveBeenCalled();
      expect(challengeCalls).not.toHaveBeenCalled();
    },
  );

  it.each(['xai', 'openai'] as const)(
    'rejects configured %s identity mismatch before calls',
    (id) => {
      const { providers, analysisCalls, challengeCalls } = adapters();
      Reflect.set(providers[id], 'id', 'local');
      expect(() =>
        createProviderRouter({ config: routing(), providers }),
      ).toThrow(`configured provider identity mismatch: ${id}`);
      expect(analysisCalls).not.toHaveBeenCalled();
      expect(challengeCalls).not.toHaveBeenCalled();
    },
  );

  it.each(['xai', 'openai'] as const)(
    'rejects configured %s without callable complete',
    (id) => {
      const { providers, analysisCalls, challengeCalls } = adapters();
      Reflect.set(providers[id], 'complete', null);
      expect(() =>
        createProviderRouter({ config: routing(), providers }),
      ).toThrow(`configured provider cannot complete calls: ${id}`);
      expect(analysisCalls).not.toHaveBeenCalled();
      expect(challengeCalls).not.toHaveBeenCalled();
    },
  );

  it('keeps the parsed policy and selected instances after caller mutation', () => {
    const { providers } = adapters();
    const config = routing();
    const original = { ...providers };
    const router = createProviderRouter({ config, providers });
    config.version = 2;
    config.lanes.analysis = 'openai';
    config.lanes.challenge = 'xai';
    providers.xai = createFakeProvider({
      id: 'xai',
      produce: () => 'replacement',
    });
    providers.openai = createFakeProvider({
      id: 'openai',
      produce: () => 'replacement',
    });
    expect(Reflect.set(router.config, 'version', 2)).toBe(false);
    expect(Reflect.set(router.config.lanes, 'analysis', 'openai')).toBe(false);
    expect(router.config).toEqual(routing());
    expect(router.resolve('analysis')).toBe(original.xai);
    expect(router.resolve('challenge')).toBe(original.openai);
  });

  it.each(['xai', 'openai'] as const)(
    'refuses %s identity drift when resolving again',
    (id) => {
      const { providers, analysisCalls, challengeCalls } = adapters();
      const router = createProviderRouter({ config: routing(), providers });
      Reflect.set(providers[id], 'id', 'local');
      const task = id === 'xai' ? 'analysis' : 'challenge';
      expect(() => router.resolve(task)).toThrow(
        `configured provider identity mismatch: ${id}`,
      );
      expect(analysisCalls).not.toHaveBeenCalled();
      expect(challengeCalls).not.toHaveBeenCalled();
    },
  );

  it('refuses noncallable adapter drift without falling back to another instance', () => {
    const { providers, analysisCalls, challengeCalls } = adapters();
    const router = createProviderRouter({ config: routing(), providers });
    Reflect.set(providers.openai, 'complete', undefined);
    expect(() => router.resolve('challenge')).toThrow(
      'configured provider cannot complete calls: openai',
    );
    expect(analysisCalls).not.toHaveBeenCalled();
    expect(challengeCalls).not.toHaveBeenCalled();
  });
});
