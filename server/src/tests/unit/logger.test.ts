/**
 * Logger utility unit tests — no server required.
 */
import { describe, it, expect } from 'vitest';
import { createLogger, goalLogger, appLogger } from '../../utils/Logger';

describe('Logger', () => {
  it('createLogger returns an object with info/warn/error methods', () => {
    const log = createLogger('TestComponent');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('createLogger does not throw when logging a plain message', () => {
    const log = createLogger('TestComponent');
    expect(() => log.info('test message')).not.toThrow();
    expect(() => log.warn('test warning')).not.toThrow();
    expect(() => log.error('test error')).not.toThrow();
  });

  it('createLogger does not throw when logging structured fields', () => {
    const log = createLogger('TestComponent');
    expect(() => log.info({ tool: 'write_file', path: '/workspace/out.txt' }, 'Writing file')).not.toThrow();
  });

  it('goalLogger does not throw when logging with executionId context', () => {
    const log = goalLogger('exec-abc-123', 'ReActReasoner');
    expect(() => log.info({ tool: 'run_command' }, 'Executing action')).not.toThrow();
    expect(() => log.warn({ stuck_count: 3 }, 'Agent stuck')).not.toThrow();
  });

  it('appLogger is a pre-created logger instance', () => {
    expect(typeof appLogger.info).toBe('function');
    expect(() => appLogger.info('App starting up')).not.toThrow();
  });

  it('logger with Error object does not throw', () => {
    const log = createLogger('ErrorTest');
    const err = new Error('something went wrong');
    expect(() => log.error({ err }, 'Caught an error')).not.toThrow();
  });
});
