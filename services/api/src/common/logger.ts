import { pino, type Logger, type LoggerOptions } from 'pino';
import { scrub } from './scrub.js';

export interface LoggerConfig {
  level: string;
  stream?: NodeJS.WritableStream;
}

/**
 * Structured JSON logger. Every argument passes through the scrubber before pino sees it,
 * so a stray email address, token or draft text cannot reach the output.
 */
export function buildLogger({ level, stream }: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: 'api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args, method) {
        const first = args[0];
        const cleaned =
          first instanceof Error
            ? [{ err: scrub(first) }, ...args.slice(1).map((a) => scrub(a))]
            : args.map((a) => scrub(a));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pino's overloaded log signature cannot be expressed for a spread
        (method as (...a: any[]) => void).apply(this, cleaned);
      },
    },
  };
  return stream ? pino(options, stream) : pino(options);
}
