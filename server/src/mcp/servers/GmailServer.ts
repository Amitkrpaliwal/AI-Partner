/**
 * GmailServer — Email send/read/search tool for the ReAct agent.
 *
 * SEND: Uses Gmail SMTP (App Password — no OAuth needed).
 *       Required env vars: GMAIL_USER, GMAIL_APP_PASSWORD
 *
 * READ/SEARCH: Uses Gmail REST API with an OAuth access token.
 *       Required env vars: GMAIL_USER, GMAIL_ACCESS_TOKEN
 *       (Generate once via OAuth2 playground or Google Cloud Console)
 *
 * If only GMAIL_USER + GMAIL_APP_PASSWORD are set → send-only mode.
 * If GMAIL_ACCESS_TOKEN is also set → full read + search + send.
 *
 * GMAIL_APP_PASSWORD: https://myaccount.google.com/apppasswords (requires 2FA)
 */

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function canSend(): boolean {
    return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}
function canRead(): boolean {
    return !!(process.env.GMAIL_USER && process.env.GMAIL_ACCESS_TOKEN);
}

async function gmailApiFetch(path: string, options: RequestInit = {}): Promise<any> {
    const token = process.env.GMAIL_ACCESS_TOKEN;
    if (!token) throw new Error('GMAIL_ACCESS_TOKEN not set');

    const res = await fetch(`${GMAIL_API}${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string> || {})
        }
    });

    if (res.status === 401) {
        throw new Error('GMAIL_ACCESS_TOKEN expired. Re-generate from Google OAuth2 Playground.');
    }
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gmail API ${res.status}: ${err.substring(0, 300)}`);
    }
    return res.json();
}

/** Decode base64url → utf-8 string */
function b64Decode(str: string): string {
    try {
        return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    } catch {
        return '';
    }
}

/** Extract plain-text body from a Gmail message payload */
function extractBody(payload: any): string {
    if (!payload) return '';

    // Try direct body first
    if (payload.body?.data) return b64Decode(payload.body.data);

    // Walk parts
    const parts: any[] = payload.parts || [];
    for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
            return b64Decode(part.body.data);
        }
    }
    // Fallback to HTML part
    for (const part of parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
            return b64Decode(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
    }
    return '';
}

