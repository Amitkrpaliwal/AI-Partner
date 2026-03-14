<div align="center">

# AI Partner

**Self-hosted autonomous AI agent platform**

Give it a goal. It researches, codes, generates documents, and delivers results to your Telegram or Discord — without you babysitting it.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/AmitkrPaiwal/AI-Partner?style=social)](https://github.com/AmitkrPaiwal/AI-Partner)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue)](docker-compose.yml)
[![Tests](https://img.shields.io/badge/tests-145%20passing-brightgreen)](server/src/tests)

[**Quick Start**](#quick-start) · [**Features**](#features) · [**Agent Profiles**](#agent-profiles) · [**Integrations**](#integrations) · [**Docs**](#configuration)

</div>

---

## Quick Start

**Mac / Linux — one command:**
```bash
curl -fsSL https://raw.githubusercontent.com/AmitkrPaiwal/AI-Partner/main/setup.sh | bash
```

**Windows — paste into PowerShell:**
```powershell
iwr -useb https://raw.githubusercontent.com/AmitkrPaiwal/AI-Partner/main/install.ps1 | iex
```

**Or clone and run:**
```bash
git clone https://github.com/AmitkrPaiwal/AI-Partner
cd AI-Partner
./setup.sh
```

The installer guides you through picking an LLM provider, enters your API key, and opens the browser when ready. **First run takes 2–4 minutes** (Docker image build).

> **Minimum requirement:** Docker Desktop running + one API key (or local Ollama)

---

## Features

### Autonomous Goal Execution
Type a goal in plain English. AI Partner decomposes it, executes multi-step plans with real tools, validates outcomes against measurable criteria, and retries or replans on failure — without manual intervention.

```
"Research the top 10 trending GitHub repos this week,
 write a summary report, and send it to my Telegram."
```

### 16 Specialist Agent Profiles
Pre-built agents with enforced tool whitelists, iteration caps, and auto-routing:

| Cluster | Agents |
|---------|--------|
| Research | Web Researcher, Fact Checker, Trend Spotter |
| Dev | Python Developer, Node.js Developer, Debugger, Shell Operator |
| Data | Financial Analyst, Data Analyst, Excel Builder |
| Content | Report Generator, Summarizer, Tech Writer, Prompt Architect, Task Planner |
| Delivery | Telegram Reporter |

Route directly: `@fin-analyst what is RELIANCE.NS today?`
Or let keywords auto-route: typing "trending AI tools" fires `@trend-spotter` automatically.

### Live Browser Automation
Puppeteer with live CDP screencasting visible in the UI. When a CAPTCHA appears, the agent pauses and shows a **"Solve CAPTCHA — Take Control"** button. You solve it, the agent resumes.

### Goal-Integrated Messaging Delivery
Results aren't just saved to files — they're **validated delivery goals**. The agent fails the task if `messaging_send_file` doesn't succeed. Supports Telegram, Discord, Slack, WhatsApp, Signal.

### Persistent Memory
- **Episodic memory** — timestamped event log of conversations and outcomes
- **Vector search** — semantic similarity across 4 embedding backends
- **Persona** — biographic facts and preferences injected into every prompt
- **Knowledge base** — upload PDFs/docs for RAG retrieval

### Document Generation
PDF · Excel (xlsx) · PowerPoint (pptx) · Word (docx) · HTML — all downloadable from the UI or sent via messaging.

### Skill Learning
After a successful goal, AI Partner generalizes the solution into a reusable parameterized skill template. Deduplicated by embedding similarity. Skills can be promoted to first-class MCP tools.

### Scheduler + Triggers
Cron-expression scheduling, webhook triggers, Google Calendar events, Gmail arrival — all fire autonomous goal execution.

---

## Agent Profiles

Each profile has:
- **Tool whitelist** — enforced, agent cannot use tools outside its list
- **Iteration cap** — prevents runaway loops
- **Auto-select keywords** — fires automatically when matched in chat
- **agentType** — determines exhaustion behavior (`research / execution / delivery / synthesis`)
- **Handoff instructions** — baked into every system prompt

Profiles are editable from the UI (Settings → Agent Profiles) or by editing `server/src/agents/seedProfiles.ts`.

---

## Integrations

Add any key to `.env` — the agent automatically gains those tools:

| Service | Env Var | Tools Unlocked |
|---------|---------|----------------|
| GitHub | `GITHUB_TOKEN` | search repos, list issues, create issues, get files, list PRs, add comments, search code |
| Notion | `NOTION_API_KEY` | search, read page, create page, query database, append blocks |
| Gmail | `GMAIL_USER` + `GMAIL_APP_PASSWORD` | send, search, read, list inbox |
| Google Calendar | `GOOGLE_CALENDAR_ACCESS_TOKEN` | list events, create event, check availability, delete event |
| Google Drive | `GOOGLE_DRIVE_ACCESS_TOKEN` | search, get file, list folder, create file |
| Twitter/X | `TWITTER_BEARER_TOKEN` | search tweets, read timeline (+ OAuth keys for posting) |
| Trello | `TRELLO_API_KEY` + `TRELLO_TOKEN` | list boards/cards, create card, move card, add comment |
| Spotify | `SPOTIFY_ACCESS_TOKEN` | search, play, pause, skip, queue, create playlist |
| Apify | `APIFY_API_TOKEN` | residential proxy scraping for CAPTCHA-protected sites |
| Image Gen | `OPENAI_API_KEY` or `STABILITY_API_KEY` | DALL-E 3 / Stability AI image generation |

**Messaging platforms:** Telegram · Discord · Slack · WhatsApp · Signal

---

## LLM Providers

At least one required. Add the key to `.env`:

| Provider | Env Var | Notes |
|----------|---------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | Claude 3.5 / 4 family |
| OpenAI | `OPENAI_API_KEY` | GPT-4o, GPT-4o-mini |
| Google | `GOOGLE_API_KEY` | Gemini 2.0 Flash |
| Groq | `GROQ_API_KEY` | Free tier, very fast (Llama, Mistral) |
| DeepSeek | `DEEPSEEK_API_KEY` | Low cost, strong at coding |
| Ollama | `OLLAMA_HOST` | Local models, no API key needed |
| Perplexity | `PERPLEXITY_API_KEY` | Search-grounded LLM with citations |

Switch models any time from **Settings → Models** in the UI.

---

## Configuration

Key files — editable without redeploying:

| File | Purpose |
|------|---------|
| `server/prompts/agent.system.md` | Agent core identity |
| `server/prompts/profiles/` | Per-profile LLM prompts |
| `server/prompts/reasoner-reason.md` | ReAct reasoning prompt |
| `server/prompts/reasoner-decide.md` | ReAct action-selection prompt |
| `server/config/blocked-domains.json` | Domains blocked from browser navigation |
| `server/config/data-api-hints.json` | API fallback hints injected when search fails |
| `server/templates/workspace/HEARTBEAT.md` | Proactive agenda tasks |
| `server/templates/workspace/SOUL.md` | Agent persona + quiet hours |

**Environment variables** — see [`.env.example`](.env.example) for the full list.

---

## Docker Commands

```bash
# Start
docker compose up -d

# View logs
docker compose logs -f app

# Stop
docker compose down

# Update to latest
./setup.sh --update        # Mac/Linux
.\install.ps1 -Update      # Windows

# Wipe all data and start fresh
./setup.sh --reset
.\install.ps1 -Reset
```

---

## Development

```bash
# Hot-reload dev mode
docker compose -f docker-compose.dev.yml up

# Run unit tests (145 tests)
cd server && npm run test:unit

# TypeScript check
cd server && npx tsc --noEmit
```

---

## Architecture

```
User → AgentOrchestrator (chat OODA loop)
          ↓ goal detected
     GoalOrientedExecutor
          ↓
     GoalExtractor → GoalDefinition (typed success criteria)
          ↓
     ReActReasoner (Reason → Act → Assess loop)
          ↓
     ExecutionEngine → MCP Tools (17 servers)
          ↓              Docker sandbox
     SelfCorrector (semantic script repair)
          ↓
     GoalValidator (checks real file/content/messaging criteria)
          ↓ all criteria pass
     SkillLearner (generalize + store for reuse)
```

**Concurrency:** Up to 3 concurrent goals, each with up to 5 parallel sub-agents via `delegate_parallel`.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">

Built with TypeScript · Express · React · Puppeteer · Docker · SQLite

⭐ Star this repo if it's useful

</div>
