#!/usr/bin/env node
/**
 * AI Partner Benchmark Runner
 *
 * Usage:
 *   node run-benchmarks.js [options]
 *
 * Options:
 *   --tier <0|1|2|3|4|all>   Run only benchmarks in that tier (default: all)
 *   --id <benchmark-id>       Run a single benchmark by ID
 *   --host <url>              API host (default: http://localhost:3000)
 *   --dry-run                 Print prompts without running
 *   --no-validate             Skip standalone criterion validation (faster, less accurate)
 *   --day <1|2|3|4>          Run the recommended day's benchmarks in order
 *
 * Examples:
 *   node run-benchmarks.js --tier 0
 *   node run-benchmarks.js --day 1
 *   node run-benchmarks.js --id T1-B01
 *   node run-benchmarks.js --tier 2 --host http://localhost:3001
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const BENCHMARKS_FILE = path.join(__dirname, 'benchmarks.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const POLL_INTERVAL = 5_000;   // ms between status polls
const APPROVAL_MODE = 'none';  // set to 'none' so benchmarks run fully autonomously

const DAY_PLANS = {
    1: ['T0-HEALTH', 'T1-B01', 'T1-B02', 'T1-B04', 'T1-B05'],
    2: ['T2-B10', 'T2-B08', 'T2-B09', 'T2-B15'],
    3: ['T3-B14', 'T3-B12'],
    4: ['T4-B16', 'T4-B17'],
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI ARGS
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { host: 'http://localhost:3000', tier: 'all', id: null, dryRun: false, day: null, validate: true };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--host': opts.host = args[++i]; break;
            case '--tier': opts.tier = args[++i]; break;
            case '--id': opts.id = args[++i]; break;
            case '--day': opts.day = Number(args[++i]); break;
            case '--dry-run': opts.dryRun = true; break;
            case '--no-validate': opts.validate = false; break;
        }
    }
    return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP UTILS
// ─────────────────────────────────────────────────────────────────────────────

function request(urlStr, method, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const lib = url.protocol === 'https:' ? https : http;
        const payload = body ? JSON.stringify(body) : null;
        const reqOpts = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        };
        const req = lib.request(reqOpts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Request timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

const post = (host, path, body) => request(`${host}${path}`, 'POST', body);
const get = (host, path) => request(`${host}${path}`, 'GET');

// ─────────────────────────────────────────────────────────────────────────────
// GOAL API
// ─────────────────────────────────────────────────────────────────────────────

async function setApprovalMode(host, mode) {
    try {
        await post(host, '/api/autonomous/goal/settings/approval-mode', { mode });
        console.log(`  ✅ Approval mode set to: ${mode}`);
    } catch (e) {
        console.warn(`  ⚠️  Could not set approval mode: ${e.message}`);
    }
}

async function submitGoal(host, prompt) {
    const res = await post(host, '/api/autonomous/goal', { request: prompt });
    if (res.status !== 200 || !res.body.execution_id) {
        throw new Error(`Goal submission failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return res.body.execution_id;
}

async function pollGoal(host, execId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL);
        try {
            const res = await get(host, `/api/autonomous/goal/${execId}`);
            if (res.status !== 200) continue;

            const { status, state, iterations } = res.body;
            const s = status || state?.status;
            process.stdout.write(
                `\r    📡 ${String(s).padEnd(12)} | iterations: ${String(iterations ?? state?.iteration ?? '?').padEnd(4)} | ` +
                `elapsed: ${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s `
            );

            if (['completed', 'failed', 'cancelled', 'error'].includes(s)) {
                console.log('');
                return res.body;
            }
        } catch { /* network blip — retry */ }
    }
    console.log('');
    throw new Error('Goal execution timed out');
}

// ─────────────────────────────────────────────────────────────────────────────
// STANDALONE CRITERION VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

