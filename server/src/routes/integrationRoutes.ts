/**
 * Integration Routes — list all third-party integrations with their status.
 *
 * GET  /api/integrations          — list all integrations with connection status
 * GET  /api/integrations/:id      — get a single integration's status + required keys
 */

import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { secretManager } from '../services/SecretManager';

export const integrationRoutes = Router();

export interface IntegrationDef {
    id: string;
    label: string;
    category: string;
    description: string;
    icon: string;
    /** Env-var names required for this integration to be functional */
    requiredKeys: string[];
    /** Env-var names that are optional (improve functionality but not required) */
    optionalKeys: string[];
    /** Docs URL for getting the credentials */
    docsUrl: string;
}

export const INTEGRATIONS: IntegrationDef[] = [
    {
        id: 'github',
        label: 'GitHub',
        category: 'Developer',
        description: 'Search repos, list/create issues, read files, browse PRs',
        icon: '🐙',
        requiredKeys: ['GITHUB_TOKEN'],
        optionalKeys: [],
        docsUrl: 'https://github.com/settings/tokens',
    },
    {
        id: 'notion',
        label: 'Notion',
        category: 'Productivity',
        description: 'Search pages, query databases, create/append content',
        icon: '📝',
        requiredKeys: ['NOTION_API_KEY'],
        optionalKeys: [],
        docsUrl: 'https://www.notion.so/my-integrations',
    },
    {
        id: 'gmail',
        label: 'Gmail',
        category: 'Communication',
        description: 'Send emails, search inbox, read messages',
        icon: '📧',
        requiredKeys: ['GMAIL_ACCESS_TOKEN'],
        optionalKeys: ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'GMAIL_REFRESH_TOKEN'],
        docsUrl: 'https://developers.google.com/oauthplayground/',
    },
    {
        id: 'google_calendar',
        label: 'Google Calendar',
        category: 'Productivity',
        description: 'List events, create meetings, check free/busy',
        icon: '📅',
        requiredKeys: ['GOOGLE_CALENDAR_ACCESS_TOKEN'],
        optionalKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALENDAR_REFRESH_TOKEN'],
        docsUrl: 'https://developers.google.com/oauthplayground/',
    },
    {
        id: 'google_drive',
        label: 'Google Drive',
        category: 'Productivity',
        description: 'Search files, read Google Docs/Sheets, upload text files',
        icon: '💾',
        requiredKeys: ['GOOGLE_DRIVE_ACCESS_TOKEN'],
        optionalKeys: ['GOOGLE_DRIVE_REFRESH_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
        docsUrl: 'https://developers.google.com/oauthplayground/',
    },
    {
        id: 'trello',
        label: 'Trello',
        category: 'Productivity',
        description: 'List boards, manage cards, move tasks between columns',
        icon: '📋',
        requiredKeys: ['TRELLO_API_KEY', 'TRELLO_TOKEN'],
        optionalKeys: [],
        docsUrl: 'https://trello.com/power-ups/admin',
    },
    {
        id: 'twitter',
        label: 'Twitter / X',
        category: 'Social',
        description: 'Search tweets, post updates, get user timelines',
        icon: '🐦',
        requiredKeys: ['TWITTER_BEARER_TOKEN'],
        optionalKeys: ['TWITTER_API_KEY', 'TWITTER_API_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_SECRET'],
        docsUrl: 'https://developer.twitter.com/en/portal/dashboard',
    },
    {
        id: 'spotify',
        label: 'Spotify',
        category: 'Media',
        description: 'Play/pause music, search tracks, manage playlists',
        icon: '🎵',
        requiredKeys: ['SPOTIFY_ACCESS_TOKEN'],
        optionalKeys: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'],
        docsUrl: 'https://developer.spotify.com/dashboard',
    },
    {
        id: 'imagegen',
        label: 'Image Generation',
        category: 'AI',
        description: 'Generate images with DALL-E 3 or Stability AI',
        icon: '🎨',
        requiredKeys: [],
        optionalKeys: ['OPENAI_API_KEY', 'STABILITY_API_KEY'],
        docsUrl: 'https://platform.openai.com/api-keys',
    },
    {
        id: 'apify',
        label: 'Apify',
        category: 'Developer',
        description: 'Web scraping, browser automation, and CAPTCHA-resistant data extraction via headless browsers and residential proxies',
        icon: '🕷️',
        requiredKeys: ['APIFY_API_TOKEN'],
        optionalKeys: [],
        docsUrl: 'https://console.apify.com/account/integrations',
    },
];

/**
 * GET /api/integrations
 * Returns all integrations with:
 *  - connected: boolean (all required keys are present in process.env OR stored as secrets)
 *  - configuredKeys: which of the optional/required keys are set
 */
integrationRoutes.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId || 'default';
        const savedSecrets = await secretManager.listSecrets(userId);
        const savedNames = new Set(savedSecrets.map(s => s.name));

        const result = INTEGRATIONS.map(integration => {
            const allKeys = [...integration.requiredKeys, ...integration.optionalKeys];
            const configuredKeys = allKeys.filter(key =>
                !!process.env[key] || savedNames.has(key)
            );
            const connected = integration.requiredKeys.length === 0
                ? configuredKeys.length > 0
                : integration.requiredKeys.every(key => !!process.env[key] || savedNames.has(key));

            return {
                id: integration.id,
                label: integration.label,
                category: integration.category,
                description: integration.description,
                icon: integration.icon,
                requiredKeys: integration.requiredKeys,
                optionalKeys: integration.optionalKeys,
                docsUrl: integration.docsUrl,
                connected,
                configuredKeys,
            };
        });

        const connected = result.filter(i => i.connected).length;
        res.json({ success: true, integrations: result, connected, total: result.length });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/integrations/:id
 * Returns a single integration status.
 */
integrationRoutes.get('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId || 'default';
        const integration = INTEGRATIONS.find(i => i.id === req.params.id);
        if (!integration) {
            return res.status(404).json({ error: `Integration "${req.params.id}" not found` });
        }
        const savedSecrets = await secretManager.listSecrets(userId);
        const savedNames = new Set(savedSecrets.map(s => s.name));

        const allKeys = [...integration.requiredKeys, ...integration.optionalKeys];
        const configuredKeys = allKeys.filter(key => !!process.env[key] || savedNames.has(key));
        const connected = integration.requiredKeys.length === 0
            ? configuredKeys.length > 0
            : integration.requiredKeys.every(key => !!process.env[key] || savedNames.has(key));

        res.json({
            success: true,
            integration: { ...integration, connected, configuredKeys },
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default integrationRoutes;
