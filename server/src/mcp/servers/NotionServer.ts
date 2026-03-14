/**
 * NotionServer — Native MCP-compatible server for Notion REST API.
 * Tools: search pages, get page, create page, query database, append blocks.
 * Requires: NOTION_API_KEY env var (Notion integration token starting with "secret_").
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function getToken(): string | null {
    return process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || null;
}

async function notionFetch(path: string, options: RequestInit = {}): Promise<any> {
    const token = getToken();
    if (!token) throw new Error('NOTION_API_KEY not set');

    const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> || {}),
    };

    const res = await fetch(`${NOTION_API}${path}`, { ...options, headers });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Notion API ${res.status}: ${err.substring(0, 300)}`);
    }
    return res.json();
}

/** Extract plain text from Notion rich_text array */
function richText(arr: any[]): string {
    return (arr || []).map((t: any) => t.plain_text || '').join('');
}

/** Convert a Notion page object to a readable summary */
function summarisePage(page: any): object {
    const props: Record<string, string> = {};
    for (const [key, val] of Object.entries(page.properties || {})) {
        const v = val as any;
        if (v.type === 'title') props[key] = richText(v.title);
        else if (v.type === 'rich_text') props[key] = richText(v.rich_text);
        else if (v.type === 'number') props[key] = String(v.number ?? '');
        else if (v.type === 'select') props[key] = v.select?.name || '';
        else if (v.type === 'multi_select') props[key] = v.multi_select.map((s: any) => s.name).join(', ');
        else if (v.type === 'date') props[key] = v.date?.start || '';
        else if (v.type === 'checkbox') props[key] = String(v.checkbox);
        else if (v.type === 'url') props[key] = v.url || '';
        else if (v.type === 'email') props[key] = v.email || '';
    }
    return { id: page.id, url: page.url, created_time: page.created_time, properties: props };
}

class NotionServer {
    isAvailable(): boolean {
        return !!getToken();
    }

    getTools() {
        return [
            {
                name: 'notion_search',
                description: 'Search Notion workspace for pages or databases by title/content.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Search text' },
                        filter_type: { type: 'string', description: 'page | database (omit for both)' },
                        page_size: { type: 'number', description: 'Max results (default 10)' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'notion_get_page',
                description: 'Get a Notion page by ID, including its properties and content blocks.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        page_id: { type: 'string', description: 'Notion page or block ID (with or without dashes)' },
                        include_blocks: { type: 'boolean', description: 'Also fetch page content blocks (default true)' }
                    },
                    required: ['page_id']
                }
            },
            {
                name: 'notion_create_page',
                description: 'Create a new Notion page inside a parent page or database.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        parent_id: { type: 'string', description: 'Parent page ID or database ID' },
                        parent_type: { type: 'string', description: 'page | database (default: page)' },
                        title: { type: 'string', description: 'Page title' },
                        content: { type: 'string', description: 'Page body as plain text (converted to paragraph blocks)' },
                        properties: { type: 'object', description: 'Extra database properties as key→value pairs (for database parents)' }
                    },
                    required: ['parent_id', 'title']
                }
            },
            {
                name: 'notion_query_database',
                description: 'Query a Notion database with optional filters and sorting.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        database_id: { type: 'string', description: 'Notion database ID' },
                        filter: { type: 'object', description: 'Notion filter object (optional)' },
                        sorts: { type: 'array', description: 'Sort array (optional)', items: { type: 'object' } },
                        page_size: { type: 'number', description: 'Max rows (default 20)' }
                    },
                    required: ['database_id']
                }
            },
            {
                name: 'notion_append_blocks',
                description: 'Append paragraph, heading, or bullet blocks to an existing Notion page.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        block_id: { type: 'string', description: 'Page or block ID to append to' },
                        content: { type: 'string', description: 'Plain text to append as paragraphs (newlines become separate blocks)' }
                    },
                    required: ['block_id', 'content']
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isAvailable()) {
            return { success: false, error: 'NOTION_API_KEY not set. Add it to your .env file.' };
        }

        try {
            switch (name) {
                case 'notion_search': {
                    const body: any = {
                        query: args.query,
                        page_size: args.page_size || 10
                    };
                    if (args.filter_type) {
                        body.filter = { value: args.filter_type, property: 'object' };
                    }
                    const data = await notionFetch('/search', { method: 'POST', body: JSON.stringify(body) });
                    return {
                        success: true,
                        results: data.results.map(summarisePage),
                        has_more: data.has_more
                    };
                }

                case 'notion_get_page': {
                    const pageId = args.page_id.replace(/-/g, '');
                    const page = await notionFetch(`/pages/${pageId}`);
                    const result: any = summarisePage(page);

                    if (args.include_blocks !== false) {
                        const blocks = await notionFetch(`/blocks/${pageId}/children?page_size=50`);
                        result.blocks = blocks.results.map((b: any) => {
                            const type = b.type;
                            const content = b[type];
                            return {
                                type,
                                text: richText(content?.rich_text || content?.text || [])
                            };
                        });
                    }

                    return { success: true, page: result };
                }

                case 'notion_create_page': {
                    const parentType = args.parent_type || 'page';
                    const parent = parentType === 'database'
                        ? { database_id: args.parent_id }
                        : { page_id: args.parent_id };

                    const children: any[] = [];
                    if (args.content) {
                        const lines = args.content.split('\n').filter((l: string) => l.trim());
                        children.push(...lines.map((line: string) => ({
                            object: 'block',
                            type: 'paragraph',
                            paragraph: {
                                rich_text: [{ type: 'text', text: { content: line.substring(0, 2000) } }]
                            }
                        })));
                    }

                    const properties: any = {
                        title: {
                            title: [{ type: 'text', text: { content: args.title } }]
                        }
                    };

                    if (args.properties) {
                        for (const [key, value] of Object.entries(args.properties)) {
                            properties[key] = {
                                rich_text: [{ type: 'text', text: { content: String(value) } }]
                            };
                        }
                    }

                    const data = await notionFetch('/pages', {
                        method: 'POST',
                        body: JSON.stringify({ parent, properties, children })
                    });

                    return { success: true, page_id: data.id, url: data.url };
                }

                case 'notion_query_database': {
                    const body: any = { page_size: args.page_size || 20 };
                    if (args.filter) body.filter = args.filter;
                    if (args.sorts) body.sorts = args.sorts;

                    const data = await notionFetch(`/databases/${args.database_id}/query`, {
                        method: 'POST',
                        body: JSON.stringify(body)
                    });

                    return {
                        success: true,
                        results: data.results.map(summarisePage),
                        has_more: data.has_more,
                        next_cursor: data.next_cursor
                    };
                }

                case 'notion_append_blocks': {
                    const lines = args.content.split('\n').filter((l: string) => l.trim());
                    const children = lines.map((line: string) => ({
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [{ type: 'text', text: { content: line.substring(0, 2000) } }]
                        }
                    }));

                    const blockId = args.block_id.replace(/-/g, '');
                    await notionFetch(`/blocks/${blockId}/children`, {
                        method: 'PATCH',
                        body: JSON.stringify({ children })
                    });

                    return { success: true, message: `Appended ${children.length} block(s) to ${args.block_id}` };
                }

                default:
                    return { success: false, error: `Unknown Notion tool: ${name}` };
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
}

export const notionServer = new NotionServer();