/** Build a base64url-encoded RFC 2822 email message */
function buildRawEmail(to: string, subject: string, body: string, from: string, cc?: string): string {
    const lines = [
        `From: ${from}`,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        body
    ].filter(Boolean).join('\r\n');

    return Buffer.from(lines).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class GmailServer {
    isAvailable(): boolean {
        return canSend() || canRead();
    }

    getTools() {
        return [
            {
                name: 'gmail_send',
                description: 'Send an email via Gmail. Requires GMAIL_USER and GMAIL_APP_PASSWORD in .env.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        to: { type: 'string', description: 'Recipient email address (or comma-separated list)' },
                        subject: { type: 'string', description: 'Email subject' },
                        body: { type: 'string', description: 'Email body (plain text)' },
                        cc: { type: 'string', description: 'CC email address(es) — optional' }
                    },
                    required: ['to', 'subject', 'body']
                }
            },
            {
                name: 'gmail_search',
                description: 'Search Gmail inbox using Gmail query syntax. Requires GMAIL_ACCESS_TOKEN.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Gmail search query (e.g. "from:boss@co.com is:unread", "subject:invoice after:2024/01/01")' },
                        max_results: { type: 'number', description: 'Max emails to return (default 10)' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'gmail_read',
                description: 'Read full content of a specific Gmail message by ID.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        message_id: { type: 'string', description: 'Gmail message ID (from gmail_search results)' }
                    },
                    required: ['message_id']
                }
            },
            {
                name: 'gmail_list_inbox',
                description: 'List most recent emails from Gmail inbox. Requires GMAIL_ACCESS_TOKEN.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        max_results: { type: 'number', description: 'Max emails to list (default 10)' },
                        unread_only: { type: 'boolean', description: 'Only show unread emails (default false)' }
                    }
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Gmail not configured. Set GMAIL_USER + GMAIL_APP_PASSWORD in .env' };
        }

        try {
            switch (name) {
                case 'gmail_send':
                    return await this.sendEmail(args);
                case 'gmail_search':
                    return await this.searchEmails(args);
                case 'gmail_read':
                    return await this.readEmail(args);
                case 'gmail_list_inbox':
                    return await this.listInbox(args);
                default:
                    return { success: false, error: `Unknown Gmail tool: ${name}` };
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async sendEmail(args: any): Promise<any> {
        if (!canSend()) {
            return { success: false, error: 'Send requires GMAIL_USER and GMAIL_APP_PASSWORD' };
        }

        if (canRead()) {
            // Prefer Gmail API send (avoids SMTP, better delivery)
            const raw = buildRawEmail(args.to, args.subject, args.body, process.env.GMAIL_USER!, args.cc);
            const data = await gmailApiFetch('/messages/send', {
                method: 'POST',
                body: JSON.stringify({ raw })
            });
            return { success: true, message_id: data.id, thread_id: data.threadId, message: `Email sent to ${args.to}` };
        }

        // SMTP fallback via nodemailer-style raw SMTP
        // Dynamic import — nodemailer is not installed by default, use fetch to Gmail SMTP
        try {
            const nodemailer = await import('nodemailer' as any);
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
            });
            const info = await transporter.sendMail({
                from: process.env.GMAIL_USER,
                to: args.to,
                cc: args.cc,
                subject: args.subject,
                text: args.body
            });
            return { success: true, message_id: info.messageId, message: `Email sent to ${args.to}` };
        } catch (smtpErr: any) {
            return {
                success: false,
                error: `SMTP send failed: ${smtpErr.message}. Install nodemailer: npm install nodemailer`
            };
        }
    }

    private async searchEmails(args: any): Promise<any> {
        if (!canRead()) return { success: false, error: 'Search requires GMAIL_ACCESS_TOKEN' };

        const params = new URLSearchParams({
            q: args.query,
            maxResults: String(args.max_results || 10)
        });

        const list = await gmailApiFetch(`/messages?${params}`);
        if (!list.messages || list.messages.length === 0) {
            return { success: true, emails: [], total_found: 0 };
        }

        // Fetch metadata for each message
        const emails = await Promise.all(
            list.messages.slice(0, args.max_results || 10).map(async (m: any) => {
                const msg = await gmailApiFetch(`/messages/${m.id}?format=metadata&metadataHeaders=Subject,From,To,Date`);
                const headers = Object.fromEntries(
                    (msg.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value])
                );
                return {
                    id: msg.id,
                    thread_id: msg.threadId,
                    subject: headers.subject || '(no subject)',
                    from: headers.from || '',
                    to: headers.to || '',
                    date: headers.date || '',
                    snippet: msg.snippet || ''
                };
            })
        );

        return { success: true, emails, total_found: list.resultSizeEstimate || emails.length };
    }

    private async readEmail(args: any): Promise<any> {
        if (!canRead()) return { success: false, error: 'Read requires GMAIL_ACCESS_TOKEN' };

        const msg = await gmailApiFetch(`/messages/${args.message_id}?format=full`);
        const headers = Object.fromEntries(
            (msg.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value])
        );
        const body = extractBody(msg.payload);

        return {
            success: true,
            id: msg.id,
            thread_id: msg.threadId,
            subject: headers.subject || '(no subject)',
            from: headers.from || '',
            to: headers.to || '',
            date: headers.date || '',
            body: body.substring(0, 5000),
            label_ids: msg.labelIds || []
        };
    }

    private async listInbox(args: any): Promise<any> {
        const query = args.unread_only ? 'in:inbox is:unread' : 'in:inbox';
        return this.searchEmails({ query, max_results: args.max_results || 10 });
    }
}

export const gmailServer = new GmailServer();