async function validateCriteria(host, criteria) {
    try {
        const res = await post(host, '/api/autonomous/goal/validate', { criteria });
        if (res.status === 200 && Array.isArray(res.body.results)) {
            return res.body.results;
        }
    } catch { /* endpoint may not be mounted on all versions */ }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BENCHMARK EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

async function runBenchmark(host, bm, validate) {
    const start = Date.now();
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`▶  [${bm.id}] ${bm.name}`);
    console.log(`   Tier ${bm.tier} | Expected pass: ${bm.expectedPassRate}% | Timeout: ${bm.timeout_minutes}m`);
    console.log(`   ${bm.description}`);

    const result = {
        id: bm.id,
        name: bm.name,
        tier: bm.tier,
        startedAt: new Date().toISOString(),
        status: 'unknown',
        passed: false,
        duration_s: 0,
        execId: null,
        goalStatus: null,
        iterations: null,
        criteria: [],
        notes: [],
    };

    try {
        console.log(`   📤 Submitting goal...`);
        const execId = await submitGoal(host, bm.prompt);
        result.execId = execId;
        console.log(`   🔑 execution_id: ${execId}`);

        const timeoutMs = (bm.timeout_minutes || 10) * 60_000;
        const finalState = await pollGoal(host, execId, timeoutMs);

        result.goalStatus = finalState.status || finalState.state?.status;
        result.iterations = finalState.iterations || finalState.state?.iteration;

        // Standalone criterion validation (post-execution)
        if (validate && bm.criteria?.length) {
            console.log(`   🔍 Validating ${bm.criteria.length} criteria...`);
            const valResults = await validateCriteria(host, bm.criteria);
            if (valResults) {
                result.criteria = valResults.map(r => ({
                    type: r.criterion?.type,
                    passed: r.passed,
                    message: r.message,
                }));
                const allPassed = result.criteria.every(c => c.passed);
                const passedCount = result.criteria.filter(c => c.passed).length;
                result.passed = allPassed;
                result.notes.push(`Criteria: ${passedCount}/${result.criteria.length} passed`);

                for (const c of result.criteria) {
                    const icon = c.passed ? '✅' : '❌';
                    console.log(`     ${icon} [${c.type}] ${c.message || ''}`);
                }
            } else {
                // Fall back to goal status
                result.passed = result.goalStatus === 'completed';
                result.notes.push('Standalone validation unavailable — using goal status only');
            }
        } else {
            result.passed = result.goalStatus === 'completed';
        }

    } catch (err) {
        result.status = 'error';
        result.notes.push(`Error: ${err.message}`);
        console.error(`   ❌ Error: ${err.message}`);
    }

    result.duration_s = Math.round((Date.now() - start) / 1000);
    result.completedAt = new Date().toISOString();
    result.status = result.passed ? 'PASS' : 'FAIL';

    const badge = result.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`   ${badge} | ${result.duration_s}s | Goal: ${result.goalStatus}`);
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT WRITER
// ─────────────────────────────────────────────────────────────────────────────

