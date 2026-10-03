import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { OpenAiSubscriptionAuthError } from './subscription-auth-types.js';
import type {
  OpenAiSubscriptionSession,
  SubscriptionAccountInfo,
} from './subscription-session.js';

type Command =
  | 'accounts'
  | 'sign-in'
  | 'select'
  | 'models'
  | 'sign-out'
  | 'manage';
export type SubscriptionOperatorArguments =
  | { readonly command: 'help' }
  | {
      readonly command: Command;
      readonly directory: string;
      readonly hosting: 'local' | 'self-hosted';
      readonly account?: string;
      readonly enablePlanUsage: boolean;
    };

export interface SubscriptionOperatorDependencies {
  readonly createSession: (config: {
    directory: string;
    hosting: 'local' | 'self-hosted';
  }) => OpenAiSubscriptionSession;
  readonly output: (text: string) => void;
  readonly error: (text: string) => void;
  readonly interactive: boolean;
  readonly prepareInteractive: () => void;
  readonly readLine: (prompt: string) => Promise<string | null>;
  readonly openAuthorizationUrl: (url: string) => Promise<void>;
  readonly signal: AbortSignal;
}

class OperatorUsageError extends Error {
  constructor() {
    super('Invalid operator command.');
  }
}

export const SUBSCRIPTION_OPERATOR_HELP = `Movement OS — ChatGPT accounts

Usage: pnpm openai:accounts <command> --directory <absolute-private-path> --hosting <local|self-hosted>

Commands:
  manage      Interactive account menu (requires a terminal).
  accounts    List saved registrations and their current status.
  sign-in     Continue with ChatGPT; add a registration, or use --account <key>.
  select      Select a saved registration with --account <key>.
  models      Fetch visible models for the active account at request time.
  sign-out    Clear one saved session with --account <key>; attempt revocation.

Options:
  --enable-plan-usage  Explicit consent request; sign-in with --account only.
  --help              Show help without accessing storage or the browser.

Build first: pnpm nx run @wsa/agent-openai:build
The private directory's parent must exist. Unix storage only; the browser and
callback listener must be reachable on the same host. This tool manages accounts
and lists models; it makes no inference request or API billing fallback.
`;

/** Parse every argument before constructing a store, prompt or browser. */
export function parseSubscriptionOperatorArguments(
  argv: readonly string[],
): SubscriptionOperatorArguments {
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        directory: { type: 'string' },
        hosting: { type: 'string' },
        account: { type: 'string' },
        'enable-plan-usage': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    const names = parsed.tokens
      .filter((token) => token.kind === 'option')
      .map((token) => token.name);
    if (new Set(names).size !== names.length || parsed.positionals.length > 1)
      throw new OperatorUsageError();
    const command = parsed.positionals[0] ?? 'manage';
    if (
      ![
        'help',
        'manage',
        'accounts',
        'sign-in',
        'select',
        'models',
        'sign-out',
      ].includes(command)
    )
      throw new OperatorUsageError();
    if (argv.length === 0 || command === 'help' || parsed.values.help) {
      if (names.some((name) => name !== 'help')) throw new OperatorUsageError();
      return { command: 'help' };
    }
    const { directory, hosting, account } = parsed.values;
    if (
      typeof directory !== 'string' ||
      !isAbsolute(directory) ||
      directory.length > 4096 ||
      /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(directory) ||
      (hosting !== 'local' && hosting !== 'self-hosted') ||
      (account !== undefined && !/^[a-f0-9]{64}$/u.test(account)) ||
      (account !== undefined &&
        !['sign-in', 'select', 'sign-out'].includes(command)) ||
      (['select', 'sign-out'].includes(command) && account === undefined) ||
      (parsed.values['enable-plan-usage'] &&
        (command !== 'sign-in' || account === undefined))
    )
      throw new OperatorUsageError();
    return {
      command: command as Command,
      directory,
      hosting,
      ...(account === undefined ? {} : { account }),
      enablePlanUsage: parsed.values['enable-plan-usage'] ?? false,
    };
  } catch {
    // Node's parser errors can echo raw arguments: never expose them.
    throw new OperatorUsageError();
  }
}

/** Terminal text is metadata, never authorization URLs or token-bearing records. */
export function operatorDisplayText(value: string): string {
  const bounded = value.slice(0, 256);
  const escaped = bounded.replace(
    /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu,
    (character) => `\\u{${character.codePointAt(0)?.toString(16) ?? 'fffd'}}`,
  );
  return value.length > bounded.length ? `${escaped}…` : escaped;
}

