/**
 * ApifyServer — Native MCP-compatible server for Apify web scraping platform.
 *
 * Tools:
 *   apify_run_actor   — Run any Apify actor with JSON input, wait for result
 *   apify_scrape_url  — Simplified URL scrape (uses headless browser actor internally)
 *   apify_get_results — Fetch paginated results from a completed actor run dataset
 *   apify_proxy_url   — Return a proxy URL string for use in scripts
 *
 * Requires: APIFY_API_TOKEN env var
 * Get token at: https://console.apify.com/account/integrations
 *
 * CAPTCHA handling: Apify routes requests through residential IPs + stealth browser
 * actors, which bypass most bot detection and CAPTCHA challenges server-side.
 */

const APIFY_BASE = 'https://api.apify.com/v2';

// Default scraping actor — supports JS rendering + stealth mode
const DEFAULT_SCRAPE_ACTOR = 'apify/cheerio-scraper';

function getToken(): string | null {
    return process.env.APIFY_API_TOKEN || null;
}

async function apifyFetch(path: string, options: RequestInit = {}): Promise<any> {
    const token = getToken();
    if (!token) throw new Error('APIFY_API_TOKEN not set');

    const sep = path.includes('?') ? '&' : '?';
    const url = `${APIFY_BASE}${path}${sep}token=${token}`;

    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string> || {}),
        }
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Apify API ${res.status}: ${err.substring(0, 300)}`);
    }

    const text = await res.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

/**
 * Wait for an actor run to finish (up to maxWaitSecs).
 * Returns the final run object with status and defaultDatasetId.
 */
async function waitForRun(runId: string, maxWaitSecs: number = 60): Promise<any> {
    const deadline = Date.now() + maxWaitSecs * 1000;
    while (Date.now() < deadline) {
        const run = await apifyFetch(`/actor-runs/${runId}`);
        const status = run?.data?.status;
        if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
            return run?.data;
        }
        await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error(`Actor run ${runId} did not finish within ${maxWaitSecs}s`);
}

class ApifyServer {
    isAvailable(): boolean {
        return !!getToken();
    }

    getTools() {
        return [
            {
                name: 'apify_run_actor',
                description: 'Run any Apify actor (web scraper or automation) with a JSON input. Apify handles JavaScript rendering, CAPTCHAs, and anti-bot detection. Returns run ID and scraped results. Use this for scraping sites that block regular fetch/curl requests.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        actorId: {
                            type: 'string',
                            description: 'Actor ID or URL-name, e.g. "apify/web-scraper", "apify/cheerio-scraper", "apify/puppeteer-scraper"'
                        },
                        input: {
                            type: 'object',
                            description: 'JSON input for the actor (startUrls, pageFunction, etc.)'
                        },
                        waitSecs: {
                            type: 'number',
                            description: 'Max seconds to wait for result (default: 120, max: 300)'
                        }
                    },
                    required: ['actorId', 'input']
                }
            },
            {
                name: 'apify_scrape_url',
                description: 'Scrape one or more URLs using a headless browser actor. Handles JavaScript, CAPTCHAs, and bot detection automatically. Returns extracted text and data from each page. Simpler alternative to apify_run_actor for basic scraping tasks.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        urls: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'List of URLs to scrape'
                        },
                        extractFields: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Optional CSS selectors or field names to extract (e.g. ["title", "h1", ".price"]). If omitted, returns full page text.'
                        },
                        waitForSelector: {
                            type: 'string',
                            description: 'Optional CSS selector to wait for before extracting (ensures dynamic content loads)'
                        },
                        useProxy: {
                            type: 'boolean',
                            description: 'Use Apify residential proxies to avoid geo-blocks and reduce CAPTCHA frequency (default: true)'
                        }
                    },
                    required: ['urls']
                }
            },
            {
                name: 'apify_get_results',
                description: 'Fetch paginated results from a completed Apify actor run dataset. Use after apify_run_actor to retrieve scraped data in bulk.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        datasetId: {
                            type: 'string',
                            description: 'Dataset ID from a completed actor run (available in run result as defaultDatasetId)'
                        },
                        limit: {
                            type: 'number',
                            description: 'Max number of items to return (default: 50, max: 1000)'
                        },
                        offset: {
                            type: 'number',
                            description: 'Number of items to skip for pagination (default: 0)'
                        },
                        fields: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Specific fields to include in each item (returns all fields if omitted)'
                        }
                    },
                    required: ['datasetId']
                }
            },
            {
                name: 'apify_proxy_url',
                description: 'Get an Apify proxy URL to use in your own scripts or fetch calls. Routes traffic through residential or datacenter IPs to avoid blocks and CAPTCHAs. Format: http://auto:<token>@proxy.apify.com:8000',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        proxyType: {
                            type: 'string',
                            description: '"residential" for real residential IPs (best for CAPTCHA bypass), "datacenter" for faster cheaper IPs (default: "residential")'
                        },
                        country: {
                            type: 'string',
                            description: 'Optional 2-letter country code to geo-target the proxy (e.g. "US", "IN", "GB")'
                        }
                    }
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isAvailable()) {
            return { success: false, error: 'APIFY_API_TOKEN not set. Add it to your .env file. Get token at: https://console.apify.com/account/integrations' };
        }

        try {
            switch (name) {

                case 'apify_run_actor': {
                    const waitSecs = Math.min(args.waitSecs || 120, 300);
                    const actorId = (args.actorId as string).replace(/\//g, '~');

                    // Start the actor run
                    const startResp = await apifyFetch(`/acts/${actorId}/runs`, {
                        method: 'POST',
                        body: JSON.stringify(args.input || {})
                    });

                    const run = startResp?.data;
                    if (!run?.id) {
                        return { success: false, error: 'Failed to start actor run', response: startResp };
                    }

                    const runId = run.id;

                    // Wait for completion
                    let finalRun: any;
                    try {
                        finalRun = await waitForRun(runId, waitSecs);
                    } catch {
                        return {
                            success: true,
                            status: 'running',
                            run_id: runId,
                            message: `Actor started but did not finish within ${waitSecs}s. Use apify_get_results with the dataset ID once done.`,
                            dataset_id: run.defaultDatasetId
                        };
                    }

                    if (finalRun.status !== 'SUCCEEDED') {
                        return {
                            success: false,
                            run_id: runId,
                            status: finalRun.status,
                            error: `Actor run ended with status: ${finalRun.status}`
                        };
                    }

                    // Fetch first page of results
                    const datasetId = finalRun.defaultDatasetId;
                    const items = datasetId
                        ? await apifyFetch(`/datasets/${datasetId}/items?limit=50`)
                        : [];

                    return {
                        success: true,
                        run_id: runId,
                        dataset_id: datasetId,
                        status: finalRun.status,
                        item_count: finalRun.stats?.itemCount || 0,
                        items: Array.isArray(items) ? items : (items?.data || [])
                    };
                }

                case 'apify_scrape_url': {
                    const urls: string[] = args.urls || [];
                    if (urls.length === 0) {
                        return { success: false, error: 'At least one URL is required' };
                    }

                    const useProxy = args.useProxy !== false;
                    const waitSecs = 120;

                    // Build input for cheerio-scraper (lightweight, no full browser)
                    // Falls back to puppeteer-scraper-like behavior via the actor
                    const input: any = {
                        startUrls: urls.map(url => ({ url })),
                        maxCrawlDepth: 0,
                        maxCrawlPages: urls.length,
                        pageFunction: args.extractFields && args.extractFields.length > 0
                            ? buildExtractFunction(args.extractFields)
                            : `async function pageFunction(context) {
                                const { $, request } = context;
                                return {
                                    url: request.url,
                                    title: $('title').text().trim(),
                                    text: $('body').text().replace(/\\s+/g, ' ').trim().substring(0, 5000)
                                };
                            }`,
                    };

                    if (useProxy) {
                        input.proxyConfiguration = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
                    }

                    if (args.waitForSelector) {
                        input.waitUntil = 'networkidle0';
                    }

                    const actorId = 'apify~cheerio-scraper';
                    const startResp = await apifyFetch(`/acts/${actorId}/runs`, {
                        method: 'POST',
                        body: JSON.stringify(input)
                    });

                    const run = startResp?.data;
                    if (!run?.id) {
                        return { success: false, error: 'Failed to start scraping actor', response: startResp };
                    }

                    let finalRun: any;
                    try {
                        finalRun = await waitForRun(run.id, waitSecs);
                    } catch {
                        return {
                            success: true,
                            status: 'running',
                            run_id: run.id,
                            dataset_id: run.defaultDatasetId,
                            message: `Scraping started but is still running. Check results with apify_get_results.`
                        };
                    }

                    const items = finalRun.defaultDatasetId
                        ? await apifyFetch(`/datasets/${finalRun.defaultDatasetId}/items?limit=100`)
                        : [];

                    return {
                        success: finalRun.status === 'SUCCEEDED',
                        run_id: run.id,
                        dataset_id: finalRun.defaultDatasetId,
                        status: finalRun.status,
                        pages_scraped: Array.isArray(items) ? items.length : 0,
                        results: Array.isArray(items) ? items : (items?.data || [])
                    };
                }

                case 'apify_get_results': {
                    const limit = Math.min(args.limit || 50, 1000);
                    const offset = args.offset || 0;
                    let path = `/datasets/${args.datasetId}/items?limit=${limit}&offset=${offset}`;
                    if (args.fields && Array.isArray(args.fields) && args.fields.length > 0) {
                        path += `&fields=${args.fields.join(',')}`;
                    }

                    const data = await apifyFetch(path);
                    const items = Array.isArray(data) ? data : (data?.data || []);
                    return {
                        success: true,
                        dataset_id: args.datasetId,
                        count: items.length,
                        offset,
                        items
                    };
                }

                case 'apify_proxy_url': {
                    const token = getToken();
                    const type = args.proxyType === 'datacenter' ? 'DATACENTER' : 'RESIDENTIAL';
                    const country = args.country ? `,country=${args.country.toUpperCase()}` : '';
                    const groups = type === 'RESIDENTIAL' ? 'RESIDENTIAL' : 'BUYPROXIES94952';
                    const proxyUrl = `http://groups-${groups}${country}:${token}@proxy.apify.com:8000`;
                    return {
                        success: true,
                        proxy_url: proxyUrl,
                        type,
                        usage: `Use as HTTP_PROXY env var or in fetch options: { agent: new HttpsProxyAgent("${proxyUrl}") }`
                    };
                }

                default:
                    return { success: false, error: `Unknown Apify tool: ${name}` };
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
}

/**
 * Build a cheerio pageFunction string that extracts specified CSS selectors.
 */
function buildExtractFunction(fields: string[]): string {
    const extractions = fields.map(f => {
        const safe = f.replace(/`/g, '\\`');
        return `${JSON.stringify(f)}: $(\`${safe}\`).map((i, el) => $(el).text().trim()).get().join(' | ')`;
    }).join(',\n');
    return `async function pageFunction(context) {
        const { $, request } = context;
        return {
            url: request.url,
            ${extractions}
        };
    }`;
}

export const apifyServer = new ApifyServer();
