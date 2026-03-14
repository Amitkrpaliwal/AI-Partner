/**
 * GoogleCalendarServer — Google Calendar read/write tool for the ReAct agent.
 *
 * Uses Google Calendar REST API v3.
 * Requires: GOOGLE_CALENDAR_ACCESS_TOKEN (OAuth2 access token)
 *           GOOGLE_CALENDAR_ID (optional, defaults to "primary")
 *
 * Generate access token:
 *   1. Go to https://developers.google.com/oauthplayground/
 *   2. Select "Google Calendar API v3" → calendar.events (read/write)
 *   3. Exchange auth code → copy access token to GOOGLE_CALENDAR_ACCESS_TOKEN
 *
 * Note: Access tokens expire in 1 hour. For persistent use, store a refresh token
 * and add GOOGLE_CALENDAR_REFRESH_TOKEN + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.
 */

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

function getToken(): string | null {
    return process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || null;
}

function getCalendarId(): string {
    return process.env.GOOGLE_CALENDAR_ID || 'primary';
}

async function calFetch(path: string, options: RequestInit = {}): Promise<any> {
    const token = getToken();
    if (!token) throw new Error('GOOGLE_CALENDAR_ACCESS_TOKEN not set');

    const res = await fetch(`${CALENDAR_API}${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string> || {})
        }
    });

    if (res.status === 401) {
        throw new Error('GOOGLE_CALENDAR_ACCESS_TOKEN expired. Re-generate from OAuth2 Playground.');
    }
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Google Calendar API ${res.status}: ${err.substring(0, 300)}`);
    }
    if (res.status === 204) return {}; // No content (DELETE)
    return res.json();
}

/** Refresh access token using refresh token (if configured) */
async function refreshAccessToken(): Promise<string | null> {
    const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!refreshToken || !clientId || !clientSecret) return null;

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token'
        })
    });

    if (!res.ok) return null;
    const data: any = await res.json();
    if (data.access_token) {
        process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = data.access_token;
        return data.access_token;
    }
    return null;
}

function formatEvent(event: any): object {
    return {
        id: event.id,
        summary: event.summary || '(no title)',
        description: event.description || '',
        start: event.start?.dateTime || event.start?.date || '',
        end: event.end?.dateTime || event.end?.date || '',
        location: event.location || '',
        attendees: (event.attendees || []).map((a: any) => ({
            email: a.email,
            response: a.responseStatus
        })),
        html_link: event.htmlLink || '',
        status: event.status || ''
    };
}

class GoogleCalendarServer {
    isAvailable(): boolean {
        return !!getToken();
    }

