import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import {
  OpenAiSubscriptionAuthError,
  SUBSCRIPTION_ISSUER,
  sanitizeOpenAiSubscriptionAuthError,
  type SubscriptionState,
  type SubscriptionStore,
} from './subscription-auth-types.js';

const MAX_BYTES = 1024 * 1024;
const text = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code < 32 || code === 127) return false;
    }
    return true;
  });
const token = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[\x21-\x7e]+$/);
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const AccountSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    issuer: z.literal(SUBSCRIPTION_ISSUER),
    subject: text,
    clientId: text.refine((value) => value !== 'dynamic_agent_client'),
    label: text,
    email: text.optional(),
    tokens: z
      .object({
        accessToken: z
          .string()
          .min(1)
          .max(16384)
          .regex(/^[A-Za-z0-9._~+/-]+=*$/),
        refreshToken: token.optional(),
        idToken: token,
        scopes: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)).max(64),
        expiresAt: epoch,
        earliestRefreshAt: epoch.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const StateSchema = z
  .object({
    version: z.literal(1),
    hostId: z
      .string()
      .regex(
        /^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      ),
    pendingClientId: text
      .refine((value) => value !== 'dynamic_agent_client')
      .optional(),
    activeAccountKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    accounts: z.array(AccountSchema).max(32),
  })
  .strict()
  .superRefine((state, context) => {
    const keys = new Set<string>();
    for (const account of state.accounts) {
      if (
        keys.has(account.key) ||
        account.key !==
          subscriptionAccountKey(account.clientId, account.subject)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'invalid account binding',
        });
      }
      keys.add(account.key);
    }
    if (state.activeAccountKey && !keys.has(state.activeAccountKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'invalid active account',
      });
    }
  });

/** Opaque stable account key; emails do not identify account registrations. */
export function subscriptionAccountKey(
  clientId: string,
  subject: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([SUBSCRIPTION_ISSUER, clientId, subject]))
    .digest('hex');
}

function fsCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function unavailable(): OpenAiSubscriptionAuthError {
  return new OpenAiSubscriptionAuthError('storage_unavailable');
}

/** Unix-only private, app-owned store. No environment or Codex credential lookup.
 * Use a directory outside any Git worktree, whose immediate parent already exists.
 * Existing directories/files must already be owned by this uid with 0700/0600.
 * A global exclusive file lock serializes processes and token rotation. Locks are
 * never stolen: an interrupted process may require operator recovery after proving
 * its owner has exited. Same-uid compromise is outside filesystem protection.
 */
