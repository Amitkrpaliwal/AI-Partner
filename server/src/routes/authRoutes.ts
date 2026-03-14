/**
 * Authentication API Routes
 *
 * POST /api/auth/login     - Login with username + password
 * POST /api/auth/register  - Create first user (only if no users exist)
 * POST /api/auth/refresh   - Refresh JWT token
 * POST /api/auth/apikey     - Generate API key (requires JWT)
 * GET  /api/auth/status     - Check auth status
 * POST /api/auth/logout     - Clear auth cookie
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../database';
import {
    AuthRequest,
    generateToken,
    verifyToken,
    initializeAuthTables
} from '../middleware/auth';
import { auditLogger } from '../services/AuditLogger';

export const authRoutes = Router();

// Ensure tables exist on first import
let tablesInitialized = false;
async function ensureTables() {
    if (!tablesInitialized) {
        await initializeAuthTables();
        tablesInitialized = true;
    }
}

/**
 * GET /api/auth/status
 * Check if auth is enabled and if users exist.
 */
authRoutes.get('/status', async (_req: Request, res: Response) => {
    try {
        await ensureTables();

        const authEnabled = process.env.AI_PARTNER_AUTH_ENABLED === 'true';
        const userCount = await db.get('SELECT COUNT(*) as count FROM users');

        res.json({
            authEnabled,
            hasUsers: (userCount?.count || 0) > 0,
            requiresSetup: authEnabled && (userCount?.count || 0) === 0,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/auth/register
 * Create the first admin user. Only works if no users exist.
 *
 * Body: { username: string, password: string }
 */
authRoutes.post('/register', async (req: Request, res: Response) => {
    try {
        await ensureTables();

        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
            return res.status(400).json({ error: 'Password must contain at least one uppercase letter and one number' });
        }

        // Only allow registration if no users exist
        const userCount = await db.get('SELECT COUNT(*) as count FROM users');
        if ((userCount?.count || 0) > 0) {
            return res.status(403).json({ error: 'Users already exist. Use login instead.' });
        }

        const userId = `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const passwordHash = bcrypt.hashSync(password, 10);

        await db.run(
            'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)',
            [userId, username.toLowerCase(), passwordHash]
        );

        const token = generateToken(userId, username.toLowerCase());

        // Set httpOnly cookie
        res.cookie('ai_partner_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
        });

        auditLogger.logAuth('register', { username: username.toLowerCase() }, { userId, ip: req.ip });

        res.json({
            success: true,
            message: 'User created successfully',
            token,
            userId,
            username: username.toLowerCase(),
        });
    } catch (error: any) {
        if (error.message?.includes('UNIQUE constraint')) {
            return res.status(409).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/auth/login
 * Login with username + password.
 *
 * Body: { username: string, password: string }
 */
authRoutes.post('/login', async (req: Request, res: Response) => {
    try {
        await ensureTables();

        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const user = await db.get(
            'SELECT id, username, password_hash FROM users WHERE username = ?',
            [username.toLowerCase()]
        );

        if (!user) {
            auditLogger.logAuth('login_failed', { username: username.toLowerCase(), reason: 'user_not_found' }, { ip: req.ip });
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        if (!bcrypt.compareSync(password, user.password_hash)) {
            auditLogger.logAuth('login_failed', { username: username.toLowerCase(), reason: 'wrong_password' }, { ip: req.ip });
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        // Update last_login
        await db.run('UPDATE users SET last_login = datetime("now") WHERE id = ?', [user.id]);

        const token = generateToken(user.id, user.username);

        auditLogger.logAuth('login', { username: user.username }, { userId: user.id, ip: req.ip });

        // Set httpOnly cookie
        res.cookie('ai_partner_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
        });

        res.json({
            success: true,
            token,
            userId: user.id,
            username: user.username,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/auth/logout
 * Clear the auth cookie.
 */
authRoutes.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie('ai_partner_token');
    res.json({ success: true, message: 'Logged out' });
});

/**
 * POST /api/auth/refresh
 * Refresh the JWT token. Requires a valid (not expired) token.
 */
authRoutes.post('/refresh', async (req: AuthRequest, res: Response) => {
    try {
        // Extract token from header or cookie
        const authHeader = req.headers.authorization;
        const cookieToken = req.cookies?.['ai_partner_token'];
        const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : cookieToken;

        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const payload = verifyToken(token);
        if (!payload) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        // Verify user still exists
        const user = await db.get('SELECT id, username FROM users WHERE id = ?', [payload.userId]);
        if (!user) {
            return res.status(401).json({ error: 'User no longer exists' });
        }

        const newToken = generateToken(user.id, user.username);

        res.cookie('ai_partner_token', newToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
        });

        res.json({
            success: true,
            token: newToken,
            userId: user.id,
            username: user.username,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/auth/apikey
 * Generate an API key for the authenticated user.
 * Requires JWT auth.
 *
 * Body: { name?: string }
 */
authRoutes.post('/apikey', async (req: AuthRequest, res: Response) => {
    try {
        await ensureTables();

        // Verify the user is authenticated
        const authHeader = req.headers.authorization;
        let userId: string | undefined;

        if (authHeader?.startsWith('Bearer ')) {
            const payload = verifyToken(authHeader.substring(7));
            if (payload) userId = payload.userId;
        }

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required to generate API key' });
        }

        const keyName = req.body.name || 'default';
        const rawKey = `aip_${crypto.randomBytes(24).toString('hex')}`;
        const keyHash = bcrypt.hashSync(rawKey, 10);
        const keyId = `key_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        await db.run(
            'INSERT INTO api_keys (id, user_id, key_hash, name) VALUES (?, ?, ?, ?)',
            [keyId, userId, keyHash, keyName]
        );

        auditLogger.logAuth('apikey_created', { keyId, name: keyName }, { userId, ip: req.ip });

        res.json({
            success: true,
            apiKey: rawKey,  // Only shown once
            keyId,
            name: keyName,
            message: 'Save this key — it cannot be retrieved later.',
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/auth/keys
 * List API keys for the authenticated user (hashed, not raw).
 */
authRoutes.get('/keys', async (req: AuthRequest, res: Response) => {
    try {
        await ensureTables();

        const authHeader = req.headers.authorization;
        let userId: string | undefined;

        if (authHeader?.startsWith('Bearer ')) {
            const payload = verifyToken(authHeader.substring(7));
            if (payload) userId = payload.userId;
        }

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const keys = await db.all(
            'SELECT id, name, created_at, last_used FROM api_keys WHERE user_id = ?',
            [userId]
        );

        res.json({ success: true, keys });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default authRoutes;
