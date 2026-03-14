/**
 * Security utilities for SSRF protection, command validation, path safety,
 * and dynamic code validation.
 *
 * Used by: WebSearchServer, BrowserServer, GoalValidator, DynamicToolRegistry
 */

import { URL } from 'url';
import path from 'path';
import net from 'net';

// ============================================================================
// URL / SSRF PROTECTION
// ============================================================================

/** IP ranges that resolve to internal/private networks */
const BLOCKED_IP_RANGES = [
    /^127\./,                          // Loopback
    /^10\./,                           // Class A private
    /^172\.(1[6-9]|2[0-9]|3[01])\./,  // Class B private
    /^192\.168\./,                     // Class C private
    /^169\.254\./,                     // Link-local / AWS metadata
    /^0\./,                            // Current network
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // Carrier-grade NAT
];

const BLOCKED_PROTOCOLS = new Set([
    'file:', 'ftp:', 'gopher:', 'data:', 'javascript:', 'vbscript:',
    'blob:', 'about:', 'chrome:', 'resource:'
]);

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'metadata.google.internal',
    'metadata',
    'metadata.internal',
]);

/**
 * Validate that a URL is safe to fetch (no SSRF).
 * Only allows http: and https: to public internet hosts.
 */
export function isUrlSafe(urlString: string): { safe: boolean; reason?: string } {
    try {
        const parsed = new URL(urlString);

        // Block dangerous protocols
        if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
            return { safe: false, reason: `Blocked protocol: ${parsed.protocol}` };
        }

        // Only allow http/https
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { safe: false, reason: `Only HTTP/HTTPS allowed, got: ${parsed.protocol}` };
        }

        const hostname = parsed.hostname.toLowerCase();

        // Block known internal hostnames
        if (BLOCKED_HOSTNAMES.has(hostname)) {
            return { safe: false, reason: `Blocked internal hostname: ${hostname}` };
        }

        // Block .internal TLD
        if (hostname.endsWith('.internal')) {
            return { safe: false, reason: `Blocked .internal domain: ${hostname}` };
        }

        // Block private/internal IPs (IPv4)
        if (net.isIPv4(hostname)) {
            for (const range of BLOCKED_IP_RANGES) {
                if (range.test(hostname)) {
                    return { safe: false, reason: `Blocked private/internal IP: ${hostname}` };
                }
            }
        }

        // Block IPv6 loopback and private
        if (net.isIPv6(hostname) || hostname.startsWith('[')) {
            const cleanIp = hostname.replace(/^\[|\]$/g, '');
            if (cleanIp === '::1' || cleanIp.startsWith('fc00:') || cleanIp.startsWith('fe80:') || cleanIp.startsWith('fd')) {
                return { safe: false, reason: `Blocked private IPv6: ${hostname}` };
            }
        }

        // Block cloud metadata IPs explicitly
        if (hostname === '169.254.169.254') {
            return { safe: false, reason: 'Blocked cloud metadata endpoint' };
        }

        return { safe: true };
    } catch {
        return { safe: false, reason: 'Invalid URL format' };
    }
}

// ============================================================================
// PATH SAFETY
// ============================================================================

/**
 * Validate that a file path stays within the allowed directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 */
export function isPathSafe(filePath: string, allowedDir: string): { safe: boolean; resolved: string; reason?: string } {
    const resolved = path.resolve(allowedDir, filePath);
    const normalizedAllowed = path.resolve(allowedDir);

    if (!resolved.startsWith(normalizedAllowed + path.sep) && resolved !== normalizedAllowed) {
        return { safe: false, resolved, reason: `Path traversal: escapes ${allowedDir}` };
    }

    return { safe: true, resolved };
}

// ============================================================================
// COMMAND SAFETY (for GoalValidator)
// ============================================================================

/** Patterns that indicate destructive/dangerous operations */
const DANGEROUS_COMMAND_PATTERNS = [
    /rm\s+(-[a-z]*r[a-z]*f|--recursive)/i,  // rm -rf
    /del\s+\/[sqf]/i,                        // Windows del with force flags
    /format\s+[a-z]:/i,                      // format drive
    /mkfs/i,                                  // make filesystem
    /dd\s+if=/i,                              // disk destroyer
    />\s*\/dev\//,                            // redirect to devices
    /shutdown/i,                              // shutdown system
    /reboot/i,                                // reboot system
    /init\s+[06]/,                            // init runlevel change
    /reg\s+(add|delete)/i,                    // Windows registry modification
    /net\s+(user|localgroup)\s/i,             // Windows user management
    /chmod\s+[0-7]*777/,                      // World-writable permissions
    /chown\s+root/,                           // Change ownership to root
    /\|\s*(ba)?sh\s*$/,                       // Pipe to shell
    /curl[^|]*\|\s*(ba)?sh/i,                // curl | sh
    /wget[^|]*\|\s*(ba)?sh/i,                // wget | sh
    /powershell\s+.*-e(ncodedcommand)?\s/i,  // PS encoded command
];

