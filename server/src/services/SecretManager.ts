/**
 * SecretManager — AES-256-GCM encrypted credential storage.
 *
 * Provides per-user encrypted secret storage for API keys, bot tokens,
 * and other sensitive credentials. Secrets are encrypted at rest using
 * AES-256-GCM with a master key derived from environment configuration.
 *
 * Usage:
 *   await secretManager.setSecret('default', 'TELEGRAM_BOT_TOKEN', 'abc123');
 *   const token = await secretManager.getSecret('default', 'TELEGRAM_BOT_TOKEN');
 *   await secretManager.deleteSecret('default', 'TELEGRAM_BOT_TOKEN');
 *   const names = await secretManager.listSecrets('default');
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { db } from '../database';

// ============================================================================
// CONSTANTS
// ============================================================================

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const TAG_LENGTH = 16; // 128 bits
const SALT = 'ai-partner-secret-salt-v1';

// ============================================================================
// SECRET MANAGER
// ============================================================================

export class SecretManager {
    private masterKey: Buffer | null = null;
    private initialized = false;

    /**
     * Initialize: create table and derive master key.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        // Table created via migration 003_secrets.sql — no inline DDL needed
        this.masterKey = this.deriveMasterKey();
        this.initialized = true;
        console.log('[SecretManager] Initialized with AES-256-GCM encryption');
    }

    /**
     * Derive the 256-bit master key from environment or persisted file.
     */
    private deriveMasterKey(): Buffer {
        let masterSecret = process.env.AI_PARTNER_MASTER_KEY;

        if (!masterSecret) {
            // Try loading from persisted file
            const dataDir = process.env.AI_PARTNER_DATA_DIR || path.join(process.cwd(), 'data');
            const keyFile = path.join(dataDir, '.master.key');

            if (fs.existsSync(keyFile)) {
                masterSecret = fs.readFileSync(keyFile, 'utf-8').trim();
            } else {
                // Auto-generate and persist
                masterSecret = crypto.randomBytes(32).toString('hex');
                if (!fs.existsSync(dataDir)) {
                    fs.mkdirSync(dataDir, { recursive: true });
                }
                fs.writeFileSync(keyFile, masterSecret, { mode: 0o600 });
                console.log('[SecretManager] Generated and saved master key to', keyFile);
            }
        }

        // Derive using PBKDF2
        return crypto.pbkdf2Sync(masterSecret, SALT, 100_000, KEY_LENGTH, 'sha512');
    }

    /**
     * Encrypt a plaintext value.
     */
    private encrypt(plaintext: string): { encrypted: string; iv: string; tag: string } {
        if (!this.masterKey) throw new Error('SecretManager not initialized');

        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv, {
            authTagLength: TAG_LENGTH,
        });

        let encrypted = cipher.update(plaintext, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        const tag = cipher.getAuthTag();

        return {
            encrypted,
            iv: iv.toString('base64'),
            tag: tag.toString('base64'),
        };
    }

    /**
     * Decrypt an encrypted value.
     */
    private decrypt(encrypted: string, ivB64: string, tagB64: string): string {
        if (!this.masterKey) throw new Error('SecretManager not initialized');

        const iv = Buffer.from(ivB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');

        const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv, {
            authTagLength: TAG_LENGTH,
        });
        decipher.setAuthTag(tag);

        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    // ========================================================================
    // PUBLIC API
    // ========================================================================

    /**
     * Store or update an encrypted secret.
     */
    async setSecret(userId: string, name: string, value: string): Promise<void> {
        await this.initialize();

        const { encrypted, iv, tag } = this.encrypt(value);
        const id = crypto.randomUUID();

        await db.run(
            `INSERT INTO secrets (id, user_id, name, encrypted_value, iv, tag)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, name) DO UPDATE SET
                encrypted_value = excluded.encrypted_value,
                iv = excluded.iv,
                tag = excluded.tag,
                updated_at = datetime('now')`,
            [id, userId, name, encrypted, iv, tag]
        );
    }

    /**
     * Retrieve and decrypt a secret. Returns null if not found.
     */
    async getSecret(userId: string, name: string): Promise<string | null> {
        await this.initialize();

        const row = await db.get(
            'SELECT encrypted_value, iv, tag FROM secrets WHERE user_id = ? AND name = ?',
            [userId, name]
        );

        if (!row) return null;

        try {
            return this.decrypt(row.encrypted_value, row.iv, row.tag);
        } catch (error: any) {
            console.error(`[SecretManager] Failed to decrypt secret "${name}":`, error.message);
            return null;
        }
    }

    /**
     * Delete a secret.
     */
    async deleteSecret(userId: string, name: string): Promise<boolean> {
        await this.initialize();

        const row = await db.get(
            'SELECT id FROM secrets WHERE user_id = ? AND name = ?',
            [userId, name]
        );

        if (!row) return false;

        await db.run('DELETE FROM secrets WHERE user_id = ? AND name = ?', [userId, name]);
        return true;
    }

    /**
     * List all secret names for a user (never returns values).
     */
    async listSecrets(userId: string): Promise<Array<{ name: string; createdAt: string; updatedAt: string }>> {
        await this.initialize();

        const rows = await db.all(
            'SELECT name, created_at, updated_at FROM secrets WHERE user_id = ? ORDER BY name',
            [userId]
        );

        return rows.map((r: any) => ({
            name: r.name,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));
    }

    /**
     * Check if a specific secret exists.
     */
    async hasSecret(userId: string, name: string): Promise<boolean> {
        await this.initialize();

        const row = await db.get(
            'SELECT 1 FROM secrets WHERE user_id = ? AND name = ?',
            [userId, name]
        );

        return !!row;
    }

    /**
     * Get a secret or throw if missing. Useful for required credentials.
     */
    async requireSecret(userId: string, name: string): Promise<string> {
        const value = await this.getSecret(userId, name);
        if (value === null) {
            throw new Error(`Required secret "${name}" not found for user "${userId}"`);
        }
        return value;
    }

    /**
     * Load all secrets for a user into process.env.
     * Called at startup so integrations that read process.env pick up saved credentials.
     * Existing env vars are NOT overwritten (so .env file takes precedence).
     */
    async loadIntoEnv(userId: string): Promise<void> {
        await this.initialize();
        const rows = await db.all(
            'SELECT name, encrypted_value, iv, tag FROM secrets WHERE user_id = ?',
            [userId]
        );
        let loaded = 0;
        for (const row of rows) {
            try {
                // Don't overwrite values already set in environment (e.g. via .env file)
                if (process.env[row.name]) continue;
                const value = this.decrypt(row.encrypted_value, row.iv, row.tag);
                process.env[row.name] = value;
                loaded++;
            } catch (e: any) {
                console.warn(`[SecretManager] Failed to load "${row.name}" into env:`, e.message);
            }
        }
        if (loaded > 0) console.log(`[SecretManager] Loaded ${loaded} secrets into process.env`);
    }
}

// Singleton
export const secretManager = new SecretManager();
