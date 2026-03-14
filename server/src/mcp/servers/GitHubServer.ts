/**
 * GitHubServer — Native MCP-compatible server for GitHub REST API.
 * Tools: search repos, list/get/create issues, get file contents, list PRs, add comment.
 * Requires: GITHUB_TOKEN env var (personal access token or fine-grained PAT).
 */

const GITHUB_API = 'https://api.github.com';

function getToken(): string | null {
    return process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || null;
}

async function ghFetch(path: string, options: RequestInit = {}): Promise<any> {
    const token = getToken();
    const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AI-Partner/1.0',
        ...(options.headers as Record<string, string> || {}),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${GITHUB_API}${path}`, { ...options, headers });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`GitHub API ${res.status}: ${err.substring(0, 300)}`);
    }
    return res.json();
}

class GitHubServer {
    isAvailable(): boolean {
        return !!getToken();
    }

    getTools() {
        return [
            {
                name: 'github_search_repos',
                description: 'Search GitHub repositories by keyword, language, or topic.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Search query (e.g. "language:python stars:>1000")' },
                        per_page: { type: 'number', description: 'Results per page (default 10, max 30)' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'github_list_issues',
                description: 'List issues for a GitHub repository. Can filter by state, labels, assignee.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        owner: { type: 'string', description: 'Repository owner (user or org)' },
                        repo: { type: 'string', description: 'Repository name' },
                        state: { type: 'string', description: 'open | closed | all (default: open)' },
                        labels: { type: 'string', description: 'Comma-separated label names' },
                        per_page: { type: 'number', description: 'Max results (default 20)' }
                    },
                    required: ['owner', 'repo']
                }
            },
            {
                name: 'github_get_issue',
                description: 'Get a specific GitHub issue or pull request by number.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        owner: { type: 'string' },
                        repo: { type: 'string' },
                        issue_number: { type: 'number', description: 'Issue or PR number' }
                    },
                    required: ['owner', 'repo', 'issue_number']
                }
            },
            {
                name: 'github_create_issue',
                description: 'Create a new issue in a GitHub repository.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        owner: { type: 'string' },
                        repo: { type: 'string' },
                        title: { type: 'string', description: 'Issue title' },
                        body: { type: 'string', description: 'Issue body (markdown)' },
                        labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
                        assignees: { type: 'array', items: { type: 'string' }, description: 'GitHub usernames' }
                    },
                    required: ['owner', 'repo', 'title']
                }
            },
            {
                name: 'github_add_comment',
                description: 'Add a comment to a GitHub issue or pull request.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        owner: { type: 'string' },
                        repo: { type: 'string' },
                        issue_number: { type: 'number' },
                        body: { type: 'string', description: 'Comment text (markdown)' }
                    },
                    required: ['owner', 'repo', 'issue_number', 'body']
                }
            },
            {
                name: 'github_get_file',
                description: 'Read a file from a GitHub repository. Returns decoded content.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        owner: { type: 'string' },
                        repo: { type: 'string' },
                        path: { type: 'string', description: 'File path in repo (e.g. "src/index.ts")' },
                        ref: { type: 'string', description: 'Branch, tag, or commit SHA (default: default branch)' }
                    },
                    required: ['owner', 'repo', 'path']
                }
            },
            {
                name: 'github_list_prs',
                description: 'List pull requests for a repository.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        owner: { type: 'string' },
                        repo: { type: 'string' },
                        state: { type: 'string', description: 'open | closed | all (default: open)' },
                        per_page: { type: 'number', description: 'Max results (default 20)' }
                    },
                    required: ['owner', 'repo']
                }
            },
            {
                name: 'github_search_code',
                description: 'Search code across GitHub repositories.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Code search query (e.g. "repo:owner/name function fetchData")' },
                        per_page: { type: 'number', description: 'Max results (default 10)' }
                    },
                    required: ['query']
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isAvailable()) {
            return { success: false, error: 'GITHUB_TOKEN not set. Add it to your .env file.' };
        }

        try {
            switch (name) {
                case 'github_search_repos': {
                    const data = await ghFetch(
                        `/search/repositories?q=${encodeURIComponent(args.query)}&per_page=${args.per_page || 10}`
                    );
                    return {
                        success: true,
                        total_count: data.total_count,
                        repos: data.items.map((r: any) => ({
                            full_name: r.full_name,
                            description: r.description,
                            stars: r.stargazers_count,
                            language: r.language,
                            url: r.html_url,
                            updated_at: r.updated_at
                        }))
                    };
                }

                case 'github_list_issues': {
                    const params = new URLSearchParams({
                        state: args.state || 'open',
                        per_page: String(args.per_page || 20)
                    });
                    if (args.labels) params.set('labels', args.labels);
                    const data = await ghFetch(`/repos/${args.owner}/${args.repo}/issues?${params}`);
                    return {
                        success: true,
                        issues: data.map((i: any) => ({
                            number: i.number,
                            title: i.title,
                            state: i.state,
                            labels: i.labels.map((l: any) => l.name),
                            assignees: i.assignees.map((a: any) => a.login),
                            created_at: i.created_at,
                            url: i.html_url,
                            body_preview: (i.body || '').substring(0, 200)
                        }))
                    };
                }

                case 'github_get_issue': {
                    const data = await ghFetch(`/repos/${args.owner}/${args.repo}/issues/${args.issue_number}`);
                    return {
                        success: true,
                        number: data.number,
                        title: data.title,
                        state: data.state,
                        body: data.body,
                        labels: data.labels.map((l: any) => l.name),
                        assignees: data.assignees.map((a: any) => a.login),
                        created_at: data.created_at,
                        updated_at: data.updated_at,
                        url: data.html_url,
                        comments: data.comments
                    };
                }

                case 'github_create_issue': {
                    const data = await ghFetch(`/repos/${args.owner}/${args.repo}/issues`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: args.title,
                            body: args.body || '',
                            labels: args.labels || [],
                            assignees: args.assignees || []
                        })
                    });
                    return {
                        success: true,
                        number: data.number,
                        url: data.html_url,
                        message: `Issue #${data.number} created: ${data.html_url}`
                    };
                }

                case 'github_add_comment': {
                    const data = await ghFetch(
                        `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}/comments`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ body: args.body })
                        }
                    );
                    return { success: true, comment_id: data.id, url: data.html_url };
                }

                case 'github_get_file': {
                    const params = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
                    const data = await ghFetch(`/repos/${args.owner}/${args.repo}/contents/${args.path}${params}`);
                    const content = Buffer.from(data.content, 'base64').toString('utf-8');
                    return {
                        success: true,
                        path: data.path,
                        size: data.size,
                        sha: data.sha,
                        content
                    };
                }

                case 'github_list_prs': {
                    const params = new URLSearchParams({
                        state: args.state || 'open',
                        per_page: String(args.per_page || 20)
                    });
                    const data = await ghFetch(`/repos/${args.owner}/${args.repo}/pulls?${params}`);
                    return {
                        success: true,
                        prs: data.map((pr: any) => ({
                            number: pr.number,
                            title: pr.title,
                            state: pr.state,
                            author: pr.user.login,
                            head: pr.head.ref,
                            base: pr.base.ref,
                            created_at: pr.created_at,
                            url: pr.html_url,
                            body_preview: (pr.body || '').substring(0, 200)
                        }))
                    };
                }

                case 'github_search_code': {
                    const data = await ghFetch(
                        `/search/code?q=${encodeURIComponent(args.query)}&per_page=${args.per_page || 10}`
                    );
                    return {
                        success: true,
                        total_count: data.total_count,
                        items: data.items.map((i: any) => ({
                            repo: i.repository.full_name,
                            path: i.path,
                            url: i.html_url
                        }))
                    };
                }

                default:
                    return { success: false, error: `Unknown GitHub tool: ${name}` };
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
}

export const gitHubServer = new GitHubServer();
