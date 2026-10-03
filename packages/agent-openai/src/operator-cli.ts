#!/usr/bin/env node
import { createOpenAiSubscriptionFileStore } from './lib/subscription-store.js';
import { createOpenAiSubscriptionSession } from './lib/subscription-session.js';
import { runSubscriptionOperator } from './lib/subscription-operator.js';
import { createOperatorBrowserOpener } from './lib/operator-browser.js';
import { createOperatorPrompt } from './lib/operator-terminal.js';

const controller = new AbortController();
let prompt: ReturnType<typeof createOperatorPrompt> | undefined;
const stop = (reason: 'SIGINT' | 'SIGTERM') => {
  controller.abort(reason);
  prompt?.close();
};
const onInterrupt = () => stop('SIGINT');
const onTerminate = () => stop('SIGTERM');
const prepareInteractive = () => {
  prompt ??= createOperatorPrompt(process.stdin, process.stdout, (reason) =>
    controller.abort(reason),
  );
};
const onOutputError = () => {
  controller.abort('io-error');
  prompt?.close();
  process.exitCode = 1;
};
process.stdout.on('error', onOutputError);
process.stderr.on('error', onOutputError);
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
try {
  process.exitCode = await runSubscriptionOperator(process.argv.slice(2), {
    createSession: ({ directory, hosting }) =>
      createOpenAiSubscriptionSession({
        hosting,
        store: createOpenAiSubscriptionFileStore({ directory }),
      }),
    output: (text) => {
      process.stdout.write(text);
    },
    error: (text) => {
      process.stderr.write(text);
    },
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    prepareInteractive,
    readLine: (text) => prompt?.readLine(text) ?? Promise.resolve(null),
    openAuthorizationUrl: createOperatorBrowserOpener({
      signal: controller.signal,
    }),
    signal: controller.signal,
  });
} finally {
  prompt?.close();
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
  // Pending native writes may fail after dispatch; retain the owned sinks until drained.
  process.once('beforeExit', () => {
    process.stdout.removeListener('error', onOutputError);
    process.stderr.removeListener('error', onOutputError);
  });
}
