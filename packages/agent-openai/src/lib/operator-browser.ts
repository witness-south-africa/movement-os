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

/** Fixed native launchers; no shell, PATH search, child diagnostics or URL logging. */
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
