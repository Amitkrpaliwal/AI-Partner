/**
 * Resilience utilities — retry with exponential backoff for transient failures.
 * Used by MCPManager and other critical paths that interact with external services.
 */

export interface RetryOptions {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Base delay in milliseconds between retries (default: 1000) */
    baseDelayMs?: number;
    /** Maximum delay cap in milliseconds (default: 10000) */
    maxDelayMs?: number;
    /** Multiplier for exponential backoff (default: 2) */
    backoffMultiplier?: number;
    /** Custom function to determine if an error is retryable (default: all errors are retryable) */
    isRetryable?: (error: any) => boolean;
    /** Called on each retry attempt for logging/metrics */
    onRetry?: (attempt: number, error: any, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    isRetryable: () => true,
    onRetry: () => { },
};

/**
 * Execute a function with retry logic and exponential backoff.
 * Jitter is added to prevent thundering herd.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    options: RetryOptions = {}
): Promise<T> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let lastError: any;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;

            // Don't retry if we've exhausted attempts or error is not retryable
            if (attempt >= opts.maxRetries || !opts.isRetryable(error)) {
                break;
            }

            // Calculate delay with exponential backoff + jitter
            const baseDelay = opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt);
            const jitter = Math.random() * opts.baseDelayMs * 0.5;
            const delay = Math.min(baseDelay + jitter, opts.maxDelayMs);

            opts.onRetry(attempt + 1, error, delay);

            await sleep(delay);
        }
    }

    throw lastError;
}

/**
 * Non-retryable errors — validation errors, auth failures, not-found.
 */
export function isTransientError(error: any): boolean {
    const msg = (error?.message || '').toLowerCase();

    // These are permanent failures — don't retry
    const permanentPatterns = [
        'validation',
        'invalid argument',
        'not found',
        'unauthorized',
        'forbidden',
        'authentication',
        'isvalidationerror',
    ];

    if (permanentPatterns.some(p => msg.includes(p))) {
        return false;
    }

    // Network/timeout/connection errors are transient
    const transientPatterns = [
        'econnrefused',
        'econnreset',
        'etimedout',
        'epipe',
        'timeout',
        'network',
        'socket hang up',
        'aborted',
    ];

    if (transientPatterns.some(p => msg.includes(p))) {
        return true;
    }

    // Default: assume retryable for unknown errors
    return true;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
