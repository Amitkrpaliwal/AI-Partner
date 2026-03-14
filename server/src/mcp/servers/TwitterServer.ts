/**
 * TwitterServer — Twitter/X API v2 integration.
 *
 * READ  (search, timeline, user info): requires TWITTER_BEARER_TOKEN
 * WRITE (post, reply, like):           requires all four OAuth 1.0a keys:
 *         TWITTER_API_KEY, TWITTER_API_SECRET,
 *         TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET
 *
 * Get credentials at: https://developer.twitter.com/en/portal/dashboard
 * Free tier: 1,500 tweets/month write, 10 posts/15min search reads.
 */

import crypto from 'crypto';

const API_V2 = 'https://api.twitter.com/2';

function hasBearer(): boolean { return !!process.env.TWITTER_BEARER_TOKEN; }
function hasOAuth(): boolean {
    return !!(process.env.TWITTER_API_KEY && process.env.TWITTER_API_SECRET &&
        process.env.TWITTER_ACCESS_TOKEN && process.env.TWITTER_ACCESS_SECRET);
}

async function bearerFetch(path: string): Promise<any> {
    const res = await fetch(`${API_V2}${path}`, {
        headers: { 'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}` }
    });
    if (!res.ok) throw new Error(`Twitter API ${res.status}: ${await res.text().then(t => t.substring(0, 300))}`);
    return res.json();
}

/** Build OAuth 1.0a Authorization header for write endpoints */
function buildOAuthHeader(method: string, url: string, bodyParams: Record<string, string> = {}): string {
    const oauthParams: Record<string, string> = {
        oauth_consumer_key: process.env.TWITTER_API_KEY!,
        oauth_nonce: crypto.randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: String(Math.floor(Date.now() / 1000)),
        oauth_token: process.env.TWITTER_ACCESS_TOKEN!,
        oauth_version: '1.0'
    };

    const allParams = { ...oauthParams, ...bodyParams };
    const sortedKeys = Object.keys(allParams).sort();
    const paramString = sortedKeys
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
        .join('&');

    const signingKey = `${encodeURIComponent(process.env.TWITTER_API_SECRET!)}&${encodeURIComponent(process.env.TWITTER_ACCESS_SECRET!)}`;
    const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
    const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

    oauthParams['oauth_signature'] = signature;
    const headerValue = Object.entries(oauthParams)
        .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
        .join(', ');
    return `OAuth ${headerValue}`;
}

async function oauthPost(endpoint: string, body: object): Promise<any> {
    const url = `${API_V2}${endpoint}`;
    const authHeader = buildOAuthHeader('POST', url);
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Twitter write API ${res.status}: ${await res.text().then(t => t.substring(0, 300))}`);
    return res.json();
}

class TwitterServer {
    isAvailable(): boolean { return hasBearer() || hasOAuth(); }

    getTools() {
        return [
            {
                name: 'twitter_search',
                description: 'Search recent tweets on Twitter/X. Requires TWITTER_BEARER_TOKEN.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Search query. E.g. "#AI lang:en -is:retweet"' },
                        max_results: { type: 'number', description: 'Max tweets (10–100, default 20)' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'twitter_post',
                description: 'Post a tweet on Twitter/X. Requires OAuth keys (TWITTER_API_KEY etc.)',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        text: { type: 'string', description: 'Tweet text (max 280 chars)' },
                        reply_to_id: { type: 'string', description: 'Tweet ID to reply to (optional)' }
                    },
                    required: ['text']
                }
            },
            {
                name: 'twitter_get_user_tweets',
                description: 'Get recent tweets from a Twitter/X user by username.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        username: { type: 'string', description: 'Twitter username (without @)' },
                        max_results: { type: 'number', description: 'Max tweets (5–100, default 10)' }
                    },
                    required: ['username']
                }
            },
            {
                name: 'twitter_get_tweet',
                description: 'Get a specific tweet by ID with metrics.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        tweet_id: { type: 'string', description: 'Tweet ID' }
                    },
                    required: ['tweet_id']
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Twitter not configured. Set TWITTER_BEARER_TOKEN in .env' };
        }
        try {
            switch (name) {
                case 'twitter_search': {
                    if (!hasBearer()) return { success: false, error: 'TWITTER_BEARER_TOKEN required for search' };
                    const max = Math.min(Math.max(args.max_results || 20, 10), 100);
                    const params = new URLSearchParams({
                        query: args.query,
                        max_results: String(max),
                        'tweet.fields': 'created_at,public_metrics,author_id',
                        expansions: 'author_id',
                        'user.fields': 'name,username'
                    });
                    const data = await bearerFetch(`/tweets/search/recent?${params}`);
                    const userMap = Object.fromEntries(
                        (data.includes?.users || []).map((u: any) => [u.id, u])
                    );
                    return {
                        success: true,
                        tweets: (data.data || []).map((t: any) => ({
                            id: t.id,
                            text: t.text,
                            created_at: t.created_at,
                            author: userMap[t.author_id]?.username || t.author_id,
                            metrics: t.public_metrics,
                            url: `https://twitter.com/i/web/status/${t.id}`
                        })),
                        result_count: data.meta?.result_count || 0
                    };
                }
                case 'twitter_post': {
                    if (!hasOAuth()) return { success: false, error: 'TWITTER_API_KEY/SECRET + TWITTER_ACCESS_TOKEN/SECRET required for posting' };
                    const body: any = { text: args.text.substring(0, 280) };
                    if (args.reply_to_id) body.reply = { in_reply_to_tweet_id: args.reply_to_id };
                    const data = await oauthPost('/tweets', body);
                    return {
                        success: true,
                        tweet_id: data.data.id,
                        text: data.data.text,
                        url: `https://twitter.com/i/web/status/${data.data.id}`
                    };
                }
                case 'twitter_get_user_tweets': {
                    if (!hasBearer()) return { success: false, error: 'TWITTER_BEARER_TOKEN required' };
                    // First resolve username → user ID
                    const userRes = await bearerFetch(`/users/by/username/${encodeURIComponent(args.username)}?user.fields=name,public_metrics`);
                    const userId = userRes.data?.id;
                    if (!userId) return { success: false, error: `User @${args.username} not found` };
                    const max = Math.min(Math.max(args.max_results || 10, 5), 100);
                    const params = new URLSearchParams({
                        max_results: String(max),
                        'tweet.fields': 'created_at,public_metrics',
                        exclude: 'retweets'
                    });
                    const tweets = await bearerFetch(`/users/${userId}/tweets?${params}`);
                    return {
                        success: true,
                        username: args.username,
                        tweets: (tweets.data || []).map((t: any) => ({
                            id: t.id,
                            text: t.text,
                            created_at: t.created_at,
                            metrics: t.public_metrics,
                            url: `https://twitter.com/i/web/status/${t.id}`
                        }))
                    };
                }
                case 'twitter_get_tweet': {
                    if (!hasBearer()) return { success: false, error: 'TWITTER_BEARER_TOKEN required' };
                    const data = await bearerFetch(`/tweets/${args.tweet_id}?tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username`);
                    return { success: true, tweet: data.data, author: data.includes?.users?.[0] };
                }
                default:
                    return { success: false, error: `Unknown Twitter tool: ${name}` };
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
}

export const twitterServer = new TwitterServer();
