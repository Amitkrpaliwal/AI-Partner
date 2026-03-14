/**
 * UsageTracker — LLM cost & usage tracking service (Phase 8).
 *
 * Tracks every LLM call: provider, model, tokens, estimated cost, latency.
 * Provides summaries by time period, provider, and conversation.
 */

import { db } from '../database';
import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

export interface LLMUsageEvent {
    provider: string;
    model: string;
    taskType: string;            // reasoning, code_gen, classification, chat, etc.
    promptTokens: number;
    completionTokens: number;
    estimatedCost: number;       // USD
    latencyMs: number;
    conversationId?: string;
    goalId?: string;
    agentId?: string;
}

export interface UsageSummary {
    totalCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCost: number;
    avgLatencyMs: number;
}

// Pricing per 1M tokens (input/output) in USD — updated Feb 2026
const PRICING: Record<string, { input: number; output: number }> = {
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4-turbo': { input: 10.00, output: 30.00 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
    'claude-3-opus': { input: 15.00, output: 75.00 },
    'claude-3-sonnet': { input: 3.00, output: 15.00 },
    'claude-3-haiku': { input: 0.25, output: 1.25 },
    'claude-3.5-sonnet': { input: 3.00, output: 15.00 },
    'gemini-pro': { input: 0.50, output: 1.50 },
    'gemini-1.5-pro': { input: 3.50, output: 10.50 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
    // Ollama / local models = free
    'default': { input: 0, output: 0 },
};

// ============================================================================
// USAGE TRACKER
// ============================================================================

export class UsageTracker extends EventEmitter {
    private initialized = false;
    private dailyCostAlert: number = 10.0; // USD

    async initialize(): Promise<void> {
        if (this.initialized) return;

        await db.run(`
            CREATE TABLE IF NOT EXISTS llm_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                task_type TEXT DEFAULT 'chat',
                prompt_tokens INTEGER DEFAULT 0,
                completion_tokens INTEGER DEFAULT 0,
                estimated_cost REAL DEFAULT 0,
                latency_ms INTEGER DEFAULT 0,
                conversation_id TEXT,
                goal_id TEXT,
                agent_id TEXT,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);

        this.initialized = true;
        console.log('[UsageTracker] Initialized');
    }

    /**
     * Record an LLM usage event
     */
    async record(event: LLMUsageEvent): Promise<void> {
        await this.initialize();

        // Estimate cost if not provided
        let cost = event.estimatedCost;
        if (cost === 0 || cost === undefined) {
            cost = this.estimateCost(event.model, event.promptTokens, event.completionTokens);
        }

        await db.run(`
            INSERT INTO llm_usage (provider, model, task_type, prompt_tokens, completion_tokens, estimated_cost, latency_ms, conversation_id, goal_id, agent_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            event.provider, event.model, event.taskType,
            event.promptTokens, event.completionTokens, cost,
            event.latencyMs, event.conversationId || null,
            event.goalId || null, event.agentId || null
        ]);

        // Check daily cost alert
        const dailyCost = await this.getDailyCost();
        if (dailyCost > this.dailyCostAlert) {
            this.emit('cost:alert', { dailyCost, threshold: this.dailyCostAlert });
        }
    }

    /**
     * Estimate cost based on model pricing
     */
    estimateCost(model: string, promptTokens: number, completionTokens: number): number {
        // Find matching pricing
        const modelKey = Object.keys(PRICING).find(k => model.toLowerCase().includes(k)) || 'default';
        const price = PRICING[modelKey];
        return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
    }

    /**
     * Get usage summary for a time period
     */
    async getSummary(period: 'daily' | 'weekly' | 'monthly' = 'daily'): Promise<UsageSummary> {
        await this.initialize();

        const dateFilter = period === 'daily' ? "date('now')"
            : period === 'weekly' ? "date('now', '-7 days')"
                : "date('now', '-30 days')";

        const row = await db.get(`
            SELECT
                COUNT(*) as totalCalls,
                COALESCE(SUM(prompt_tokens), 0) as totalPromptTokens,
                COALESCE(SUM(completion_tokens), 0) as totalCompletionTokens,
                COALESCE(SUM(prompt_tokens + completion_tokens), 0) as totalTokens,
                COALESCE(SUM(estimated_cost), 0) as totalCost,
                COALESCE(AVG(latency_ms), 0) as avgLatencyMs
            FROM llm_usage
            WHERE timestamp >= ${dateFilter}
        `);

        return {
            totalCalls: row?.totalCalls || 0,
            totalPromptTokens: row?.totalPromptTokens || 0,
            totalCompletionTokens: row?.totalCompletionTokens || 0,
            totalTokens: row?.totalTokens || 0,
            totalCost: Math.round((row?.totalCost || 0) * 10000) / 10000,
            avgLatencyMs: Math.round(row?.avgLatencyMs || 0),
        };
    }

    /**
     * Get usage breakdown by provider
     */
    async getByProvider(period: 'daily' | 'weekly' | 'monthly' = 'weekly'): Promise<any[]> {
        await this.initialize();

        const dateFilter = period === 'daily' ? "date('now')"
            : period === 'weekly' ? "date('now', '-7 days')"
                : "date('now', '-30 days')";

        return db.all(`
            SELECT
                provider,
                model,
                COUNT(*) as calls,
                SUM(prompt_tokens) as promptTokens,
                SUM(completion_tokens) as completionTokens,
                SUM(estimated_cost) as totalCost,
                AVG(latency_ms) as avgLatencyMs
            FROM llm_usage
            WHERE timestamp >= ${dateFilter}
            GROUP BY provider, model
            ORDER BY totalCost DESC
        `);
    }

    /**
     * Get usage for a specific conversation
     */
    async getByConversation(conversationId: string): Promise<any[]> {
        await this.initialize();

        return db.all(`
            SELECT
                provider, model, task_type,
                SUM(prompt_tokens) as promptTokens,
                SUM(completion_tokens) as completionTokens,
                SUM(estimated_cost) as totalCost,
                COUNT(*) as calls
            FROM llm_usage
            WHERE conversation_id = ?
            GROUP BY provider, model, task_type
        `, [conversationId]);
    }

    /**
     * Get today's total cost
     */
    async getDailyCost(): Promise<number> {
        await this.initialize();
        const row = await db.get("SELECT COALESCE(SUM(estimated_cost), 0) as cost FROM llm_usage WHERE timestamp >= date('now')");
        return row?.cost || 0;
    }

    /**
     * Set daily cost alert threshold
     */
    setDailyCostAlert(threshold: number): void {
        this.dailyCostAlert = threshold;
    }

    /**
     * Get daily cost alert threshold
     */
    getDailyCostAlert(): number {
        return this.dailyCostAlert;
    }
}

export const usageTracker = new UsageTracker();