function accountRow(account: SubscriptionAccountInfo, index: number): string {
  return (
    `${String(index + 1)}. ${operatorDisplayText(account.label)}${account.active ? ' [active]' : ''}\n` +
    `   key: ${operatorDisplayText(account.key)}; session: ${account.signedIn ? 'signed in' : 'signed out'}; plan usage: ${account.planUsageAuthorized ? 'enabled' : 'disabled'}\n`
  );
}

// Read live cancellation state after awaits; it can change across each operation.
function wasCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

function stopped(signal: AbortSignal): number {
  return signal.reason === 'eof'
    ? 0
    : signal.reason === 'io-error'
      ? 1
      : signal.reason === 'SIGTERM'
        ? 143
        : 130;
}

function errorCategory(error: unknown): string {
  try {
    if (error instanceof OpenAiSubscriptionAuthError)
      return new OpenAiSubscriptionAuthError(error.code).code;
  } catch {
    // Even typed injected errors can contain throwing accessors.
  }
  return 'operation_failed';
}

async function showModels(
  session: OpenAiSubscriptionSession,
  deps: SubscriptionOperatorDependencies,
) {
  const models = await session.listModels({ signal: deps.signal });
  if (wasCancelled(deps.signal)) return;
  deps.output('Visible models for the active account at request time:\n');
  if (models.length === 0) deps.output('No visible models were returned.\n');
  models.forEach((model, index) =>
    deps.output(
      `${String(index + 1)}. ${operatorDisplayText(model.displayName)} — ${operatorDisplayText(model.slug)}\n`,
    ),
  );
}

async function signIn(
  session: OpenAiSubscriptionSession,
  deps: SubscriptionOperatorDependencies,
  account?: string,
  enablePlanUsage = false,
) {
  deps.output('Continue with ChatGPT — opening the system browser.\n');
  if (enablePlanUsage)
    deps.output(
      'Requesting permission to use this app with your ChatGPT plan. Review access and limits in ChatGPT Settings > Usage.\n',
    );
  const result = await session.signIn({
    openAuthorizationUrl: deps.openAuthorizationUrl,
    signal: deps.signal,
    ...(account === undefined ? {} : { accountKey: account }),
    enablePlanUsage,
  });
  if (wasCancelled(deps.signal)) return;
  deps.output(
    `Signed in: ${operatorDisplayText(result.label)}\nkey: ${operatorDisplayText(result.key)}\n`,
  );
  deps.output(
    result.planUsageAuthorized
      ? 'ChatGPT plan usage is enabled for this registration.\n'
      : 'Signed in without ChatGPT plan permission. Enable plan usage explicitly to list models or use inference.\n',
  );
}

async function signOut(
  session: OpenAiSubscriptionSession,
  deps: SubscriptionOperatorDependencies,
  account: string,
) {
  // Cancellation affects remote revocation; await the source's local clearing.
  const result = await session.signOut({
    accountKey: account,
    signal: deps.signal,
  });
  deps.output(`Local session cleared for ${operatorDisplayText(account)}.\n`);
  deps.output(
    result.remoteRevocationConfirmed
      ? 'Remote revocation confirmed.\n'
      : 'Remote revocation was not confirmed. Manage app access in ChatGPT Settings.\n',
  );
}

async function chooseAccount(
  session: OpenAiSubscriptionSession,
  deps: SubscriptionOperatorDependencies,
): Promise<SubscriptionAccountInfo | undefined> {
  const accounts = await session.listAccounts();
  if (wasCancelled(deps.signal)) return undefined;
  if (accounts.length === 0) {
    deps.output(
      'No saved registrations. Choose Continue with ChatGPT to add one.\n',
    );
    return undefined;
  }
  deps.output('Saved registration snapshot:\n');
  accounts.forEach((account, index) => deps.output(accountRow(account, index)));
  const answer = await deps.readLine('Registration number (0 cancels): ');
  if (answer === null || wasCancelled(deps.signal) || answer.trim() === '0')
    return undefined;
  const index = /^\d{1,2}$/u.test(answer.trim())
    ? Number(answer.trim()) - 1
    : -1;
  const account = accounts[index];
  if (!account) deps.output('Choose a listed registration number.\n');
  return account;
}

