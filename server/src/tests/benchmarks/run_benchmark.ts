/**
 * AI Partner — Benchmark Runner
 * Tests G01–G20 via POST /api/autonomous/goal/sync
 * NEVER uses /api/chat — tests must go through the goal executor directly.
 *
 * Usage:
 *   npx ts-node --esm src/tests/benchmarks/run_benchmark.ts
 *   npx ts-node --esm src/tests/benchmarks/run_benchmark.ts --goals G01,G06  (subset)
 *   npx ts-node --esm src/tests/benchmarks/run_benchmark.ts --advanced         (G22–G26)
 *   npx ts-node --esm src/tests/benchmarks/run_benchmark.ts --browser          (BG01–BG10)
 *   npx ts-node --esm src/tests/benchmarks/run_benchmark.ts --browser-smoke    (Phase 1: infra only)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL      = process.env.BENCHMARK_URL || 'http://localhost:3000';
const MODEL         = process.env.BENCHMARK_MODEL || 'unknown';
const ADVANCED      = process.argv.includes('--advanced');
const BROWSER       = process.argv.includes('--browser');
const BROWSER_SMOKE = process.argv.includes('--browser-smoke');
const SUBSET   = (() => {
  const idx = process.argv.indexOf('--goals');
  return idx !== -1 ? process.argv[idx + 1]?.split(',') : null;
})();

// ============================================================================
// Goal definitions
// ============================================================================

interface Goal {
  id: string;
  text: string;
  expectedFiles: string[];             // relative to /workspace/
  criteriaType: 'file_exists' | 'file_contains' | 'file_size' | 'llm_evaluates';
  fileContains?: string;               // for file_contains check
  fileSizeMin?: number;                // for file_size check (bytes)
  timeoutMs: number;
  dependsOn?: string;                  // goal ID that must pass first
  seedBefore?: Record<string,string>;  // path → content to write before goal runs
}

const GOALS_BASIC: Goal[] = [
  // Category A — File generation (no network)
  {
    id: 'G01',
    text: 'Write a CSV file to /workspace/output/employees.csv with exactly 10 rows of fake employee data with columns: name, age, department, salary. Include a header row.',
    expectedFiles: ['output/employees.csv'],
    criteriaType: 'file_contains',
    fileContains: 'name',
    timeoutMs: 900_000,
  },
  {
    id: 'G02',
    text: 'Generate a JSON file at /workspace/output/cities.json listing 5 Indian cities. Each entry must have fields: city, state, population.',
    expectedFiles: ['output/cities.json'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },
  {
    id: 'G03',
    text: 'Write a Python script to /workspace/output/fibonacci.py that defines a function called fibonacci() which computes and prints all Fibonacci numbers up to 100.',
    expectedFiles: ['output/fibonacci.py'],
    criteriaType: 'file_contains',
    fileContains: 'def fibonacci',
    timeoutMs: 900_000,
  },
  {
    id: 'G04',
    text: 'Create an Excel (XLSX) spreadsheet at /workspace/output/budget.xlsx with a monthly budget template. Include 12 rows (one per month) with columns: Month, Income, Expenses, Savings.',
    expectedFiles: ['output/budget.xlsx'],
    criteriaType: 'file_size',
    fileSizeMin: 4000,  // Real xlsx must be > 4 KB (skeleton/text would be < 500 bytes)
    timeoutMs: 900_000,
  },
  {
    id: 'G05',
    text: 'Write a markdown report to /workspace/output/solar_report.md about solar energy. The report must include a "Pros" section and a "Cons" section with at least 3 points each.',
    expectedFiles: ['output/solar_report.md'],
    criteriaType: 'file_contains',
    fileContains: 'Pros',
    timeoutMs: 900_000,
  },

  // Category B — Code execution (Docker sandbox)
  {
    id: 'G06',
    text: 'Execute a Python script that computes the mean and standard deviation of the list [12,45,7,89,23,56,34,78]. Write the results to /workspace/output/stats.txt. The file must contain the word "mean".',
    expectedFiles: ['output/stats.txt'],
    criteriaType: 'file_contains',
    fileContains: 'mean',
    timeoutMs: 900_000,
  },
  {
    id: 'G07',
    text: 'A JSON file exists at /workspace/sample.json. Execute a Node.js script that reads this file and counts the number of top-level keys. Write the count to /workspace/output/keycount.txt. The file should contain the number 5.',
    expectedFiles: ['output/keycount.txt'],
    criteriaType: 'file_contains',
    fileContains: '5',
    timeoutMs: 900_000,
    seedBefore: {
      '/workspace/sample.json': '{"name":"test","version":1,"env":"dev","debug":true,"max_retries":3}',
    },
  },
  {
    id: 'G08',
    text: 'Run a shell command to find all files with the .py extension in /workspace recursively. Save the list of file paths to /workspace/output/pyfiles.txt.',
    expectedFiles: ['output/pyfiles.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },
  {
    id: 'G09',
    text: 'Execute a Python script that generates a multiplication table from 1 to 10. Format it so each line looks like "N x M = R". Save the output to /workspace/output/table.txt.',
    expectedFiles: ['output/table.txt'],
    criteriaType: 'file_contains',
    fileContains: '10 x',
    timeoutMs: 900_000,
  },
  {
    id: 'G10',
    text: 'Execute a Python script that parses the JSON string \'{"product": "laptop", "price": 999, "qty": 5}\' and writes a formatted human-readable summary to /workspace/output/parsed.txt.',
    expectedFiles: ['output/parsed.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },

  // Category C — Web fetch (network required)
  {
    id: 'G11',
    text: 'Fetch the current price of Bitcoin (BTC) in USD from any public source. Write the price and the source URL to /workspace/output/btc_price.txt.',
    expectedFiles: ['output/btc_price.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },
  {
    id: 'G12',
    text: 'Search the web for the top 3 AI agent frameworks available in 2025 or 2026. Write a summary of each (2 sentences minimum) to /workspace/output/frameworks.md.',
    expectedFiles: ['output/frameworks.md'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },
  {
    id: 'G13',
    text: 'Fetch today\'s current weather for Mumbai, India from any public weather source. Write the temperature (in Celsius or Fahrenheit) and weather condition to /workspace/output/weather.txt.',
    expectedFiles: ['output/weather.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },
  {
    id: 'G14',
    text: 'Fetch the current USD to INR exchange rate from any public source. Write the rate and source to /workspace/output/exchange.txt. The rate should be a number.',
    expectedFiles: ['output/exchange.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },
  {
    id: 'G15',
    text: 'Search for the latest news headline about the Indian stock market (NSE or BSE) from today or yesterday. Write a 2-3 sentence summary to /workspace/output/market_news.txt.',
    expectedFiles: ['output/market_news.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },

  // Category D — Multi-step reasoning
  {
    id: 'G16',
    text: 'Create a 5-day vegetarian meal plan. Each day must have a different meal. Write the plan to /workspace/output/mealplan.md with one day per section.',
    expectedFiles: ['output/mealplan.md'],
    criteriaType: 'file_contains',
    fileContains: 'Day',
    timeoutMs: 900_000,
  },
  {
    id: 'G17',
    text: 'Write a Python script that generates a random password of exactly 16 characters containing uppercase letters, lowercase letters, digits, and symbols. Execute the script and save the generated password to /workspace/output/password.txt.',
    expectedFiles: ['output/password.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },
  {
    id: 'G18',
    text: 'Fetch the current price of Bitcoin (BTC) in USD. Fetch the current price of Ethereum (ETH) in USD. Compute the BTC/ETH ratio. Save all three values (BTC price, ETH price, ratio) to /workspace/output/crypto_ratio.txt.',
    expectedFiles: ['output/crypto_ratio.txt'],
    criteriaType: 'file_contains',
    fileContains: 'BTC',
    timeoutMs: 900_000,
  },
  {
    id: 'G19',
    text: 'Create a 30-day Rust programming study plan with weekly milestones. Write the plan to /workspace/output/rust_plan.md.',
    expectedFiles: ['output/rust_plan.md'],
    criteriaType: 'file_contains',
    fileContains: 'Week',
    timeoutMs: 900_000,
  },
  {
    id: 'G20',
    text: 'Read the file /workspace/output/employees.csv. Execute a Python script to compute the average salary from the salary column. Write the average to /workspace/output/avg_salary.txt.',
    expectedFiles: ['output/avg_salary.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
    dependsOn: 'G01',
  },
];

const GOALS_ADVANCED: Goal[] = [
  {
    id: 'G22',
    text: 'A TypeScript project is seeded at /workspace/src/ with 5 files. List all .ts files, read each one, then write /workspace/output/architecture.md that maps every module, its exported names, and its dependencies on other modules in the project.',
    expectedFiles: ['output/architecture.md'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
    seedBefore: {
      '/workspace/src/types.ts': `// Shared domain types
export interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: Date;
}

export interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
}

export interface Order {
  id: string;
  userId: string;
  products: { productId: string; qty: number }[];
  total: number;
  status: 'pending' | 'fulfilled' | 'cancelled';
}
`,
      '/workspace/src/utils.ts': `// Utility helpers
import { User } from './types';

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

export function isAdmin(user: User): boolean {
  return user.role === 'admin';
}

export function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  return items.slice((page - 1) * pageSize, page * pageSize);
}
`,
      '/workspace/src/database.ts': `// Database service
import { User, Product, Order } from './types';
import { generateId } from './utils';

const users: Map<string, User> = new Map();
const products: Map<string, Product> = new Map();
const orders: Map<string, Order> = new Map();

export function findUserById(id: string): User | undefined {
  return users.get(id);
}

export function createProduct(name: string, price: number, stock: number): Product {
  const product: Product = { id: generateId(), name, price, stock };
  products.set(product.id, product);
  return product;
}

export function createOrder(userId: string, items: { productId: string; qty: number }[]): Order {
  const total = items.reduce((sum, item) => {
    const p = products.get(item.productId);
    return sum + (p ? p.price * item.qty : 0);
  }, 0);
  const order: Order = { id: generateId(), userId, products: items, total, status: 'pending' };
  orders.set(order.id, order);
  return order;
}

export function listOrders(userId: string): Order[] {
  return [...orders.values()].filter(o => o.userId === userId);
}
`,
      '/workspace/src/auth.ts': `// Authentication service
import { User } from './types';
import { isAdmin, generateId } from './utils';
import { findUserById } from './database';

const sessions: Map<string, string> = new Map(); // token -> userId

export function login(email: string, password: string): string | null {
  // Simplified: in production, verify password hash
  const userId = email.split('@')[0];
  const token = generateId();
  sessions.set(token, userId);
  return token;
}

export function logout(token: string): void {
  sessions.delete(token);
}

export function getAuthenticatedUser(token: string): User | undefined {
  const userId = sessions.get(token);
  return userId ? findUserById(userId) : undefined;
}

export function requireAdmin(token: string): boolean {
  const user = getAuthenticatedUser(token);
  return user ? isAdmin(user) : false;
}
`,
      '/workspace/src/api.ts': `// API route handlers
import { User, Product, Order } from './types';
import { formatCurrency, paginate } from './utils';
import { createProduct, createOrder, listOrders } from './database';
import { getAuthenticatedUser, requireAdmin } from './auth';

export interface ApiRequest {
  token?: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export function handleCreateProduct(req: ApiRequest): ApiResponse<Product> {
  if (!requireAdmin(req.token || '')) {
    return { success: false, error: 'Unauthorized: admin required' };
  }
  const { name, price, stock } = req.body as { name: string; price: number; stock: number };
  const product = createProduct(name, price, stock);
  return { success: true, data: product };
}

export function handleCreateOrder(req: ApiRequest): ApiResponse<Order> {
  const user = getAuthenticatedUser(req.token || '');
  if (!user) return { success: false, error: 'Unauthorized' };
  const { items } = req.body as { items: { productId: string; qty: number }[] };
  const order = createOrder(user.id, items);
  return { success: true, data: order };
}

export function handleListOrders(req: ApiRequest): ApiResponse<Order[]> {
  const user = getAuthenticatedUser(req.token || '');
  if (!user) return { success: false, error: 'Unauthorized' };
  const page = parseInt(req.query?.page || '1');
  const orders = listOrders(user.id);
  return { success: true, data: paginate(orders, page, 10) };
}

export function handleGetOrderTotal(req: ApiRequest): ApiResponse<string> {
  const user = getAuthenticatedUser(req.token || '');
  if (!user) return { success: false, error: 'Unauthorized' };
  const orders = listOrders(user.id);
  const total = orders.reduce((sum, o) => sum + o.total, 0);
  return { success: true, data: formatCurrency(total) };
}
`,
    },
  },
  {
    id: 'G23',
    text: 'Read /workspace/sales_data.csv (12 months of revenue and units data). Execute Python to compute monthly revenue trend. Generate a bar chart as /workspace/output/revenue_chart.png using matplotlib. Write a 200-word insight summary to /workspace/output/revenue_insight.md.',
    expectedFiles: ['output/revenue_chart.png', 'output/revenue_insight.md'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
    seedBefore: {
      '/workspace/sales_data.csv': 'month,revenue,units\nJan,120000,450\nFeb,135000,480\nMar,128000,460\nApr,145000,510\nMay,160000,570\nJun,175000,610\nJul,168000,590\nAug,182000,640\nSep,190000,670\nOct,178000,625\nNov,210000,740\nDec,235000,820\n',
    },
  },
  {
    id: 'G24',
    text: 'Research LangGraph, AutoGen, and CrewAI AI agent frameworks. For each one find: pricing model, primary use case, and one limitation. Write /workspace/output/comparison.md with a structured comparison table. Include the source URL for each framework.',
    expectedFiles: ['output/comparison.md'],
    criteriaType: 'file_contains',
    fileContains: 'LangGraph',
    timeoutMs: 900_000,
  },
  {
    id: 'G25',
    text: 'Search for Nifty50 daily closing values for the last 7 trading days from 2 different sources. Identify the single largest one-day move (up or down). Write /workspace/output/market_summary.md with the data table, the biggest move amount, and the names of both sources used.',
    expectedFiles: ['output/market_summary.md'],
    criteriaType: 'file_exists',
    timeoutMs: 900_000,
  },
  {
    id: 'G26',
    text: 'Read the Python script at /workspace/buggy_script.py. Execute it to see the errors. Fix all bugs in the script. Execute the fixed version to confirm it runs without errors. Write /workspace/output/fix_log.md explaining each bug found and the fix applied, with before/after code for each.',
    expectedFiles: ['output/fix_log.md'],
    criteriaType: 'file_contains',
    fileContains: 'fix',
    timeoutMs: 900_000,
    seedBefore: {
      '/workspace/buggy_script.py': `# Buggy script with 3 deliberate bugs
import math

# Bug 1: missing import (random is used but not imported)
# Bug 2: wrong variable name (reslt instead of result)
# Bug 3: off-by-one error (range starts at 0 instead of 1)

def compute_stats(numbers):
    mean = sum(numbers) / len(numbers)
    variance = sum((x - mean) ** 2 for x in numbers) / len(numbers)
    std_dev = math.sqrt(variance)
    reslt = {"mean": mean, "std_dev": std_dev}
    return reslt

def generate_samples(n):
    samples = []
    for i in range(0, n):  # Bug 3: should be range(1, n+1)
        samples.append(random.randint(1, 100))  # Bug 1: random not imported
    return samples

if __name__ == "__main__":
    data = generate_samples(10)
    stats = compute_stats(data)
    print(f"Mean: {stats['reslt']}")  # Bug 2: should be stats['mean'] not stats['reslt']
`,
    },
  },
];

// ============================================================================
// Browser/Computer-Use Goals
// ============================================================================
// Test sites used here are purpose-built for scraping practice and don't block bots:
//   httpbin.org        — echo server for HTTP testing
//   quotes.toscrape.com — Scrapingclub's public practice scraper
//   books.toscrape.com — same family, for pagination tests
//   example.com        — IANA maintained, zero bot-detection
//   news.ycombinator.com — open, no JS required, simple HTML

// Phase 1 — Smoke (BG01–BG05): infrastructure validation, no complex reasoning
// Phase 2 — Agent scraping (BG06–BG08): multi-step autonomous extraction
// Phase 3 — Interaction (BG09–BG10): fill, click, form submit

const GOALS_BROWSER: Goal[] = [
  // ── Phase 1: Infrastructure smoke tests ─────────────────────────────────
  {
    id: 'BG01',
    text: 'Use the browser_fetch tool to fetch https://httpbin.org/json and save the raw JSON response body to /workspace/output/httpbin_fetch.json. Do not use browser_launch — use browser_fetch directly.',
    expectedFiles: ['output/httpbin_fetch.json'],
    criteriaType: 'file_contains',
    fileContains: 'slideshow',
    timeoutMs: 120_000,
  },
  {
    id: 'BG02',
    text: 'Launch a headless browser (browser_launch), navigate to https://example.com (browser_navigate), take a full-page screenshot and save it to /workspace/output/example_screenshot.png (browser_screenshot), then close the browser (browser_close).',
    expectedFiles: ['output/example_screenshot.png'],
    criteriaType: 'file_size',
    fileSizeMin: 3000,   // example.com is minimal HTML — screenshot is ~4-5KB
    timeoutMs: 300_000,
  },
  {
    id: 'BG03',
    text: 'Launch a headless browser, navigate to https://httpbin.org/html, use browser_extract to get the text content of the <h1> element, save the extracted heading text to /workspace/output/h1_text.txt, then close the browser.',
    expectedFiles: ['output/h1_text.txt'],
    criteriaType: 'file_contains',
    fileContains: 'Herman',
    timeoutMs: 180_000,
  },
  {
    id: 'BG04',
    text: 'Launch a headless browser, navigate to https://httpbin.org/get (which returns JSON showing request info), use browser_get_content to get the full page HTML, extract the "origin" IP address from the JSON body, and write the IP address to /workspace/output/origin_ip.txt.',
    expectedFiles: ['output/origin_ip.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 180_000,
  },
  {
    id: 'BG05',
    text: 'Use browser_fetch to fetch https://quotes.toscrape.com (returns full HTML). Parse the response to extract the first quote text you find (between <span class="text"> tags). Write the quote to /workspace/output/first_quote.txt.',
    expectedFiles: ['output/first_quote.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 120_000,
  },

  // ── Phase 2: Autonomous multi-step scraping ──────────────────────────────
  {
    id: 'BG06',
    text: 'Launch a headless browser. Navigate to https://quotes.toscrape.com. Extract ALL quote texts and their authors from the first page (there are 10 quotes). Save them to /workspace/output/quotes.csv as a CSV with columns: quote,author. Close the browser.',
    expectedFiles: ['output/quotes.csv'],
    criteriaType: 'file_contains',
    fileContains: 'author',
    timeoutMs: 300_000,
  },
  {
    id: 'BG07',
    text: 'Launch a headless browser. Navigate to https://books.toscrape.com. Find all books in the "Mystery" category (click the Mystery link in the sidebar). Extract the title and price of each book on that page. Write the results to /workspace/output/mystery_books.md as a markdown table with columns: Title | Price. Close the browser.',
    expectedFiles: ['output/mystery_books.md'],
    criteriaType: 'file_contains',
    fileContains: 'Price',
    timeoutMs: 300_000,
  },
  {
    id: 'BG08',
    text: 'Use browser_fetch to fetch https://news.ycombinator.com. Parse the HTML to extract the top 5 story titles and their URLs (look for <span class="titleline"> elements). Write a markdown list to /workspace/output/hn_top5.md with each story as "- [Title](URL)".',
    expectedFiles: ['output/hn_top5.md'],
    criteriaType: 'file_contains',
    fileContains: 'http',
    timeoutMs: 180_000,
  },

  // ── Phase 3: Browser interaction (fill, click, submit) ───────────────────
  {
    id: 'BG09',
    text: 'Launch a headless browser. Step 1: Navigate to https://httpbin.org/forms/post (this page shows an HTML order form). Step 2: Use browser_fill with selector "input[name=custname]" and value "TestUser". Step 3: Use browser_fill with selector "input[name=custtel]" and value "555-1234". Step 4: Use browser_click with selector "button[type=submit]" to submit the form. Step 5: Wait 3 seconds with browser_wait (no selector, just timeout=3000). Step 6: The page will have navigated to https://httpbin.org/post which shows a JSON object. Use browser_get_content to capture the page content. Step 7: Write the content to /workspace/output/form_response.json. The JSON response from httpbin /post will contain a "form" key with your submitted "custname" value of "TestUser".',
    expectedFiles: ['output/form_response.json'],
    criteriaType: 'file_contains',
    fileContains: 'TestUser',
    timeoutMs: 420_000,
  },
  {
    id: 'BG10',
    text: 'Launch a headless browser. Navigate to https://quotes.toscrape.com/login. Fill the username field (selector "input#username" or "input[name=username]") with "user" and the password field (selector "input#password" or "input[name=password]") with "password", then click the login button (selector "input[type=submit]" or "button[type=submit]"). After the page loads, use browser_get_content to get the page content. Write the page title (look for <title> or <h2> tag) and current URL to /workspace/output/login_result.txt. Close the browser.',
    expectedFiles: ['output/login_result.txt'],
    criteriaType: 'file_exists',
    timeoutMs: 420_000,
  },
];

// Smoke-only subset: just BG01–BG05
const GOALS_BROWSER_SMOKE: Goal[] = GOALS_BROWSER.filter(g =>
  ['BG01', 'BG02', 'BG03', 'BG04', 'BG05'].includes(g.id)
);

// ============================================================================
// Helpers
// ============================================================================

interface GoalResult {
  id: string;
  text: string;
  passed: boolean;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'TIMEOUT' | 'ERROR';
  iterations: number;
  durationMs: number;
  failureReason: string | null;
  failureClass: string | null;
}

async function cleanOutput(): Promise<void> {
  console.log('\n[SETUP] Cleaning /workspace/output/ ...');
  try {
    // Use recursive=true on the directory itself (fastest) — fallback to per-file deletion
    const delRes = await fetchWithTimeout(
      `${BASE_URL}/api/workspace/file?path=output&recursive=true`,
      10_000,
      { method: 'DELETE' }
    );
    if (!delRes.ok) {
      // Fallback: list files and delete individually
      const res = await fetchWithTimeout(`${BASE_URL}/api/workspace/files?path=output&depth=1`, 5_000);
      if (res.ok) {
        // API returns { success, entries } not { files }
        const data = await res.json() as { success?: boolean; entries?: { name: string; path: string; type: string }[] };
        const entries = data.entries || [];
        for (const f of entries) {
          if (f.type === 'file') {
            await fetchWithTimeout(`${BASE_URL}/api/workspace/file?path=${encodeURIComponent(f.path)}`, 5_000, { method: 'DELETE' });
          }
        }
      }
    }
    // Re-create empty output dir
    await fetchWithTimeout(`${BASE_URL}/api/workspace/mkdir`, 5_000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'output' }),
    });
  } catch {
    // output dir may not exist — that's fine
  }
  console.log('[SETUP] Output directory cleaned.');
}

async function seedFile(filePath: string, content: string): Promise<void> {
  // Strip /workspace/ prefix — workspaceRoutes expects a relative path
  const relPath = filePath.replace(/^\/workspace\//, '');
  try {
    // Ensure parent directory exists first
    const dir = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '';
    if (dir) {
      await fetchWithTimeout(`${BASE_URL}/api/workspace/mkdir`, 5_000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
    }

    // Use multipart upload to write the seed file directly
    const boundary = '----BenchmarkBoundary' + Date.now();
    const filename = relPath.split('/').pop() || 'file';
    const body = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="path"`,
      '',
      relPath,
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      'Content-Type: text/plain',
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const res = await fetchWithTimeout(`${BASE_URL}/api/workspace/upload`, 10_000, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`[SEED] Failed to seed ${filePath}: HTTP ${res.status} — ${txt}`);
    } else {
      console.log(`[SEED] Seeded ${filePath}`);
    }
  } catch (e) {
    console.warn(`[SEED] Error seeding ${filePath}: ${e}`);
  }
}

async function checkFileExists(relativePath: string): Promise<{ exists: boolean; sizeBytes: number; content: string }> {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/api/workspace/content?path=${encodeURIComponent(relativePath)}`,
      10_000
    );
    if (!res.ok) return { exists: false, sizeBytes: 0, content: '' };
    const text = await res.text();
    // Binary files: API returns JSON metadata with a `size` field (content is null)
    try {
      const json = JSON.parse(text);
      if (json.binary === true && typeof json.size === 'number') {
        return { exists: json.success !== false, sizeBytes: json.size, content: '' };
      }
    } catch { /* not JSON — plain text file, fall through */ }
    return { exists: true, sizeBytes: Buffer.byteLength(text, 'utf8'), content: text };
  } catch {
    return { exists: false, sizeBytes: 0, content: '' };
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runGoal(goal: Goal, passedIds: Set<string>): Promise<GoalResult> {
  // Check dependency
  if (goal.dependsOn && !passedIds.has(goal.dependsOn)) {
    console.log(`[${goal.id}] SKIP — dependency ${goal.dependsOn} did not pass`);
    return { id: goal.id, text: goal.text, passed: false, status: 'SKIP', iterations: 0, durationMs: 0, failureReason: `dependency ${goal.dependsOn} failed`, failureClass: null };
  }

  // Seed required files
  if (goal.seedBefore) {
    for (const [filePath, content] of Object.entries(goal.seedBefore)) {
      await seedFile(filePath, content);
    }
  }

  console.log(`\n[${goal.id}] Running: "${goal.text.substring(0, 80)}..."`);
  const startMs = Date.now();

  let apiResult: any = null;
  let timedOut = false;

  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/api/autonomous/goal/sync`,
      goal.timeoutMs + 10_000,  // buffer beyond goal timeout
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: goal.text,
          user_id: 'benchmark',
          options: { maxIterations: 20, approvalMode: 'none' },
        }),
      }
    );
    if (res.ok) {
      apiResult = await res.json();
    } else {
      const errText = await res.text();
      return buildResult(goal, startMs, false, `HTTP ${res.status}: ${errText}`, 'TOOL_ERROR', 0);
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') timedOut = true;
    else return buildResult(goal, startMs, false, String(e), 'TOOL_ERROR', 0);
  }

  const durationMs = Date.now() - startMs;
  const iterations = apiResult?.result?.iterations ?? apiResult?.result?.iteration ?? 0;

  if (timedOut) {
    return buildResult(goal, startMs, false, `Timed out after ${goal.timeoutMs}ms`, 'TIMEOUT', iterations);
  }

  const executorPassed = apiResult?.success === true;
  if (!executorPassed) {
    const status = apiResult?.result?.status;
    const failClass = status === 'max_iterations' ? 'MAX_ITERATIONS' : 'TOOL_ERROR';
    return buildResult(goal, startMs, false, `Executor status: ${status}`, failClass, iterations);
  }

  // Verify expected files exist
  for (const expectedFile of goal.expectedFiles) {
    const { exists, sizeBytes, content } = await checkFileExists(expectedFile);

    if (!exists) {
      return buildResult(goal, startMs, false, `File not found: ${expectedFile}`, 'PATH_ERROR', iterations);
    }

    if (goal.criteriaType === 'file_size' && goal.fileSizeMin !== undefined) {
      if (sizeBytes < goal.fileSizeMin) {
        return buildResult(goal, startMs, false, `File too small: ${expectedFile} is ${sizeBytes} bytes (min ${goal.fileSizeMin})`, 'VALIDATION_LOOP', iterations);
      }
    }

    if (goal.criteriaType === 'file_contains' && goal.fileContains) {
      if (!content.toLowerCase().includes(goal.fileContains.toLowerCase())) {
        return buildResult(goal, startMs, false, `File exists but missing "${goal.fileContains}": ${expectedFile}`, 'VALIDATION_LOOP', iterations);
      }
    }
  }

  console.log(`[${goal.id}] PASS — ${iterations} iter, ${(durationMs/1000).toFixed(1)}s`);
  return { id: goal.id, text: goal.text, passed: true, status: 'PASS', iterations, durationMs, failureReason: null, failureClass: null };
}

function buildResult(goal: Goal, startMs: number, passed: boolean, reason: string, failClass: string, iterations: number): GoalResult {
  const durationMs = Date.now() - startMs;
  console.log(`[${goal.id}] FAIL — ${iterations} iter, ${(durationMs/1000).toFixed(1)}s — ${reason}`);
  return { id: goal.id, text: goal.text, passed, status: 'FAIL', iterations, durationMs, failureReason: reason, failureClass: failClass };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const goals = BROWSER_SMOKE ? GOALS_BROWSER_SMOKE
              : BROWSER       ? GOALS_BROWSER
              : ADVANCED      ? GOALS_ADVANCED
              :                 GOALS_BASIC;
  const filteredGoals = SUBSET ? goals.filter(g => SUBSET.includes(g.id)) : goals;

  const suiteLabel = BROWSER_SMOKE ? 'BROWSER SMOKE (BG01–BG05)'
                   : BROWSER       ? 'BROWSER FULL (BG01–BG10)'
                   : ADVANCED      ? 'ADVANCED (G22–G26)'
                   :                 'BASIC (G01–G20)';

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log(`║  AI Partner Benchmark — ${suiteLabel.padEnd(28)}║`);
  console.log(`║  Model: ${MODEL.padEnd(43)}║`);
  console.log(`║  Goals: ${String(filteredGoals.length).padEnd(43)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  // Clean output directory before run
  await cleanOutput();

  const results: GoalResult[] = [];
  const passedIds = new Set<string>();

  for (const goal of filteredGoals) {
    const result = await runGoal(goal, passedIds);
    results.push(result);
    if (result.passed) passedIds.add(result.id);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  const timedOut = results.filter(r => r.status === 'TIMEOUT').length;
  const total = results.length;
  const passRate = ((passed / total) * 100).toFixed(1);
  const avgIter = passed > 0
    ? (results.filter(r => r.passed).reduce((sum, r) => sum + r.iterations, 0) / passed).toFixed(1)
    : 'N/A';

  // Category breakdown (basic only)
  const catA = results.filter(r => ['G01','G02','G03','G04','G05'].includes(r.id));
  const catB = results.filter(r => ['G06','G07','G08','G09','G10'].includes(r.id));
  const catC = results.filter(r => ['G11','G12','G13','G14','G15'].includes(r.id));
  const catD = results.filter(r => ['G16','G17','G18','G19','G20'].includes(r.id));

  console.log('\n══════════════════════ RESULTS ══════════════════════');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '─' : '✗';
    const iter = r.iterations > 0 ? `${r.iterations}iter` : '     ';
    const dur  = r.durationMs > 0 ? `${(r.durationMs/1000).toFixed(1)}s` : '   ';
    const fail = r.failureReason ? `  ← ${r.failureReason.substring(0, 70)}` : '';
    console.log(` ${icon} ${r.id.padEnd(4)} ${r.status.padEnd(7)} ${iter.padStart(6)}  ${dur.padStart(6)}${fail}`);
  }

  console.log('\n══════════════════════ SUMMARY ══════════════════════');
  console.log(` Total:   ${passed}/${total} passed (${passRate}%)`);
  console.log(` Failed:  ${failed}   Skipped: ${skipped}   Timeout: ${timedOut}`);
  console.log(` Avg iterations (passed goals only): ${avgIter}`);

  if (!ADVANCED && !BROWSER && !BROWSER_SMOKE) {
    const pct = (arr: GoalResult[]) => `${arr.filter(r=>r.passed).length}/${arr.length}`;
    console.log(`\n Category A (file gen):   ${pct(catA)}`);
    console.log(` Category B (code exec):  ${pct(catB)}`);
    console.log(` Category C (web fetch):  ${pct(catC)}`);
    console.log(` Category D (multi-step): ${pct(catD)}`);
  }

  if (BROWSER || BROWSER_SMOKE) {
    const ph1 = results.filter(r => ['BG01','BG02','BG03','BG04','BG05'].includes(r.id));
    const ph2 = results.filter(r => ['BG06','BG07','BG08'].includes(r.id));
    const ph3 = results.filter(r => ['BG09','BG10'].includes(r.id));
    const pct = (arr: GoalResult[]) => arr.length ? `${arr.filter(r=>r.passed).length}/${arr.length}` : 'skipped';
    console.log(`\n Phase 1 (infra/smoke):     ${pct(ph1)}`);
    console.log(` Phase 2 (agent scraping):  ${pct(ph2)}`);
    console.log(` Phase 3 (form interaction): ${pct(ph3)}`);
  }

  const gate = (BROWSER || BROWSER_SMOKE) ? 60
             : ADVANCED ? 60 : 80;
  const gateLabel = BROWSER_SMOKE ? 'Browser smoke gate (60%)'
                  : BROWSER       ? 'Browser full gate (60%)'
                  : ADVANCED      ? 'Manus-parity gate (60%)'
                  :                 'Phase 1 gate (80%)';
  const gatePassed = parseFloat(passRate) >= gate;
  console.log(`\n ${gatePassed ? '✓ GATE PASSED' : '✗ GATE NOT MET'} — ${gateLabel}: need ${gate}%, got ${passRate}%`);

  // Failure classification summary
  const classes: Record<string, number> = {};
  for (const r of results.filter(r => r.failureClass)) {
    classes[r.failureClass!] = (classes[r.failureClass!] || 0) + 1;
  }
  if (Object.keys(classes).length > 0) {
    console.log('\n Failure classes:');
    for (const [cls, count] of Object.entries(classes)) {
      console.log(`   ${cls}: ${count}`);
    }
  }

  // ─── Write JSON results ────────────────────────────────────────────────────
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
  const safeModel = MODEL.replace(/[^a-z0-9._-]/gi, '_');
  const suffix = BROWSER_SMOKE ? '_browser_smoke' : BROWSER ? '_browser' : ADVANCED ? '_advanced' : '';
  const outFile = path.join(__dirname, `../../../../docs/benchmark_results/${dateStr}_${safeModel}${suffix}.json`);

  const jsonOutput = {
    run_at: now.toISOString(),
    model: MODEL,
    suite: BROWSER_SMOKE ? 'browser_smoke' : BROWSER ? 'browser' : ADVANCED ? 'advanced' : 'basic',
    total,
    passed,
    pass_rate: parseFloat(passRate),
    avg_iterations_passed: avgIter === 'N/A' ? null : parseFloat(avgIter),
    gate_passed: gatePassed,
    results,
  };

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(jsonOutput, null, 2));
    console.log(`\n Results saved to: ${outFile}`);
  } catch (e) {
    console.warn(`\n Could not save results file: ${e}`);
  }

  process.exit(gatePassed ? 0 : 1);
}

main().catch(e => { console.error('Benchmark runner crashed:', e); process.exit(2); });
