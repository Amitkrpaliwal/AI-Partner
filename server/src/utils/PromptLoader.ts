/**
 * PromptLoader — Loads prompt templates from server/prompts/*.md files.
 *
 * Usage:
 *   const template = promptLoader.load('reasoner-reason', DEFAULT_PROMPT);
 *   const filled = promptLoader.interpolate(template, { GOAL: '...', CRITERIA: '...' });
 *
 * Files are loaded once and cached. Edit the .md files and restart the server
 * to pick up changes (no code change needed).
 *
 * If a file is absent or unreadable, the provided default string is used.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible directory resolution (tsx runs in ESM scope where __dirname is undefined)
const currentDir = ((): string => {
    try {
        // ESM path
        return path.dirname(fileURLToPath(import.meta.url));
    } catch {
        // CommonJS fallback
        return __dirname;
    }
})();

// server/prompts/ — two levels up from src/utils/
const PROMPTS_DIR = path.join(currentDir, '../../prompts');

class PromptLoader {
    private cache: Map<string, string> = new Map();

    /**
     * Load a prompt by name.  Falls back to `defaultContent` if the file
     * doesn't exist or can't be read.
     *
     * @param name           Filename without extension, e.g. "reasoner-reason"
     * @param defaultContent Fallback string used when the file is absent
     */
    load(name: string, defaultContent: string): string {
        if (this.cache.has(name)) return this.cache.get(name)!;

        const filePath = path.join(PROMPTS_DIR, `${name}.md`);
        try {
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            if (content.length > 0) {
                this.cache.set(name, content);
                return content;
            }
        } catch {
            // File absent or unreadable — use default silently
        }

        this.cache.set(name, defaultContent);
        return defaultContent;
    }

    /**
     * Replace {{TOKEN}} placeholders in a template string.
     *
     * Built-in auto-injected tokens (no need to pass in vars):
     *   {{CURRENT_DATE}}     — e.g. "Thursday, 20 February 2026"
     *   {{CURRENT_TIME}}     — e.g. "01:26 AM IST"
     *   {{CURRENT_DATETIME}} — date + time combined
     *
     * @param template  String with {{TOKEN}} placeholders
     * @param vars      Map of TOKEN → value (values are coerced to string)
     */
    interpolate(template: string, vars: Record<string, string | number> = {}): string {
        const now = new Date();
        const tz = 'Asia/Kolkata';
        const autoVars: Record<string, string> = {
            CURRENT_DATE: now.toLocaleDateString('en-IN', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz
            }),
            CURRENT_TIME: now.toLocaleTimeString('en-IN', {
                hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: tz
            }),
            CURRENT_DATETIME: now.toLocaleString('en-IN', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: tz
            }),
        };

        return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
            if (key in vars) return String(vars[key]);
            if (key in autoVars) return autoVars[key];
            return `{{${key}}}`;
        });
    }

    /**
     * Clear the cache entry for a prompt so the next call reloads from disk.
     * Useful during development when you want hot-reloading without restart.
     */
    reload(name: string): void {
        this.cache.delete(name);
    }

    /** Clear all cached prompts. */
    reloadAll(): void {
        this.cache.clear();
    }
}

export const promptLoader = new PromptLoader();
