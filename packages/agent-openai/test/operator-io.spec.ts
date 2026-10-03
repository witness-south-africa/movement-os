import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createOperatorBrowserOpener } from '../src/lib/operator-browser.js';
import { createOperatorPrompt } from '../src/lib/operator-terminal.js';

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
