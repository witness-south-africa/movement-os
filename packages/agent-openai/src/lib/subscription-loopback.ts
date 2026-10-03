import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { OpenAiSubscriptionAuthError } from './subscription-auth-types.js';

interface CallbackResult {
  readonly code: string;
  readonly clientId?: string;
}

/** A single-use listener; no callback values are reflected into responses. */
export async function openSubscriptionLoopback(options: {
  readonly state: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly redirectUri: string;
  readonly callback: Promise<CallbackResult>;
  close(): void;
}> {
  if (isAborted(options.signal)) {
    throw new OpenAiSubscriptionAuthError('cancelled');
  }
  let resolveCallback!: (result: CallbackResult) => void;
  let rejectCallback!: (error: OpenAiSubscriptionAuthError) => void;
  const callback = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // An early abort/listener error can precede the caller awaiting this promise.
  void callback.catch(() => undefined);
  let settled = false;
  let authority = '';
  const server: Server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
    (request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Connection', 'close');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      const raw = request.url ?? '';
      if (
        request.method !== 'GET' ||
        request.headers.host !== authority ||
        !raw.startsWith('/') ||
        raw.startsWith('//') ||
        raw.includes('\\') ||
        !safeValue(raw, 8192) ||
        raw.length > 8192
      ) {
        response.writeHead(400).end('Invalid request.');
        return;
      }
      let url: URL;
      try {
        url = new URL(raw, `http://${authority}`);
      } catch {
        response.writeHead(400).end('Invalid request.');
        return;
      }
      if (url.origin !== `http://${authority}` || url.hash !== '') {
        response.writeHead(400).end('Invalid request.');
        return;
      }
      if (url.pathname !== '/auth/callback') {
        response.writeHead(404).end('Not found.');
        return;
      }
      if (settled) {
        response.writeHead(400).end('Sign-in has already completed.');
        return;
      }
      settled = true;
      let error: OpenAiSubscriptionAuthError | undefined;
      let result: CallbackResult | undefined;
      const parameters = url.searchParams;
      const duplicated = [...new Set(parameters.keys())].some(
        (key) => parameters.getAll(key).length !== 1,
      );
      const state = parameters.get('state');
      // State is checked before error/code/client values are interpreted.
      if (duplicated || state === null || !equalState(state, options.state)) {
        error = new OpenAiSubscriptionAuthError('invalid_callback');
      } else if (parameters.has('error')) {
        error = new OpenAiSubscriptionAuthError(
          parameters.get('error') === 'access_denied' && !parameters.has('code')
            ? 'access_denied'
            : 'invalid_callback',
        );
      } else {
        const code = parameters.get('code');
        const clientId = parameters.get('client_id');
        if (
          !safeValue(code, 4096) ||
          (clientId !== null && !safeValue(clientId, 512))
        ) {
          error = new OpenAiSubscriptionAuthError('invalid_callback');
        } else {
          result = {
            code,
            ...(clientId !== null ? { clientId } : {}),
          };
        }
      }
      response
        .writeHead(error ? 400 : 200)
        .end(
          error
            ? 'Sign-in could not be verified. Return to Movement OS.'
            : 'Callback received. Return to Movement OS to finish sign-in.',
        );
      if (error) rejectCallback(error);
      else if (result) resolveCallback(result);
      else rejectCallback(new OpenAiSubscriptionAuthError('invalid_callback'));
    },
  );
  const close = (): void => {
    options.signal.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  };
  const abort = (): void => {
    if (!settled) {
      settled = true;
      rejectCallback(new OpenAiSubscriptionAuthError('cancelled'));
    }
    close();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => {
        reject(new OpenAiSubscriptionAuthError('transport_failed'));
      });
      server.listen(0, '127.0.0.1', () => resolve());
    });
    if (isAborted(options.signal)) {
      throw new OpenAiSubscriptionAuthError('cancelled');
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new OpenAiSubscriptionAuthError('transport_failed');
    }
    authority = `127.0.0.1:${String(address.port)}`;
    return {
      redirectUri: `http://${authority}/auth/callback`,
      callback,
      close,
    };
  } catch {
    close();
    throw new OpenAiSubscriptionAuthError(
      isAborted(options.signal) ? 'cancelled' : 'transport_failed',
    );
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function safeValue(value: string | null, maximum: number): value is string {
  if (value === null || value.length === 0 || value.length > maximum)
    return false;
  for (const character of value) {
    if (character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
      return false;
  }
  return true;
}

function equalState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
