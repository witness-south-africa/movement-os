import {
  operatorDisplayText,
  parseSubscriptionOperatorArguments,
  runSubscriptionOperator,
  type SubscriptionOperatorDependencies,
} from '../src/lib/subscription-operator.js';
import type {
  OpenAiSubscriptionSession,
  SubscriptionAccountInfo,
} from '../src/lib/subscription-session.js';
import { OpenAiSubscriptionAuthError } from '../src/lib/subscription-auth-types.js';
import {
  deferred,
  harness,
  initializeSubscriptionFixtures,
  present,
} from './subscription-fixtures.js';

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const CONFIG = ['--directory', '/tmp/operator-private', '--hosting', 'local'];
const account: SubscriptionAccountInfo = {
  key: KEY,
  label: 'Saved account',
  active: true,
  signedIn: true,
  planUsageAuthorized: true,
};
function fixture() {
  const controller = new AbortController();
  const session = {
    listAccounts: jest.fn(() => Promise.resolve([account])),
    selectAccount: jest.fn((_key: string) => Promise.resolve(account)),
    listModels: jest.fn(() =>
      Promise.resolve([
        { slug: 'visible-model', displayName: 'Visible model' },
      ]),
    ),
    signIn: jest.fn(
      (_options: Parameters<OpenAiSubscriptionSession['signIn']>[0]) =>
        Promise.resolve(account),
    ),
    signOut: jest.fn(
      (_options: Parameters<OpenAiSubscriptionSession['signOut']>[0]) =>
        Promise.resolve({ remoteRevocationConfirmed: false }),
    ),
    resolveAccessToken: jest.fn(),
  };
  const output: string[] = [];
  const errors: string[] = [];
  const answers: (string | null)[] = [];
  const deps: SubscriptionOperatorDependencies = {
    createSession: jest.fn(() => session),
    output: (text) => output.push(text),
    error: (text) => errors.push(text),
    interactive: true,
    prepareInteractive: jest.fn(),
    readLine: jest.fn(() => Promise.resolve(answers.shift() ?? null)),
    openAuthorizationUrl: jest.fn(() => Promise.resolve()),
    signal: controller.signal,
  };
  return { session, deps, controller, output, errors, answers };
}

describe('operator command boundaries', () => {
  test.each([[], ['--help'], ['help']].map((args) => ({ args })))(
    'help does not touch session or browser: $args',
    async ({ args }) => {
      const f = fixture();
      expect(await runSubscriptionOperator(args, f.deps)).toBe(0);
      expect(f.output.join('')).toContain('Continue with ChatGPT');
      expect(f.deps.createSession).not.toHaveBeenCalled();
      expect(f.deps.prepareInteractive).not.toHaveBeenCalled();
      expect(f.deps.openAuthorizationUrl).not.toHaveBeenCalled();
    },
  );
  test.each(
    [
      ['bad-private-command', ...CONFIG],
      ['accounts', ...CONFIG, '--unknown=private-token'],
      ['accounts', ...CONFIG, '--directory', '/private-second'],
      ['accounts', '--directory', 'relative', '--hosting', 'local'],
      ['accounts', '--directory', '/tmp/\nprivate', '--hosting', 'local'],
      ['accounts', '--directory', '/tmp/private', '--hosting', 'cloud'],
      ['select', ...CONFIG],
      ['sign-out', ...CONFIG, '--account', 'short'],
      ['models', ...CONFIG, '--account', KEY],
      ['sign-in', ...CONFIG, '--enable-plan-usage'],
      ['accounts', ...CONFIG, '--enable-plan-usage'],
      ['accounts', ...CONFIG, '--help'],
      ['accounts', 'models', ...CONFIG],
    ].map((args) => ({ args })),
  )(
    'invalid arguments fail before any side effect: $args',
    async ({ args }) => {
      const f = fixture();
      expect(await runSubscriptionOperator(args, f.deps)).toBe(2);
      expect(f.deps.createSession).not.toHaveBeenCalled();
      expect(f.deps.prepareInteractive).not.toHaveBeenCalled();
      expect(f.deps.openAuthorizationUrl).not.toHaveBeenCalled();
      expect(f.errors.join('')).toBe(
        'Invalid command or configuration. Interactive manage requires a terminal. Use --help.\n',
      );
    },
  );
  it('requires a TTY only for manage and validates configuration first', async () => {
    const f = fixture();
    expect(
      await runSubscriptionOperator(['manage', ...CONFIG], {
        ...f.deps,
        interactive: false,
      }),
    ).toBe(2);
    expect(f.deps.createSession).not.toHaveBeenCalled();
    expect(
      await runSubscriptionOperator(['accounts', ...CONFIG], {
        ...f.deps,
        interactive: false,
      }),
    ).toBe(0);
    expect(parseSubscriptionOperatorArguments(CONFIG).command).toBe('manage');
  });
  test.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['eof', 0],
  ] as const)(
    'already stopped %s does not construct storage',
    async (reason, code) => {
      const f = fixture();
      f.controller.abort(reason);
      expect(
        await runSubscriptionOperator(['accounts', ...CONFIG], f.deps),
      ).toBe(code);
      expect(f.deps.createSession).not.toHaveBeenCalled();
    },
  );
  it('passes the explicit host and directory to the source factory', async () => {
    const f = fixture();
    expect(await runSubscriptionOperator(['accounts', ...CONFIG], f.deps)).toBe(
      0,
    );
    expect(f.deps.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/tmp/operator-private',
        hosting: 'local',
      }),
    );
    expect(f.output.join('')).toContain(KEY);
    expect(f.session.resolveAccessToken).not.toHaveBeenCalled();
  });
});

