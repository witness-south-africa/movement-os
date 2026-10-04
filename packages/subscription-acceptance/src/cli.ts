import {
  createOpenAiSubscriptionFileStore,
  createOperatorBrowserOpener,
  createOperatorManualBrowserOpener,
  createOperatorPrompt,
} from '@wsa/agent-openai/subscription-auth';
import {
  runAcceptance,
  type AcceptanceConfig,
  type BuildProvenance,
} from './index.js';

/** Only the source-verifying bootstrap invokes this operator entry point. */
export async function runCli(
  config: AcceptanceConfig,
  provenance: BuildProvenance,
) {
  if (
    config.browser !== undefined &&
    !['system', 'manual'].includes(config.browser)
  )
    throw new Error('Invalid browser selection.');
  const controller = new AbortController();
  let prompt: ReturnType<typeof createOperatorPrompt> | undefined;
  const stop = () => {
    controller.abort();
    prompt?.close();
  };
  const onOutputError = () => {
    stop();
    process.exitCode = 1;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.on('error', onOutputError);
  process.stderr.on('error', onOutputError);
  try {
    return await runAcceptance(config, provenance, {
      store: createOpenAiSubscriptionFileStore({ directory: config.directory }),
      fetch: globalThis.fetch,
      signal: controller.signal,
      openAuthorizationUrl: async (url) => {
        if (config.browser === 'manual') {
          prompt ??= createOperatorPrompt(process.stdin, process.stderr, stop);
          await createOperatorManualBrowserOpener({
            signal: controller.signal,
            display: (authorizationUrl) =>
              new Promise<void>((resolve, reject) => {
                process.stderr.write(
                  'Open this fresh sign-in link in your preferred browser on this computer.\n' +
                    'Keep this terminal open; the local callback expires after five minutes.\n' +
                    `${authorizationUrl}\n`,
                  (error) => {
                    if (error) {
                      onOutputError();
                      reject(new Error('Operator output failed.'));
                    } else resolve();
                  },
                );
              }),
          })(url);
        } else {
          process.stderr.write(
            'Choose the ChatGPT account and plan-use consent in your system default browser.\n',
          );
          await createOperatorBrowserOpener({ signal: controller.signal })(url);
        }
      },
      chooseModel: async (models) => {
        if (!process.stdin.isTTY || models.length === 0) return undefined;
        // Escape model labels; never display account labels or authorization URLs.
        for (const [index, model] of models.entries())
          process.stderr.write(
            `${String(index + 1)}. ${JSON.stringify(model.slug)}\n`,
          );
        prompt ??= createOperatorPrompt(process.stdin, process.stderr, stop);
        const timer = setTimeout(stop, 300_000);
        try {
          const answer = await prompt.readLine(
            'Choose a visible model number: ',
          );
          if (!answer || !/^[1-9][0-9]{0,3}$/.test(answer)) return undefined;
          return models[Number(answer) - 1]?.slug;
        } finally {
          clearTimeout(timer);
        }
      },
    });
  } finally {
    prompt?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.once('beforeExit', () => {
      process.stdout.removeListener('error', onOutputError);
      process.stderr.removeListener('error', onOutputError);
    });
  }
}