async function manage(
  session: OpenAiSubscriptionSession,
  deps: SubscriptionOperatorDependencies,
): Promise<number> {
  while (!wasCancelled(deps.signal)) {
    const accounts = await session.listAccounts();
    if (wasCancelled(deps.signal)) break;
    deps.output('\nMovement OS — saved account snapshot\n');
    if (accounts.length === 0) deps.output('No saved registrations.\n');
    accounts.forEach((account, index) =>
      deps.output(accountRow(account, index)),
    );
    deps.output(
      '1. Continue with ChatGPT (add registration)\n2. Sign in again to a saved registration\n3. Enable ChatGPT plan usage for a saved registration\n4. Select a saved registration\n5. List visible models for the active account\n6. Sign out a saved registration\n0. Exit\n',
    );
    const answer = await deps.readLine('Action: ');
    if (answer === null || answer.trim() === '0')
      return wasCancelled(deps.signal) ? stopped(deps.signal) : 0;
    if (wasCancelled(deps.signal)) break;
    const action = answer.trim();
    if (!/^[1-6]$/u.test(action)) {
      deps.output('Choose a listed action.\n');
      continue;
    }
    try {
      if (action === '1') await signIn(session, deps);
      else if (action === '5') await showModels(session, deps);
      else {
        const account = await chooseAccount(session, deps);
        if (!account || wasCancelled(deps.signal)) continue;
        if (action === '2') await signIn(session, deps, account.key);
        else if (action === '4') {
          await session.selectAccount(account.key);
          if (!wasCancelled(deps.signal))
            deps.output(
              `Selected registration: ${operatorDisplayText(account.key)}. List models again for the active account.\n`,
            );
        } else {
          const prompt =
            action === '3'
              ? 'Request consent to use this registration’s ChatGPT plan? [y/N]: '
              : 'Clear this saved session and attempt remote revocation? [y/N]: ';
          const consent = await deps.readLine(prompt);
          if (
            consent === null ||
            wasCancelled(deps.signal) ||
            !/^y(?:es)?$/iu.test(consent.trim())
          )
            continue;
          if (action === '3') await signIn(session, deps, account.key, true);
          else await signOut(session, deps, account.key);
        }
      }
    } catch (error) {
      if (wasCancelled(deps.signal)) break;
      deps.error(`Account action failed (${errorCategory(error)}).\n`);
    }
  }
  return stopped(deps.signal);
}

/** Command dispatch owns no OAuth/store implementation and never performs inference. */
export async function runSubscriptionOperator(
  argv: readonly string[],
  deps: SubscriptionOperatorDependencies,
): Promise<number> {
  try {
    const args = parseSubscriptionOperatorArguments(argv);
    if (args.command === 'help') {
      deps.output(SUBSCRIPTION_OPERATOR_HELP);
      return 0;
    }
    if (args.command === 'manage' && !deps.interactive)
      throw new OperatorUsageError();
    if (wasCancelled(deps.signal)) return stopped(deps.signal);
    if (args.command === 'manage') deps.prepareInteractive();
    if (wasCancelled(deps.signal)) return stopped(deps.signal);
    const session = deps.createSession(args);
    if (args.command === 'manage') return await manage(session, deps);
    if (args.command === 'accounts') {
      const accounts = await session.listAccounts();
      if (wasCancelled(deps.signal)) return stopped(deps.signal);
      deps.output('Saved registration snapshot:\n');
      if (accounts.length === 0) deps.output('No saved registrations.\n');
      accounts.forEach((account, index) =>
        deps.output(accountRow(account, index)),
      );
    } else if (args.command === 'sign-in') {
      await signIn(session, deps, args.account, args.enablePlanUsage);
    } else if (args.command === 'models') await showModels(session, deps);
    else {
      if (args.account === undefined) throw new OperatorUsageError();
      if (args.command === 'select') {
        await session.selectAccount(args.account);
        if (!wasCancelled(deps.signal))
          deps.output(
            `Selected registration: ${operatorDisplayText(args.account)}. List models again for the active account.\n`,
          );
      } else await signOut(session, deps, args.account);
    }
    return wasCancelled(deps.signal) ? stopped(deps.signal) : 0;
  } catch (error) {
    if (wasCancelled(deps.signal)) return stopped(deps.signal);
    if (error instanceof OperatorUsageError) {
      deps.error(
        'Invalid command or configuration. Interactive manage requires a terminal. Use --help.\n',
      );
      return 2;
    }
    deps.error(
      `Account operation failed (${errorCategory(error)}). Check account status, private-directory permissions, browser availability and connectivity.\n`,
    );
    return 1;
  }
}
