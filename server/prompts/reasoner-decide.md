Based on this analysis, choose ONE action to take RIGHT NOW.

ANALYSIS:
{{ANALYSIS}}

GOAL: {{GOAL}}

AVAILABLE TOOLS:
{{TOOL_NAMES}}

You MUST choose one tool and output ONLY this JSON (no markdown, no explanation):
{"tool": "tool_name", "args": {"key": "value"}, "reasoning": "one sentence why"}

RULES:
- The "tool" field MUST be one of the tool names listed above
- For creating files use write_file with {"path": "...", "content": "..."}
- For running commands use run_command with {"command": "..."}
- Prefer INCREMENTAL steps: one small action per call
- Do NOT generate large multi-line scripts in run_command
- For reading use read_file, for exploring use list_directory

BROWSER EFFICIENCY RULES:
- When you know a sequence of browser steps (navigate→fill→click→screenshot), use browser_action_sequence with an "actions" array — this saves multiple LLM iterations
- browser_navigate now returns pagePreview automatically — no need to call browser_get_text right after navigating
- browser_click and browser_fill have automatic selector fallback — if CSS selector fails they try text= and xpath variants
- The EXECUTION_JOURNAL shows [BROWSER_STATE] entries with current url/title — read these before calling browser_get_text
- browser_fetch is faster and less detectable than browser_navigate for APIs and JSON endpoints
- stealth_fetch handles Cloudflare-protected pages

SANDBOX TOOL AVAILABILITY (pre-installed — use these, do NOT apt-get install):
- PDF generation: use `pdfkit` (npm) — `const PDFDocument = require('pdfkit'); const doc = new PDFDocument(); doc.pipe(fs.createWriteStream('out.pdf')); doc.text('...'); doc.end();`
- Markdown→PDF: use `md-to-pdf` (npm) — `const { mdToPdf } = require('md-to-pdf'); await mdToPdf({ content: markdownStr }, { dest: 'out.pdf' });`
- CSV parsing: use `csv-parser` (npm) — already installed, just `require('csv-parser')`
- Excel/XLSX: use `xlsx` (npm) — `const XLSX = require('xlsx');`
- HTML parsing: use `cheerio` (npm)
- HTTP requests: use `axios` (npm) or built-in `fetch`
- Do NOT try to install pandoc, wkhtmltopdf, or any apt package for PDF — use pdfkit or md-to-pdf instead

ANTI-LOOP / ANTI-BLOCK RULES (CRITICAL):
- If a previous browser_navigate returned blocked=true, do NOT call browser_navigate on the same domain again
- For financial/stock data: use run_command with a Node.js fetch script calling Yahoo Finance API
- For news/search: use web_search tool — it uses SearXNG which has no CAPTCHA
- For product prices: use web_search tool, not browser_navigate to Amazon/Flipkart
{{BLOCKED_SITE_CONTEXT}}
