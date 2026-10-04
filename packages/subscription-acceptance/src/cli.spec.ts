import { runCli } from './cli.js';
import { runAcceptance } from './index.js';
import {
  createOperatorBrowserOpener,
  createOperatorPrompt,
  createOpenAiSubscriptionFileStore,
} from '@wsa/agent-openai/subscription-auth';
import type { AcceptanceDependencies, BuildProvenance } from './index.js';

jest.mock('./index.js', () => ({ runAcceptance: jest.fn() }));
jest.mock('@wsa/agent-openai/subscription-auth', () => ({
  createOpenAiSubscriptionFileStore: jest.fn(() => ({})),
  createOperatorBrowserOpener: jest.fn(() =>
    jest.fn(() => Promise.resolve(undefined)),
  ),
  createOperatorPrompt: jest.fn(() => ({
    readLine: jest.fn(() => Promise.resolve('1')),
    close: jest.fn(),
  })),
}));
const provenance: BuildProvenance = {
  sourceRevision: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  lockSha256: 'c'.repeat(64),
  artifactSha256: 'd'.repeat(64),
  artifactCount: 1,
  nodeVersion: 'v22.13.0',
  typescriptVersion: '5.6.3',
};
const config = {
  directory: '/explicit-fresh-directory',
  hosting: 'local' as const,
  acceptUncappedOutput: true as const,
};
const models = [
  { slug: 'visible-model', displayName: 'PRIVATE-ACCOUNT-LABEL' },
];
const acceptance = jest.mocked(runAcceptance);
let write: jest.SpyInstance;
const initialTty = process.stdin.isTTY;
beforeEach(() => {
  jest.clearAllMocks();
  write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: true,
  });
});
afterEach(() => {
  write.mockRestore();
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: initialTty,
  });
  process.exitCode = undefined;
  process.emit('beforeExit', 0);
});
const inRunner = (action: (deps: AcceptanceDependencies) => Promise<void>) => {
  acceptance.mockImplementation(async (_config, _provenance, deps) => {
    await action(deps);
    return { analysisAccepted: true } as Awaited<
      ReturnType<typeof runAcceptance>
    >;
  });
};

describe('operator acceptance entry point', () => {
  it('uses explicit fresh directory, opens owned browser, prompts only bounded model choices, and owns cleanup', async () => {
    const signals = process.listenerCount('SIGINT');
    inRunner(async (deps) => {
      await deps.openAuthorizationUrl(
        'https://auth.openai.com/api/accounts/authorize?PRIVATE-STATE',
      );
      expect(await deps.chooseModel(models)).toBe('visible-model');
    });
    expect(await runCli(config, provenance)).toEqual({
      analysisAccepted: true,
    });
    expect(createOpenAiSubscriptionFileStore).toHaveBeenCalledWith({
      directory: config.directory,
    });
    expect(createOperatorBrowserOpener).toHaveBeenCalled();
    expect(
      jest.mocked(createOperatorPrompt).mock.results[0]?.value.close,
    ).toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(signals);
    expect(write.mock.calls.flat().join('')).not.toMatch(
      /PRIVATE-|explicit-fresh-directory|authorize\?/,
    );
  });
  it.each(['', '0', '10000', 'private-text', null, '999'])(
    'rejects unusable choice %s',
    async (answer) => {
      jest.mocked(createOperatorPrompt).mockReturnValue({
        readLine: jest.fn(() => Promise.resolve(answer)),
        close: jest.fn(),
      });
      inRunner(async (deps) => {
        expect(await deps.chooseModel(models)).toBeUndefined();
      });
      await runCli(config, provenance);
    },
  );
  it('skips prompts without terminal or visible models', async () => {
    inRunner(async (deps) => {
      expect(await deps.chooseModel([])).toBeUndefined();
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: false,
      });
      expect(await deps.chooseModel(models)).toBeUndefined();
    });
    await runCli(config, provenance);
    expect(createOperatorPrompt).not.toHaveBeenCalled();
  });
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'aborts and closes pending terminal on %s',
    async (signal) => {
      const events = jest.spyOn(process, 'on');
      inRunner(async (deps) => {
        await deps.chooseModel(models);
        const handler = events.mock.calls.find(
          ([event]) => event === signal,
        )?.[1];
        handler?.();
        expect(deps.signal.aborted).toBe(true);
      });
      await runCli(config, provenance);
      events.mockRestore();
      expect(
        jest.mocked(createOperatorPrompt).mock.results[0]?.value.close,
      ).toHaveBeenCalled();
    },
  );
  it('cancels on terminal EOF or output error without exposing diagnostics', async () => {
    inRunner(async (deps) => {
      await deps.chooseModel(models);
      const eof = jest.mocked(createOperatorPrompt).mock.calls[0]?.[2];
      eof?.('eof');
      process.stderr.emit('error', new Error('PRIVATE-OUTPUT-ERROR'));
      expect(deps.signal.aborted).toBe(true);
      expect(process.exitCode).toBe(1);
    });
    await runCli(config, provenance);
    expect(write.mock.calls.flat().join('')).not.toContain(
      'PRIVATE-OUTPUT-ERROR',
    );
  });
  it('releases signal handlers if run fails before a prompt', async () => {
    acceptance.mockRejectedValue(new Error('PRIVATE-INJECTED-FAILURE'));
    const count = process.listenerCount('SIGTERM');
    await expect(runCli(config, provenance)).rejects.toThrow(
      'PRIVATE-INJECTED-FAILURE',
    );
    expect(process.listenerCount('SIGTERM')).toBe(count);
  });
});
