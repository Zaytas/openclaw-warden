import { describe, it, expect } from 'vitest';
import { isSubagentContext, normalizePathFromParams, commandFromParams, resultToText, matchesAnyPattern } from '../src/utils.js';
import path from 'node:path';

describe('isSubagentContext', () => {
  it('detects isSubagent: true', () => {
    expect(isSubagentContext({ isSubagent: true })).toBe(true);
  });

  it('detects parentSessionKey', () => {
    expect(isSubagentContext({ parentSessionKey: 'parent-123' })).toBe(true);
  });

  it('detects session.parentKey', () => {
    expect(isSubagentContext({ session: { parentKey: 'parent' } })).toBe(true);
  });

  it('detects "subagent" in sessionId', () => {
    expect(isSubagentContext({ sessionId: 'agent:main:subagent:abc123' })).toBe(true);
  });

  it('detects "subagent" in session.id', () => {
    expect(isSubagentContext({ session: { id: 'main-subagent-task-1' } })).toBe(true);
  });

  it('returns false for normal contexts', () => {
    expect(isSubagentContext({ sessionId: 'agent:main:main' })).toBe(false);
    expect(isSubagentContext({})).toBe(false);
    expect(isSubagentContext({ session: { id: 'agent:main:main' } })).toBe(false);
  });
});

describe('normalizePathFromParams', () => {
  it('resolves file_path', () => {
    const result = normalizePathFromParams({ file_path: 'src/index.ts' });
    expect(result).toBe(path.resolve('src/index.ts'));
  });

  it('resolves path parameter', () => {
    const result = normalizePathFromParams({ path: '/absolute/path.ts' });
    expect(result).toBe('/absolute/path.ts');
  });

  it('resolves filePath parameter', () => {
    const result = normalizePathFromParams({ filePath: 'relative/file.ts' });
    expect(result).toBe(path.resolve('relative/file.ts'));
  });

  it('returns undefined when no path parameter', () => {
    expect(normalizePathFromParams({ command: 'ls' })).toBeUndefined();
    expect(normalizePathFromParams({})).toBeUndefined();
  });

  it('prefers file_path over path', () => {
    const result = normalizePathFromParams({ file_path: '/a.ts', path: '/b.ts' });
    expect(result).toBe('/a.ts');
  });
});

describe('commandFromParams', () => {
  it('extracts command parameter', () => {
    expect(commandFromParams({ command: 'ls -la' })).toBe('ls -la');
  });

  it('extracts cmd parameter', () => {
    expect(commandFromParams({ cmd: 'npm test' })).toBe('npm test');
  });

  it('returns undefined when no command parameter', () => {
    expect(commandFromParams({ file_path: '/a.ts' })).toBeUndefined();
    expect(commandFromParams({})).toBeUndefined();
  });
});

describe('resultToText', () => {
  it('handles string result', () => {
    expect(resultToText('hello')).toBe('hello');
  });

  it('handles null/undefined', () => {
    expect(resultToText(null)).toBe('');
    expect(resultToText(undefined)).toBe('');
  });

  it('includes matched string keys and JSON in output', () => {
    // The real implementation collects all matching string keys + full JSON
    const result = resultToText({ output: 'from output' });
    expect(result).toContain('from output');
    expect(result).toContain('{"output":"from output"}');
  });

  it('handles object with stdout', () => {
    const result = resultToText({ stdout: 'from stdout' });
    expect(result).toContain('from stdout');
    expect(result).toContain('"stdout"');
  });

  it('handles object with text', () => {
    const result = resultToText({ text: 'from text' });
    expect(result).toContain('from text');
  });

  it('handles object with content', () => {
    const result = resultToText({ content: 'from content' });
    expect(result).toContain('from content');
  });

  it('handles object with body', () => {
    const result = resultToText({ body: 'from body' });
    expect(result).toContain('from body');
  });

  it('includes multiple matched keys separated by newlines', () => {
    const result = resultToText({ output: 'out1', stdout: 'out2' });
    expect(result).toContain('out1');
    expect(result).toContain('out2');
    // Parts are joined by newlines
    expect(result.split('\n').length).toBeGreaterThanOrEqual(3); // out1, out2, JSON
  });

  it('JSON-serializes objects without known string keys', () => {
    const result = resultToText({ foo: 'bar', baz: 123 });
    // No known keys match, but JSON is always appended
    expect(result).toContain('{"foo":"bar","baz":123}');
  });

  it('handles numbers', () => {
    expect(resultToText(42)).toBe('42');
  });

  it('handles booleans', () => {
    expect(resultToText(true)).toBe('true');
  });
});

describe('matchesAnyPattern', () => {
  it('matches case-insensitively', () => {
    expect(matchesAnyPattern('Service Is Running', ['service is running'])).toBe(true);
    expect(matchesAnyPattern('service is running', ['Service Is Running'])).toBe(true);
  });

  it('matches substring', () => {
    expect(matchesAnyPattern('the service is running now', ['service is running'])).toBe(true);
  });

  it('returns false when no patterns match', () => {
    expect(matchesAnyPattern('some text', ['other', 'stuff'])).toBe(false);
  });

  it('returns false with empty patterns', () => {
    expect(matchesAnyPattern('anything', [])).toBe(false);
  });

  it('matches any one of multiple patterns', () => {
    expect(matchesAnyPattern('is healthy', ['running', 'healthy', 'ready'])).toBe(true);
  });
});
