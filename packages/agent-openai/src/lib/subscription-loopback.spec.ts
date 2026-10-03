import { request as httpRequest } from 'node:http';
import { openSubscriptionLoopback } from './subscription-loopback.js';
describe('subscription loopback callback', () => {
  it('rejects malformed raw targets without throwing or consuming the valid callback', async () => {
    const listener = await openSubscriptionLoopback({
      state: 'expected',
      signal: new AbortController().signal,
    });
    try {
      const address = new URL(listener.redirectUri);
      for (const path of [
        '/\\[',
        '/\\evil.example/auth/callback?state=expected&code=bad',
        '/auth/callback#fragment',
      ]) {
        const status = await new Promise<number>((resolve, reject) => {
          const request = httpRequest(
            { hostname: address.hostname, port: address.port, path },
            (response) => {
              response.resume();
              resolve(response.statusCode ?? 0);
            },
          );
          request.on('error', reject);
          request.end();
        });
        expect(status).toBe(400);
      }
      await fetch(`${listener.redirectUri}?state=expected&code=valid`);
      await expect(listener.callback).resolves.toEqual({ code: 'valid' });
    } finally {
      listener.close();
    }
  });
  it('binds the fixed IPv4 path on an available port and consumes one callback', async () => {
    const controller = new AbortController();
    const listener = await openSubscriptionLoopback({
      state: 'expected',
      signal: controller.signal,
    });
    try {
      const uri = new URL(listener.redirectUri);
      expect(uri.hostname).toBe('127.0.0.1');
      expect(uri.pathname).toBe('/auth/callback');
      expect(uri.port).not.toBe('');
      expect((await fetch(`${uri.origin}/favicon.ico`)).status).toBe(404);
      const response = await fetch(
        `${listener.redirectUri}?state=expected&code=secret-code&client_id=issued-client`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('secret-code');
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(listener.callback).resolves.toEqual({
        code: 'secret-code',
        clientId: 'issued-client',
      });
      expect(
        (await fetch(`${listener.redirectUri}?state=expected&code=reuse`))
          .status,
      ).toBe(400);
    } finally {
      listener.close();
    }
  });
  it.each([
    ['state=wrong&error=access_denied', 'invalid_callback'],
    ['error=access_denied', 'invalid_callback'],
    ['state=expected&error=access_denied', 'access_denied'],
    ['state=expected&error=unknown', 'invalid_callback'],
    ['state=expected&error=access_denied&code=ambiguous', 'invalid_callback'],
    ['state=expected&code=one&code=two', 'invalid_callback'],
    ['state=expected&state=expected&code=one', 'invalid_callback'],
    ['state=expected&code=one&client_id=', 'invalid_callback'],
    ['state=expected&code=', 'invalid_callback'],
    ['state=expected&code=%00secret', 'invalid_callback'],
    ['state=expected', 'invalid_callback'],
  ])(
    'rejects invalid/declined callback %s without reflecting it',
    async (parameters, code) => {
      const listener = await openSubscriptionLoopback({
        state: 'expected',
        signal: new AbortController().signal,
      });
      try {
        const response = await fetch(`${listener.redirectUri}?${parameters}`);
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain(parameters);
        await expect(listener.callback).rejects.toMatchObject({ code });
      } finally {
        listener.close();
      }
    },
  );
  it('rejects POST and foreign Host without consuming the valid callback', async () => {
    const listener = await openSubscriptionLoopback({
      state: 'expected',
      signal: new AbortController().signal,
    });
    try {
      expect(
        (await fetch(listener.redirectUri, { method: 'POST' })).status,
      ).toBe(400);
      const foreignHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          listener.redirectUri,
          { headers: { host: 'evil.example' } },
          (response) => {
            response.resume();
            resolve(present(response.statusCode));
          },
        );
        request.on('error', reject);
        request.end();
      });
      expect(foreignHost).toBe(400);
      await fetch(`${listener.redirectUri}?state=expected&code=valid`);
      await expect(listener.callback).resolves.toEqual({ code: 'valid' });
    } finally {
      listener.close();
    }
  });
  it('cleans up when cancelled and rejects an already cancelled start', async () => {
    const controller = new AbortController();
    const listener = await openSubscriptionLoopback({
      state: 'expected',
      signal: controller.signal,
    });
    controller.abort();
    await expect(listener.callback).rejects.toMatchObject({
      code: 'cancelled',
    });
    await expect(fetch(listener.redirectUri)).rejects.toThrow();
    await expect(
      openSubscriptionLoopback({
        state: 'expected',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});

function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error('Missing fixture value');
  return value;
}
