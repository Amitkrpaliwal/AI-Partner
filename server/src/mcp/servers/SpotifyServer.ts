/**
 * SpotifyServer — Spotify Web API integration.
 * Tools: search, play/pause/skip, current track, queue, create playlist.
 *
 * Requires: SPOTIFY_ACCESS_TOKEN (OAuth2, scopes: user-read-playback-state,
 *           user-modify-playback-state, user-read-currently-playing,
 *           playlist-modify-public, playlist-modify-private)
 *
 * For persistent use: SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET + SPOTIFY_REFRESH_TOKEN
 * Get token from: https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens
 */

const SPOTIFY_API = 'https://api.spotify.com/v1';

function getToken(): string | null {
    return process.env.SPOTIFY_ACCESS_TOKEN || null;
}

async function spotifyFetch(path: string, options: RequestInit = {}): Promise<any> {
    const token = getToken();
    if (!token) throw new Error('SPOTIFY_ACCESS_TOKEN not set');

    const res = await fetch(`${SPOTIFY_API}${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string> || {})
        }
    });

    if (res.status === 401) throw new Error('SPOTIFY_ACCESS_TOKEN expired. Re-generate from Spotify Dashboard.');
    if (res.status === 204 || res.status === 202) return { success: true };
    if (!res.ok) throw new Error(`Spotify API ${res.status}: ${await res.text().then(t => t.substring(0, 300))}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
}

async function refreshToken(): Promise<string | null> {
    const rt = process.env.SPOTIFY_REFRESH_TOKEN;
    const cid = process.env.SPOTIFY_CLIENT_ID;
    const cs = process.env.SPOTIFY_CLIENT_SECRET;
    if (!rt || !cid || !cs) return null;
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(`${cid}:${cs}`).toString('base64')}`
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt })
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data.access_token) { process.env.SPOTIFY_ACCESS_TOKEN = data.access_token; return data.access_token; }
    return null;
}

class SpotifyServer {
    isAvailable(): boolean { return !!getToken(); }

    getTools() {
        return [
            {
                name: 'spotify_search',
                description: 'Search Spotify for tracks, albums, artists, or playlists.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Search query' },
                        type: { type: 'string', description: 'track | album | artist | playlist (default: track)' },
                        limit: { type: 'number', description: 'Max results (default 10)' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'spotify_play',
                description: 'Start or resume Spotify playback. Can play a specific track URI.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        uri: { type: 'string', description: 'Spotify URI to play (e.g. "spotify:track:4iV5W9uYEdYUVa79Axb7Rh") — optional, resumes if omitted' },
                        device_id: { type: 'string', description: 'Device ID to play on (optional)' }
                    }
                }
            },
            {
                name: 'spotify_pause',
                description: 'Pause Spotify playback.',
                inputSchema: { type: 'object' as const, properties: {} }
            },
            {
                name: 'spotify_skip',
                description: 'Skip to the next or previous track.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        direction: { type: 'string', description: 'next | previous (default: next)' }
                    }
                }
            },
            {
                name: 'spotify_current_track',
                description: 'Get the currently playing track on Spotify.',
                inputSchema: { type: 'object' as const, properties: {} }
            },
            {
                name: 'spotify_add_to_queue',
                description: 'Add a track to the Spotify playback queue.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        uri: { type: 'string', description: 'Spotify track URI (e.g. "spotify:track:4iV5W9uYEdYUVa79Axb7Rh")' }
                    },
                    required: ['uri']
                }
            },
            {
                name: 'spotify_create_playlist',
                description: 'Create a new Spotify playlist and optionally add tracks.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Playlist name' },
                        description: { type: 'string', description: 'Playlist description' },
                        track_uris: { type: 'array', items: { type: 'string' }, description: 'List of Spotify track URIs to add' },
                        public: { type: 'boolean', description: 'Public playlist (default: false)' }
                    },
                    required: ['name']
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Spotify not configured. Set SPOTIFY_ACCESS_TOKEN in .env' };
        }
        try {
            switch (name) {
                case 'spotify_search': {
                    const type = args.type || 'track';
                    const params = new URLSearchParams({ q: args.query, type, limit: String(args.limit || 10) });
                    const data = await spotifyFetch(`/search?${params}`);
                    const items = data[`${type}s`]?.items || [];
                    return {
                        success: true,
                        type,
                        results: items.map((item: any) => ({
                            uri: item.uri,
                            name: item.name,
                            artist: item.artists?.map((a: any) => a.name).join(', ') || '',
                            album: item.album?.name || '',
                            duration_ms: item.duration_ms,
                            popularity: item.popularity,
                            external_url: item.external_urls?.spotify
                        }))
                    };
                }
                case 'spotify_play': {
                    const body: any = {};
                    if (args.uri) body.uris = [args.uri];
                    const deviceParam = args.device_id ? `?device_id=${args.device_id}` : '';
                    await spotifyFetch(`/me/player/play${deviceParam}`, {
                        method: 'PUT',
                        body: JSON.stringify(body)
                    });
                    return { success: true, message: args.uri ? `Playing ${args.uri}` : 'Playback resumed' };
                }
                case 'spotify_pause': {
                    await spotifyFetch('/me/player/pause', { method: 'PUT' });
                    return { success: true, message: 'Playback paused' };
                }
                case 'spotify_skip': {
                    const dir = args.direction === 'previous' ? 'previous' : 'next';
                    await spotifyFetch(`/me/player/${dir}`, { method: 'POST' });
                    return { success: true, message: `Skipped to ${dir} track` };
                }
                case 'spotify_current_track': {
                    const data = await spotifyFetch('/me/player/currently-playing');
                    if (!data || !data.item) return { success: true, playing: false };
                    return {
                        success: true,
                        playing: data.is_playing,
                        track: {
                            uri: data.item.uri,
                            name: data.item.name,
                            artist: data.item.artists?.map((a: any) => a.name).join(', '),
                            album: data.item.album?.name,
                            progress_ms: data.progress_ms,
                            duration_ms: data.item.duration_ms
                        }
                    };
                }
                case 'spotify_add_to_queue': {
                    await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(args.uri)}`, { method: 'POST' });
                    return { success: true, message: `Added ${args.uri} to queue` };
                }
                case 'spotify_create_playlist': {
                    // Get current user ID
                    const me = await spotifyFetch('/me');
                    const playlist = await spotifyFetch(`/users/${me.id}/playlists`, {
                        method: 'POST',
                        body: JSON.stringify({
                            name: args.name,
                            description: args.description || '',
                            public: args.public ?? false
                        })
                    });
                    let tracksAdded = 0;
                    if (args.track_uris?.length) {
                        await spotifyFetch(`/playlists/${playlist.id}/tracks`, {
                            method: 'POST',
                            body: JSON.stringify({ uris: args.track_uris.slice(0, 100) })
                        });
                        tracksAdded = Math.min(args.track_uris.length, 100);
                    }
                    return {
                        success: true,
                        playlist_id: playlist.id,
                        url: playlist.external_urls?.spotify,
                        tracks_added: tracksAdded,
                        message: `Playlist "${args.name}" created`
                    };
                }
                default:
                    return { success: false, error: `Unknown Spotify tool: ${name}` };
            }
        } catch (err: any) {
            if (err.message.includes('expired')) await refreshToken();
            return { success: false, error: err.message };
        }
    }
}

export const spotifyServer = new SpotifyServer();