/** Shell metacharacters that enable injection */
const SHELL_INJECTION_PATTERNS = [
    /`[^`]+`/,         // Backtick command substitution
    /\$\([^)]+\)/,     // $() subshell
    // Note: semicolons are intentionally allowed — they appear legitimately in Python one-liners
    // (e.g. python3 -c "import statistics; print(43)") and are not reliably distinguishable
    // from real injection at the string level without a full shell parser.
];

/**
 * Check if a command is safe to execute.
 * Blocks destructive patterns and shell injection.
 */
export function isCommandSafe(command: string): { safe: boolean; reason?: string } {
    const trimmed = command.trim();

    if (!trimmed) {
        return { safe: false, reason: 'Empty command' };
    }

    // Block destructive patterns
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { safe: false, reason: `Dangerous command pattern blocked` };
        }
    }

    // Block shell injection
    for (const pattern of SHELL_INJECTION_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { safe: false, reason: `Shell injection pattern detected` };
        }
    }

    return { safe: true };
}

// ============================================================================
// DYNAMIC TOOL CODE SAFETY
// ============================================================================

/** Code patterns that shouldn't appear in sandboxed tool code */
const DANGEROUS_CODE_PATTERNS = [
    { pattern: /require\s*\(\s*['"]child_process['"]/, reason: 'child_process access' },
    { pattern: /require\s*\(\s*['"]fs['"]/, reason: 'filesystem access' },
    { pattern: /require\s*\(\s*['"]net['"]/, reason: 'network access' },
    { pattern: /require\s*\(\s*['"]http['"]/, reason: 'HTTP access' },
    { pattern: /require\s*\(\s*['"]https['"]/, reason: 'HTTPS access' },
    { pattern: /require\s*\(\s*['"]os['"]/, reason: 'OS access' },
    { pattern: /require\s*\(\s*['"]path['"]/, reason: 'path access' },
    { pattern: /require\s*\(\s*['"]dgram['"]/, reason: 'UDP access' },
    { pattern: /require\s*\(\s*['"]cluster['"]/, reason: 'cluster access' },
    { pattern: /process\.exit/, reason: 'process.exit' },
    { pattern: /process\.env/, reason: 'environment variable access' },
    { pattern: /process\.kill/, reason: 'process.kill' },
    { pattern: /process\.binding/, reason: 'process.binding' },
    { pattern: /\beval\s*\(/, reason: 'eval() usage' },
    { pattern: /\bFunction\s*\(/, reason: 'Function constructor' },
    { pattern: /import\s*\(/, reason: 'dynamic import' },
    { pattern: /globalThis\b/, reason: 'globalThis access' },
    { pattern: /\bglobal\./, reason: 'global object access' },
    { pattern: /\bglobal\[/, reason: 'global object access' },
    { pattern: /constructor\s*\[\s*['"]constructor['"]/, reason: 'sandbox escape via constructor' },
    { pattern: /this\s*\.\s*constructor/, reason: 'potential sandbox escape' },
    { pattern: /__proto__/, reason: 'prototype pollution' },
    { pattern: /Object\.setPrototypeOf/, reason: 'prototype modification' },
];

/**
 * Validate dynamic tool code for dangerous patterns.
 * This is a defense-in-depth layer — not a complete sandbox.
 */
export function isToolCodeSafe(code: string): { safe: boolean; reason?: string } {
    for (const { pattern, reason } of DANGEROUS_CODE_PATTERNS) {
        if (pattern.test(code)) {
            return { safe: false, reason: `Dangerous code pattern: ${reason}` };
        }
    }
    return { safe: true };
}

/**
 * Audit log helper — records security-relevant events.
 */
export function logSecurityEvent(
    level: 'info' | 'warn' | 'block',
    source: string,
    message: string,
    details?: Record<string, any>
): void {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        source,
        message,
        ...(details ? { details } : {})
    };

    if (level === 'block') {
        console.warn(`[SECURITY:BLOCK] [${source}] ${message}`, details || '');
    } else if (level === 'warn') {
        console.warn(`[SECURITY:WARN] [${source}] ${message}`, details || '');
    } else {
        console.log(`[SECURITY:INFO] [${source}] ${message}`);
    }
}
