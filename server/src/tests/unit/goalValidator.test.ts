/**
 * GoalValidator unit tests — no server required.
 * Uses real temp directories so file checks are genuine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GoalValidator } from '../../agents/GoalValidator';
import type { SuccessCriterion } from '../../types/goal';

function makeCriterion(type: string, config: Record<string, any>): SuccessCriterion {
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    type: type as any,
    config,
    required: true,
    weight: 1,   // required for score calculation
    status: 'pending',
  };
}

describe('GoalValidator', () => {
  let tmpDir: string;
  let validator: GoalValidator;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-validator-'));
    validator = new GoalValidator();
    validator.setWorkspace(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────
  // file_exists
  // ──────────────────────────────────────────────────────────────
  describe('file_exists criterion', () => {
    it('passes when file exists', async () => {
      const filePath = path.join(tmpDir, 'exists.txt');
      fs.writeFileSync(filePath, 'hello');

      const c = makeCriterion('file_exists', { path: filePath });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });

    it('fails when file does not exist', async () => {
      const c = makeCriterion('file_exists', { path: path.join(tmpDir, 'missing.txt') });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // file_contains
  // ──────────────────────────────────────────────────────────────
  describe('file_contains criterion', () => {
    it('passes when file contains the pattern', async () => {
      const filePath = path.join(tmpDir, 'report.txt');
      fs.writeFileSync(filePath, 'Total revenue: $12,345\nProfit margin: 23%');

      const c = makeCriterion('file_contains', { path: filePath, pattern: 'revenue' });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });

    it('fails when file does not contain the pattern', async () => {
      const filePath = path.join(tmpDir, 'empty_report.txt');
      fs.writeFileSync(filePath, 'Nothing useful here');

      const c = makeCriterion('file_contains', { path: filePath, pattern: 'revenue' });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
    });

    it('fails gracefully when file does not exist', async () => {
      const c = makeCriterion('file_contains', {
        path: path.join(tmpDir, 'no_such_file.txt'),
        pattern: 'anything',
      });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
    });

    // ── Bug 3 regression: multiline regex flag ─────────────────
    it('[Bug 3] ^.*$ pattern passes on a multiline file', async () => {
      const filePath = path.join(tmpDir, 'multiline.txt');
      fs.writeFileSync(filePath, '"use strict";\nexports.greet = function(name) { return "Hello, " + name; };\n');

      // ^.*$ with no multiline flag would fail because . doesn't match \n
      // and ^ only matches at position 0. With the 'gim' fix this should pass.
      const c = makeCriterion('file_contains', { path: filePath, pattern: '^.*$' });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });

    it('[Bug 3] line-anchored pattern matches first line of compiled JS', async () => {
      const filePath = path.join(tmpDir, 'compiled.js');
      fs.writeFileSync(filePath, '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.greet = greet;\n');

      const c = makeCriterion('file_contains', { path: filePath, pattern: '^"use strict"' });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });

    it('[Bug 3] exports pattern matches inside multiline compiled JS', async () => {
      const filePath = path.join(tmpDir, 'greeting-preview.txt');
      fs.writeFileSync(filePath, '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.greet = greet;\n');

      const c = makeCriterion('file_contains', { path: filePath, pattern: 'exports\\.greet|module\\.exports|Hello,' });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // output_matches
  // ──────────────────────────────────────────────────────────────
  describe('output_matches criterion', () => {
    it('passes when command output contains expected string', async () => {
      const c = makeCriterion('output_matches', {
        command: 'echo hello_world_test',
        expected: 'hello_world_test',
      });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });

    it('fails when output does not match', async () => {
      const c = makeCriterion('output_matches', {
        command: 'echo something_else',
        expected: 'expected_string_not_present',
      });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // code_compiles
  // ──────────────────────────────────────────────────────────────
  describe('code_compiles criterion', () => {
    // ── Bug 2 regression: cd prefix stripping ─────────────────
    it('[Bug 2] strips cd <dir> && prefix and passes the directory as cwd', async () => {
      // Use "echo done" as the "compiler" — it always exits 0 so the criterion passes.
      // The key is that if cd stripping was broken this would error with
      // "Compiler not found: cd is not installed or not in PATH"
      const c = makeCriterion('code_compiles', {
        command: `cd ${tmpDir} && echo done`,
      });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
      expect(result.message).toContain('successfully');
    });

    it('[Bug 2] plain compile command (no cd prefix) still works', async () => {
      const c = makeCriterion('code_compiles', {
        command: 'echo compile_ok',
      });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // unknown type
  // ──────────────────────────────────────────────────────────────
  describe('unknown criterion type', () => {
    it('returns passed: false with descriptive message', async () => {
      const c = makeCriterion('totally_unknown_type', {});
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('totally_unknown_type');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // validateGoal — aggregate
  // ──────────────────────────────────────────────────────────────
  describe('validateGoal', () => {
    it('returns complete=true when all required criteria pass', async () => {
      const filePath = path.join(tmpDir, 'output.txt');
      fs.writeFileSync(filePath, 'done');

      const goal = {
        id: 'g1',
        description: 'test',
        success_criteria: [
          makeCriterion('file_exists', { path: filePath }),
        ],
        estimated_complexity: 1,
        required_tools: [],
        expected_files: [],
        context: '',
        type: 'file',
      } as any;

      const result = await validator.validateGoal(goal);
      expect(result.complete).toBe(true);
      expect(result.passed.length).toBe(1);
      expect(result.failed.length).toBe(0);
      expect(result.score).toBe(100);
    });

    it('returns complete=false when a required criterion fails', async () => {
      const goal = {
        id: 'g2',
        description: 'test',
        success_criteria: [
          makeCriterion('file_exists', { path: path.join(tmpDir, 'missing_output.txt') }),
        ],
        estimated_complexity: 1,
        required_tools: [],
        expected_files: [],
        context: '',
        type: 'file',
      } as any;

      const result = await validator.validateGoal(goal);
      expect(result.complete).toBe(false);
      expect(result.score).toBe(0);
    });
  });
});


describe('GoalValidator', () => {
  let tmpDir: string;
  let validator: GoalValidator;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-validator-'));
    validator = new GoalValidator();
    validator.setWorkspace(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────
  // file_exists
  // ──────────────────────────────────────────────────────────────
  describe('file_exists criterion', () => {
    it('passes when file exists', async () => {
      const filePath = path.join(tmpDir, 'exists.txt');
      fs.writeFileSync(filePath, 'hello');

      const c = makeCriterion('file_exists', { path: filePath });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });

    it('fails when file does not exist', async () => {
      const c = makeCriterion('file_exists', { path: path.join(tmpDir, 'missing.txt') });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // file_contains
  // ──────────────────────────────────────────────────────────────
  describe('file_contains criterion', () => {
    it('passes when file contains the pattern', async () => {
      const filePath = path.join(tmpDir, 'report.txt');
      fs.writeFileSync(filePath, 'Total revenue: $12,345\nProfit margin: 23%');

      const c = makeCriterion('file_contains', { path: filePath, pattern: 'revenue' });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });

    it('fails when file does not contain the pattern', async () => {
      const filePath = path.join(tmpDir, 'empty_report.txt');
      fs.writeFileSync(filePath, 'Nothing useful here');

      const c = makeCriterion('file_contains', { path: filePath, pattern: 'revenue' });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
    });

    it('fails gracefully when file does not exist', async () => {
      const c = makeCriterion('file_contains', {
        path: path.join(tmpDir, 'no_such_file.txt'),
        pattern: 'anything',
      });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // output_matches
  // ──────────────────────────────────────────────────────────────
  describe('output_matches criterion', () => {
    it('passes when command output contains expected string', async () => {
      const c = makeCriterion('output_matches', {
        command: 'echo hello_world_test',
        expected: 'hello_world_test',
      });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(true);
    });

    it('fails when output does not match', async () => {
      const c = makeCriterion('output_matches', {
        command: 'echo something_else',
        expected: 'expected_string_not_present',
      });
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // unknown type
  // ──────────────────────────────────────────────────────────────
  describe('unknown criterion type', () => {
    it('returns passed: false with descriptive message', async () => {
      const c = makeCriterion('totally_unknown_type', {});
      const result = await validator.validateCriterion(c);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('totally_unknown_type');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // validateGoal — aggregate
  // ──────────────────────────────────────────────────────────────
  describe('validateGoal', () => {
    it('returns complete=true when all required criteria pass', async () => {
      const filePath = path.join(tmpDir, 'output.txt');
      fs.writeFileSync(filePath, 'done');

      const goal = {
        id: 'g1',
        description: 'test',
        success_criteria: [
          makeCriterion('file_exists', { path: filePath }),
        ],
        estimated_complexity: 1,
        required_tools: [],
        expected_files: [],
        context: '',
        type: 'file',
      } as any;

      const result = await validator.validateGoal(goal);
      expect(result.complete).toBe(true);
      expect(result.passed.length).toBe(1);
      expect(result.failed.length).toBe(0);
      expect(result.score).toBe(100);
    });

    it('returns complete=false when a required criterion fails', async () => {
      const goal = {
        id: 'g2',
        description: 'test',
        success_criteria: [
          makeCriterion('file_exists', { path: path.join(tmpDir, 'missing_output.txt') }),
        ],
        estimated_complexity: 1,
        required_tools: [],
        expected_files: [],
        context: '',
        type: 'file',
      } as any;

      const result = await validator.validateGoal(goal);
      expect(result.complete).toBe(false);
      expect(result.score).toBe(0);
    });
  });
});
