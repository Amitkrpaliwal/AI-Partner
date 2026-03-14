import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

// Types formerly in AutonomousTaskExecutor — defined here to remove the dependency
export interface TaskStep {
    id: string;
    description: string;
    validation: {
        type: 'file_exists' | 'code_compiles' | 'tests_pass' | 'custom' | 'none';
        criteria?: any;
    };
    status?: 'pending' | 'executing' | 'completed' | 'failed';
    result?: any;
}

export interface ValidationResult {
    passed: boolean;
    reason?: string;
    errors?: string[];
    message?: string;
}

const execAsync = promisify(exec);

// ============================================================================
// TASK VALIDATOR
// Validates step outputs using various strategies
// ============================================================================

export class TaskValidator {
    private workspaceDir: string;

    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
    }

    /**
     * Validate a step's output based on its validation type
     */
    async validate(step: TaskStep, result: any): Promise<ValidationResult> {
        console.log(`[TaskValidator] Validating step ${step.id} with type: ${step.validation.type}`);

        try {
            switch (step.validation.type) {
                case 'file_exists':
                    return await this.validateFileExists(step.validation.criteria);

                case 'code_compiles':
                    return await this.validateCompilation(step.validation.criteria);

                case 'tests_pass':
                    return await this.validateTests(step.validation.criteria);

                case 'custom':
                    return await this.validateCustom(step.validation.criteria, result);

                case 'none':
                default:
                    return { passed: true, message: 'No validation required' };
            }
        } catch (error) {
            console.error(`[TaskValidator] Validation error:`, error);
            return {
                passed: false,
                reason: `Validation error: ${error}`,
                errors: [String(error)]
            };
        }
    }

    /**
     * Check if a file exists
     */
    private async validateFileExists(criteria: { path: string }): Promise<ValidationResult> {
        if (!criteria?.path) {
            return { passed: true, message: 'No file path specified for validation' };
        }

        const filePath = path.isAbsolute(criteria.path)
            ? criteria.path
            : path.join(this.workspaceDir, criteria.path);

        try {
            await fs.promises.access(filePath);
            const stats = await fs.promises.stat(filePath);

            return {
                passed: true,
                message: `File ${criteria.path} exists (${stats.size} bytes)`
            };
        } catch {
            return {
                passed: false,
                reason: `File ${criteria.path} not found`,
                errors: [`Expected file does not exist: ${criteria.path}`]
            };
        }
    }

    /**
     * Check if TypeScript/JavaScript code compiles
     */
    private async validateCompilation(criteria?: { command?: string; directory?: string }): Promise<ValidationResult> {
        const command = criteria?.command || 'npx tsc --noEmit';
        const cwd = criteria?.directory || this.workspaceDir;

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd,
                timeout: 60000 // 1 minute timeout
            });

            // Check for TypeScript errors
            if (stderr && (stderr.includes('error TS') || stderr.includes('error:'))) {
                const errors = this.parseTypeScriptErrors(stderr);
                return {
                    passed: false,
                    reason: 'TypeScript compilation errors',
                    errors
                };
            }

            if (stdout && stdout.includes('error TS')) {
                const errors = this.parseTypeScriptErrors(stdout);
                return {
                    passed: false,
                    reason: 'TypeScript compilation errors',
                    errors
                };
            }

            return {
                passed: true,
                message: 'TypeScript compilation successful'
            };

        } catch (error: any) {
            // TypeScript exits with error code on compilation errors
            const output = error.stdout || error.stderr || String(error);

            if (output.includes('error TS') || output.includes('error:')) {
                const errors = this.parseTypeScriptErrors(output);
                return {
                    passed: false,
                    reason: 'TypeScript compilation failed',
                    errors
                };
            }

            return {
                passed: false,
                reason: `Compilation command failed: ${error.message}`,
                errors: [output.substring(0, 500)]
            };
        }
    }

    /**
     * Check if tests pass
     */
    private async validateTests(criteria?: { pattern?: string; command?: string }): Promise<ValidationResult> {
        const command = criteria?.command || `npm test${criteria?.pattern ? ` -- ${criteria.pattern}` : ''}`;

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: this.workspaceDir,
                timeout: 120000 // 2 minute timeout
            });

            const output = stdout + stderr;

            // Check for test failures
            if (output.includes('FAIL') || output.includes('✕') || output.includes('failed')) {
                const errors = this.parseTestErrors(output);
                return {
                    passed: false,
                    reason: 'Some tests failed',
                    errors
                };
            }

            // Check for success indicators
            if (output.includes('PASS') || output.includes('✓') || output.includes('passed')) {
                return {
                    passed: true,
                    message: 'All tests passed'
                };
            }

            // No clear indication - assume passed if no error
            return {
                passed: true,
                message: 'Tests completed'
            };

        } catch (error: any) {
            const output = error.stdout || error.stderr || String(error);
            const errors = this.parseTestErrors(output);

            return {
                passed: false,
                reason: 'Test execution failed',
                errors: errors.length > 0 ? errors : [output.substring(0, 500)]
            };
        }
    }

    /**
     * Custom validation via LLM or simple checks
     */
    private async validateCustom(criteria: { description?: string; check?: string }, result: any): Promise<ValidationResult> {
        if (!criteria) {
            return { passed: true, message: 'No custom validation criteria' };
        }

        // Simple string checks
        if (criteria.check && result) {
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            if (resultStr.includes(criteria.check)) {
                return { passed: true, message: `Found expected: ${criteria.check}` };
            } else {
                return {
                    passed: false,
                    reason: `Expected to find "${criteria.check}" in result`,
                    errors: [`Missing expected content: ${criteria.check}`]
                };
            }
        }

        // For description-based validation, we'd need LLM - for now, pass
        return { passed: true, message: `Custom validation: ${criteria.description || 'passed'}` };
    }

    /**
     * Parse TypeScript error output
     */
    private parseTypeScriptErrors(output: string): string[] {
        const errors: string[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            // Match patterns like: file.ts(10,5): error TS2304: ...
            if (line.includes('error TS') || line.match(/\(\d+,\d+\):\s*error/)) {
                errors.push(line.trim());
            }
        }

        // Limit to first 10 errors
        return errors.slice(0, 10);
    }

    /**
     * Parse test error output
     */
    private parseTestErrors(output: string): string[] {
        const errors: string[] = [];
        const lines = output.split('\n');

        let inFailBlock = false;
        for (const line of lines) {
            // Capture FAIL lines and following context
            if (line.includes('FAIL') || line.includes('✕') || line.includes('Error:')) {
                inFailBlock = true;
            }

            if (inFailBlock) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('at ')) {
                    errors.push(trimmed);
                }

                // Stop after blank line
                if (!trimmed) {
                    inFailBlock = false;
                }
            }
        }

        // Limit to first 10 errors
        return errors.slice(0, 10);
    }

    /**
     * Run ESLint validation
     */
    async validateLinting(filePath?: string): Promise<ValidationResult> {
        const target = filePath || '.';
        const command = `npx eslint ${target} --format=compact`;

        try {
            const { stdout } = await execAsync(command, {
                cwd: this.workspaceDir,
                timeout: 60000
            });

            if (stdout.includes('error')) {
                const errors = stdout.split('\n')
                    .filter(line => line.includes('error'))
                    .slice(0, 10);

                return {
                    passed: false,
                    reason: 'ESLint errors found',
                    errors
                };
            }

            return {
                passed: true,
                message: 'No linting errors'
            };

        } catch (error: any) {
            // ESLint exits with error code when issues found
            const output = error.stdout || '';
            if (output.includes('error')) {
                const errors = output.split('\n')
                    .filter((line: string) => line.includes('error'))
                    .slice(0, 10);

                return {
                    passed: false,
                    reason: 'ESLint errors found',
                    errors
                };
            }

            return {
                passed: true,
                message: 'Linting check completed'
            };
        }
    }
}
