import { EventEmitter } from 'events';
import path from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { isUrlSafe, isPathSafe, logSecurityEvent } from '../../utils/security';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface BrowserSession {
    id: string;
    status: 'launching' | 'ready' | 'navigating' | 'closed' | 'error';
    currentUrl: string;
    createdAt: number;
}

export interface NavigateRequest {
    url: string;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface ClickRequest {
    selector: string;
    timeout?: number;
}

export interface FillRequest {
    selector: string;
    value: string;
    timeout?: number;
}

export interface ExtractRequest {
    selector: string;
    attribute?: string; // If not provided, extracts textContent
    all?: boolean; // If true, extract from all matching elements
}

export interface ScreenshotRequest {
    path?: string;
    fullPage?: boolean;
    selector?: string; // Screenshot specific element
}

export interface EvalRequest {
    script: string;
}

export interface WaitRequest {
    selector?: string;
    timeout?: number;
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
}

// ============================================================================
// BROWSER SERVER
// ============================================================================

/**
 * Browser MCP Server using Playwright for web automation
 * Note: This is a lightweight wrapper. Full Playwright is lazy-loaded when needed.
 */
export class BrowserServer extends EventEmitter {
    private browser: any = null;
    private context: any = null;
    private page: any = null;
    private session: BrowserSession | null = null;
    private playwright: any = null;
    private isPlaywrightAvailable = false;
    private currentDomain: string = '';
    private readonly sessionsDir: string = process.env.BROWSER_SESSIONS_DIR || path.join(process.cwd(), 'sessions');

    // CDP screencasting
    private cdpSession: any = null;
    private screencastActive = false;
    /** Called with each JPEG frame (base64) from CDP screencasting */
    public onScreencastFrame: ((base64: string) => void) | null = null;

    constructor() {
        super();
        this.checkPlaywrightAvailability();
    }

    /**
     * Check if Playwright is installed
     */
    private async checkPlaywrightAvailability(): Promise<void> {
        try {
            // Dynamic import to avoid hard dependency
            this.playwright = await import('playwright');
            this.isPlaywrightAvailable = true;
            console.log('[BrowserServer] Playwright is available');
        } catch (e) {
            this.isPlaywrightAvailable = false;
            console.warn('[BrowserServer] Playwright not installed. Run: npm install playwright');
        }
    }

