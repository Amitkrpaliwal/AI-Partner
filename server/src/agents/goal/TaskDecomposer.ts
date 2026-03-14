/**
 * TaskDecomposer — Breaks a GoalDefinition into ordered sub-tasks.
 * Extracted from GoalOrientedExecutor.ts (Sprint 2: Kill the Monolith).
 */

import { GoalDefinition } from '../../types/goal';
import { modelManager } from '../../services/llm/modelManager';
import { modelRouter } from '../../services/llm/modelRouter';

export interface SubTask {
    description: string;
    expected_files: string[];
    order: number;
}

export class TaskDecomposer {

    /**
     * Break a goal into ordered sub-tasks for sequential execution.
     * Uses plain text generation (not JSON) for reliability.
     */
    async decomposeGoal(goal: GoalDefinition): Promise<SubTask[]> {
        // Use a fast model for task decomposition — structured planning, not vision/reasoning.
        const llm = modelRouter.getAdapterForTask('simple_qa') || modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
        if (!llm) {
            // Can't decompose without LLM - treat entire goal as one task
            return [{
                description: goal.description,
                expected_files: goal.success_criteria
                    .filter(c => c.type === 'file_exists')
                    .map(c => c.config.path!)
                    .filter(Boolean),
                order: 1
            }];
        }

        const prompt = `Break this goal into 1-5 ordered steps.

GOAL: ${goal.description}

CRITICAL RULES:
- If the goal requires sending a Telegram/Discord/WhatsApp notification, make it the LAST step and describe it as: "Call messaging_send tool to send a Telegram message with [content]" — NEVER plan to write a Python script or telegram_notify.py to do this. The messaging_send MCP tool handles it directly.
- Each step must produce concrete output files.

For each step, write EXACTLY in this format:
STEP 1: [description]
FILES: [comma-separated list of files this step creates]

STEP 2: [description]
FILES: [comma-separated list of files]

Keep it simple. 1-5 steps maximum. Each step should create specific files.`;

        try {
            const response = await llm.generate(prompt, { temperature: 0.2 });

            // Parse steps using regex (plain text, NOT JSON)
            const steps: SubTask[] = [];
            const stepRegex = /STEP\s*(\d+)\s*:\s*(.+?)(?:\r?\n)(?:FILES?\s*:\s*(.+?))?(?:\r?\n|$)/gi;
            let match;

            while ((match = stepRegex.exec(response)) !== null) {
                const files = match[3]
                    ? match[3].split(',').map(f => f.trim()).filter(f => f.length > 0 && !f.startsWith('['))
                    : [];
                steps.push({
                    description: match[2].trim(),
                    expected_files: files,
                    order: parseInt(match[1])
                });
            }

            if (steps.length === 0) {
                console.log('[TaskDecomposer] Could not parse decomposition, using single task');
                return [{
                    description: goal.description,
                    expected_files: goal.success_criteria
                        .filter(c => c.type === 'file_exists')
                        .map(c => c.config.path!)
                        .filter(Boolean),
                    order: 1
                }];
            }

            console.log(`[TaskDecomposer] Decomposed into ${steps.length} sub-tasks`);
            steps.forEach(s => console.log(`  ${s.order}. ${s.description} -> [${s.expected_files.join(', ')}]`));

            return steps.sort((a, b) => a.order - b.order);
        } catch (error) {
            console.error('[TaskDecomposer] Goal decomposition failed:', error);
            return [{
                description: goal.description,
                expected_files: goal.success_criteria
                    .filter(c => c.type === 'file_exists')
                    .map(c => c.config.path!)
                    .filter(Boolean),
                order: 1
            }];
        }
    }
}
