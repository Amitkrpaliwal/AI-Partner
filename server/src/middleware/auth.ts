/**
 * Authentication Middleware — JWT-based auth with API key support.
 *
 * Flow:
 * 1. User logs in via POST /api/auth/login → gets JWT
 * 2. JWT sent via Authorization header or httpOnly cookie
 * 3. API keys sent via X-API-Key header (for programmatic access)
 *
 * Public routes (no auth required):
 * - POST /api/auth/login
 * - GET  /api/health
 * - GET  /api/auth/status
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../database';

// ============================================================================
// TYPES
// ============================================================================

export interface AuthRequest extends Request {
    userId?: string;
    username?: string;
    authMethod?: 'jwt' | 'apikey' | 'none';
}

export interface JWTPayload {
    userId: string;
    username: string;
    iat: number;
    exp: number;
}

// ============================================================================
// CONFIG
// ============================================================================

const JWT_SECRET = process.env.AI_PARTNER_JWT_SECRET || 'ai-partner-dev-secret-change-in-production';
const JWT_EXPIRY = '24h';
const API_KEY_HEADER = 'x-api-key';

// Warn about insecure default secret
if (!process.env.AI_PARTNER_JWT_SECRET && process.env.AI_PARTNER_AUTH_ENABLED === 'true') {
    console.warn('\n⚠️  WARNING: Using default JWT secret with auth enabled!');
    console.warn('   Set AI_PARTNER_JWT_SECRET to a secure random value in production.\n');
}

/** Routes that don't require authentication */
const PUBLIC_ROUTES = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/status',
    '/api/health',
    '/api/setup/status',
    '/api/setup/complete',
];

// ============================================================================
// JWT HELPERS
// ============================================================================

/**
 * Generate a JWT for a user.
 */
export function generateToken(userId: string, username: string): string {
    return jwt.sign(
        { userId, username } as Partial<JWTPayload>,
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
}

/**
 * Verify and decode a JWT.
 */
export function verifyToken(token: string): JWTPayload | null {
    try {
        return jwt.verify(token, JWT_SECRET) as JWTPayload;
    } catch {
        return null;
    }
}

// ============================================================================
// API KEY HELPERS
// ============================================================================

/**
 * Initialize the auth tables (users, api_keys).
 */
export async function initializeAuthTables(): Promise<void> {
    await db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            last_login TEXT
        )
    `);

    await db.run(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            name TEXT DEFAULT 'default',
            created_at TEXT DEFAULT (datetime('now')),
            last_used TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
}

/**
 * Validate an API key.
 */
async function validateApiKey(apiKey: string): Promise<{ userId: string; username: string } | null> {
    try {
        const bcrypt = await import('bcryptjs');
        const keys = await db.all('SELECT ak.key_hash, ak.user_id, u.username FROM api_keys ak JOIN users u ON ak.user_id = u.id');

        for (const row of keys) {
            if (bcrypt.compareSync(apiKey, row.key_hash)) {
                // Update last_used
                await db.run('UPDATE api_keys SET last_used = datetime("now") WHERE key_hash = ?', [row.key_hash]);
                return { userId: row.user_id, username: row.username };
            }
        }
    } catch {
        // DB not ready or no keys
    }
    return null;
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

/**
 * Authentication middleware.
 * Checks JWT (header or cookie) and API key.
 * Public routes bypass auth.
 */
export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
    // Skip auth for public routes
    const path = req.path.toLowerCase();
    if (PUBLIC_ROUTES.some(r => path.startsWith(r))) {
        req.userId = 'anonymous';
        req.authMethod = 'none';
        next();
        return;
    }

    // Check auth state — allow through if auth is disabled
    if (process.env.AI_PARTNER_AUTH_ENABLED !== 'true') {
        req.userId = 'default';
        req.username = 'default';
        req.authMethod = 'none';
        next();
        return;
    }

    // Try JWT from Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const payload = verifyToken(token);
        if (payload) {
            req.userId = payload.userId;
            req.username = payload.username;
            req.authMethod = 'jwt';
            next();
            return;
        }
    }

    // Try JWT from cookie
    const cookieToken = req.cookies?.['ai_partner_token'];
    if (cookieToken) {
        const payload = verifyToken(cookieToken);
        if (payload) {
            req.userId = payload.userId;
            req.username = payload.username;
            req.authMethod = 'jwt';
            next();
            return;
        }
    }

    // Try API key
    const apiKey = req.headers[API_KEY_HEADER] as string;
    if (apiKey) {
        validateApiKey(apiKey).then(user => {
            if (user) {
                req.userId = user.userId;
                req.username = user.username;
                req.authMethod = 'apikey';
                next();
            } else {
                res.status(401).json({ error: 'Invalid API key' });
            }
        }).catch(() => {
            res.status(500).json({ error: 'Auth validation failed' });
        });
        return;
    }

    // No valid auth found
    res.status(401).json({ error: 'Authentication required. Provide JWT or API key.' });
}