describe('operator dispatch and presentation', () => {
  it('targets full registration keys and only requests plan consent explicitly', async () => {
    const f = fixture();
    await runSubscriptionOperator(['sign-in', ...CONFIG], f.deps);
    expect(f.session.signIn).toHaveBeenLastCalledWith({
      openAuthorizationUrl: f.deps.openAuthorizationUrl,
      signal: f.controller.signal,
      enablePlanUsage: false,
    });
    await runSubscriptionOperator(
      ['sign-in', ...CONFIG, '--account', KEY],
      f.deps,
    );
    expect(f.session.signIn).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountKey: KEY, enablePlanUsage: false }),
    );
    await runSubscriptionOperator(
      ['sign-in', ...CONFIG, '--account', KEY, '--enable-plan-usage'],
      f.deps,
    );
    expect(f.session.signIn).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountKey: KEY, enablePlanUsage: true }),
    );
    await runSubscriptionOperator(
      ['select', ...CONFIG, '--account', OTHER],
      f.deps,
    );
    expect(f.session.selectAccount).toHaveBeenCalledWith(OTHER);
  });
  it('does not label catalog results with an earlier active account snapshot', async () => {
    const f = fixture();
    await runSubscriptionOperator(['models', ...CONFIG], f.deps);
    expect(f.session.listAccounts).not.toHaveBeenCalled();
    expect(f.session.listModels).toHaveBeenCalledWith({
      signal: f.controller.signal,
    });
    expect(f.output.join('')).toContain('active account at request time');
    expect(f.output.join('')).not.toContain(account.label);
    expect(f.output.join('')).toContain('visible-model');
  });
  it('reports a saved identity without plan permission honestly', async () => {
    const f = fixture();
    f.session.signIn.mockResolvedValue({
      ...account,
      planUsageAuthorized: false,
    });
    await runSubscriptionOperator(['sign-in', ...CONFIG], f.deps);
    expect(f.output.join('')).toContain('without ChatGPT plan permission');
    expect(f.output.join('')).not.toContain('usage is enabled');
  });
  test.each([true, false])(
    'reports local clearing separately from revocation %s',
    async (confirmed) => {
      const f = fixture();
      f.session.signOut.mockResolvedValue({
        remoteRevocationConfirmed: confirmed,
      });
      await runSubscriptionOperator(
        ['sign-out', ...CONFIG, '--account', OTHER],
        f.deps,
      );
      expect(f.session.signOut).toHaveBeenCalledWith({
        accountKey: OTHER,
        signal: f.controller.signal,
      });
      expect(f.output.join('')).toContain(`Local session cleared for ${OTHER}`);
      expect(f.output.join('')).toContain(
        confirmed
          ? 'Remote revocation confirmed.'
          : 'Remote revocation was not confirmed.',
      );
    },
  );
  it('escapes terminal controls, bidi and line separators and bounds metadata', async () => {
    const f = fixture();
    const hostile = '\x1b[31m\n\r\t\u202e\u200b\u2028\u2029';
    f.session.listAccounts.mockResolvedValue([{ ...account, label: hostile }]);
    f.session.listModels.mockResolvedValue([
      { slug: hostile, displayName: hostile },
    ]);
    await runSubscriptionOperator(['accounts', ...CONFIG], f.deps);
    await runSubscriptionOperator(['models', ...CONFIG], f.deps);
    expect(f.output.join('')).not.toContain(hostile);
    for (const control of [
      '\x1b',
      '\r',
      '\u202e',
      '\u200b',
      '\u2028',
      '\u2029',
    ])
      expect(f.output.join('')).not.toContain(control);
    expect(f.output.join('')).toContain('\\u{1b}');
    expect(operatorDisplayText('x'.repeat(1000))).toBe(`${'x'.repeat(256)}…`);
    expect(operatorDisplayText('\ud800')).toBe('\\u{d800}');
  });
  it('rebuilds known errors and suppresses raw provider messages and throwing accessors', async () => {
    const f = fixture();
    const decorated = new OpenAiSubscriptionAuthError('plan_not_authorized');
    decorated.message = 'private-token-and-path';
    f.session.listModels.mockRejectedValueOnce(decorated);
    expect(await runSubscriptionOperator(['models', ...CONFIG], f.deps)).toBe(
      1,
    );
    expect(f.errors.join('')).toContain('plan_not_authorized');
    Object.defineProperty(decorated, 'code', {
      get: () => {
        throw new Error('private-token');
      },
    });
    f.session.listModels.mockRejectedValueOnce(decorated);
    expect(await runSubscriptionOperator(['models', ...CONFIG], f.deps)).toBe(
      1,
    );
    f.session.listModels.mockRejectedValueOnce(
      new Error('private-token-and-path'),
    );
    expect(await runSubscriptionOperator(['models', ...CONFIG], f.deps)).toBe(
      1,
    );
    expect(f.errors.join('')).toContain('operation_failed');
    expect(f.errors.join('')).not.toContain('private-token');
  });
  test.each(['select', 'sign-out'] as const)(
    'cancellation awaits bounded local %s cleanup',
    async (command) => {
      const f = fixture();
      const entered = deferred();
      const complete = deferred();
      const operation = async () => {
        entered.resolve();
        await complete.promise;
        return { remoteRevocationConfirmed: false };
      };
      if (command === 'select')
        f.session.selectAccount.mockImplementation(async () => {
          await operation();
          return account;
        });
      else f.session.signOut.mockImplementation(operation);
      let settled = false;
      const result = runSubscriptionOperator(
        [command, ...CONFIG, '--account', KEY],
        f.deps,
      ).then((code) => {
        settled = true;
        return code;
      });
      await entered.promise;
      f.controller.abort('SIGTERM');
      await Promise.resolve();
      expect(settled).toBe(false);
      complete.resolve();
      expect(await result).toBe(143);
      if (command === 'sign-out')
        expect(f.output.join('')).toContain('Local session cleared');
    },
  );
});