export function createOpenAiSubscriptionFileStore(options: {
  readonly directory: string;
  readonly lockTimeoutMs?: number;
}): SubscriptionStore {
  const waitMs = options.lockTimeoutMs ?? 30_000;
  if (
    process.platform === 'win32' ||
    typeof process.getuid !== 'function' ||
    typeof options.directory !== 'string' ||
    !isAbsolute(options.directory) ||
    options.directory.includes('\0') ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 1 ||
    waitMs > 300_000
  ) {
    throw new OpenAiSubscriptionAuthError('invalid_configuration');
  }
  const uid = process.getuid();
  const directory = resolve(options.directory);
  const statePath = join(directory, 'accounts.json');
  const lockPath = join(directory, 'session.lock');

  async function ensureDirectory(): Promise<void> {
    // Refuse symlinked components and Git-owned paths before creating any state.
    let component = parse(directory).root;
    for (const name of directory
      .slice(component.length)
      .split('/')
      .filter(Boolean)) {
      component = join(component, name);
      try {
        const info = await lstat(component);
        if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
        // A writable ancestor could rename this directory and substitute its
        // own path. Root/current uid are trusted; sticky directories such as
        // /tmp prevent other users from replacing their owned descendants.
        if (
          (info.uid !== 0 && info.uid !== uid) ||
          ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
        )
          throw unavailable();
      } catch (error) {
        if (fsCode(error) !== 'ENOENT' || component !== directory)
          throw unavailable();
      }
    }
    let ancestor = directory;
    for (;;) {
      try {
        const marker = await lstat(join(ancestor, '.git'));
        if (marker.isDirectory()) {
          // An empty unrelated .git directory is not a worktree marker.
          // HEAD is present in initialized repositories; worktree .git files
          // and symlink markers are always rejected without following them.
          await lstat(join(ancestor, '.git', 'HEAD'));
        }
        throw unavailable();
      } catch (error) {
        if (fsCode(error) !== 'ENOENT') throw unavailable();
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    try {
      await mkdir(directory, { mode: 0o700 });
      // Set exact permissions on our new directory despite a restrictive umask.
      // Existing directories are validated below and are never repaired.
      await chmod(directory, 0o700);
    } catch (error) {
      if (fsCode(error) !== 'EEXIST') throw unavailable();
    }
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== uid ||
      (info.mode & 0o7777) !== 0o700
    ) {
      throw unavailable();
    }
  }

  async function checkFile(handle: FileHandle): Promise<void> {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== uid ||
      (info.mode & 0o7777) !== 0o600 ||
      info.nlink !== 1
    ) {
      throw unavailable();
    }
  }

  function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new OpenAiSubscriptionAuthError('cancelled');
  }

  async function acquire(signal?: AbortSignal): Promise<FileHandle> {
    const deadline = performance.now() + waitMs;
    for (;;) {
      checkAbort(signal);
      await ensureDirectory();
      try {
        const handle = await open(
          lockPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.chmod(0o600);
          await checkFile(handle);
        } catch (error) {
          await release(handle);
          throw error;
        }
        return handle;
      } catch (error) {
        if (fsCode(error) !== 'EEXIST') throw unavailable();
        // Never follow or unlink an existing lock, even if its contents look stale.
        let info;
        try {
          info = await lstat(lockPath);
        } catch (error) {
          if (fsCode(error) === 'ENOENT') continue;
          throw unavailable();
        }
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.uid !== uid ||
          (info.mode & 0o7777) !== 0o600 ||
          info.nlink !== 1
        ) {
          throw unavailable();
        }
        if (performance.now() >= deadline)
          throw new OpenAiSubscriptionAuthError('storage_locked');
        await new Promise<void>((fulfill) =>
          setTimeout(
            fulfill,
            Math.min(25, Math.max(1, deadline - performance.now())),
          ),
        );
      }
    }
  }

  async function load(): Promise<SubscriptionState> {
    let handle: FileHandle;
    try {
      handle = await open(
        statePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (fsCode(error) === 'ENOENT')
        return { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
      throw unavailable();
    }
    try {
      await checkFile(handle);
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      for (;;) {
        const result = await handle.read(
          bytes,
          size,
          bytes.length - size,
          null,
        );
        size += result.bytesRead;
        if (size > MAX_BYTES) throw unavailable();
        if (result.bytesRead === 0) break;
      }
      return StateSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            bytes.subarray(0, size),
          ),
        ),
      );
    } finally {
      await handle.close();
    }
  }

  async function save(state: SubscriptionState): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(StateSchema.parse(state)) + '\n');
    if (bytes.length > MAX_BYTES) throw unavailable();
    await ensureDirectory();
    const temporaryPath = join(directory, `${randomUUID()}.tmp`);
    const handle = await open(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await checkFile(handle);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, statePath);
      const directoryHandle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async function release(lock: FileHandle): Promise<void> {
    try {
      const held = await lock.stat();
      const current = await lstat(lockPath);
      if (held.ino !== current.ino || held.dev !== current.dev)
        throw unavailable();
      await unlink(lockPath);
    } catch {
      throw unavailable();
    } finally {
      await lock.close().catch(() => {
        throw unavailable();
      });
    }
  }

  return {
    async transaction<T>(
      operation: (state: SubscriptionState) => Promise<T>,
      request?: { readonly signal?: AbortSignal },
    ): Promise<T> {
      let lock: FileHandle | undefined;
      try {
        lock = await acquire(request?.signal);
        checkAbort(request?.signal);
        const state = await load();
        const before = JSON.stringify(state);
        const result = await operation(state);
        // New host identity must persist even for the first read-only transaction.
        let exists = true;
        try {
          await lstat(statePath);
        } catch (error) {
          if (fsCode(error) !== 'ENOENT') throw error;
          exists = false;
        }
        if (!exists || before !== JSON.stringify(state)) await save(state);
        return result;
      } catch (error) {
        throw sanitizeOpenAiSubscriptionAuthError(error, 'storage_unavailable');
      } finally {
        if (lock) await release(lock);
      }
    },
  };
}
