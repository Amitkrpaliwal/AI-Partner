/**
 * TrelloServer — Trello REST API integration.
 * Tools: list boards, list cards, create card, move card, add comment, update card.
 *
 * Get credentials at: https://trello.com/power-ups/admin → API Key & Token
 * Required env vars: TRELLO_API_KEY, TRELLO_TOKEN
 */

const TRELLO_API = 'https://api.trello.com/1';

function getAuth(): string | null {
    if (!process.env.TRELLO_API_KEY || !process.env.TRELLO_TOKEN) return null;
    return `key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;
}

async function trelloFetch(path: string, options: RequestInit = {}): Promise<any> {
    const auth = getAuth();
    if (!auth) throw new Error('TRELLO_API_KEY and TRELLO_TOKEN not set');

    const separator = path.includes('?') ? '&' : '?';
    const res = await fetch(`${TRELLO_API}${path}${separator}${auth}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string> || {}) }
    });

    if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text().then(t => t.substring(0, 200))}`);
    return res.json();
}

class TrelloServer {
    isAvailable(): boolean { return !!getAuth(); }

    getTools() {
        return [
            {
                name: 'trello_list_boards',
                description: 'List all Trello boards for the authenticated user.',
                inputSchema: { type: 'object' as const, properties: {} }
            },
            {
                name: 'trello_list_cards',
                description: 'List cards in a Trello board or list. Can filter by list name.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        board_id: { type: 'string', description: 'Trello board ID (from trello_list_boards)' },
                        list_name: { type: 'string', description: 'Filter by list name (e.g. "To Do", "In Progress") — optional' }
                    },
                    required: ['board_id']
                }
            },
            {
                name: 'trello_create_card',
                description: 'Create a new card in a Trello list.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        list_id: { type: 'string', description: 'Trello list ID (from trello_list_cards)' },
                        name: { type: 'string', description: 'Card title' },
                        desc: { type: 'string', description: 'Card description (markdown)' },
                        due: { type: 'string', description: 'Due date ISO8601 (optional)' },
                        labels: { type: 'array', items: { type: 'string' }, description: 'Label color names (red, blue, green, etc.)' }
                    },
                    required: ['list_id', 'name']
                }
            },
            {
                name: 'trello_move_card',
                description: 'Move a Trello card to a different list.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        card_id: { type: 'string', description: 'Trello card ID' },
                        list_id: { type: 'string', description: 'Target list ID' }
                    },
                    required: ['card_id', 'list_id']
                }
            },
            {
                name: 'trello_add_comment',
                description: 'Add a comment to a Trello card.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        card_id: { type: 'string', description: 'Trello card ID' },
                        text: { type: 'string', description: 'Comment text' }
                    },
                    required: ['card_id', 'text']
                }
            },
            {
                name: 'trello_get_board_lists',
                description: 'Get all lists (columns) in a Trello board with their IDs.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        board_id: { type: 'string', description: 'Trello board ID' }
                    },
                    required: ['board_id']
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isAvailable()) {
            return { success: false, error: 'Trello not configured. Set TRELLO_API_KEY and TRELLO_TOKEN in .env' };
        }
        try {
            switch (name) {
                case 'trello_list_boards': {
                    const boards = await trelloFetch('/members/me/boards?fields=id,name,desc,url,closed');
                    return {
                        success: true,
                        boards: boards.filter((b: any) => !b.closed).map((b: any) => ({
                            id: b.id,
                            name: b.name,
                            desc: b.desc,
                            url: b.url
                        }))
                    };
                }
                case 'trello_list_cards': {
                    const lists = await trelloFetch(`/boards/${args.board_id}/lists?cards=open&card_fields=id,name,desc,due,labels,idList,url`);
                    let result = lists;
                    if (args.list_name) {
                        result = lists.filter((l: any) =>
                            l.name.toLowerCase().includes(args.list_name.toLowerCase())
                        );
                    }
                    return {
                        success: true,
                        lists: result.map((l: any) => ({
                            list_id: l.id,
                            list_name: l.name,
                            cards: (l.cards || []).map((c: any) => ({
                                id: c.id,
                                name: c.name,
                                desc: (c.desc || '').substring(0, 200),
                                due: c.due,
                                labels: (c.labels || []).map((lbl: any) => lbl.color),
                                url: c.url
                            }))
                        }))
                    };
                }
                case 'trello_create_card': {
                    const card = await trelloFetch(`/cards`, {
                        method: 'POST',
                        body: JSON.stringify({
                            idList: args.list_id,
                            name: args.name,
                            desc: args.desc || '',
                            due: args.due || null
                        })
                    });
                    return {
                        success: true,
                        card_id: card.id,
                        url: card.url,
                        message: `Card "${args.name}" created`
                    };
                }
                case 'trello_move_card': {
                    await trelloFetch(`/cards/${args.card_id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ idList: args.list_id })
                    });
                    return { success: true, message: `Card moved to list ${args.list_id}` };
                }
                case 'trello_add_comment': {
                    const comment = await trelloFetch(`/cards/${args.card_id}/actions/comments`, {
                        method: 'POST',
                        body: JSON.stringify({ text: args.text })
                    });
                    return { success: true, comment_id: comment.id };
                }
                case 'trello_get_board_lists': {
                    const lists = await trelloFetch(`/boards/${args.board_id}/lists?fields=id,name,closed`);
                    return {
                        success: true,
                        lists: lists.filter((l: any) => !l.closed).map((l: any) => ({
                            id: l.id,
                            name: l.name
                        }))
                    };
                }
                default:
                    return { success: false, error: `Unknown Trello tool: ${name}` };
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
}

export const trelloServer = new TrelloServer();