    /**
     * Get available tools for MCP protocol
     */
    getTools() {
        return [
            {
                name: 'browser_launch',
                description: 'Launch a browser session. Must be called before other browser operations.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        headless: {
                            type: 'boolean',
                            description: 'Run in headless mode (default: true)'
                        }
                    }
                }
            },
            {
                name: 'browser_navigate',
                description: 'Navigate to a URL in the browser',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL to navigate to'
                        },
                        waitUntil: {
                            type: 'string',
                            enum: ['load', 'domcontentloaded', 'networkidle'],
                            description: 'Wait condition (default: load)'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'browser_click',
                description: 'Click an element on the page',
                inputSchema: {
                    type: 'object',
                    properties: {
                        selector: {
                            type: 'string',
                            description: 'CSS selector for the element to click'
                        },
                        timeout: {
                            type: 'number',
                            description: 'Timeout in ms (default: 30000)'
                        }
                    },
                    required: ['selector']
                }
            },
            {
                name: 'browser_fill',
                description: 'Fill text into an input field',
                inputSchema: {
                    type: 'object',
                    properties: {
                        selector: {
                            type: 'string',
                            description: 'CSS selector for the input field'
                        },
                        value: {
                            type: 'string',
                            description: 'Text to enter'
                        },
                        timeout: {
                            type: 'number',
                            description: 'Timeout in ms (default: 30000)'
                        }
                    },
                    required: ['selector', 'value']
                }
            },
            {
                name: 'browser_extract',
                description: 'Extract text or attribute from element(s)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        selector: {
                            type: 'string',
                            description: 'CSS selector for the element(s)'
                        },
                        attribute: {
                            type: 'string',
                            description: 'Attribute to extract (default: textContent)'
                        },
                        all: {
                            type: 'boolean',
                            description: 'Extract from all matching elements (default: false)'
                        }
                    },
                    required: ['selector']
                }
            },
            {
                name: 'browser_screenshot',
                description: 'Take a screenshot of the page or element',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'File path to save screenshot (optional, returns base64 if not provided)'
                        },
                        fullPage: {
                            type: 'boolean',
                            description: 'Capture full page (default: false)'
                        },
                        selector: {
                            type: 'string',
                            description: 'CSS selector to screenshot specific element'
                        }
                    }
                }
            },
            {
                name: 'browser_eval',
                description: 'Execute JavaScript in the page context',
                inputSchema: {
                    type: 'object',
                    properties: {
                        script: {
                            type: 'string',
                            description: 'JavaScript code to execute'
                        }
                    },
                    required: ['script']
                }
            },
            {
                name: 'browser_wait',
                description: 'Wait for an element to appear or condition',
                inputSchema: {
                    type: 'object',
                    properties: {
                        selector: {
                            type: 'string',
                            description: 'CSS selector to wait for'
                        },
                        timeout: {
                            type: 'number',
                            description: 'Timeout in ms (default: 30000)'
                        },
                        state: {
                            type: 'string',
                            enum: ['attached', 'detached', 'visible', 'hidden'],
                            description: 'State to wait for (default: visible)'
                        }
                    },
                    required: ['selector']
                }
            },
            {
                name: 'browser_close',
                description: 'Close the browser session',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'browser_get_content',
                description: 'Get the full HTML content of the current page',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'browser_fetch',
                description: 'Fetch a URL directly via HTTP (no browser needed). Faster and less detectable than browser_navigate. Use for APIs, JSON endpoints, and simple pages. Returns raw body.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'URL to fetch' },
                        headers: { type: 'object', description: 'Optional HTTP headers to include' }
                    },
                    required: ['url']
                }
            },
            {
                name: 'stealth_fetch',
                description: 'Fetch a URL using stealth techniques to bypass Cloudflare and bot-detection. Uses the active browser context\'s cookies/fingerprint if available, otherwise falls back to enhanced HTTP with TLS fingerprinting. Use when browser_navigate or browser_fetch is blocked.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'URL to fetch stealthily' },
                        headers: { type: 'object', description: 'Optional extra HTTP headers' }
                    },
                    required: ['url']
                }
            },
            {
                name: 'browser_action_sequence',
                description: 'Execute multiple browser actions in one call, saving LLM iterations. Use when you know the sequence of steps (e.g. navigate → fill form → click submit → screenshot). Each step runs atomically; on failure, returns results up to the failed step. STRONGLY PREFER this over separate browser_* calls when you know the flow.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        actions: {
                            type: 'array',
                            description: 'Ordered list of browser actions to execute',
                            items: {
                                type: 'object',
                                properties: {
                                    tool: { type: 'string', description: 'Tool name: browser_navigate | browser_click | browser_fill | browser_extract | browser_screenshot | browser_wait | browser_scroll' },
                                    args: { type: 'object', description: 'Arguments for the tool' }
                                },
                                required: ['tool', 'args']
                            }
                        }
                    },
                    required: ['actions']
                }
            }
        ];
    }

    /**
     * Execute a tool by name
     */
    async callTool(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'browser_launch':
                return this.launch(args?.headless ?? true);
            case 'browser_navigate':
                return this.navigate(args);
            case 'browser_click':
                return this.click(args);
            case 'browser_fill':
                return this.fill(args);
            case 'browser_extract':
                return this.extract(args);
            case 'browser_screenshot':
                return this.screenshot(args);
            case 'browser_eval':
                return this.evaluate(args);
            case 'browser_wait':
                return this.wait(args);
            case 'browser_close':
                return this.close();
            case 'browser_get_content':
                return this.getContent();
            case 'browser_fetch':
                return this.fetchUrl(args?.url, args?.headers);
            case 'stealth_fetch':
                return this.stealthFetch(args?.url, args?.headers);
            case 'browser_action_sequence':
                return this.actionSequence(args?.actions || []);
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    /**
     * Execute multiple browser actions atomically in one call.
     * Saves LLM API calls for known multi-step flows (navigate→fill→click→screenshot).
     * Stops at first failure and returns results up to that point.
     */
    async actionSequence(actions: Array<{ tool: string; args: any }>): Promise<{
        success: boolean;
        results: Array<{ step: number; tool: string; result: any; success: boolean }>;
        stoppedAt?: number;
        finalUrl?: string;
        finalTitle?: string;
    }> {
        const results: Array<{ step: number; tool: string; result: any; success: boolean }> = [];

        for (let i = 0; i < actions.length; i++) {
            const { tool, args } = actions[i];
            // Prevent self-recursion — browser_action_sequence cannot nest itself
            if (tool === 'browser_action_sequence') {
                results.push({ step: i + 1, tool, result: { success: false, error: 'Nested browser_action_sequence is not allowed' }, success: false });
                return { success: false, results, stoppedAt: i + 1, finalUrl: this.page?.url(), finalTitle: await this.page?.title().catch(() => '') };
            }
            let result: any;
            try {
                result = await this.callTool(tool, args);
            } catch (e: any) {
                result = { success: false, error: e.message };
            }

            const stepSuccess = result?.success !== false && result?.isError !== true;
            results.push({ step: i + 1, tool, result, success: stepSuccess });

            if (!stepSuccess) {
                return {
                    success: false,
                    results,
                    stoppedAt: i + 1,
                    finalUrl: this.page?.url(),
                    finalTitle: await this.page?.title().catch(() => ''),
                };
            }
        }

        return {
            success: true,
            results,
            finalUrl: this.page?.url(),
            finalTitle: await this.page?.title().catch(() => ''),
        };
    }

    // ========================================================================
    // CDP SCREENCASTING — real-time frame push to Inspector
    // ========================================================================

    /**
     * Start CDP screencasting on the current page.
     * Frames arrive as JPEG base64 strings via `onScreencastFrame`.
     * Only works with Chromium (Playwright's default browser).
     */
    private async startScreencast(): Promise<void> {
        if (!this.page) return;
        // If screencast is marked active but CDPSession is gone (e.g. after browser_launch re-use),
        // reset and re-start so the panel doesn't stay blank.
        if (this.screencastActive && !this.cdpSession) this.screencastActive = false;
        if (this.screencastActive) return;
        try {
            this.cdpSession = await this.context.newCDPSession(this.page);
            await this.cdpSession.send('Page.startScreencast', {
                format: 'jpeg',
                quality: 55,          // slightly lower quality for better throughput
                maxWidth: 1280,
                maxHeight: 720,
                everyNthFrame: 2,     // ~30fps max from Chrome instead of every frame
            });
            this.screencastActive = true;

            this.cdpSession.on('Page.screencastFrame', (event: any) => {
                // Fire-and-forget ack — Chrome MUST NOT be blocked waiting for this.
                // Awaiting the ack stalls Chrome's frame delivery whenever Node.js event
                // loop is busy (LLM inference, Docker exec, etc.), causing frozen stream.
                this.cdpSession?.send('Page.screencastFrameAck', { sessionId: event.sessionId })
                    .catch(() => { /* ignore — session may have closed */ });
                if (this.onScreencastFrame) {
                    this.onScreencastFrame(event.data);
                }
            });

            console.log('[BrowserServer] CDP screencasting started');
        } catch (e: any) {
            // CDP screencasting is Chromium-only; gracefully degrade
            console.warn('[BrowserServer] CDP screencasting unavailable:', e.message);
            this.screencastActive = false;
        }
    }

    /**
     * Pause screencasting WITHOUT tearing down the CDP session.
     * Much faster than stopScreencast() — use this for brief pauses like screenshots.
     */
    private async pauseScreencast(): Promise<void> {
        if (!this.cdpSession || !this.screencastActive) return;
        try { await this.cdpSession.send('Page.stopScreencast'); } catch { /* ignore */ }
        this.screencastActive = false;
    }

    /**
     * Resume screencasting on the EXISTING CDP session (no session teardown/recreate).
     * Pair with pauseScreencast() for brief pauses like screenshots.
     * Use stopScreencast()/startScreencast() only when the page/context changes.
     */
    private async resumeScreencast(): Promise<void> {
        if (!this.cdpSession || this.screencastActive) return;
        try {
            await this.cdpSession.send('Page.startScreencast', {
                format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2,
            });
            this.screencastActive = true;
        } catch { /* ignore — non-critical */ }
    }

    /** Stop and clean up the CDP session */
    private async stopScreencast(): Promise<void> {
        if (!this.cdpSession) return;
        // RC#6: always detach the session — even if screencast was manually stopped,
        // the CDP session holds a listener that leaks if not detached.
        if (this.screencastActive) {
            try { await this.cdpSession.send('Page.stopScreencast'); } catch { /* ignore */ }
        }
        try { await this.cdpSession.detach(); } catch { /* ignore */ }
        this.cdpSession = null;
        this.screencastActive = false;
    }

    /**
     * RC#2: Attach crash/close handlers to a freshly created page.
     * Called once per page creation so dead pages are detected automatically.
     */
    private _attachPageHandlers(): void {
        if (!this.page) return;
        this.page.on('crash', () => {
            console.warn('[BrowserServer] Page crashed — marking dead, next tool call will re-launch');
            this.page = null;
            this.cdpSession = null;
            this.screencastActive = false;
        });
        this.page.on('close', () => {
            // Only reset if not an intentional browser.close() (browser still alive)
            if (this.browser) {
                console.warn('[BrowserServer] Page closed unexpectedly — marking dead');
                this.page = null;
                this.cdpSession = null;
                this.screencastActive = false;
            }
        });
    }

    /**
     * Launch browser
     */
    async launch(headless: boolean = true): Promise<{ success: boolean; session?: BrowserSession; error?: string }> {
        if (!this.isPlaywrightAvailable) {
            return {
                success: false,
                error: 'Playwright not installed. Run: npm install playwright && npx playwright install chromium'
            };
        }

        if (this.browser) {
            // RC#1+RC#5: validate page liveness — a crashed/closed page needs re-attach
            if (this.page) {
                try {
                    await this.page.evaluate(() => true); // lightweight liveness ping
                    return { success: true, session: this.session! };
                } catch {
                    console.warn('[BrowserServer] Stale page detected on browser_launch — re-attaching');
                    this.page = null;
                    this.cdpSession = null;
                    this.screencastActive = false;
                }
            }
            // Browser alive but page dead — create a new page without full re-launch
            try {
                this.page = await this.context.newPage();
                this._attachPageHandlers();
                await this.startScreencast();
                if (this.session) this.session.status = 'ready';
                console.log('[BrowserServer] Page re-attached to existing browser');
                return { success: true, session: this.session! };
            } catch (e: any) {
                console.warn('[BrowserServer] Re-attach failed, performing full re-launch:', e.message);
                await this.browser.close().catch(() => { });
                this.browser = null;
                this.context = null;
                this.page = null;
            }
        }

        // Force headless when there is no display server (Docker, CI, headless Linux).
        // The LLM sometimes requests headless:false which crashes with "Missing X server".
        const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
        if (!headless && noDisplay) {
            console.warn('[BrowserServer] No display server detected — forcing headless: true');
            headless = true;
        }

        try {
            const sessionId = `browser_${Date.now()}`;
            this.session = {
                id: sessionId,
                status: 'launching',
                currentUrl: '',
                createdAt: Date.now()
            };

            console.log(`[BrowserServer] Launching browser (headless: ${headless}, stealth: true)...`);
            this.emit('browser:launching', { sessionId });

            // Stealth launch: disable automation flags
            this.browser = await this.playwright.chromium.launch({
                headless,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-setuid-sandbox'
                ]
            });

            // RC#2: browser-level disconnect resets all state
            this.browser.on('disconnected', () => {
                console.warn('[BrowserServer] Browser disconnected — resetting all state');
                this.browser = null;
                this.context = null;
                this.page = null;
                this.cdpSession = null;
                this.screencastActive = false;
                this.session = null;
            });

            // Stealth context: realistic fingerprint
            this.context = await this.browser.newContext({
                viewport: { width: 1366, height: 768 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                locale: 'en-US',
                timezoneId: 'Asia/Kolkata',
                permissions: ['geolocation'],
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"'
                }
            });

            // Hide webdriver flag (key stealth technique)
            await this.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                // @ts-ignore
                window.chrome = { runtime: {} };
            });

            this.page = await this.context.newPage();
            this._attachPageHandlers(); // RC#2: crash/close recovery
            await this.startScreencast();

            this.session.status = 'ready';
            console.log(`[BrowserServer] Browser ready (session: ${sessionId}, stealth mode active)`);
            this.emit('browser:ready', { sessionId });

            return { success: true, session: this.session };
        } catch (e: any) {
            console.error('[BrowserServer] Launch failed:', e.message);
            this.session = null;
            return { success: false, error: e.message };
        }
    }

    // Per-domain waitUntil overrides — JS-heavy SPAs need domcontentloaded;
    // static/SSR sites that need the full load event are listed here too.
    // Global default is 'domcontentloaded' (safe for most modern sites).
    private static readonly WAIT_UNTIL_OVERRIDES: Record<string, 'load' | 'domcontentloaded' | 'networkidle'> = {
        // SPA / JS-rendered (lazy content loads AFTER load event)
        'github.com': 'domcontentloaded',
        'news.ycombinator.com': 'domcontentloaded',
        'linkedin.com': 'domcontentloaded',
        'twitter.com': 'domcontentloaded',
        'x.com': 'domcontentloaded',
        'reddit.com': 'domcontentloaded',
        'producthunt.com': 'domcontentloaded',
        // SSR / static sites that need full load
        'en.wikipedia.org': 'load',
        'wikipedia.org': 'load',
        'stackoverflow.com': 'load',
    };

    /**
     * Navigate to URL
     */
    async navigate(request: NavigateRequest): Promise<{ success: boolean; url?: string; title?: string; blocked?: boolean; blockType?: string; error?: string }> {
        // Fix 5: auto-launch browser if not already running
        if (!this.page) {
            const autoLaunch = await this.launch(true);
            if (!autoLaunch.success) {
                return { success: false, error: `Auto-launch failed: ${autoLaunch.error}` };
            }
        }
        if (!this.page) {
        }

        try {
            // SSRF protection: validate URL before navigation
            const urlCheck = isUrlSafe(request.url);
            if (!urlCheck.safe) {
                logSecurityEvent('block', 'BrowserServer', `navigate blocked: ${urlCheck.reason}`, { url: request.url });
                return { success: false, error: `URL blocked: ${urlCheck.reason}` };
            }

            const navHostname = (() => { try { return new URL(request.url).hostname; } catch { return ''; } })();
            const waitUntil = request.waitUntil
                || BrowserServer.WAIT_UNTIL_OVERRIDES[navHostname]
                || 'domcontentloaded';
            console.log(`[BrowserServer] Navigating to: ${request.url}`);
            this.emit('browser:navigating', { url: request.url });

            // Per-domain session persistence: restore cookies/localStorage on first navigation to a domain
            const hostname = new URL(request.url).hostname;
            if (!this.currentDomain && this.context && hostname) {
                const sessionFile = path.join(this.sessionsDir, `${hostname.replace(/[^a-z0-9.-]/gi, '_')}.json`);
                try {
                    const raw = await readFile(sessionFile, 'utf8');
                    const storageState = JSON.parse(raw);
                    // Close fresh context and reopen with saved state
                    await this.page.close().catch(() => { });
                    await this.context.close().catch(() => { });
                    this.context = await this.browser.newContext({
                        viewport: { width: 1366, height: 768 },
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                        locale: 'en-US',
                        timezoneId: 'Asia/Kolkata',
                        storageState,
                        extraHTTPHeaders: {
                            'Accept-Language': 'en-US,en;q=0.9',
                            'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
                            'sec-ch-ua-mobile': '?0',
                            'sec-ch-ua-platform': '"Windows"'
                        }
                    });
                    await this.context.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        // @ts-ignore
                        window.chrome = { runtime: {} };
                    });
                    this.page = await this.context.newPage();
                    this._attachPageHandlers(); // RC#2: crash/close recovery on restored page
                    // RC#1: properly stop old screencast before starting new one
                    await this.stopScreencast();
                    await this.startScreencast();
                    console.log(`[BrowserServer] Session restored for domain: ${hostname}`);
                } catch {
                    // No saved session — proceed with fresh context
                }
                this.currentDomain = hostname;
            }

            if (this.session) this.session.status = 'navigating';
            await this.page.goto(request.url, { waitUntil, timeout: 30000 });
            // RC#3: For JS-heavy SPAs (Reddit, Twitter, etc.) wait for actual content to appear
            // rather than a fixed 1.5s delay — avoids returning blank skeleton HTML.
            // If no meaningful text arrives within 5s, proceed anyway (sparse pages are valid).
            if (waitUntil === 'domcontentloaded') {
                // Wait until the page has enough text that actual content (posts, articles,
                // results) must have rendered — 1500 chars is well past any nav/skeleton.
                await this.page.waitForFunction(
                    () => (document.body?.innerText?.trim()?.length ?? 0) > 1500,
                    { timeout: 8000 }
                ).catch(() => { /* timeout OK — proceed with whatever is loaded */ });
            }

            const title = await this.page.title();
            const finalUrl = this.page.url();

            if (this.session) {
                this.session.status = 'ready';
                this.session.currentUrl = finalUrl;
            }

            // CAPTCHA / block detection — check before returning success
            const blockStatus = await this.detectBlock(title, finalUrl);
            if (blockStatus.blocked) {
                console.warn(`[BrowserServer] Page blocked (${blockStatus.type}): ${finalUrl}`);
                this.emit('browser:blocked', { url: finalUrl, blockType: blockStatus.type });
                return {
                    success: false,
                    blocked: true,
                    blockType: blockStatus.type,
                    url: finalUrl,
                    title,
                    error: `Page blocked by ${blockStatus.type}. Switch to web_search or a public API instead of browser scraping.`
                };
            }

            console.log(`[BrowserServer] Navigated to: ${finalUrl} (${title})`);
            this.emit('browser:navigated', { url: finalUrl, title });

            // Auto-return a truncated page text preview so the agent doesn't need
            // a separate browser_get_text call just to know what's on the page.
            // Saves 1 LLM iteration per navigation.
            let pagePreview = '';
            try {
                const rawText = await this.page!.evaluate(() => {
                    // Remove script/style/nav noise, get meaningful body text
                    const els = document.querySelectorAll('script,style,nav,header,footer,noscript');
                    els.forEach(el => el.remove());
                    return (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                });
                pagePreview = rawText.substring(0, 4000) + (rawText.length > 4000 ? '…' : '');
            } catch { /* non-fatal — page preview is best-effort */ }

            return { success: true, url: finalUrl, title, pagePreview };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Detect CAPTCHA, Cloudflare, and other bot-blocking pages.
     * Returns blocked:true with the type of block detected.
     */
    private async detectBlock(title: string, url: string): Promise<{ blocked: boolean; type?: string }> {
        try {
            const t = title.toLowerCase();
            const u = url.toLowerCase();

            // Google CAPTCHA / "sorry" page
            if (u.includes('google.com/sorry') || u.includes('recaptcha') || u.includes('accounts.google.com/v3/signin'))
                return { blocked: true, type: 'captcha' };

            // Common CAPTCHA indicators in title
            if (t.includes('captcha') || t.includes('are you a robot') || t.includes('verify you are human'))
                return { blocked: true, type: 'captcha' };

            // Cloudflare challenge
            if (t.includes('just a moment') || t.includes('checking your browser') || t.includes('please wait'))
                return { blocked: true, type: 'cloudflare' };

            // Access denied / forbidden
            if (t.includes('access denied') || t.includes('403 forbidden') || t.includes('permission denied'))
                return { blocked: true, type: 'access_denied' };

            // Rate limiting
            if (t.includes('rate limit') || t.includes('too many requests') || t.includes('429'))
                return { blocked: true, type: 'rate_limit' };

            // Check page body for block indicators (sample first 800 chars)
            const bodySnippet: string = await this.page.evaluate(() =>
                (document.body?.innerText || '').substring(0, 800).toLowerCase()
            ).catch(() => '');

            if (bodySnippet.includes('enable javascript') && bodySnippet.includes('cloudflare'))
                return { blocked: true, type: 'cloudflare' };
            if (bodySnippet.includes('unusual traffic') || bodySnippet.includes('automated queries'))
                return { blocked: true, type: 'captcha' };
            if (bodySnippet.includes('your ip has been blocked') || bodySnippet.includes('ip address has been blocked'))
                return { blocked: true, type: 'ip_blocked' };

            return { blocked: false };
        } catch {
            return { blocked: false }; // If detection fails, assume not blocked
        }
    }

    /**
     * Direct HTTP fetch without browser — faster and less detectable than browser_navigate.
     * Use for APIs, JSON endpoints, and simple HTML pages.
     */
    async fetchUrl(url: string, headers?: Record<string, string>): Promise<{ success: boolean; status?: number; body?: string; contentType?: string; error?: string }> {
        try {
            const urlCheck = isUrlSafe(url);
            if (!urlCheck.safe) {
                return { success: false, error: `URL blocked: ${urlCheck.reason}` };
            }

            const https = await import('https');
            const http = await import('http');
            const { URL: NodeURL } = await import('url');

            const parsed = new NodeURL(url);
            const lib = parsed.protocol === 'https:' ? https : http;

            const defaultHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/html, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                ...headers
            };

            return new Promise((resolve) => {
                const req = lib.get(url, { headers: defaultHeaders, timeout: 15000 }, (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                    res.on('end', () => {
                        resolve({
                            success: (res.statusCode || 0) < 400,
                            status: res.statusCode,
                            body: data.substring(0, 50000), // cap at 50KB
                            contentType: res.headers['content-type'] || ''
                        });
                    });
                });
                req.on('error', (e: Error) => resolve({ success: false, error: e.message }));
                req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Request timed out' }); });
            });
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Stealth fetch — bypasses Cloudflare and bot-detection by using:
     * 1. Playwright's request context (shares browser cookies + TLS fingerprint) if browser is active
     * 2. Otherwise: enhanced HTTP with realistic headers + random delays
     * Returns { success, body, contentType, strategy } so caller knows what worked.
     */
    async stealthFetch(url: string, extraHeaders?: Record<string, string>): Promise<{
        success: boolean; body?: string; contentType?: string; strategy?: string; error?: string;
    }> {
        try {
            const urlCheck = isUrlSafe(url);
            if (!urlCheck.safe) {
                return { success: false, error: `URL blocked: ${urlCheck.reason}` };
            }

            // Strategy 1: Use Playwright's browser context request — shares real browser's
            // TLS fingerprint, cookies, and User-Agent. Most reliable Cloudflare bypass.
            if (this.context) {
                try {
                    console.log(`[BrowserServer] stealth_fetch via Playwright context: ${url}`);
                    const response = await this.context.request.get(url, {
                        timeout: 30000,
                        headers: {
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Cache-Control': 'no-cache',
                            'Pragma': 'no-cache',
                            'Sec-Fetch-Dest': 'document',
                            'Sec-Fetch-Mode': 'navigate',
                            'Sec-Fetch-Site': 'none',
                            'Upgrade-Insecure-Requests': '1',
                            ...extraHeaders,
                        },
                        ignoreHTTPSErrors: true,
                    });

                    if (response.ok()) {
                        const body = await response.text();
                        const contentType = response.headers()['content-type'] || '';

                        // Quick Cloudflare check on result
                        const preview = body.substring(0, 500).toLowerCase();
                        if (preview.includes('just a moment') && preview.includes('cloudflare')) {
                            // Still blocked — fall through to next strategy
                            console.warn('[BrowserServer] stealth_fetch Strategy 1 still blocked by Cloudflare');
                        } else {
                            console.log(`[BrowserServer] stealth_fetch Strategy 1 success (${body.length} chars)`);
                            return { success: true, body: body.substring(0, 100000), contentType, strategy: 'playwright_context' };
                        }
                    }
                } catch (e: any) {
                    console.warn(`[BrowserServer] stealth_fetch Strategy 1 failed: ${e.message}`);
                }
            }

            // Strategy 2: Enhanced HTTP with rotating realistic headers and slight jitter delay
            // Simulates a real browser request without Playwright overhead.
            const jitterMs = 500 + Math.random() * 1500; // 0.5 - 2s human-like delay
            await new Promise(r => setTimeout(r, jitterMs));

            const userAgents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
            ];
            const ua = userAgents[Math.floor(Math.random() * userAgents.length)];

            const https = await import('https');
            const http = await import('http');
            const { URL: NodeURL } = await import('url');

            const parsed = new NodeURL(url);
            const lib = parsed.protocol === 'https:' ? https : http;

            const stealthHeaders = {
                'User-Agent': ua,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Upgrade-Insecure-Requests': '1',
                'DNT': '1',
                ...extraHeaders,
            };

            const result = await new Promise<{ success: boolean; body?: string; contentType?: string; error?: string }>((resolve) => {
                const req = lib.get(url, { headers: stealthHeaders, timeout: 20000 }, (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                    res.on('end', () => {
                        const ok = (res.statusCode || 0) < 400;
                        resolve({
                            success: ok,
                            body: data.substring(0, 100000),
                            contentType: res.headers['content-type'] || '',
                        });
                    });
                });
                req.on('error', (e: Error) => resolve({ success: false, error: e.message }));
                req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Request timed out' }); });
            });

            if (result.success) {
                const preview = (result.body || '').substring(0, 500).toLowerCase();
                if (preview.includes('just a moment') && preview.includes('cloudflare')) {
                    return { success: false, error: 'Cloudflare challenge page — stealth bypass failed. Human intervention required.' };
                }
                console.log(`[BrowserServer] stealth_fetch Strategy 2 success (${result.body?.length} chars)`);
                return { ...result, strategy: 'enhanced_http' };
            }

            return { success: false, error: result.error || 'All stealth strategies exhausted' };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Click element
     */
    async click(request: ClickRequest): Promise<{ success: boolean; error?: string }> {
        // Fix 5: auto-launch
        if (!this.page) {
            const al = await this.launch(true);
            if (!al.success) return { success: false, error: `Auto-launch failed: ${al.error}` };
        }
        if (!this.page) { return { success: false, error: 'Browser not available' }; }

        try {
            const timeout = request.timeout || 15000;
            const sel = request.selector;
            console.log(`[BrowserServer] Clicking: ${sel}`);

            // Detect whether sel is a CSS/XPath selector or plain human-readable text.
            // CSS selectors contain #, ., [, >, :, (, ) or start with a tag name + space.
            // Text fallbacks (text=, aria-label, title) only make sense for plain strings.
            const isCssSelector = /[#.\[>:()]/.test(sel) || /^(input|button|a|div|span|form)\b/i.test(sel);

            const fallbacks: string[] = [sel];
            if (!isCssSelector) {
                // Plain text: try Playwright text locator, XPath text match, aria-label, title
                fallbacks.push(
                    `text=${sel}`,
                    `xpath=//*[contains(text(),'${sel.replace(/'/g, "\\'")}')]`,
                    `[aria-label="${sel}"]`,
                    `[title="${sel}"]`,
                );
            }
            // Always try role-based: button with matching text (useful for submit buttons)
            if (!isCssSelector) fallbacks.push(`role=button[name="${sel}"]`);

            let lastErr = '';
            for (const candidate of fallbacks) {
                try {
                    await this.page.click(candidate, { timeout: candidate === sel ? timeout : 5000 });
                    if (candidate !== sel) console.log(`[BrowserServer] Click succeeded with fallback: ${candidate}`);
                    this.emit('browser:clicked', { selector: candidate });
                    const newUrl = this.page.url();
                    return { success: true, url: newUrl };
                } catch (e: any) {
                    lastErr = e.message;
                }
            }
            return { success: false, error: `Element not found: "${sel}". Last error: ${lastErr.substring(0, 200)}` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Fill input
     */
    async fill(request: FillRequest): Promise<{ success: boolean; error?: string }> {
        // Fix 5: auto-launch
        if (!this.page) {
            const al = await this.launch(true);
            if (!al.success) return { success: false, error: `Auto-launch failed: ${al.error}` };
        }
        if (!this.page) { return { success: false, error: 'Browser not available' }; }

        try {
            const timeout = request.timeout || 15000;
            const sel = request.selector;
            console.log(`[BrowserServer] Filling: ${sel}`);

            // Detect CSS selector vs plain text (field label/placeholder text)
            const isCssSelector = /[#.\[>:()]/.test(sel) || /^(input|textarea|select)\b/i.test(sel);

            const fallbacks: string[] = [sel];
            if (!isCssSelector) {
                // Plain text like "Email", "Password" — try placeholder, name, label text
                fallbacks.push(
                    `[placeholder*="${sel}"]`,
                    `[name="${sel}"]`,
                    `[id="${sel}"]`,
                    `[aria-label*="${sel}"]`,
                );
            }

            let lastErr = '';
            for (const candidate of fallbacks) {
                try {
                    await this.page.fill(candidate, request.value, { timeout: candidate === sel ? timeout : 5000 });
                    if (candidate !== sel) console.log(`[BrowserServer] Fill succeeded with fallback: ${candidate}`);
                    this.emit('browser:filled', { selector: candidate });
                    return { success: true };
                } catch (e: any) {
                    lastErr = e.message;
                    // If primary CSS selector timed out (element exists but slow), don't try text fallbacks
                    if (candidate === sel && e.message.includes('Timeout')) break;
                }
            }
            return { success: false, error: `Input not found: "${sel}". Last error: ${lastErr.substring(0, 200)}` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Extract content
     */
    async extract(request: ExtractRequest): Promise<{ success: boolean; data?: string | string[]; error?: string }> {
        // Fix 5: auto-launch
        if (!this.page) {
            const al = await this.launch(true);
            if (!al.success) return { success: false, error: `Auto-launch failed: ${al.error}` };
        }
        if (!this.page) { return { success: false, error: 'Browser not available' }; }

        try {
            if (request.all) {
                const elements = await this.page.$$(request.selector);
                const results: string[] = [];

                for (const el of elements) {
                    if (request.attribute) {
                        const value = await el.getAttribute(request.attribute);
                        if (value) results.push(value);
                    } else {
                        const text = await el.textContent();
                        if (text) results.push(text.trim());
                    }
                }

                return { success: true, data: results };
            } else {
                const element = await this.page.$(request.selector);
                if (!element) {
                    return { success: false, error: `Element not found: ${request.selector}` };
                }

                let value: string;
                if (request.attribute) {
                    value = await element.getAttribute(request.attribute) || '';
                } else {
                    value = (await element.textContent() || '').trim();
                }

                return { success: true, data: value };
            }
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Take screenshot
     */
    async screenshot(request: ScreenshotRequest = {}): Promise<{ success: boolean; path?: string; base64?: string; error?: string }> {
        // Fix 5: auto-launch
        if (!this.page) {
            const al = await this.launch(true);
            if (!al.success) return { success: false, error: `Auto-launch failed: ${al.error}` };
        }
        if (!this.page) { return { success: false, error: 'Browser not available' }; }

        try {
            const options: any = {
                fullPage: request.fullPage || false
            };

            let target = this.page;
            if (request.selector) {
                target = await this.page.$(request.selector);
                if (!target) {
                    return { success: false, error: `Element not found: ${request.selector}` };
                }
            }

            // Pause CDP screencasting while taking screenshot — active screencasting
            // locks Chromium's compositor and causes page.screenshot() to return
            // only the 8-byte PNG magic header with no image data.
            // Use pauseScreencast()/resumeScreencast() — keeps the CDP session alive
            // so the stream resumes instantly with no re-setup delay (RC#4).
            const wasScreencasting = this.screencastActive;
            if (wasScreencasting) {
                await this.pauseScreencast();
            }

            try {
                if (request.path) {
                    // Allow paths under /workspace (MCP filesystem root) or CWD.
                    // The agent always targets /workspace/output/... which is outside /app (CWD in Docker).
                    const workspaceRoot = process.env.MCP_WORKSPACE_ROOT || '/workspace';
                    let pathCheck = isPathSafe(request.path, workspaceRoot);
                    if (!pathCheck.safe) {
                        pathCheck = isPathSafe(request.path, process.cwd());
                    }
                    if (!pathCheck.safe) {
                        logSecurityEvent('block', 'BrowserServer', `screenshot path blocked: ${pathCheck.reason}`, { path: request.path });
                        return { success: false, error: `Path blocked: ${pathCheck.reason}` };
                    }

                    // Ensure parent directory exists
                    const { mkdir: mkdirFs } = await import('fs/promises');
                    await mkdirFs(path.dirname(pathCheck.resolved), { recursive: true }).catch(() => { });

                    await target.screenshot({ path: pathCheck.resolved, ...options });
                    console.log(`[BrowserServer] Screenshot saved: ${pathCheck.resolved}`);
                    return { success: true, path: pathCheck.resolved };
                } else {
                    const buffer = await target.screenshot(options);
                    const base64 = buffer.toString('base64');

                    // Auto-save to workspace so the file appears in the file tree.
                    // The agent can still read base64 from the response; the file is a bonus.
                    const workspaceRoot = process.env.MCP_WORKSPACE_ROOT || '/workspace';
                    const autoDir = path.join(workspaceRoot, 'output', 'screenshots');
                    const autoFile = path.join(autoDir, `screenshot_${Date.now()}.png`);
                    try {
                        const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('fs/promises');
                        await mkdirFs(autoDir, { recursive: true });
                        await writeFileFs(autoFile, buffer);
                        console.log(`[BrowserServer] Screenshot auto-saved: ${autoFile}`);
                        return { success: true, base64, path: autoFile };
                    } catch {
                        // Auto-save is best-effort; still return base64 on failure
                        return { success: true, base64 };
                    }
                }
            } finally {
                // Resume on the existing CDP session — much faster than full start/stop.
                if (wasScreencasting) {
                    await this.resumeScreencast();
                }
            }
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Evaluate JavaScript
     */
    async evaluate(request: EvalRequest): Promise<{ success: boolean; result?: any; error?: string }> {
        // Fix 5: auto-launch
        if (!this.page) {
            const al = await this.launch(true);
            if (!al.success) return { success: false, error: `Auto-launch failed: ${al.error}` };
        }
        if (!this.page) { return { success: false, error: 'Browser not available' }; }

        try {
            // Audit log for script evaluation
            logSecurityEvent('info', 'BrowserServer', `browser_eval executing (${request.script.length} chars)`, {
                preview: request.script.substring(0, 100)
            });
            const result = await this.page.evaluate(request.script);
            return { success: true, result };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Wait for element
     */
    async wait(request: WaitRequest): Promise<{ success: boolean; error?: string }> {
        // Fix 5: auto-launch
        if (!this.page) {
            const al = await this.launch(true);
            if (!al.success) return { success: false, error: `Auto-launch failed: ${al.error}` };
        }
        if (!this.page) { return { success: false, error: 'Browser not available' }; }

        try {
            const timeout = request.timeout || 30000;
            const state = request.state || 'visible';

            console.log(`[BrowserServer] Waiting for: ${request.selector} (${state})`);
            await this.page.waitForSelector(request.selector, { timeout, state });

            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Get page content
     */
    async getContent(): Promise<{ success: boolean; html?: string; error?: string }> {
        // Fix 5: auto-launch
        if (!this.page) {
            const al = await this.launch(true);
            if (!al.success) return { success: false, error: `Auto-launch failed: ${al.error}` };
        }
        if (!this.page) { return { success: false, error: 'Browser not available' }; }

        try {
            const html = await this.page.content();
            return { success: true, html };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Close browser
     */
    async close(): Promise<{ success: boolean }> {
        if (this.browser) {
            // Save session state for the current domain before closing
            if (this.context && this.currentDomain) {
                try {
                    await mkdir(this.sessionsDir, { recursive: true });
                    const storageState = await this.context.storageState();
                    const sessionFile = path.join(this.sessionsDir, `${this.currentDomain.replace(/[^a-z0-9.-]/gi, '_')}.json`);
                    await writeFile(sessionFile, JSON.stringify(storageState), 'utf8');
                    console.log(`[BrowserServer] Session saved for domain: ${this.currentDomain}`);
                } catch (e: any) {
                    console.warn(`[BrowserServer] Failed to save session: ${e.message}`);
                }
            }
            await this.stopScreencast();
            try {
                await this.browser.close();
                console.log('[BrowserServer] Browser closed');
                this.emit('browser:closed', { sessionId: this.session?.id });
            } catch (e) {
                // Ignore close errors
            }
            this.browser = null;
            this.context = null;
            this.page = null;
            this.session = null;
            this.currentDomain = '';
        }
        return { success: true };
    }

    /**
     * Get current session info
     */
    getSession(): BrowserSession | null {
        return this.session;
    }

    /**
     * Check if browser is ready
     */
    isReady(): boolean {
        return this.page !== null && this.session?.status === 'ready';
    }

    /**
     * Get current page URL (for browser control panel)
     */
    getCurrentUrl(): string {
        return this.session?.currentUrl || '';
    }

    /**
     * Whether a browser session is currently active.
     */
    isLaunched(): boolean {
        return this.page !== null;
    }

    /**
     * Click at absolute pixel coordinates — used for human-control forwarding.
     * Viewport is 1366×768.
     */
    async clickAtCoordinates(x: number, y: number): Promise<{ success: boolean; error?: string }> {
        if (!this.page) return { success: false, error: 'Browser not launched' };
        try {
            await this.page.mouse.click(x, y);
            this.emit('browser:clicked', { x, y });
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Type text — used for human-control forwarding.
     */
    async typeText(text: string): Promise<{ success: boolean; error?: string }> {
        if (!this.page) return { success: false, error: 'Browser not launched' };
        try {
            await this.page.keyboard.type(text);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Press a named key (e.g. 'Enter', 'Tab', 'Backspace', 'Escape') — human-control forwarding.
     */
    async pressKey(key: string): Promise<{ success: boolean; error?: string }> {
        if (!this.page) return { success: false, error: 'Browser not launched' };
        try {
            await this.page.keyboard.press(key);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Scroll the page by (deltaX, deltaY) pixels at a given point — human-control forwarding.
     */
    async scrollAt(x: number, y: number, deltaX: number, deltaY: number): Promise<{ success: boolean; error?: string }> {
        if (!this.page) return { success: false, error: 'Browser not launched' };
        try {
            await this.page.mouse.wheel(deltaX, deltaY);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }
}

// Singleton instance
export const browserServer = new BrowserServer();
