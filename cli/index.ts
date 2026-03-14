#!/usr/bin/env node

/**
 * AI Partner CLI — Command-line interface for the AI Partner agent.
 *
 * Usage:
 *   npx ai-partner chat "What is the capital of France?"
 *   npx ai-partner goal "Create a landing page for my startup"
 *   npx ai-partner status
 *   npx ai-partner config --set OPENAI_API_KEY=sk-...
 *   npx ai-partner models
 */

import readline from 'readline';

const BASE_URL = process.env.AI_PARTNER_URL || 'http://localhost:3000';

// ============================================================================
// HELPERS
// ============================================================================

async function fetchJSON(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return response.json();
}

function printHeader() {
    console.log('\n🤖 AI Partner CLI\n');
}

// ============================================================================
// COMMANDS
// ============================================================================

async function cmdChat(message: string, stream: boolean = false) {
    if (stream) {
        // SSE streaming mode
        const response = await fetch(`${BASE_URL}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });

        if (!response.ok || !response.body) {
            console.error(`Error: ${response.statusText}`);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            const lines = text.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.type === 'token') {
                            process.stdout.write(event.text);
                        } else if (event.type === 'complete') {
                            console.log('\n');
                        } else if (event.type === 'error') {
                            console.error(`\n❌ ${event.message}`);
                        }
                    } catch { /* skip malformed lines */ }
                }
            }
        }
    } else {
        const result = await fetchJSON('/api/chat', {
            method: 'POST',
            body: JSON.stringify({ message, mode: 'chat' })
        });
        console.log(result.response || result.executionMode);
    }
}

async function cmdGoal(goal: string) {
    console.log(`⚙️  Executing goal: "${goal}"\n`);
    const result = await fetchJSON('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: goal, mode: 'goal' })
    });
    console.log(result.response);
    if (result.artifacts?.length > 0) {
        console.log('\n📁 Created files:');
        result.artifacts.forEach((f: string) => console.log(`   - ${f}`));
    }
    console.log(`\n📊 Progress: ${result.progress || 'N/A'}%`);
}

async function cmdStatus() {
    const [health, agents, models] = await Promise.all([
        fetchJSON('/api/health'),
        fetchJSON('/api/agents').catch(() => ({ active: 0, totalSpawned: 0 })),
        fetchJSON('/api/models').catch(() => ({ models: [] }))
    ]);

    console.log(`Status:    ${health.status}`);
    console.log(`Workspace: ${health.workspace}`);
    console.log(`Heartbeat: ${health.heartbeat?.isRunning ? '✅ Running' : '⏸  Stopped'}`);
    console.log(`Agents:    ${agents.active} active / ${agents.totalSpawned} total`);
    console.log(`Models:    ${(models.models || models.available || []).length} available`);
}

async function cmdModels() {
    const result = await fetchJSON('/api/models');
    const models = result.models || result.available || [];
    if (models.length === 0) {
        console.log('No models available. Configure an LLM provider first.');
        return;
    }
    console.log('Available Models:\n');
    for (const m of models) {
        const provider = m.provider || 'unknown';
        console.log(`  ${m.id || m.name}  (${provider})`);
    }
}

async function cmdConfig(args: string[]) {
    if (args.length === 0) {
        const config = await fetchJSON('/api/config');
        console.log(JSON.stringify(config, null, 2));
        return;
    }

    if (args[0] === '--set' && args[1]) {
        const [key, ...valueParts] = args[1].split('=');
        const value = valueParts.join('=');
        console.log(`Setting ${key} = ${value.substring(0, 10)}...`);
        console.log('(Config update via CLI is read-only. Use the UI settings or .env file.)');
    }
}

async function cmdInteractive() {
    printHeader();
    console.log('Interactive mode. Type "exit" to quit, "!goal" prefix for goals.\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> '
    });

    rl.prompt();

    rl.on('line', async (line: string) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }
        if (input === 'exit' || input === 'quit') { rl.close(); return; }

        try {
            if (input.startsWith('!goal ')) {
                await cmdGoal(input.slice(6));
            } else if (input === '!status') {
                await cmdStatus();
            } else if (input === '!models') {
                await cmdModels();
            } else {
                await cmdChat(input, true);
            }
        } catch (e: any) {
            console.error(`❌ ${e.message}`);
        }

        rl.prompt();
    });

    rl.on('close', () => {
        console.log('\n👋 Goodbye!\n');
        process.exit(0);
    });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    try {
        switch (command) {
            case 'chat':
                if (!args[1]) { console.error('Usage: ai-partner chat "message"'); process.exit(1); }
                printHeader();
                await cmdChat(args.slice(1).join(' '), args.includes('--stream'));
                break;

            case 'goal':
                if (!args[1]) { console.error('Usage: ai-partner goal "task description"'); process.exit(1); }
                printHeader();
                await cmdGoal(args.slice(1).join(' '));
                break;

            case 'status':
                printHeader();
                await cmdStatus();
                break;

            case 'models':
                printHeader();
                await cmdModels();
                break;

            case 'config':
                printHeader();
                await cmdConfig(args.slice(1));
                break;

            case 'interactive':
            case 'i':
                await cmdInteractive();
                break;

            default:
                if (args.length === 0) {
                    // Default to interactive mode
                    await cmdInteractive();
                } else {
                    printHeader();
                    console.log('Commands:');
                    console.log('  chat "message"     Send a chat message');
                    console.log('  chat "msg" --stream  Stream response tokens');
                    console.log('  goal "task"        Execute an autonomous goal');
                    console.log('  status             Show system status');
                    console.log('  models             List available models');
                    console.log('  config             Show current config');
                    console.log('  interactive (i)    Interactive chat mode');
                    console.log('');
                    console.log('Set AI_PARTNER_URL env to change server (default: http://localhost:3000)');
                }
                break;
        }
    } catch (e: any) {
        console.error(`❌ Error: ${e.message}`);
        if (e.message.includes('ECONNREFUSED')) {
            console.error('   Is the AI Partner server running? Start with: npm run dev');
        }
        process.exit(1);
    }
}

main();
