/**
 * SelfCorrector — Fixes failed scripts and replans execution strategies.
 * Extracted from GoalOrientedExecutor.ts (Sprint 2: Kill the Monolith).
 */

import { ExecutionState, StateAssessment, ReplanResult } from '../../types/goal';
import { modelManager } from '../../services/llm/modelManager';
import { modelRouter } from '../../services/llm/modelRouter';
import { ScriptGenerator } from './ScriptGenerator';
import { promptLoader } from '../../utils/PromptLoader';

/**
 * Classify the severity of an error string for early-replan decisions.
 *
 * 'fatal'     — deterministic, will never succeed with the current approach.
 *               Set stuck_count to threshold immediately to skip wasted iterations.
 * 'transient' — could succeed on retry (rate-limit, network blip, timeout).
 *               Normal stuck_count increment applies.
 * 'unknown'   — unrecognised; treat as transient by default.
 */
export type ErrorSeverity = 'fatal' | 'transient' | 'unknown';

export function classifyErrorSeverity(errorText: string): ErrorSeverity {
    const t = errorText.toLowerCase();

    // ── FATAL — deterministic failures that will never self-heal ──────────────
    if (
        t.includes('modulenotfounderror') ||
        t.includes('importerror') ||
        t.includes('no module named') ||
        t.includes('cannot find module')   // Node.js equivalent
    ) return 'fatal';

    if (
        t.includes('permission denied') ||
        t.includes('eacces') ||
        t.includes('enoent') && t.includes('/workspace')
    ) return 'fatal';

    if (
        t.includes('captcha') ||
        t.includes('cloudflare') ||
        t.includes('access denied') ||
        t.includes('403 forbidden') ||
        t.includes('bot detected')
    ) return 'fatal';

    if (
        t.includes('syntaxerror') ||
        t.includes('indentationerror') ||
        t.includes('nameerror') ||       // Python: undefined variable — won't fix itself
        t.includes('typeerror') && t.includes('is not a function')
    ) return 'fatal';

    // ── TRANSIENT — may succeed on retry ─────────────────────────────────────
    if (
        t.includes('timeout') ||
        t.includes('connection refused') ||
        t.includes('network') ||
        t.includes('rate limit') ||
        t.includes('429') ||
        t.includes('503') ||
        t.includes('502')
    ) return 'transient';

    return 'unknown';
}

export class SelfCorrector {
    private scriptGen = new ScriptGenerator();

    /**
     * Self-correction: Analyze script errors and generate a fixed version.
     * LLMs are good at fixing code when shown the error message.
     * Skips self-correction for runtime-not-found errors (nothing to fix).
     */
    async selfCorrectScript(
        originalScript: string,
        error: string,
        state: ExecutionState,
        runtime: 'python' | 'node' = 'python',
        isRuntimeNotFoundError: (output: string) => boolean
    ): Promise<string | null> {
        // Don't try to self-correct if the runtime itself isn't found
        if (isRuntimeNotFoundError(error)) {
            console.log('[SelfCorrector] Skipping self-correction: runtime not found (not a script error)');
            return null;
        }

        const llm = modelRouter.getAdapterForTask('code_generation') || modelManager.getActiveAdapter();
        if (!llm) return null;

        const lang = runtime === 'python' ? 'Python' : 'Node.js';
        console.log(`[SelfCorrector] Attempting self-correction for ${lang} script error`);

        const template = promptLoader.load('self-corrector', `This {{LANG}} script had an error. Fix it and output the corrected script.

ORIGINAL SCRIPT:
{{ORIGINAL_SCRIPT}}

ERROR:
{{ERROR}}

GOAL: {{GOAL}}

Fix the error and output ONLY the corrected {{LANG}} script. No explanations, no markdown.`);

        const prompt = promptLoader.interpolate(template, {
            LANG: lang,
            ORIGINAL_SCRIPT: originalScript.substring(0, 2000),
            ERROR: error.substring(0, 500),
            GOAL: state.goal.description,
        });

        try {
            const fixed = await llm.generate(prompt, { temperature: 0.2 });
            const cleaned = this.scriptGen.cleanScriptResponse(fixed, runtime);

            // Reject if the LLM returned the same (or nearly identical) broken script
            const isDifferentEnough =
                Math.abs(cleaned.length - originalScript.length) > 10 ||
                cleaned.substring(0, 200) !== originalScript.substring(0, 200);

            // Require at least one statement separator — catches empty / single-token responses
            const hasMinStructure = cleaned.includes('\n') || cleaned.includes(';');

            const hasFileOps = runtime === 'python'
                ? cleaned.includes('open(') || cleaned.includes('write(') ||
                  cleaned.includes('.write_text(') || cleaned.includes('.write_bytes(')
                : cleaned.includes('writeFile') || cleaned.includes('writeSync') ||
                  cleaned.includes('fs.') || cleaned.includes('createWriteStream');

            if (!isDifferentEnough || !hasMinStructure || !hasFileOps) {
                console.log('[SelfCorrector] Corrected script rejected: not meaningfully different or missing file operations');
                return null;
            }
            return cleaned;
        } catch (e) {
            console.error('[SelfCorrector] Self-correction failed:', e);
            return null;
        }
    }