describe('interactive account menu', () => {
  it('refreshes snapshots and captures the chosen immutable key', async () => {
    const f = fixture();
    f.session.listAccounts
      .mockResolvedValueOnce([account])
      .mockResolvedValueOnce([{ ...account, key: OTHER }])
      .mockResolvedValue([account]);
    f.answers.push('4', '1', '5', '0');
    expect(await runSubscriptionOperator(['manage', ...CONFIG], f.deps)).toBe(
      0,
    );
    expect(f.session.selectAccount).toHaveBeenCalledWith(OTHER);
    expect(f.session.listModels).toHaveBeenCalledTimes(1);
    expect(f.deps.prepareInteractive).toHaveBeenCalledTimes(1);
  });
  it('requires an explicit yes for grant changes and session clearing', async () => {
    const f = fixture();
    f.answers.push(
      '3',
      '1',
      'no',
      '6',
      '1',
      '',
      '3',
      '1',
      'yes',
      '6',
      '1',
      'y',
      '0',
    );
    expect(await runSubscriptionOperator(['manage', ...CONFIG], f.deps)).toBe(
      0,
    );
    expect(f.session.signIn).toHaveBeenCalledTimes(1);
    expect(f.session.signIn).toHaveBeenCalledWith(
      expect.objectContaining({ accountKey: KEY, enablePlanUsage: true }),
    );
    expect(f.session.signOut).toHaveBeenCalledTimes(1);
    expect(f.session.signOut).toHaveBeenCalledWith({
      accountKey: KEY,
      signal: f.controller.signal,
    });
  });
  it('invalid actions and invalid account numbers perform no account action', async () => {
    const f = fixture();
    f.answers.push('private-input', '4', '9999', '4', '0', '0');
    expect(await runSubscriptionOperator(['manage', ...CONFIG], f.deps)).toBe(
      0,
    );
    expect(f.session.selectAccount).not.toHaveBeenCalled();
    expect(f.session.signIn).not.toHaveBeenCalled();
    expect(f.output.join('')).not.toContain('private-input');
  });
  it('can recover from a sanitized action failure and exit on EOF', async () => {
    const f = fixture();
    f.answers.push('5', null);
    f.session.listModels.mockRejectedValue(new Error('private-provider-body'));
    expect(await runSubscriptionOperator(['manage', ...CONFIG], f.deps)).toBe(
      0,
    );
    expect(f.errors.join('')).toBe(
      'Account action failed (operation_failed).\n',
    );
  });
  it('EOF during account selection or consent performs no action', async () => {
    for (const answers of [
      ['2', null],
      ['3', '1', null],
      ['6', '1', null],
    ]) {
      const f = fixture();
      f.answers.push(...answers);
      expect(await runSubscriptionOperator(['manage', ...CONFIG], f.deps)).toBe(
        0,
      );
      expect(f.session.signIn).not.toHaveBeenCalled();
      expect(f.session.signOut).not.toHaveBeenCalled();
    }
  });
});

