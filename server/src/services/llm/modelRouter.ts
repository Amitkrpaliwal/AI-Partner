import { modelManager } from './modelManager';
import { LLMAdapter } from './types';

/**
 * ModelRouter - Smart Model Routing
 *
 * Routes different task types to the most appropriate model:
 * - Classification/routing → fast model (llama3.2, gpt-4o-mini)
 * - Code generation → strong model (codellama, gpt-4o, deepseek-coder)
 * - Reasoning/planning → strong model
 * - Embeddings → embedding model (nomic-embed-text)
 * - Simple Q&A → fast model
 *
 * Falls back to the active adapter if no specialized model is configured.
 */

export type TaskType = 'classification' | 'code_generation' | 'reasoning' | 'embedding' | 'simple_qa' | 'json_generation';

interface ModelRoute {
    taskType: TaskType;
    preferredProviders: string[];      // In priority order
    preferredModels: string[];          // Model name patterns
}

const DEFAULT_ROUTES: ModelRoute[] = [
    {
        // Fast small models — classification needs speed, not power
        taskType: 'classification',
        preferredProviders: ['cerebras', 'groq', 'openrouter', 'fireworks', 'openai', 'ollama'],
        preferredModels: ['llama-3', 'gpt-4o-mini', 'llama3.2', 'mistral']
    },
    {
        // Fast small models — OODA decisions, simple questions
        taskType: 'simple_qa',
        preferredProviders: ['cerebras', 'groq', 'openrouter', 'fireworks', 'openai', 'ollama'],
        preferredModels: ['llama-3', 'gpt-4o-mini', 'llama3.2']
    },
    {
        // Strong models — code quality matters more than speed
        taskType: 'code_generation',
        preferredProviders: ['openai', 'anthropic', 'deepseek', 'fireworks', 'openrouter', 'ollama'],
        preferredModels: ['gpt-4o', 'deepseek-chat', 'claude', 'codellama', 'qwen2.5-coder']
    },
    {
        // Strong reasoning models
        taskType: 'reasoning',
        preferredProviders: ['openai', 'anthropic', 'cohere', 'deepseek', 'openrouter', 'ollama'],
        preferredModels: ['gpt-4o', 'claude', 'command-r-plus', 'deepseek-chat', 'llama3']
    },
    {
        // Fast models for ReAct JSON decisions — cerebras is 100k tok/s
        taskType: 'json_generation',
        preferredProviders: ['cerebras', 'groq', 'openrouter', 'fireworks', 'openai', 'ollama'],
        preferredModels: ['gpt-4o-mini', 'gpt-4o', 'llama-3', 'llama3.2']
    },
    {
        taskType: 'embedding',
        preferredProviders: ['ollama', 'openai', 'cohere'],
        preferredModels: ['nomic-embed-text', 'text-embedding-3-small', 'embed-english-v3.0']
    }
];

export class ModelRouter {
    private routes: ModelRoute[] = DEFAULT_ROUTES;

    /**
     * Get the best available adapter for a specific task type.
     * Falls back to the active adapter if no specialized route matches.
     */
    getAdapterForTask(taskType: TaskType): LLMAdapter {
        const activeStatus = modelManager.getActiveModelStatus();
        const activeProvider = activeStatus.provider;

        const route = this.routes.find(r => r.taskType === taskType);
        if (!route) return modelManager.getActiveAdapter();

        // Prioritize the user's actively selected provider above the hardcoded defaults
        const preferredProviders = activeProvider
            ? [activeProvider, ...route.preferredProviders.filter(p => p !== activeProvider)]
            : route.preferredProviders;

        // Try each preferred provider in order
        for (const providerName of preferredProviders) {
            const adapter = modelManager.getAdapter(providerName);
            if (adapter) {
                return adapter;
            }
        }

        // Fallback to active
        return modelManager.getActiveAdapter();
    }

    /**
     * Classify a prompt into a task type for routing.
     * Uses heuristics (no LLM call needed - fast).
     */
    classifyTask(prompt: string): TaskType {
        const lower = prompt.toLowerCase();

        // Code generation patterns
        if (
            lower.includes('write a script') ||
            lower.includes('write code') ||
            lower.includes('create a function') ||
            lower.includes('implement') ||
            lower.includes('generate code') ||
            lower.includes('python script') ||
            lower.includes('node.js script') ||
            lower.includes('fix the error') ||
            lower.includes('fix the bug')
        ) {
            return 'code_generation';
        }

        // JSON generation patterns
        if (
            lower.includes('output json') ||
            lower.includes('respond with json') ||
            lower.includes('choose one action') ||
            lower.includes('choose the single')
        ) {
            return 'json_generation';
        }

        // Reasoning patterns
        if (
            lower.includes('think step by step') ||
            lower.includes('analyze') ||
            lower.includes('break this goal') ||
            lower.includes('plan') ||
            lower.includes('what should we do')
        ) {
            return 'reasoning';
        }

        // Embedding patterns
        if (
            lower.includes('embed') ||
            lower.includes('similarity') ||
            lower.includes('vector')
        ) {
            return 'embedding';
        }

        // Simple Q&A — short questions without action keywords
        if (prompt.length < 200 && (lower.includes('?') || lower.startsWith('what') || lower.startsWith('how') || lower.startsWith('why'))) {
            return 'simple_qa';
        }

        // Default: classification (fast model)
        return 'classification';
    }

    /**
     * Get both the adapter and suggested task type for a prompt.
     * Convenience method combining classification + routing.
     */
    route(prompt: string): { adapter: LLMAdapter; taskType: TaskType } {
        const taskType = this.classifyTask(prompt);
        const adapter = this.getAdapterForTask(taskType);
        return { adapter, taskType };
    }
}

export const modelRouter = new ModelRouter();