    getTools() {
        return [
            {
                name: 'calendar_list_events',
                description: 'List upcoming Google Calendar events. Can filter by date range.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        time_min: { type: 'string', description: 'Start datetime ISO8601 (default: now). E.g. "2025-01-01T00:00:00Z"' },
                        time_max: { type: 'string', description: 'End datetime ISO8601. E.g. "2025-01-31T23:59:59Z"' },
                        max_results: { type: 'number', description: 'Max events to return (default 10)' },
                        search_query: { type: 'string', description: 'Text to search in event titles/descriptions' },
                        calendar_id: { type: 'string', description: 'Calendar ID (default: primary)' }
                    }
                }
            },
            {
                name: 'calendar_create_event',
                description: 'Create a new event in Google Calendar.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        title: { type: 'string', description: 'Event title/summary' },
                        start: { type: 'string', description: 'Start datetime ISO8601 (e.g. "2025-06-15T14:00:00+05:30")' },
                        end: { type: 'string', description: 'End datetime ISO8601 (e.g. "2025-06-15T15:00:00+05:30")' },
                        description: { type: 'string', description: 'Event description' },
                        location: { type: 'string', description: 'Event location' },
                        attendees: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'List of attendee email addresses'
                        },
                        all_day: { type: 'boolean', description: 'Create as all-day event (uses date format instead of dateTime)' },
                        calendar_id: { type: 'string', description: 'Calendar ID (default: primary)' }
                    },
                    required: ['title', 'start', 'end']
                }
            },
            {
                name: 'calendar_check_availability',
                description: 'Check free/busy status for a time range. Useful for finding open slots.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        time_min: { type: 'string', description: 'Start datetime ISO8601' },
                        time_max: { type: 'string', description: 'End datetime ISO8601' },
                        calendar_ids: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Calendar IDs to check (default: ["primary"])'
                        }
                    },
                    required: ['time_min', 'time_max']
                }
            },
            {
                name: 'calendar_delete_event',
                description: 'Delete a Google Calendar event by ID.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        event_id: { type: 'string', description: 'Event ID (from calendar_list_events)' },
                        calendar_id: { type: 'string', description: 'Calendar ID (default: primary)' }
                    },
                    required: ['event_id']
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isAvailable()) {
            return {
                success: false,
                error: 'Google Calendar not configured. Set GOOGLE_CALENDAR_ACCESS_TOKEN in .env (see server/src/mcp/servers/GoogleCalendarServer.ts for instructions)'
            };
        }

        try {
            switch (name) {
                case 'calendar_list_events':
                    return await this.listEvents(args);
                case 'calendar_create_event':
                    return await this.createEvent(args);
                case 'calendar_check_availability':
                    return await this.checkAvailability(args);
                case 'calendar_delete_event':
                    return await this.deleteEvent(args);
                default:
                    return { success: false, error: `Unknown Calendar tool: ${name}` };
            }
        } catch (err: any) {
            // If 401, try to refresh token once
            if (err.message.includes('expired') || err.message.includes('401')) {
                const newToken = await refreshAccessToken();
                if (newToken) {
                    return this.callTool(name, args); // Retry once with new token
                }
            }
            return { success: false, error: err.message };
        }
    }

    private async listEvents(args: any): Promise<any> {
        const calendarId = encodeURIComponent(args.calendar_id || getCalendarId());
        const params = new URLSearchParams({
            maxResults: String(args.max_results || 10),
            singleEvents: 'true',
            orderBy: 'startTime',
            timeMin: args.time_min || new Date().toISOString()
        });

        if (args.time_max) params.set('timeMax', args.time_max);
        if (args.search_query) params.set('q', args.search_query);

        const data = await calFetch(`/calendars/${calendarId}/events?${params}`);
        return {
            success: true,
            events: (data.items || []).map(formatEvent),
            count: (data.items || []).length
        };
    }

    private async createEvent(args: any): Promise<any> {
        const calendarId = encodeURIComponent(args.calendar_id || getCalendarId());

        const event: any = {
            summary: args.title,
            description: args.description || '',
            location: args.location || '',
            start: args.all_day
                ? { date: args.start.substring(0, 10) }
                : { dateTime: args.start },
            end: args.all_day
                ? { date: args.end.substring(0, 10) }
                : { dateTime: args.end }
        };

        if (args.attendees?.length) {
            event.attendees = args.attendees.map((email: string) => ({ email }));
        }

        const data = await calFetch(`/calendars/${calendarId}/events`, {
            method: 'POST',
            body: JSON.stringify(event)
        });

        return {
            success: true,
            event_id: data.id,
            html_link: data.htmlLink,
            message: `Event "${args.title}" created for ${args.start}`
        };
    }

    private async checkAvailability(args: any): Promise<any> {
        const calendarIds = args.calendar_ids || [getCalendarId()];

        const data = await calFetch('/freeBusy', {
            method: 'POST',
            body: JSON.stringify({
                timeMin: args.time_min,
                timeMax: args.time_max,
                items: calendarIds.map((id: string) => ({ id }))
            })
        });

        const result: Record<string, any> = {};
        for (const [calId, info] of Object.entries(data.calendars || {})) {
            const busy = (info as any).busy || [];
            result[calId] = {
                busy_periods: busy,
                is_free: busy.length === 0
            };
        }

        return { success: true, time_min: args.time_min, time_max: args.time_max, calendars: result };
    }

    private async deleteEvent(args: any): Promise<any> {
        const calendarId = encodeURIComponent(args.calendar_id || getCalendarId());
        await calFetch(`/calendars/${calendarId}/events/${args.event_id}`, { method: 'DELETE' });
        return { success: true, message: `Event ${args.event_id} deleted` };
    }
}

export const googleCalendarServer = new GoogleCalendarServer();
