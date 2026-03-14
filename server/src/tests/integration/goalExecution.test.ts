/**
 * Integration tests for GoalOrientedExecutor.
 *
 * These tests import the real GoalOrientedExecutor class but mock all external
 * dependencies (DB, MCP, LLM, sub-modules) so the full control-flow is exercised
 * without any network, Docker, or filesystem side-effects.
 *
 * Tests:
 *   1. Wall-clock timeout (Fix 1.3) — GOAL_MAX_EXECUTION_MS fires correctly
 *   2. Cancellation — cancel() stops the loop and returns status='cancelled'
 *   3. Happy path — mock LLM writes a file, validator passes, status='completed'
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted mock references — must be created before vi.mock() factory functions
// run (vi.hoisted ensures correct hoisting order).
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
    const noop = () => { };
    const noopAsync = async () => { };
    const nullAsync = async () => null;
    const emptyArrayAsync = async () => [];

    const silentLogger = () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    });

    return {
        // ── ReActReasoner instance ──────────────────────────────────────────
        reasonAndDecide: vi.fn(),
        executeAction: vi.fn(),
        generateForceWriteAction: vi.fn().mockResolvedValue(null),
        resetSearchState: vi.fn(),
        setDelegationConfig: vi.fn(),

        // ── GoalExtractor instance ──────────────────────────────────────────
        extractGoal: vi.fn(),

        // ── TaskDecomposer instance ─────────────────────────────────────────
        decomposeGoal: vi.fn().mockResolvedValue([]),

        // ── ExecutionEngine instance ────────────────────────────────────────
        executeViaScript: vi.fn().mockResolvedValue(false),
        detectRuntime: vi.fn().mockResolvedValue('node'),
        isRuntimeNotFoundError: vi.fn().mockReturnValue(false),

        // ── SelfCorrector instance ──────────────────────────────────────────
        selfCorrectScript: vi.fn().mockResolvedValue(null),
        replan: vi.fn(),

        // ── goalValidator singleton ─────────────────────────────────────────
        goalValidator: {
            setWorkspace: vi.fn(),
            setOutputDir: vi.fn(),
            validateGoal: vi.fn(),
            executionStartTime: 0,
        },

        // ── agentPool singleton ─────────────────────────────────────────────
        agentPool: {
            lookupProfile: vi.fn().mockResolvedValue(null),
            clearAbort: vi.fn(),
            resetSpawnCounter: vi.fn(),
            setUserContext: vi.fn(),
            setBudget: vi.fn(),
            delegateTask: vi.fn(),
            abort: vi.fn(),
        },

        // ── agentBus singleton ──────────────────────────────────────────────
        agentBus: {
            registerAgent: vi.fn(),
            send: vi.fn(),
            unregisterAgent: vi.fn(),
            setGateway: vi.fn(),
        },

        // ── db singleton ────────────────────────────────────────────────────
        db: {
            run: vi.fn().mockResolvedValue(undefined),
            get: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue([]),
        },

        // ── mcpManager singleton ────────────────────────────────────────────
        mcpManager: {
            getWorkspace: vi.fn().mockReturnValue('/workspace'),
            callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
        },

        // ── configManager singleton ─────────────────────────────────────────
        configManager: {
            getConfig: vi.fn().mockReturnValue({ execution: { approval_mode: 'none' } }),
            getWorkspaceDir: vi.fn().mockReturnValue('/workspace'),
        },

        // ── skillLearner singleton ──────────────────────────────────────────
        skillLearner: {
            findMatchingSkill: vi.fn().mockResolvedValue(null),
            learnFromInstruction: vi.fn().mockResolvedValue(null),
        },

        // ── modelRouter singleton ───────────────────────────────────────────
        modelRouter: { getAdapterForTask: vi.fn().mockReturnValue(null) },

        // ── modelManager singleton ──────────────────────────────────────────
        modelManager: {
            getActiveAdapter: vi.fn().mockReturnValue(null),
            getActiveModelStatus: vi.fn().mockReturnValue({ provider: 'test', model: 'test-model' }),
            getProviderNames: vi.fn().mockReturnValue(['test']),
            getFallbackAdapter: vi.fn().mockReturnValue(null),
            refreshProviders: vi.fn().mockResolvedValue(undefined),
            switchModel: vi.fn().mockResolvedValue(undefined),
        },

        // ── containerSessionManager singleton ───────────────────────────────
        containerSessionManager: {
            cleanupStaleContainers: vi.fn().mockResolvedValue(undefined),
            destroySession: vi.fn().mockResolvedValue(undefined),
        },

        // ── promptLoader singleton ──────────────────────────────────────────
        promptLoader: {
            load: vi.fn().mockReturnValue(''),
            interpolate: vi.fn((t: string) => t),
        },

        // ── memory manager (dynamic import) ────────────────────────────────
        memoryManager: {
            storeMemory: vi.fn().mockResolvedValue(undefined),
            hybridSearch: vi.fn().mockResolvedValue([]),
            addEpisodicEvent: vi.fn().mockResolvedValue(undefined),
        },

        // ── Logger ─────────────────────────────────────────────────────────
        silentLogger,
        createLogger: vi.fn(silentLogger),
        goalLogger: vi.fn(silentLogger),

        noop,
        noopAsync,
        nullAsync,
        emptyArrayAsync,
    };
});

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks — replace all heavy dependencies before the executor is imported
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../utils/Logger', () => ({
    createLogger: mocks.createLogger,
    goalLogger: mocks.goalLogger,
    appLogger: mocks.silentLogger(),
}));

vi.mock('../../agents/GoalValidator', () => ({
    goalValidator: mocks.goalValidator,
}));

vi.mock('../../agents/AgentPool', () => ({
    agentPool: mocks.agentPool,
}));

vi.mock('../../agents/AgentBus', () => ({
    agentBus: mocks.agentBus,
}));

vi.mock('../../database', () => ({ db: mocks.db }));
vi.mock('../../database/index', () => ({ db: mocks.db }));

vi.mock('../../mcp/MCPManager', () => ({
    mcpManager: mocks.mcpManager,
}));

vi.mock('../../services/ConfigManager', () => ({
    configManager: mocks.configManager,
}));

vi.mock('../../config/MarkdownConfigLoader', () => ({
    MarkdownConfigLoader: vi.fn().mockImplementation(() => ({
        loadUser: vi.fn().mockReturnValue(''),
    })),
}));

vi.mock('../../services/SkillLearner', () => ({
    skillLearner: mocks.skillLearner,
}));

vi.mock('../../services/llm/modelRouter', () => ({
    modelRouter: mocks.modelRouter,
}));

vi.mock('../../services/llm/modelManager', () => ({
    modelManager: mocks.modelManager,
}));

vi.mock('../../execution/ContainerSession', () => ({
    containerSessionManager: mocks.containerSessionManager,
}));

vi.mock('../../utils/PromptLoader', () => ({
    promptLoader: mocks.promptLoader,
}));

vi.mock('../../utils/modelUtils', () => ({
    parseParamCount: vi.fn().mockReturnValue(0),
    isSmallModel: vi.fn().mockReturnValue(false),
}));

vi.mock('../../memory/MemoryManager', () => ({
    memoryManager: mocks.memoryManager,
}));

vi.mock('../../mcp/servers/BrowserServer', () => ({
    browserServer: {
        screenshot: vi.fn().mockResolvedValue({ base64: null }),
        getCurrentUrl: vi.fn().mockReturnValue(''),
        stealthFetch: vi.fn().mockResolvedValue({ success: false, error: 'mock' }),
    },
}));

// ── Sub-module class mocks ───────────────────────────────────────────────────

vi.mock('../../agents/goal/GoalExtractor', () => ({
    GoalExtractor: vi.fn().mockImplementation(function () {
        return { extractGoal: mocks.extractGoal };
    }),
}));

vi.mock('../../agents/goal/TaskDecomposer', () => ({
    TaskDecomposer: vi.fn().mockImplementation(function () {
        return { decomposeGoal: mocks.decomposeGoal };
    }),
}));

vi.mock('../../agents/goal/ExecutionEngine', () => ({
    ExecutionEngine: vi.fn().mockImplementation(function () {
        return {
            enableNetwork: false,
            containerSessionId: '',
            executeViaScript: mocks.executeViaScript,
            detectRuntime: mocks.detectRuntime,
            isRuntimeNotFoundError: mocks.isRuntimeNotFoundError,
        };
    }),
}));

vi.mock('../../agents/goal/SelfCorrector', () => ({
    SelfCorrector: vi.fn().mockImplementation(function () {
        return {
            selfCorrectScript: mocks.selfCorrectScript,
            replan: mocks.replan,
        };
    }),
    classifyErrorSeverity: vi.fn().mockReturnValue('unknown'),
}));

vi.mock('../../agents/goal/ReActReasoner', () => ({
    ReActReasoner: vi.fn().mockImplementation(function () {
        return {
            containerSessionId: '',
            enableNetwork: false,
            browserIntent: false,
            profileContent: '',
            activeProfile: 'default',
            userContext: '',
            outputDir: '',
            executionPlan: '',
            skillStrategyHint: '',
            searchMetrics: {},
            reasonAndDecide: mocks.reasonAndDecide,
            executeAction: mocks.executeAction,
            generateForceWriteAction: mocks.generateForceWriteAction,
            resetSearchState: mocks.resetSearchState,
            setDelegationConfig: mocks.setDelegationConfig,
        };
    }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Now import the module under test (AFTER all vi.mock() calls)
// ─────────────────────────────────────────────────────────────────────────────

import { GoalOrientedExecutor } from '../../agents/GoalOrientedExecutor';

// ─────────────────────────────────────────────────────────────────────────────
// Shared test goal — complexity 5 avoids the fast-path (requires ≤ 3)
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_GOAL = {
    description: 'write hello world to a file',
    estimated_complexity: 5,
    success_criteria: [
        {
            id: 'c1',
            type: 'file_exists' as const,
            status: 'pending' as const,
            config: { path: '/workspace/goal-test/hello.txt' },
            required: true,
        },
    ],
    suggested_milestones: ['Write the file'],
    expected_files: ['/workspace/goal-test/hello.txt'],
    approach: 'write_file',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('GoalOrientedExecutor — integration', () => {
    let executor: GoalOrientedExecutor;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();

        // Re-apply default mock implementations after clearAllMocks
        mocks.db.run.mockResolvedValue(undefined);
        mocks.db.get.mockResolvedValue(null);
        mocks.db.all.mockResolvedValue([]);
        mocks.mcpManager.getWorkspace.mockReturnValue('/workspace');
        mocks.mcpManager.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
        mocks.configManager.getConfig.mockReturnValue({ execution: { approval_mode: 'none' } });
        mocks.configManager.getWorkspaceDir.mockReturnValue('/workspace');
        mocks.agentPool.lookupProfile.mockResolvedValue(null);
        mocks.goalValidator.validateGoal.mockResolvedValue({
            score: 0, complete: false, passed: [], failed: [],
        });
        mocks.skillLearner.findMatchingSkill.mockResolvedValue(null);
        mocks.modelRouter.getAdapterForTask.mockReturnValue(null);
        mocks.modelManager.getActiveAdapter.mockReturnValue(null);
        mocks.modelManager.getActiveModelStatus.mockReturnValue({ provider: 'test', model: 'test-model' });
        mocks.extractGoal.mockResolvedValue(MOCK_GOAL);
        mocks.decomposeGoal.mockResolvedValue([]);

        executor = new GoalOrientedExecutor();

        // Restore env
        process.env = { ...originalEnv };
        delete process.env['GOAL_MAX_EXECUTION_MS'];
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: Wall-clock timeout (Fix 1.3)
    // ─────────────────────────────────────────────────────────────────────────
    it('fails with goal_timeout when wall-clock limit is exceeded', async () => {
        // Set a very short timeout so it fires mid-run
        process.env['GOAL_MAX_EXECUTION_MS'] = '50';

        // reasonAndDecide sleeps 100ms (longer than timeout) then returns an action
        mocks.reasonAndDecide.mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 100));
            return {
                reasoning: 'Write the file now.',
                action: { tool: 'write_file', args: { path: '/workspace/goal-test/hello.txt', content: 'hello' }, reasoning: 'write the file' },
            };
        });

        // executeAction returns success for write_file
        mocks.executeAction.mockResolvedValue({
            tool_used: 'write_file',
            args: { path: '/workspace/goal-test/hello.txt', content: 'hello' },
            result: { stdout: 'written' },
            success: true,
            iteration: 1,
            timestamp: new Date(),
            duration_ms: 5,
            artifacts_created: ['/workspace/goal-test/hello.txt'],
        });

        // validateGoal returns incomplete on first call (timeout fires before 2nd iteration)
        mocks.goalValidator.validateGoal.mockResolvedValue({
            score: 0, complete: false, passed: [], failed: [],
        });

        const result = await executor.executeGoal('write hello world to a file', 'test-user', {
            max_iterations: 100,
        });

        expect(result.status).toBe('failed');
        expect(result.failure_reason).toMatch(/wall.clock time|execution timeout|absolute timeout/i);
    }, 10_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: Cancellation
    // ─────────────────────────────────────────────────────────────────────────
    it('stops and returns cancelled when cancel() is called mid-run', async () => {
        let capturedExecutionId: string | undefined;

        // reasonAndDecide captures the execution ID from state, then delays
        mocks.reasonAndDecide.mockImplementation(async (state: any) => {
            capturedExecutionId = state.execution_id;
            await new Promise(r => setTimeout(r, 80));
            return {
                reasoning: 'reading the workspace',
                action: { tool: 'list_directory', args: { path: '/workspace' }, reasoning: 'explore' },
            };
        });

        mocks.executeAction.mockResolvedValue({
            tool_used: 'list_directory',
            args: { path: '/workspace' },
            result: 'file1.txt\nfile2.txt',
            success: true,
            iteration: 1,
            timestamp: new Date(),
            duration_ms: 5,
            artifacts_created: [],
        });

        // Start without awaiting
        const goalPromise = executor.executeGoal('list files in workspace', 'test-user');

        // Wait until reasonAndDecide starts (capturedExecutionId gets set)
        await vi.waitFor(
            () => { expect(capturedExecutionId).toBeDefined(); },
            { timeout: 3000, interval: 10 }
        );

        // Cancel the execution
        const cancelled = executor.cancel(capturedExecutionId!);
        expect(cancelled).toBe(true);

        // Now wait for the goal to complete
        const result = await goalPromise;

        expect(result.status).toBe('cancelled');
    }, 10_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: Happy path — write_file succeeds, validator passes → completed
    // ─────────────────────────────────────────────────────────────────────────
    it('completes successfully when the action succeeds and validator passes', async () => {
        // Mock reasonAndDecide to return a write_file action
        mocks.reasonAndDecide.mockResolvedValue({
            reasoning: 'I will write the hello world file now.',
            action: {
                tool: 'write_file',
                args: { path: '/workspace/goal-test/hello.txt', content: 'hello world' },
                reasoning: 'write the required output file',
            },
        });

        // Mock executeAction to simulate successful write_file
        mocks.executeAction.mockResolvedValue({
            tool_used: 'write_file',
            args: { path: '/workspace/goal-test/hello.txt', content: 'hello world' },
            result: { stdout: 'File written successfully' },
            success: true,
            iteration: 1,
            timestamp: new Date(),
            duration_ms: 10,
            artifacts_created: ['/workspace/goal-test/hello.txt'],
        });

        // Validator returns complete=true on first call
        const passedCriteria = [{ ...MOCK_GOAL.success_criteria[0], status: 'passed' as const }];
        mocks.goalValidator.validateGoal.mockResolvedValue({
            score: 100,
            complete: true,
            passed: passedCriteria,
            failed: [],
        });

        const result = await executor.executeGoal('write hello world to a file', 'test-user', {
            max_iterations: 20,
        });

        expect(result.status).toBe('completed');
        expect(mocks.executeAction).toHaveBeenCalledTimes(1);
        expect(mocks.goalValidator.validateGoal).toHaveBeenCalled();
    }, 10_000);
});
