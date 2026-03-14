/**
 * GoogleDriveServer — Google Drive REST API integration.
 * Tools: search files, get file content, list folder, create/upload text file.
 *
 * Uses same OAuth token pattern as Google Calendar.
 * Required env vars: GOOGLE_DRIVE_ACCESS_TOKEN
 *
 * For persistent use, set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_DRIVE_REFRESH_TOKEN
 * Get token from: https://developers.google.com/oauthplayground/
 *   Scope: https://www.googleapis.com/auth/drive
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

function getToken(): string | null {
    return process.env.GOOGLE_DRIVE_ACCESS_TOKEN || null;
}

async function driveFetch(path: string, options: RequestInit = {}, baseUrl: string = DRIVE_API): Promise<any> {
    const token = getToken();
    if (!token) throw new Error('GOOGLE_DRIVE_ACCESS_TOKEN not set');

    const res = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string> || {})
        }
    });

    if (res.status === 401) throw new Error('GOOGLE_DRIVE_ACCESS_TOKEN expired. Re-generate from OAuth2 Playground.');
    if (res.status === 204) return {};
    if (!res.ok) throw new Error(`Google Drive API ${res.status}: ${await res.text().then(t => t.substring(0, 300))}`);
    return res.json();
}

async function refreshToken(): Promise<string | null> {
    const rt = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    const cid = process.env.GOOGLE_CLIENT_ID;
    const cs = process.env.GOOGLE_CLIENT_SECRET;
    if (!rt || !cid || !cs) return null;
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: rt, client_id: cid, client_secret: cs, grant_type: 'refresh_token' })
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data.access_token) { process.env.GOOGLE_DRIVE_ACCESS_TOKEN = data.access_token; return data.access_token; }
    return null;
}

function formatFile(f: any): object {
    return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size,
        modified: f.modifiedTime,
        parents: f.parents,
        web_link: f.webViewLink
    };
}

class GoogleDriveServer {
    isAvailable(): boolean { return !!getToken(); }

    getTools() {
        return [
            {
                name: 'drive_search',
                description: 'Search files and folders in Google Drive.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Drive search query. E.g. "name contains \'budget\' and mimeType=\'application/vnd.google-apps.spreadsheet\'"' },
                        max_results: { type: 'number', description: 'Max results (default 10)' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'drive_get_file',
                description: 'Get content of a Google Drive file. Works for Docs, Sheets (as CSV), and plain text files.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        file_id: { type: 'string', description: 'Google Drive file ID' },
                        export_format: { type: 'string', description: 'For Google Docs: text/plain | text/csv | text/html (default: text/plain)' }
                    },
                    required: ['file_id']
                }
            },
            {
                name: 'drive_list_folder',
                description: 'List files inside a Google Drive folder.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        folder_id: { type: 'string', description: 'Folder ID (or "root" for My Drive root)' },
                        max_results: { type: 'number', description: 'Max results (default 20)' }
                    },
                    required: ['folder_id']
                }
            },
            {
                name: 'drive_create_file',
                description: 'Create a new plain text file in Google Drive.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'File name (e.g. "report.txt")' },
                        content: { type: 'string', description: 'File text content' },
                        folder_id: { type: 'string', description: 'Parent folder ID (optional, defaults to root)' },
                        mime_type: { type: 'string', description: 'MIME type (default: text/plain)' }
                    },
                    required: ['name', 'content']
                }
            },
            {
                name: 'drive_get_file_info',
                description: 'Get metadata (name, size, type, modified date) of a Google Drive file.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        file_id: { type: 'string', description: 'Google Drive file ID' }
                    },
                    required: ['file_id']
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Google Drive not configured. Set GOOGLE_DRIVE_ACCESS_TOKEN in .env' };
        }
        try {
            switch (name) {
                case 'drive_search': {
                    const params = new URLSearchParams({
                        q: args.query,
                        pageSize: String(args.max_results || 10),
                        fields: 'files(id,name,mimeType,size,modifiedTime,parents,webViewLink)'
                    });
                    const data = await driveFetch(`/files?${params}`);
                    return { success: true, files: (data.files || []).map(formatFile) };
                }
                case 'drive_get_file': {
                    // Get file metadata first to check MIME type
                    const meta = await driveFetch(`/files/${args.file_id}?fields=mimeType,name`);
                    const isGoogleDoc = meta.mimeType?.startsWith('application/vnd.google-apps.');
                    let content: string;
                    if (isGoogleDoc) {
                        const fmt = args.export_format || 'text/plain';
                        const token = getToken();
                        const res = await fetch(
                            `${DRIVE_API}/files/${args.file_id}/export?mimeType=${encodeURIComponent(fmt)}`,
                            { headers: { 'Authorization': `Bearer ${token}` } }
                        );
                        if (!res.ok) throw new Error(`Export failed: ${res.status}`);
                        content = await res.text();
                    } else {
                        const token = getToken();
                        const res = await fetch(
                            `${DRIVE_API}/files/${args.file_id}?alt=media`,
                            { headers: { 'Authorization': `Bearer ${token}` } }
                        );
                        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
                        content = await res.text();
                    }
                    return {
                        success: true,
                        file_id: args.file_id,
                        name: meta.name,
                        content: content.substring(0, 10000)
                    };
                }
                case 'drive_list_folder': {
                    const folderId = args.folder_id;
                    const params = new URLSearchParams({
                        q: `'${folderId}' in parents and trashed=false`,
                        pageSize: String(args.max_results || 20),
                        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)'
                    });
                    const data = await driveFetch(`/files?${params}`);
                    return { success: true, files: (data.files || []).map(formatFile) };
                }
                case 'drive_create_file': {
                    const mimeType = args.mime_type || 'text/plain';
                    const metadata: any = { name: args.name, mimeType };
                    if (args.folder_id) metadata.parents = [args.folder_id];

                    // Multipart upload
                    const boundary = `boundary_${Date.now()}`;
                    const body = [
                        `--${boundary}`,
                        'Content-Type: application/json; charset=UTF-8',
                        '',
                        JSON.stringify(metadata),
                        `--${boundary}`,
                        `Content-Type: ${mimeType}`,
                        '',
                        args.content,
                        `--${boundary}--`
                    ].join('\r\n');

                    const token = getToken();
                    const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': `multipart/related; boundary=${boundary}`
                        },
                        body
                    });
                    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
                    const file = await res.json();
                    return { success: true, file_id: file.id, name: file.name, web_link: file.webViewLink };
                }
                case 'drive_get_file_info': {
                    const data = await driveFetch(`/files/${args.file_id}?fields=id,name,mimeType,size,modifiedTime,parents,webViewLink`);
                    return { success: true, file: formatFile(data) };
                }
                default:
                    return { success: false, error: `Unknown Drive tool: ${name}` };
            }
        } catch (err: any) {
            if (err.message.includes('expired')) await refreshToken();
            return { success: false, error: err.message };
        }
    }
}

export const googleDriveServer = new GoogleDriveServer();
