import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        messageFormat: '({component}) {msg}',
      },
    }
  : undefined;

const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport,
});

/**
 * Create a child logger with a fixed component label.
 * Usage: const log = createLogger('ReActReasoner');
 *        log.info({ executionId, tool }, 'Executing action');
 */
export function createLogger(component: string) {
  return baseLogger.child({ component });
}

/** App-level logger for startup code in index.ts */
export const appLogger = createLogger('App');

/**
 * Create a logger with executionId (and optional requestId) bound to every line.
 * requestId ties the goal execution back to the originating HTTP request,
 * enabling full request→execution→tool call tracing in log aggregators.
 */
export function goalLogger(executionId: string, component: string, requestId?: string) {
  return baseLogger.child({ executionId, component, ...(requestId ? { requestId } : {}) });
}
