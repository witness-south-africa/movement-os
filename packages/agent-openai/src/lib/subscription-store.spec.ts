import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOpenAiSubscriptionFileStore,
  subscriptionAccountKey,
} from './subscription-store.js';
import {
  OpenAiSubscriptionAuthError,
  SUBSCRIPTION_ISSUER,
  type SubscriptionAccountRecord,
} from './subscription-auth-types.js';

describe('private subscription credential store', () => {
  let temporary: string;
  let directory: string;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'movement-auth-store-'));
    directory = join(temporary, 'accounts');
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });
  const account = (
    client = 'oaiapp_one',
    subject = 'subject-one',
  ): SubscriptionAccountRecord => ({
    key: subscriptionAccountKey(client, subject),
    issuer: SUBSCRIPTION_ISSUER,
    subject,
    clientId: client,
    label: 'Account 1',
    email: 'same@example.test',
    tokens: {
      accessToken: 'offline-access-fixture',
      refreshToken: 'offline-refresh-fixture',
      idToken: 'offline-id-fixture',
      scopes: ['openid', 'chatgpt.tokens.use.direct'],
      expiresAt: 2_000_000_000_000,
    },
  });
  const store = () => createOpenAiSubscriptionFileStore({ directory });

  it('persists one stable host, protected records and account selection across restart', async () => {
    const one = store();
    const host = await one.transaction((state) =>
      Promise.resolve(state.hostId),
    );
    expect(host).toMatch(/^urn:uuid:/);
    await one.transaction((state) => {
      state.accounts.push(account(), account('oaiapp_two'));
      state.activeAccountKey = account('oaiapp_two').key;
      state.pendingClientId = 'oaiapp_pending';
      return Promise.resolve();
    });
    const disk = await store().transaction((state) =>
      Promise.resolve(structuredClone(state)),
    );
    expect(disk.hostId).toBe(host);
    expect(disk.accounts).toHaveLength(2);
    expect(disk.accounts[0]?.key).not.toBe(disk.accounts[1]?.key);
    expect(disk.activeAccountKey).toBe(disk.accounts[1]?.key);
    expect(disk.pendingClientId).toBe('oaiapp_pending');
    expect((await lstat(directory)).mode & 0o7777).toBe(0o700);
    expect((await lstat(join(directory, 'accounts.json'))).mode & 0o7777).toBe(
      0o600,
    );
    expect(await readdir(directory)).toEqual(['accounts.json']);
  });

  it('rolls back throwing transactions and removes only its own lock', async () => {
    await store().transaction(() => Promise.resolve(undefined));
    const before = await readFile(join(directory, 'accounts.json'), 'utf8');
    await expect(
      store().transaction((state) => {
        state.accounts.push(account());
        throw new OpenAiSubscriptionAuthError('invalid_identity');
      }),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
    expect(await readFile(join(directory, 'accounts.json'), 'utf8')).toBe(
      before,
    );
    await expect(
      store().transaction(() => {
        throw new Error('credential-secret');
      }),
    ).rejects.toMatchObject({
      code: 'storage_unavailable',
      message: 'openai subscription authentication: storage_unavailable',
    });
    expect(await readdir(directory)).toEqual(['accounts.json']);
  });

  it('serializes independent store instances so rotating replacements cannot race', async () => {
    await store().transaction((state) => {
      state.accounts.push(account());
      return Promise.resolve();
    });
    const order: string[] = [];
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((fulfill) => {
      enter = fulfill;
    });
    const first = store().transaction(async (state) => {
      order.push('first');
      enter();
      await new Promise<void>((fulfill) => setTimeout(fulfill, 50));
      const saved = state.accounts[0]?.tokens;
      if (!saved) throw new Error('missing fixture');
      saved.refreshToken = 'new-refresh';
      order.push('first-saved');
    });
    await entered;
    await Promise.all([
      first,
      store().transaction((state) => {
        order.push('second');
        expect(state.accounts[0]?.tokens?.refreshToken).toBe('new-refresh');
        return Promise.resolve();
      }),
    ]);
    expect(order).toEqual(['first', 'first-saved', 'second']);
  });

  it('rebuilds mutated typed exceptions and catches malicious code getters', async () => {
    const mutated = Object.assign(
      new OpenAiSubscriptionAuthError('invalid_identity'),
      {
        message: 'offline-sensitive-diagnostic',
        cause: new Error('offline-cause'),
      },
    );
    await expect(
      store().transaction(() => Promise.reject(mutated)),
    ).rejects.toMatchObject({
      code: 'invalid_identity',
      message: 'openai subscription authentication: invalid_identity',
    });
    await store()
      .transaction(() => Promise.reject(mutated))
      .catch((error: unknown) => {
        expect(error).not.toHaveProperty('cause');
      });
    const accessor = new OpenAiSubscriptionAuthError('invalid_identity');
    Object.defineProperty(accessor, 'code', {
      get: () => {
        throw new Error('offline-getter-secret');
      },
    });
    await expect(
      store().transaction(() => Promise.reject(accessor)),
    ).rejects.toMatchObject({
      code: 'storage_unavailable',
      message: 'openai subscription authentication: storage_unavailable',
    });
  });

  it('times out without stealing an existing lock and can be cancelled while waiting', async () => {
    await store().transaction(() => Promise.resolve(undefined));
    const lockPath = join(directory, 'session.lock');
    await writeFile(lockPath, 'existing-process-fixture', { mode: 0o600 });
    const locked = createOpenAiSubscriptionFileStore({
      directory,
      lockTimeoutMs: 30,
    });
    await expect(
      locked.transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_locked' });
    const controller = new AbortController();
    const cancelled = store().transaction(
      () => {
        throw new Error('must not run');
      },
      { signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 15);
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    expect(await readFile(lockPath, 'utf8')).toBe('existing-process-fixture');
    await rm(lockPath);
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).resolves.toBeUndefined();
  });

  it('rejects already-cancelled work before creating a directory', async () => {
    await expect(
      store().transaction(() => Promise.resolve(undefined), {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates exact private permissions under a restrictive umask without poisoning the lock', async () => {
    // Native stripping runs the current source in a separate process, avoiding
    // mutation of Jest's shared process umask or dependence on a prior build.
    for (const name of ['subscription-store', 'subscription-auth-types']) {
      const source = await readFile(join(__dirname, `${name}.ts`), 'utf8');
      await writeFile(
        join(temporary, `${name}.js`),
        stripTypeScriptTypes(source),
      );
    }
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
    await symlink(
      join(__dirname, '..', '..', 'node_modules'),
      join(temporary, 'node_modules'),
    );
    await writeFile(
      join(temporary, 'child.mjs'),
      `
      import { createOpenAiSubscriptionFileStore } from './subscription-store.js';
      import { lstat, readdir } from 'node:fs/promises';
      import { join } from 'node:path';
      const directory = join(process.cwd(), 'accounts');
      const previous = process.umask(0o777);
      const store = createOpenAiSubscriptionFileStore({ directory });
      await store.transaction(() => Promise.resolve());
      process.umask(previous);
      await store.transaction(() => Promise.resolve());
      process.stdout.write(JSON.stringify({
        directoryMode: (await lstat(directory)).mode & 0o7777,
        fileMode: (await lstat(join(directory, 'accounts.json'))).mode & 0o7777,
        files: await readdir(directory)
      }));
    `,
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['child.mjs'],
      { cwd: temporary, timeout: 5000 },
    );
    expect(JSON.parse(stdout)).toEqual({
      directoryMode: 0o700,
      fileMode: 0o600,
      files: ['accounts.json'],
    });
  });

  it.each(['relative/path', '\0', ''])(
    'rejects invalid directory %p',
    (path) => {
      expect(() =>
        createOpenAiSubscriptionFileStore({ directory: path }),
      ).toThrow(OpenAiSubscriptionAuthError);
    },
  );
  it.each([0, -1, 0.5, Number.NaN, 300001])(
    'rejects invalid lock timeout %p',
    (lockTimeoutMs) => {
      expect(() =>
        createOpenAiSubscriptionFileStore({ directory, lockTimeoutMs }),
      ).toThrow(OpenAiSubscriptionAuthError);
    },
  );

  it('refuses to create secrets inside a Git worktree', async () => {
    await writeFile(join(temporary, '.git'), 'gitdir: preserved-user-worktree');
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not create missing parent paths or repair broad permissions', async () => {
    await expect(
      createOpenAiSubscriptionFileStore({
        directory: join(directory, 'missing'),
      }).transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    await mkdir(directory, { mode: 0o755 });
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
  });
  it('rejects non-sticky writable ancestors and accepts an owned child under a sticky directory', async () => {
    await chmod(temporary, 0o777);
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await chmod(temporary, 0o1777);
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).resolves.toBeUndefined();
    expect((await lstat(directory)).mode & 0o7777).toBe(0o700);
  });
  it('refuses a symlinked directory or ancestor', async () => {
    const real = join(temporary, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, directory);
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(
      createOpenAiSubscriptionFileStore({
        directory: join(directory, 'child'),
      }).transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await readdir(real)).toEqual([]);
  });
  it('refuses symlinked or non-regular locks without following or replacing them', async () => {
    await store().transaction(() => Promise.resolve(undefined));
    const outside = join(temporary, 'outside');
    await writeFile(outside, 'preserved', { mode: 0o600 });
    await symlink(outside, join(directory, 'session.lock'));
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await readFile(outside, 'utf8')).toBe('preserved');
    await rm(join(directory, 'session.lock'));
    await mkdir(join(directory, 'session.lock'), { mode: 0o700 });
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
  });
  it('refuses broad, symlinked, hard-linked and non-regular credential files', async () => {
    await store().transaction(() => Promise.resolve(undefined));
    const statePath = join(directory, 'accounts.json');
    await chmod(statePath, 0o644);
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    await chmod(statePath, 0o600);
    await link(statePath, join(temporary, 'hard-link'));
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    await rm(join(temporary, 'hard-link'));
    const preserved = await readFile(statePath, 'utf8');
    await rm(statePath);
    await writeFile(join(temporary, 'outside'), preserved, { mode: 0o600 });
    await symlink(join(temporary, 'outside'), statePath);
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await readFile(join(temporary, 'outside'), 'utf8')).toBe(preserved);
    await rm(statePath);
    await mkdir(statePath, { mode: 0o700 });
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
  });
  it.each(['{malformed', '{"version":2}', '\xff'])(
    'rejects corrupt state without overwriting it',
    async (raw) => {
      await store().transaction(() => Promise.resolve(undefined));
      const bytes = raw === '\xff' ? Buffer.from([0xff]) : Buffer.from(raw);
      await writeFile(join(directory, 'accounts.json'), bytes);
      await expect(
        store().transaction(() => Promise.resolve(undefined)),
      ).rejects.toMatchObject({ code: 'storage_unavailable' });
      expect(await readFile(join(directory, 'accounts.json'))).toEqual(bytes);
    },
  );
  it('rejects oversized state before parsing or returning credentials', async () => {
    await store().transaction(() => Promise.resolve(undefined));
    await writeFile(
      join(directory, 'accounts.json'),
      Buffer.alloc(1024 * 1024 + 1, 32),
    );
    await expect(
      store().transaction(() => Promise.resolve(undefined)),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
  });
  it('rejects invalid bindings, duplicate accounts, bad active account and dynamic issued client', async () => {
    await store().transaction(() => Promise.resolve(undefined));
    for (const mutate of [
      (state: {
        accounts: SubscriptionAccountRecord[];
        activeAccountKey?: string | undefined;
      }) => {
        const first = account();
        first.key = 'a'.repeat(64);
        state.accounts.push(first);
      },
      (state: {
        accounts: SubscriptionAccountRecord[];
        activeAccountKey?: string | undefined;
      }) => {
        state.accounts.push(account(), account());
      },
      (state: {
        accounts: SubscriptionAccountRecord[];
        activeAccountKey?: string | undefined;
      }) => {
        state.activeAccountKey = 'b'.repeat(64);
      },
      (state: {
        accounts: SubscriptionAccountRecord[];
        activeAccountKey?: string | undefined;
      }) => {
        state.accounts.push(account('dynamic_agent_client'));
      },
    ]) {
      await expect(
        store().transaction((state) => {
          mutate(state);
          return Promise.resolve();
        }),
      ).rejects.toMatchObject({ code: 'storage_unavailable' });
      expect(
        await store().transaction((state) => Promise.resolve(state.accounts)),
      ).toEqual([]);
    }
  });
});