function writeReport(results, outPath) {
    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = total - passed;
    const pct = total ? Math.round((passed / total) * 100) : 0;
    const now = new Date().toISOString();

    const tierGroups = {};
    for (const r of results) {
        if (!tierGroups[r.tier]) tierGroups[r.tier] = [];
        tierGroups[r.tier].push(r);
    }

    let md = `# AI Partner Benchmark Results\n\n`;
    md += `**Run:** ${now}  \n`;
    md += `**Score:** ${passed}/${total} (${pct}%)  \n\n`;

    // Summary table
    md += `## Summary\n\n`;
    md += `| ID | Name | Tier | Status | Criteria | Duration | Iterations |\n`;
    md += `|----|------|------|--------|----------|----------|------------|\n`;
    for (const r of results) {
        const status = r.passed ? '✅ PASS' : '❌ FAIL';
        const passedC = r.criteria.filter(c => c.passed).length;
        const totalC = r.criteria.length;
        const critStr = totalC ? `${passedC}/${totalC}` : '—';
        md += `| ${r.id} | ${r.name} | T${r.tier} | ${status} | ${critStr} | ${r.duration_s}s | ${r.iterations ?? '—'} |\n`;
    }

    // Per-tier breakdown
    for (const [tier, group] of Object.entries(tierGroups).sort()) {
        const tp = group.filter(r => r.passed).length;
        md += `\n## Tier ${tier} Results (${tp}/${group.length} passed)\n\n`;
        for (const r of group) {
            const badge = r.passed ? '✅' : '❌';
            md += `### ${badge} ${r.id} — ${r.name}\n\n`;
            md += `- **Status:** ${r.status}\n`;
            md += `- **Goal status:** ${r.goalStatus ?? 'unknown'}\n`;
            md += `- **Iterations:** ${r.iterations ?? '—'}\n`;
            md += `- **Duration:** ${r.duration_s}s\n`;
            md += `- **Execution ID:** \`${r.execId ?? 'none'}\`\n`;
            if (r.notes.length) md += `- **Notes:** ${r.notes.join('; ')}\n`;
            if (r.criteria.length) {
                md += `\n**Criteria validation:**\n\n`;
                for (const c of r.criteria) {
                    const cBadge = c.passed ? '✅' : '❌';
                    md += `- ${cBadge} \`${c.type}\` — ${c.message || ''}\n`;
                }
            }
            md += '\n';
        }
    }

    // Failure analysis
    const failures = results.filter(r => !r.passed);
    if (failures.length) {
        md += `## Failure Analysis\n\n`;
        md += `${failed} benchmark(s) failed. Failed criteria:\n\n`;
        for (const r of failures) {
            md += `### ${r.id}\n`;
            for (const c of r.criteria.filter(c => !c.passed)) {
                md += `- ❌ \`${c.type}\` — ${c.message}\n`;
            }
            if (r.notes.length) md += `- ⚠️ ${r.notes.join('; ')}\n`;
            md += '\n';
        }
    }

    fs.writeFileSync(outPath, md, 'utf8');
    console.log(`\n📄 Report written to: ${outPath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

async function checkServerHealth(host) {
    try {
        const res = await get(host, '/api/autonomous/goal?limit=1');
        if (res.status === 200) {
            console.log(`✅ Server reachable at ${host}`);
            return true;
        }
    } catch { }
    console.error(`❌ Server NOT reachable at ${host}`);
    console.error(`   Start AI Partner server first: cd server && npm run dev`);
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const opts = parseArgs();
    const benchmarks = JSON.parse(fs.readFileSync(BENCHMARKS_FILE, 'utf8'));

    // Filter benchmarks
    let toRun = benchmarks;
    if (opts.id) {
        toRun = benchmarks.filter(b => b.id === opts.id);
        if (!toRun.length) { console.error(`Benchmark not found: ${opts.id}`); process.exit(1); }
    } else if (opts.day) {
        const ids = DAY_PLANS[opts.day];
        if (!ids) { console.error(`Unknown day: ${opts.day}. Valid: 1,2,3,4`); process.exit(1); }
        toRun = ids.map(id => benchmarks.find(b => b.id === id)).filter(Boolean);
        console.log(`📅 Day ${opts.day} plan: ${ids.join(' → ')}`);
    } else if (opts.tier !== 'all') {
        toRun = benchmarks.filter(b => String(b.tier) === String(opts.tier));
    }

    // Filter out benchmarks with unmet requirements
    toRun = toRun.filter(b => {
        if (b.requires?.includes('telegram')) {
            console.log(`⚠️  Skipping ${b.id} — requires Telegram (add --telegram flag when ready)`);
            return false;
        }
        return true;
    });

    if (opts.dryRun) {
        console.log(`\n🧪 DRY RUN — ${toRun.length} benchmarks would run:\n`);
        for (const b of toRun) {
            console.log(`  [T${b.tier}] ${b.id} — ${b.name} (${b.timeout_minutes}m)`);
        }
        return;
    }

    console.log(`\n🚀 AI Partner Benchmark Runner`);
    console.log(`   Host:       ${opts.host}`);
    console.log(`   Benchmarks: ${toRun.length}`);
    console.log(`   Validate:   ${opts.validate}`);

    // Health check
    const healthy = await checkServerHealth(opts.host);
    if (!healthy) process.exit(1);

    // Set approval mode to none for autonomous runs
    await setApprovalMode(opts.host, APPROVAL_MODE);

    // Ensure results dir
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

    const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jsonOut = path.join(RESULTS_DIR, `results-${runTimestamp}.json`);
    const mdOut = path.join(RESULTS_DIR, `results-${runTimestamp}.md`);

    const results = [];

    for (let i = 0; i < toRun.length; i++) {
        const bm = toRun[i];
        console.log(`\n[${i + 1}/${toRun.length}]`);
        const result = await runBenchmark(opts.host, bm, opts.validate);
        results.push(result);

        // Save incrementally so partial runs are preserved
        fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2), 'utf8');

        // Stop on T0 health check failure
        if (bm.tier === 0 && !result.passed) {
            console.log(`\n🛑 Platform health check failed — stopping run.`);
            console.log(`   Fix the reported issues before running Tier 1+ benchmarks.`);
            break;
        }
    }

    // Write markdown report
    writeReport(results, mdOut);

    // Final summary
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const pct = total ? Math.round((passed / total) * 100) : 0;

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 FINAL SCORE: ${passed}/${total} (${pct}%)`);
    console.log(`   JSON: ${jsonOut}`);
    console.log(`   MD:   ${mdOut}`);

    if (pct === 100) console.log(`\n🏆 Perfect score — ready to demo!`);
    else if (pct >= 80) console.log(`\n✅ Strong result — minor gaps to fix.`);
    else if (pct >= 60) console.log(`\n⚠️  Partial pass — review the failure analysis above.`);
    else console.log(`\n❌ Needs work — check infrastructure first (Docker, search providers).`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
