# AI Partner Benchmark Suite

Automated benchmark runner for the 20-benchmark test plan.

## Quick Start

```bash
# From: d:\AI\Test\AI Partner\benchmarks

# T0 — Platform health check (always run this first)
node run-benchmarks.js --tier 0

# Day 1 — Core reliability (run after T0 passes)
node run-benchmarks.js --day 1

# Day 2 — Differentiators
node run-benchmarks.js --day 2

# Day 3 — Stress tests
node run-benchmarks.js --day 3

# Day 4 — Hero demos
node run-benchmarks.js --day 4

# Single benchmark
node run-benchmarks.js --id T1-B01

# Dry run (preview prompts without running)
node run-benchmarks.js --day 1 --dry-run

# Different server port
node run-benchmarks.js --day 1 --host http://localhost:3001
```

## Prerequisites

1. **Server running:** `cd server && npm run dev`
2. **Docker running:** `docker info` should succeed (required for T1-B01 Python sandbox)
3. **Search provider:** At least one of SearXNG/Brave/DDG configured
4. **Telegram** (Day 2 T2-B15 only): Bot token configured in Settings → Integrations

## Files

| File | Purpose |
|------|---------|
| `benchmarks.json` | All benchmark definitions (prompt, criteria, tier, timeout) |
| `run-benchmarks.js` | Runner script — submits goals, polls status, validates, reports |
| `results/` | Timestamped JSON + Markdown result files (created automatically) |

## Execution Model

```
run-benchmarks.js
    ↓
POST /api/autonomous/goal          ← submits the benchmark prompt as a goal
    ↓
GET  /api/autonomous/goal/:id      ← polls every 5s until complete/failed
    ↓
POST /api/autonomous/goal/validate ← runs each success criterion independently
    ↓
results/results-<timestamp>.md     ← benchmark report
```

## Day Plans

| Day | Benchmarks | Goal |
|-----|-----------|------|
| Day 1 | T0-HEALTH, T1-B01, T1-B02, T1-B04, T1-B05 | Smoke tests — confirm core pipeline |
| Day 2 | T2-B10, T2-B08, T2-B09, T2-B15 | Differentiators — unique capabilities |
| Day 3 | T3-B14, T3-B12 | Stress tests — failure recovery + doc gen |
| Day 4 | T4-B16, T4-B17 | Hero demos — launch video candidates |

**Rule:** Do not run Day 2 until Day 1 is 100% green. Do not run Day 4 until Days 1-3 are ≥80%.

## Adding Benchmarks

Add entries to `benchmarks.json`. Each benchmark needs:
```json
{
  "id": "T2-BXX",
  "tier": 2,
  "name": "Human readable name",
  "description": "One-line description",
  "prompt": "Full goal prompt sent to the agent",
  "criteria": [
    { "type": "file_exists", "config": { "path": "output.json" } },
    { "type": "file_contains", "config": { "path": "output.json", "pattern": "expected" } },
    { "type": "llm_evaluates", "config": { "path": "output.json", "criteria": "judgement prompt" } }
  ],
  "expectedPassRate": 85,
  "timeout_minutes": 10
}
```

Criterion types: `file_exists`, `file_contains`, `code_compiles`, `tests_pass`, `output_matches`, `custom`, `llm_evaluates`
