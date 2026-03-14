import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database';
import {
    chatRouter,
    DiscordAdapter,
    TelegramAdapter,
    AdapterConfig
} from '../adapters/ChatAdapters';
import { messagingGateway } from '../services/MessagingGateway';

const router = Router();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function getAdapterConfig(platform: string): Promise<AdapterConfig | null> {
    try {
        const row = await db.get(
            'SELECT * FROM chat_adapter_configs WHERE platform = ?',
            [platform]
        );

        if (!row) return null;

        return {
            enabled: row.enabled === 1 || row.enabled === true,
            token: row.token,
            botUsername: row.bot_username,
            allowedUsers: JSON.parse(row.allowed_users || '[]'),
            allowedChannels: JSON.parse(row.allowed_channels || '[]')
        };
    } catch (e) {
        console.error(`[ChatRoutes] Error getting config for ${platform}:`, e);
        return null;
    }
}

async function saveAdapterConfig(platform: string, config: AdapterConfig): Promise<void> {
    const existing = await db.get(
        'SELECT id FROM chat_adapter_configs WHERE platform = ?',
        [platform]
    );

    if (existing) {
        await db.run(
            `UPDATE chat_adapter_configs SET
                enabled = ?, token = ?, bot_username = ?,
                allowed_users = ?, allowed_channels = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE platform = ?`,
            [
                config.enabled ? 1 : 0,
                config.token || null,
                config.botUsername || null,
                JSON.stringify(config.allowedUsers || []),
                JSON.stringify(config.allowedChannels || []),
                platform
            ]
        );
    } else {
        await db.run(
            `INSERT INTO chat_adapter_configs
                (id, platform, enabled, token, bot_username, allowed_users, allowed_channels)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                uuidv4(),
                platform,
                config.enabled ? 1 : 0,
                config.token || null,
                config.botUsername || null,
                JSON.stringify(config.allowedUsers || []),
                JSON.stringify(config.allowedChannels || [])
            ]
        );
    }
}

// ============================================================================
// INITIALIZATION - Called on server startup
// ============================================================================

export async function initializeChatAdapters(): Promise<void> {
    console.log('[ChatRoutes] Initializing chat adapters from saved configs...');

    // Try to initialize Discord
    const discordConfig = await getAdapterConfig('discord');
    if (discordConfig?.enabled && discordConfig.token) {
        console.log('[ChatRoutes] Found saved Discord config, attempting to connect...');
        const adapter = new DiscordAdapter();
        const success = await chatRouter.registerAdapter(adapter, discordConfig);
        if (success) {
            console.log('[ChatRoutes] Discord adapter connected from saved config');
        } else {
            console.log('[ChatRoutes] Discord adapter failed to connect. Check token.');
        }
    }

    // Try to initialize Telegram
    const telegramConfig = await getAdapterConfig('telegram');
    if (telegramConfig?.enabled && telegramConfig.token) {
        console.log('[ChatRoutes] Found saved Telegram config, attempting to connect...');
        const adapter = new TelegramAdapter();
        const success = await chatRouter.registerAdapter(adapter, telegramConfig);
        if (success) {
            console.log('[ChatRoutes] Telegram adapter connected from saved config');
        } else {
            console.log('[ChatRoutes] Telegram adapter failed to connect. Check token.');
        }
    }
}

// ============================================================================
// API ROUTES
// ============================================================================

/**
 * GET /api/chat/adapters/status
 * Get status of all chat adapters
 */
router.get('/status', async (req: Request, res: Response) => {
    try {
        const activeStatus = chatRouter.getStatus();
        const discordConfig = await getAdapterConfig('discord');
        const telegramConfig = await getAdapterConfig('telegram');

        // Check chatRouter (manual adapter) connection state
        const chatRouterDiscordConnected = activeStatus.find(a => a.platform === 'discord')?.connected || false;
        const chatRouterTelegramConnected = activeStatus.find(a => a.platform === 'telegram')?.connected || false;

        // Also check MessagingGateway — Telegram/Discord may be auto-connected from env vars
        const gwTelegramStatus = messagingGateway.getProviderStatus('telegram');
        const gwDiscordStatus = messagingGateway.getProviderStatus('discord');

        const discordConnected = chatRouterDiscordConnected || (gwDiscordStatus?.connected || false);
        const telegramConnected = chatRouterTelegramConnected || (gwTelegramStatus?.connected || false);

        const discordState: 'connected' | 'configured' | 'not_configured' =
            discordConnected ? 'connected' : discordConfig?.token ? 'configured' : 'not_configured';
        const telegramState: 'connected' | 'configured' | 'not_configured' =
            telegramConnected ? 'connected' : telegramConfig?.token ? 'configured' : 'not_configured';

        res.json({
            adapters: activeStatus,
            discord: {
                configured: !!discordConfig?.token,
                enabled: discordConfig?.enabled || false,
                connected: discordConnected,
                status: discordState
            },
            telegram: {
                configured: !!telegramConfig?.token || telegramConnected,
                enabled: telegramConfig?.enabled !== false,
                connected: telegramConnected,
                status: telegramState
            }
        });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * GET /api/chat/adapters/configs
 * Get all adapter configurations (tokens masked)
 */
router.get('/configs', async (req: Request, res: Response) => {
    try {
        const rows = await db.all('SELECT * FROM chat_adapter_configs');
        const configs = rows.map((row: any) => ({
            platform: row.platform,
            enabled: row.enabled === 1 || row.enabled === true,
            hasToken: !!row.token,
            botUsername: row.bot_username,
            allowedUsers: JSON.parse(row.allowed_users || '[]'),
            allowedChannels: JSON.parse(row.allowed_channels || '[]'),
            updatedAt: row.updated_at
        }));
        res.json({ configs });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * POST /api/chat/adapters/discord/configure
 * Configure Discord adapter
 */
router.post('/discord/configure', async (req: Request, res: Response) => {
    try {
        const { token, allowedUsers, allowedChannels, enabled } = req.body;

        const config: AdapterConfig = {
            enabled: enabled ?? true,
            token,
            allowedUsers: allowedUsers || [],
            allowedChannels: allowedChannels || []
        };

        // Save to database
        await saveAdapterConfig('discord', config);

        if (config.enabled && config.token) {
            // Shutdown existing connection if any
            const existingStatus = chatRouter.getStatus();
            if (existingStatus.find(a => a.platform === 'discord')) {
                await chatRouter.shutdown();
            }

            const adapter = new DiscordAdapter();
            const success = await chatRouter.registerAdapter(adapter, config);

            if (success) {
                res.json({
                    success: true,
                    message: 'Discord adapter configured and connected',
                    connected: true
                });
            } else {
                res.json({
                    success: false,
                    message: 'Failed to connect Discord. Check token or install discord.js',
                    hint: 'npm install discord.js',
                    connected: false
                });
            }
        } else {
            res.json({
                success: true,
                message: config.enabled ? 'Discord config saved (no token)' : 'Discord adapter disabled',
                connected: false
            });
        }
    } catch (error: any) {
        console.error('[ChatRoutes] Discord configure error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/chat/adapters/telegram/configure
 * Configure Telegram adapter
 */
router.post('/telegram/configure', async (req: Request, res: Response) => {
    try {
        const { token, allowedUsers, allowedChannels, enabled } = req.body;

        const config: AdapterConfig = {
            enabled: enabled ?? true,
            token,
            allowedUsers: allowedUsers || [],
            allowedChannels: allowedChannels || []
        };

        // Save to database
        await saveAdapterConfig('telegram', config);

        if (config.enabled && config.token) {
            const adapter = new TelegramAdapter();
            const success = await chatRouter.registerAdapter(adapter, config);

            if (success) {
                res.json({
                    success: true,
                    message: 'Telegram adapter configured and connected',
                    connected: true
                });
            } else {
                res.json({
                    success: false,
                    message: 'Failed to connect Telegram. Check token or install node-telegram-bot-api',
                    hint: 'npm install node-telegram-bot-api',
                    connected: false
                });
            }
        } else {
            res.json({
                success: true,
                message: config.enabled ? 'Telegram config saved (no token)' : 'Telegram adapter disabled',
                connected: false
            });
        }
    } catch (error: any) {
        console.error('[ChatRoutes] Telegram configure error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/chat/adapters/:platform
 * Remove adapter configuration
 */
router.delete('/:platform', async (req: Request, res: Response) => {
    try {
        const { platform } = req.params;

        if (!['discord', 'telegram'].includes(platform)) {
            return res.status(400).json({ error: 'Invalid platform' });
        }

        // Shutdown adapter if running
        const status = chatRouter.getStatus();
        if (status.find(a => a.platform === platform)) {
            await chatRouter.shutdown();
        }

        // Delete from database
        await db.run('DELETE FROM chat_adapter_configs WHERE platform = ?', [platform]);

        res.json({ success: true, message: `${platform} adapter configuration removed` });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/chat/adapters/shutdown
 * Shutdown all chat adapters
 */
router.post('/shutdown', async (req: Request, res: Response) => {
    try {
        await chatRouter.shutdown();

        // Update enabled status in DB
        await db.run('UPDATE chat_adapter_configs SET enabled = 0');

        res.json({ success: true, message: 'All chat adapters shutdown' });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/chat/adapters/reconnect
 * Reconnect all enabled adapters from saved configs
 */
router.post('/reconnect', async (req: Request, res: Response) => {
    try {
        // Shutdown existing
        await chatRouter.shutdown();

        // Reinitialize from saved configs
        await initializeChatAdapters();

        const status = chatRouter.getStatus();
        res.json({
            success: true,
            message: 'Reconnection complete',
            adapters: status
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
