import { spawn, type ChildProcess } from 'node:child_process';

interface BrowserOptions {
  readonly signal: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly launch?: (
    file: string,
    args: readonly string[],
    options: { shell: false; stdio: 'ignore'; windowsHide: true },
  ) => ChildProcess;
}

function browserError(): Error {
  return new Error('System browser could not be opened.');
}

/** Native default-browser launchers; no shell, PATH search or URL logging. */
export function createOperatorBrowserOpener(options: BrowserOptions) {
  const launch = options.launch ?? spawn;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (authorizationUrl: string): Promise<void> => {
    let url: URL;
    try {
      url = new URL(authorizationUrl);
    } catch {
      throw browserError();
    }
    if (
      authorizationUrl.length > 65_536 ||
      url.origin !== 'https://auth.openai.com' ||
      url.pathname !== '/api/accounts/authorize' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      !['linux', 'darwin'].includes(platform) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000 ||
      options.signal.aborted
    )
      throw browserError();
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = launch(
          platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open',
          [authorizationUrl],
          {
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
          },
        );
      } catch {
        reject(browserError());
        return;
      }
      let finished = false;
      const finish = (success: boolean, terminate = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        // Keep the owned error handler until close: kill/spawn can report late errors.
        child.removeListener('exit', onExit);
        if (terminate) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* Never expose launcher diagnostics. */
          }
          child.unref();
        }
        if (success) resolve();
        else reject(browserError());
      };
      const onAbort = () => finish(false, true);
      const onError = () => finish(false);
      const onExit = (code: number | null) =>
        finish(code === 0 && !options.signal.aborted);
      const onClose = () => {
        finish(false);
        child.removeListener('error', onError);
      };
      const timer = setTimeout(() => finish(false, true), timeoutMs);
      child.on('error', onError);
      child.once('close', onClose);
      child.once('exit', onExit);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    });
  };
}

interface ManualBrowserOptions {
  readonly signal: AbortSignal;
  readonly display: (authorizationUrl: string) => Promise<void>;
  readonly timeoutMs?: number;
}

const FRESH_AUTHORIZATION_KEYS = new Set([
  'client_id',
  'agent_name_hint',
  'ext_agent_host_id',
  'response_type',
  'redirect_uri',
  'scope',
  'resource',
  'state',
  'nonce',
  'code_challenge_method',
  'code_challenge',
  'prompt',
]);

/** Validate only the fresh, public PKCE request produced for a new registration. */
function freshAuthorizationUrl(value: string): boolean {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    if (
      url.href !== value ||
      url.origin !== 'https://auth.openai.com' ||
      url.pathname !== '/api/accounts/authorize' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    )
      return false;
    const params = url.searchParams;
    const keys = [...params.keys()];
    if (
      keys.length !== FRESH_AUTHORIZATION_KEYS.size ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !FRESH_AUTHORIZATION_KEYS.has(key)) ||
      params.get('client_id') !== 'dynamic_agent_client' ||
      params.get('agent_name_hint') !== 'Movement OS' ||
      params.get('response_type') !== 'code' ||
      params.get('scope') !==
        'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' ||
      params.get('resource') !== 'https://api.openai.com/v1' ||
      params.get('code_challenge_method') !== 'S256' ||
      params.get('prompt') !== 'consent' ||
      !/^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        params.get('ext_agent_host_id') ?? '',
      ) ||
      ['state', 'nonce', 'code_challenge'].some(
        (key) => !/^[A-Za-z0-9_-]{43}$/.test(params.get(key) ?? ''),
      )
    )
      return false;
    const redirect = new URL(params.get('redirect_uri') ?? '');
    return (
      redirect.href === params.get('redirect_uri') &&
      redirect.protocol === 'http:' &&
      redirect.hostname === '127.0.0.1' &&
      /^[1-9][0-9]{0,4}$/.test(redirect.port) &&
      Number(redirect.port) <= 65535 &&
      redirect.pathname === '/auth/callback' &&
      redirect.username === '' &&
      redirect.password === '' &&
      redirect.search === '' &&
      redirect.hash === ''
    );
  } catch {
    return false;
  }
}

/** Explicit fresh-link display; saved-account hint-bearing URLs are never shown. */
export function createOperatorManualBrowserOpener(
  options: ManualBrowserOptions,
) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (authorizationUrl: string): Promise<void> => {
    const error = () =>
      new Error('Manual authorization link could not be displayed.');
    if (
      !freshAuthorizationUrl(authorizationUrl) ||
      options.signal.aborted ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000
    )
      throw error();
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        if (success && !options.signal.aborted) resolve();
        else reject(error());
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      // Both handlers stay attached to absorb a late writer failure after abort.
      void Promise.resolve()
        .then(() => {
          if (finished || options.signal.aborted) throw error();
          return options.display(authorizationUrl);
        })
        .then(
          () => finish(true),
          () => finish(false),
        );
    });
  };
}
