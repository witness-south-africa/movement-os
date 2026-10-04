import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  createOperatorBrowserOpener,
  createOperatorManualBrowserOpener,
} from '../src/lib/operator-browser.js';
import { createOperatorPrompt } from '../src/lib/operator-terminal.js';
import {
  harness,
  initializeSubscriptionFixtures,
} from './subscription-fixtures.js';

const AUTH_URL =
  'https://auth.openai.com/api/accounts/authorize?state=literal%24%28private%29&id_token_hint=private-hint';
function browserFixture(platform: NodeJS.Platform = 'linux', timeoutMs = 1000) {
  const controller = new AbortController();
  const child = new ChildProcess();
  const kill = jest.spyOn(child, 'kill').mockReturnValue(true);
  const unref = jest.spyOn(child, 'unref').mockImplementation(() => undefined);
  const launch = jest.fn(() => child);
  const open = createOperatorBrowserOpener({
    signal: controller.signal,
    platform,
    timeoutMs,
    launch,
  });
  return { controller, child, kill, unref, launch, open };
}
describe('system browser boundary', () => {
  test.each([
    ['linux', '/usr/bin/xdg-open'],
    ['darwin', '/usr/bin/open'],
  ] as const)(
    'launches fixed %s binary with a literal URL',
    async (platform, binary) => {
      const f = browserFixture(platform);
      const result = f.open(AUTH_URL);
      expect(f.launch).toHaveBeenCalledWith(binary, [AUTH_URL], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      f.child.emit('exit', 0);
      f.child.emit('close', 0);
      await expect(result).resolves.toBeUndefined();
      expect(f.kill).not.toHaveBeenCalled();
      expect(f.child.listenerCount('error')).toBe(0);
      expect(f.child.listenerCount('exit')).toBe(0);
    },
  );
  test.each([
    'bad-private-url',
    'http://auth.openai.com/api/accounts/authorize',
    'https://other.test/api/accounts/authorize',
    'https://auth.openai.com/other',
    'https://user:private@auth.openai.com/api/accounts/authorize',
    `${AUTH_URL}#private`,
  ])('rejects URL before launching: %s', async (url) => {
    const f = browserFixture();
    await expect(f.open(url)).rejects.toThrow(
      'System browser could not be opened.',
    );
    expect(f.launch).not.toHaveBeenCalled();
  });
  test.each(['win32', 'aix'] as const)(
    'fails unsupported platform %s before launch',
    async (platform) => {
      const f = browserFixture(platform);
      await expect(f.open(AUTH_URL)).rejects.toThrow(
        'System browser could not be opened.',
      );
      expect(f.launch).not.toHaveBeenCalled();
    },
  );
  it('does not launch when already cancelled', async () => {
    const f = browserFixture();
    f.controller.abort();
    await expect(f.open(AUTH_URL)).rejects.toThrow(
      'System browser could not be opened.',
    );
    expect(f.launch).not.toHaveBeenCalled();
  });
  test.each(['throw', 'error', 'exit'] as const)(
    'suppresses %s launcher diagnostics',
    async (mode) => {
      const f = browserFixture();
      if (mode === 'throw')
        f.launch.mockImplementation(() => {
          throw new Error('private-hint');
        });
      const result = f.open(AUTH_URL);
      if (mode === 'error') f.child.emit('error', new Error('private-hint'));
      if (mode === 'exit') f.child.emit('exit', 1);
      await expect(result).rejects.toThrow(
        'System browser could not be opened.',
      );
      f.child.emit('close', 1);
      expect(f.child.listenerCount('error')).toBe(0);
      expect(f.child.listenerCount('exit')).toBe(0);
    },
  );
  it('kills only its owned launcher on cancellation', async () => {
    const f = browserFixture();
    const result = f.open(AUTH_URL);
    f.controller.abort();
    await expect(result).rejects.toThrow('System browser could not be opened.');
    expect(f.kill).toHaveBeenCalledWith('SIGKILL');
    expect(f.unref).toHaveBeenCalledTimes(1);
    expect(f.child.listenerCount('exit')).toBe(0);
  });
  it('absorbs late launcher errors after cancellation until close', async () => {
    const f = browserFixture();
    const result = f.open(AUTH_URL);
    f.controller.abort();
    await expect(result).rejects.toThrow('System browser could not be opened.');
    expect(() =>
      f.child.emit('error', new Error('private-late-launcher-diagnostic')),
    ).not.toThrow();
    f.child.emit('close', null);
    expect(f.child.listenerCount('error')).toBe(0);
    expect(f.child.listenerCount('close')).toBe(0);
  });
  it('bounds a stuck launcher without leaking diagnostics', async () => {
    const f = browserFixture('linux', 5);
    await expect(f.open(AUTH_URL)).rejects.toThrow(
      'System browser could not be opened.',
    );
    expect(f.kill).toHaveBeenCalledWith('SIGKILL');
    expect(f.unref).toHaveBeenCalledTimes(1);
  });
});

describe('explicit fresh authorization link boundary', () => {
  beforeAll(initializeSubscriptionFixtures);
  function freshUrl() {
    const url = new URL('https://auth.openai.com/api/accounts/authorize');
    url.search = new URLSearchParams({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Movement OS',
      ext_agent_host_id: 'urn:uuid:12345678-1234-4234-8234-123456789abc',
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:43623/auth/callback',
      scope:
        'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      state: 's'.repeat(43),
      nonce: 'n'.repeat(43),
      code_challenge_method: 'S256',
      code_challenge: 'c'.repeat(43),
      prompt: 'consent',
    }).toString();
    return url;
  }
  function manualFixture(timeoutMs = 1000) {
    const controller = new AbortController();
    const display = jest.fn(() => Promise.resolve());
    const open = createOperatorManualBrowserOpener({
      signal: controller.signal,
      display,
      timeoutMs,
    });
    return { controller, display, open };
  }
  it('displays only a validated fresh public PKCE request', async () => {
    const f = manualFixture();
    const url = freshUrl().href;
    await expect(f.open(url)).resolves.toBeUndefined();
    expect(f.display).toHaveBeenCalledTimes(1);
    expect(f.display).toHaveBeenCalledWith(url);
  });
  it('accepts the native fresh-session URL through its actual loopback callback', async () => {
    const f = harness();
    // The native protected file store generates this version-4 urn form.
    f.store.state.hostId = 'urn:uuid:12345678-1234-4234-8234-123456789abc';
    const display = jest.fn(f.open);
    const account = await f.session.signIn({
      enablePlanUsage: true,
      openAuthorizationUrl: createOperatorManualBrowserOpener({
        signal: new AbortController().signal,
        display,
      }),
    });
    expect(account.signedIn).toBe(true);
    expect(account.planUsageAuthorized).toBe(true);
    expect(display).toHaveBeenCalledTimes(1);
    expect(f.authorization.searchParams.has('id_token_hint')).toBe(false);
    expect(f.authorization.searchParams.has('login_hint')).toBe(false);
    expect(f.requests.some(({ url }) => url.endsWith('/oauth/token'))).toBe(
      true,
    );
    expect(f.requests.every(({ url }) => !url.endsWith('/responses'))).toBe(
      true,
    );
  });
  it('rejects native saved-account hints without display and preserves credentials', async () => {
    const f = harness();
    f.store.state.hostId = 'urn:uuid:12345678-1234-4234-8234-123456789abc';
    const account = await f.session.signIn({
      enablePlanUsage: true,
      openAuthorizationUrl: f.open,
    });
    const before = structuredClone(f.store.state);
    const display = jest.fn(f.open);
    await expect(
      f.session.signIn({
        accountKey: account.key,
        enablePlanUsage: true,
        openAuthorizationUrl: createOperatorManualBrowserOpener({
          signal: new AbortController().signal,
          display,
        }),
      }),
    ).rejects.toMatchObject({ code: 'transport_failed' });
    expect(display).not.toHaveBeenCalled();
    expect(f.store.state).toEqual(before);
  });
  it.each([
    ['id_token_hint', 'PRIVATE-TOKEN'],
    ['login_hint', 'PRIVATE-EMAIL'],
    ['access_token', 'PRIVATE-TOKEN'],
    ['code', 'PRIVATE-CALLBACK-CODE'],
    ['unknown', 'PRIVATE-VALUE'],
    ['client_id', 'issued-saved-client'],
    ['agent_name_hint', 'PRIVATE-ACCOUNT-LABEL'],
    ['response_type', 'token'],
    ['code_challenge_method', 'plain'],
    ['code_challenge', 'unbounded-or-invalid'],
    ['state', 'state\nprivate'],
    ['nonce', 'nonce-private'],
    ['prompt', 'none'],
    ['resource', 'https://other.test/v1'],
    ['scope', 'openid private_scope'],
    ['ext_agent_host_id', 'PRIVATE-HOST-ID'],
    ['redirect_uri', 'https://127.0.0.1:43623/auth/callback'],
    ['redirect_uri', 'http://localhost:43623/auth/callback'],
    ['redirect_uri', 'http://other.test:43623/auth/callback'],
    ['redirect_uri', 'http://127.0.0.1:43623/other'],
    ['redirect_uri', 'http://127.0.0.1:43623/auth/callback?code=PRIVATE'],
    ['redirect_uri', 'http://private@127.0.0.1:43623/auth/callback'],
    ['redirect_uri', 'http://127.0.0.1:43623/auth/callback#PRIVATE'],
    ['redirect_uri', 'http://127.0.0.1/auth/callback'],
  ])('rejects unsafe %s without displaying any URL', async (key, value) => {
    const f = manualFixture();
    const url = freshUrl();
    url.searchParams.set(key, value);
    await expect(f.open(url.href)).rejects.toThrow(
      'Manual authorization link could not be displayed.',
    );
    expect(f.display).not.toHaveBeenCalled();
  });
  it.each(['state', 'client_id', 'redirect_uri'])(
    'rejects duplicate %s',
    async (key) => {
      const f = manualFixture();
      const url = freshUrl();
      url.searchParams.append(key, url.searchParams.get(key) ?? '');
      await expect(f.open(url.href)).rejects.toThrow(
        'Manual authorization link could not be displayed.',
      );
      expect(f.display).not.toHaveBeenCalled();
    },
  );
  it.each(['state', 'code_challenge', 'ext_agent_host_id', 'prompt'])(
    'rejects missing %s',
    async (key) => {
      const f = manualFixture();
      const url = freshUrl();
      url.searchParams.delete(key);
      await expect(f.open(url.href)).rejects.toThrow(
        'Manual authorization link could not be displayed.',
      );
      expect(f.display).not.toHaveBeenCalled();
    },
  );
  it('rejects credentials, fragments, controls and non-official endpoints', async () => {
    const base = freshUrl().href;
    for (const url of [
      'invalid-private-url',
      base.replace('https:', 'http:'),
      base.replace('auth.openai.com', 'other.test'),
      base.replace('/api/accounts/authorize', '/other'),
      base.replace('https://', 'https://user:PRIVATE@'),
      `${base}#PRIVATE`,
      `${base}\n`,
      base.replace('state=', 'state=%E2%80%AE'),
      base + 'x'.repeat(8192),
    ]) {
      const f = manualFixture();
      await expect(f.open(url)).rejects.toThrow(
        'Manual authorization link could not be displayed.',
      );
      expect(f.display).not.toHaveBeenCalled();
    }
  });
  it('does not display after cancellation', async () => {
    const f = manualFixture();
    f.controller.abort();
    await expect(f.open(freshUrl().href)).rejects.toThrow(
      'Manual authorization link could not be displayed.',
    );
    expect(f.display).not.toHaveBeenCalled();
  });
  it.each(['throw', 'reject'] as const)(
    'suppresses %s output diagnostics',
    async (mode) => {
      const f = manualFixture();
      f.display.mockImplementation(() => {
        if (mode === 'throw') throw new Error('PRIVATE-WRITER-DIAGNOSTIC');
        return Promise.reject(new Error('PRIVATE-WRITER-DIAGNOSTIC'));
      });
      await expect(f.open(freshUrl().href)).rejects.toThrow(
        'Manual authorization link could not be displayed.',
      );
    },
  );
  it('bounds a stalled output sink and absorbs late failure after cancellation', async () => {
    for (const mode of ['timeout', 'cancel']) {
      const f = manualFixture(5);
      let reject!: (error: Error) => void;
      f.display.mockImplementation(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      );
      const pending = f.open(freshUrl().href);
      await Promise.resolve();
      if (mode === 'cancel') f.controller.abort();
      await expect(pending).rejects.toThrow(
        'Manual authorization link could not be displayed.',
      );
      reject(new Error('PRIVATE-LATE-WRITER-DIAGNOSTIC'));
      await Promise.resolve();
    }
  });
});

describe('owned terminal prompt', () => {
  function fixture() {
    const input = new PassThrough();
    const output = new PassThrough();
    const onEof = jest.fn();
    const prompt = createOperatorPrompt(input, output, onEof);
    return { input, output, onEof, prompt };
  }
  it('resolves pending input on EOF and clears buffered commands', async () => {
    const f = fixture();
    const result = f.prompt.readLine('Action: ');
    f.input.end();
    expect(await result).toBeNull();
    expect(f.onEof).toHaveBeenCalledTimes(1);
    expect(await f.prompt.readLine('Again: ')).toBeNull();
    const queued = fixture();
    queued.input.end('6\n1\ny\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await queued.prompt.readLine('Action: ')).toBeNull();
  });
  it('closes and cancels on input failure without exposing raw diagnostics', async () => {
    const f = fixture();
    const result = f.prompt.readLine('Action: ');
    expect(() =>
      f.input.emit('error', new Error('private-input-diagnostic')),
    ).not.toThrow();
    expect(await result).toBeNull();
    expect(f.onEof).toHaveBeenCalledTimes(1);
    expect(f.input.listenerCount('data')).toBe(0);
    expect(f.onEof).toHaveBeenCalledWith('io-error');
  });
  it('reads one pending line and then a bounded buffered line', async () => {
    const f = fixture();
    const result = f.prompt.readLine('Action: ');
    f.input.write('4\n1\n');
    expect(await result).toBe('4');
    expect(await f.prompt.readLine('Account: ')).toBe('1');
    f.prompt.close();
    expect(f.onEof).not.toHaveBeenCalled();
  });
  it('manual close resolves pending input and preserves caller streams and listeners', async () => {
    const f = fixture();
    const listener = jest.fn();
    f.input.on('close', listener);
    const result = f.prompt.readLine('Action: ');
    f.prompt.close();
    f.prompt.close();
    expect(await result).toBeNull();
    expect(f.onEof).not.toHaveBeenCalled();
    expect(f.input.destroyed).toBe(false);
    expect(f.output.destroyed).toBe(false);
    expect(f.input.listeners('close')).toContain(listener);
    expect(f.input.listenerCount('data')).toBe(0);
  });
  test.each(['x'.repeat(1025) + '\n', '1\n'.repeat(17)])(
    'closes excessive input instead of executing it',
    async (text) => {
      const f = fixture();
      f.input.write(text);
      expect(await f.prompt.readLine('Action: ')).toBeNull();
      expect(f.onEof).toHaveBeenCalledTimes(1);
    },
  );
});
