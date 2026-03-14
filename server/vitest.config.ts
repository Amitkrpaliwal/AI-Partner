import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        // pdf-parse v1 exposes ./lib/pdf-parse.js as an internal path that is NOT
        // listed in its package.json exports field.  Vite's import-analysis plugin
        // rejects it at transform time even inside dynamic import() calls.
        // Point the specifier at a lightweight stub so GoalValidator.ts can be
        // transformed without errors during unit/integration tests.
        alias: [
            {
                find: 'pdf-parse/lib/pdf-parse.js',
                replacement: path.resolve(__dirname, 'src/tests/__mocks__/pdfParseStub.ts'),
            },
        ],
    },
    test: {
        globals: true,
        environment: 'node',
        testTimeout: 30000,
        hookTimeout: 15000,
        include: ['src/tests/**/*.test.ts'],
        exclude: ['node_modules', 'dist'],
        reporters: ['verbose'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            // Scope coverage to critical path files — expanded as unit tests are added
            include: [
                'src/agents/goal/ReActReasoner.ts',
                'src/agents/goal/GoalValidator.ts',
                'src/agents/goal/SelfCorrector.ts',
                'src/agents/goal/ContextBuilder.ts',
                'src/database/MigrationRunner.ts',
                'src/utils/Logger.ts',
                'src/execution/ContainerSession.ts',
                'src/services/GoalEscalationDetector.ts',
                // Session 13 additions — skill library connectivity + multi-agent
                'src/services/SkillLearner.ts',
                'src/services/AgentOrchestrator.ts',
                'src/agents/AgentPool.ts',
            ],
            reportsDirectory: './coverage',
            thresholds: {
                lines: 65,
                functions: 65,
            },
        },
    },
});