describe('offline source session integration', () => {
  beforeAll(initializeSubscriptionFixtures);
  it('wires verified sign-in, catalog, selected registration and sign-out without credential output', async () => {
    const source = harness();
    const f = fixture();
    const deps = {
      ...f.deps,
      createSession: () => source.session,
      openAuthorizationUrl: source.open,
    };
    expect(await runSubscriptionOperator(['sign-in', ...CONFIG], deps)).toBe(0);
    const saved = present((await source.session.listAccounts())[0]);
    expect(saved.signedIn).toBe(true);
    expect(
      await runSubscriptionOperator(
        ['select', ...CONFIG, '--account', saved.key],
        deps,
      ),
    ).toBe(0);
    expect(await runSubscriptionOperator(['models', ...CONFIG], deps)).toBe(0);
    expect(f.output.join('')).toContain('model-second');
    expect(f.output.join('')).not.toContain('internal-hidden');
    expect(
      await runSubscriptionOperator(
        ['sign-out', ...CONFIG, '--account', saved.key],
        deps,
      ),
    ).toBe(0);
    expect(present((await source.session.listAccounts())[0]).signedIn).toBe(
      false,
    );
    const rendered = [...f.output, ...f.errors].join('');
    expect(rendered).not.toMatch(
      /access-1|refresh-1|id_token|auth\.openai\.com|single-use-code/u,
    );
    expect(
      source.requests.some((request) => request.url.endsWith('/responses')),
    ).toBe(false);
    expect(f.errors).toEqual([]);
  });
});