    /**
     * Replan: Generate a new strategy when the current approach isn't working.
     */
    async replan(state: ExecutionState, assessment: StateAssessment): Promise<ReplanResult> {
        const llm = modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
        if (!llm) {
            // Find first missing file and try to write it
            const missingFile = state.goal.success_criteria.find(
                c => c.type === 'file_exists' && c.status !== 'passed'
            );
            return {
                new_strategy: 'Generate files directly',
                first_action: missingFile?.config.path
                    ? { tool: 'write_file', args: { path: missingFile.config.path, content: '# Auto-generated\n' } }
                    : undefined as any,
                why_different: 'No LLM available, attempting direct file creation'
            };
        }

        // Summarize errors — deduplicate repeated errors, show last 8 max
        const recentErrors = state.error_history.slice(-8);
        const failedApproaches = recentErrors.length > 0
            ? recentErrors.map((e, i) => `[${i + 1}] ${e.context}: ${e.error.substring(0, 200)}`).join('\n')
            : 'Initial attempts failed — no prior errors recorded';

        // Root cause classification for explicit guidance
        const errorText = recentErrors.map(e => e.error).join(' ').toLowerCase();
        let rootCauseHint = '';
        if (errorText.includes('captcha') || errorText.includes('bot') || errorText.includes('blocked')) {
            rootCauseHint = 'ROOT CAUSE: Target website blocks bots/scrapers. Do NOT retry the same site. Use a financial data API (yfinance, nsepy, alpha_vantage) or a different data source instead.';
        } else if (errorText.includes('modulenotfounderror') || errorText.includes('importerror') || errorText.includes('no module named')) {
            rootCauseHint = 'ROOT CAUSE: Required Python package is missing. Use only standard-library modules (urllib, json, csv, os) or packages pre-installed in the sandbox (requests, yfinance, pandas, numpy).';
        } else if (errorText.includes('connection refused') || errorText.includes('timeout') || errorText.includes('network')) {
            rootCauseHint = 'ROOT CAUSE: Network/connection failure. Check if the service requires authentication or is rate-limited. Try a different endpoint or fallback data source.';
        } else if (errorText.includes('write_truncated') || errorText.includes('content is empty')) {
            rootCauseHint = 'ROOT CAUSE: File content was truncated mid-generation. Generate the file content in smaller chunks or simplify the output format.';
        } else if (errorText.includes('permission denied') || errorText.includes('eacces')) {
            rootCauseHint = 'ROOT CAUSE: File permission error. Write files to /workspace/output/ directory which has write access.';
        }

        // Last 5 journal entries for execution context
        const journalContext = state.execution_journal && state.execution_journal.length > 0
            ? state.execution_journal.slice(-5).join('\n')
            : 'No journal entries yet';

        const replanTemplate = promptLoader.load('replan', `The current approach is not working after {{STRATEGY_CHANGES}} attempt(s). Generate a FUNDAMENTALLY DIFFERENT strategy.

ORIGINAL GOAL: {{GOAL}}

WHAT WAS TRIED (last {{ERROR_COUNT}} errors):
{{FAILED_APPROACHES}}

{{ROOT_CAUSE_HINT}}

RECENT EXECUTION STEPS:
{{JOURNAL_CONTEXT}}

CURRENT STATE:
- Files created: {{ARTIFACTS}}
- Criteria passed: {{CRITERIA_PASSED}}
- Criteria failing: {{CRITERIA_FAILING}}
- Blocking issues: {{BLOCKING_ISSUES}}

OUTPUT CONTRACT — DO NOT CHANGE THESE FILENAMES:
{{REQUIRED_FILES}}
Any new strategy MUST produce files with these exact names. Do not rename, combine, or consolidate them.

RULES FOR THE NEW STRATEGY:
1. Do NOT repeat any approach already tried above
2. If web scraping failed → switch to a data API (yfinance, nsepy, requests to an API endpoint)
3. If an import failed → use only stdlib or known-available packages: requests, json, csv, openpyxl, pandas, numpy, beautifulsoup4. NEVER use fpdf, reportlab — for PDF use: run_command pandoc report.md -o report.pdf --pdf-engine=wkhtmltopdf
4. If a file wasn't created → verify the write path uses /workspace/output/
5. The new strategy must produce different output via a different method
6. MESSAGING: To send Telegram/Discord/WhatsApp, call the messaging_send MCP tool directly — NEVER write a Python script for it

Output JSON:
{
  "new_strategy": "One sentence: what you will do differently and why",
  "first_action": {
    "tool": "tool_name",
    "args": {}
  },
  "why_different": "Specific technical reason this avoids the previous failures",
  "avoided_mistakes": ["mistake1", "mistake2"]
}`);

        const requiredFiles = state.goal.success_criteria
            .filter(c => c.type === 'file_exists' && c.config.path)
            .map(c => `- ${c.config.path}`)
            .join('\n') || '- (none specified)';

        const prompt = promptLoader.interpolate(replanTemplate, {
            GOAL: state.goal.description,
            FAILED_APPROACHES: failedApproaches,
            ROOT_CAUSE_HINT: rootCauseHint,
            JOURNAL_CONTEXT: journalContext,
            ARTIFACTS: state.artifacts.join(', ') || 'None',
            CRITERIA_PASSED: String(state.goal.success_criteria.filter(c => c.status === 'passed').length),
            CRITERIA_FAILING: String(state.goal.success_criteria.filter(c => c.status === 'failed').length),
            BLOCKING_ISSUES: assessment.blocking_issues.join(', ') || 'None identified',
            STRATEGY_CHANGES: String((state.strategy_changes ?? 0) + 1),
            ERROR_COUNT: String(recentErrors.length),
            REQUIRED_FILES: requiredFiles,
        });

        try {
            return await llm.generateJSON(prompt, {});
        } catch (error) {
            return {
                new_strategy: 'Retry with simpler approach',
                first_action: { tool: 'write_file', args: { path: 'output.txt', content: 'Attempting recovery...' } },
                why_different: 'Fallback strategy'
            };
        }
    }
}
