import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Own the prompt interface, but leave caller streams/listeners intact. */
export function createOperatorPrompt(
  input: Readable,
  output: Writable,
  onEof: (reason: 'eof' | 'io-error') => void,
) {
  const reader = createInterface({ input, terminal: false, historySize: 0 });
  let closed = false;
  let finishing = false;
  let failed = false;
  let pending: ((line: string | null) => void) | undefined;
  const lines: string[] = [];
  // Input failures must close/cancel without surfacing stream diagnostics.
  reader.on('error', () => {
    failed = true;
    reader.close();
  });
  reader.on('line', (line: string) => {
    if (closed) return;
    if (line.length > 1024 || lines.length >= 16) {
      reader.close();
      return;
    }
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve(line);
    } else lines.push(line);
  });
  reader.once('close', () => {
    closed = true;
    lines.length = 0;
    pending?.(null);
    pending = undefined;
    input.pause();
    if (!finishing) onEof(failed ? 'io-error' : 'eof');
  });
  return {
    readLine(prompt: string): Promise<string | null> {
      if (closed || input.readableEnded || input.destroyed)
        return Promise.resolve(null);
      output.write(prompt);
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (pending) return Promise.resolve(null);
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    close() {
      finishing = true;
      reader.close();
    },
  };
}
