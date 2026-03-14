/**
 * Path normalization tests — validates that relative paths fed to MCP file tools
 * are correctly prefixed with the workspace root before being dispatched.
 *
 * Uses path.normalize() on both sides so tests pass on Windows (backslash) and
 * Linux/macOS (forward slash) equally.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';

// ── Inline the normalization logic (mirrors ReActReasoner.executeAction) ──
const FILE_TOOLS = new Set([
  'read_file', 'write_file', 'create_directory', 'list_directory',
  'move_file', 'copy_file', 'delete_file', 'edit_file',
  'search_files', 'get_file_info',
]);

function normalizePath(p: string, workspaceRoot: string): string {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  return path.join(workspaceRoot, p);
}

function normalizeFileToolArgs(
  tool: string,
  args: Record<string, any>,
  workspaceRoot: string
): Record<string, any> {
  if (!FILE_TOOLS.has(tool)) return args;
  const normalized = { ...args };
  if (normalized.path) normalized.path = normalizePath(normalized.path, workspaceRoot);
  if (normalized.source) normalized.source = normalizePath(normalized.source, workspaceRoot);
  if (normalized.destination) normalized.destination = normalizePath(normalized.destination, workspaceRoot);
  return normalized;
}

// Helpers for platform-safe path comparison
const WS = path.normalize('/workspace');

function p(...parts: string[]): string {
  return path.join(WS, ...parts);
}

describe('Path normalization for MCP file tools', () => {
  it('prefixes a relative path with workspace root', () => {
    const args = normalizeFileToolArgs('write_file', { path: 'output/result.txt', content: 'x' }, WS);
    expect(path.normalize(args.path)).toBe(p('output', 'result.txt'));
    expect(args.content).toBe('x'); // non-path args unchanged
  });

  it('leaves an absolute path unchanged', () => {
    const absPath = path.join(WS, 'output', 'result.txt');
    const args = normalizeFileToolArgs('write_file', { path: absPath }, WS);
    expect(path.normalize(args.path)).toBe(absPath);
  });

  it('normalizes source and destination for move_file', () => {
    const args = normalizeFileToolArgs('move_file', {
      source: 'old/file.txt',
      destination: 'new/file.txt',
    }, WS);
    expect(path.normalize(args.source)).toBe(p('old', 'file.txt'));
    expect(path.normalize(args.destination)).toBe(p('new', 'file.txt'));
  });

  it('does NOT normalize args for non-file tools', () => {
    const original = { command: 'node script.js', cwd: '.' };
    const args = normalizeFileToolArgs('run_command', original, WS);
    expect(args.command).toBe('node script.js'); // untouched
    expect(args.cwd).toBe('.');                  // untouched
  });

  it('handles a path with nested subdirectories', () => {
    const args = normalizeFileToolArgs('read_file', { path: 'subdir/nested/file.txt' }, WS);
    expect(path.normalize(args.path)).toBe(p('subdir', 'nested', 'file.txt'));
  });

  it('handles empty path gracefully (returns empty string)', () => {
    const args = normalizeFileToolArgs('write_file', { path: '', content: 'x' }, WS);
    expect(args.path).toBe('');
  });

  it('normalizes list_directory path to workspace root for "."', () => {
    const args = normalizeFileToolArgs('list_directory', { path: '.' }, WS);
    expect(path.normalize(args.path)).toBe(path.normalize(WS));
  });

  it('normalizes create_directory path', () => {
    const args = normalizeFileToolArgs('create_directory', { path: 'output/reports' }, WS);
    expect(path.normalize(args.path)).toBe(p('output', 'reports'));
  });
});
