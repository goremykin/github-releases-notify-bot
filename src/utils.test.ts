import { describe, it, expect } from 'vitest';
import { truncateMessage, getReleaseMessages, TRUNCATED_SUFFIX } from './utils.ts';

describe('truncateMessage', () => {
  it('returns message unchanged when within limit', () => {
    const msg = 'Hello world';
    expect(truncateMessage(msg, 100)).toBe(msg);
  });

  it('returns message unchanged when exactly at limit', () => {
    const msg = 'A'.repeat(100);
    expect(truncateMessage(msg, 100)).toBe(msg);
  });

  it('result length never exceeds maxLength', () => {
    const msg = 'word '.repeat(1000);
    const result = truncateMessage(msg, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('cuts at last safe newline before limit', () => {
    // Build a message where the last newline before limit is easy to find
    const line1 = 'First line';
    const line2 = 'Second line';
    const filler = 'X'.repeat(200);
    const msg = `${line1}\n${line2}\n${filler}`;
    const result = truncateMessage(msg, 60);
    expect(result).toContain(TRUNCATED_SUFFIX);
    expect(result.startsWith(line1)).toBe(true);
  });

  it('accounts for suffix length — total does not exceed maxLength', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line number ${i}`).join('\n');
    const maxLength = 200;
    const result = truncateMessage(lines, maxLength);
    expect(result.length).toBeLessThanOrEqual(maxLength);
  });

  it('does not cut inside a code block', () => {
    const before = 'Normal text\n';
    const codeBlock = '```\nsome code\nmore code\neven more code lines here\n```\n';
    const after = 'After code\n'.repeat(20);
    const msg = before + codeBlock + after;

    // Set maxLength so it would fall inside the code block if not handled
    const cutInsideCode = before.length + codeBlock.length / 2;
    const result = truncateMessage(msg, Math.floor(cutInsideCode) + TRUNCATED_SUFFIX.length + 5);

    // The cut should not land between ``` markers
    const withoutSuffix = result.slice(0, result.length - TRUNCATED_SUFFIX.length);
    const openCount = (withoutSuffix.match(/```/g) ?? []).length;
    expect(openCount % 2).toBe(0);
  });

  it('falls back to hard cut when no newline found', () => {
    const msg = 'A'.repeat(200);
    const maxLength = 50;
    const result = truncateMessage(msg, maxLength);
    expect(result.length).toBeLessThanOrEqual(maxLength);
    expect(result.endsWith(TRUNCATED_SUFFIX)).toBe(true);
  });
});

describe('getReleaseMessages', () => {
  const repo = { owner: 'octocat', name: 'hello-world' };

  it('short message contains repo name in bold', () => {
    const { short } = getReleaseMessages(repo, { name: 'v1.0.0' });
    expect(short).toContain('<b>octocat/hello-world</b>');
    expect(short).toContain('v1.0.0');
  });

  it('short message marks pre-release', () => {
    const { short } = getReleaseMessages(repo, { name: 'v2.0.0-beta', isPrerelease: true });
    expect(short).toContain('<b>Pre-release</b>');
  });

  it('full message is MarkdownV2 — repo name is bold with escaped dash', () => {
    const { full } = getReleaseMessages(repo, { name: 'v1.0.0', url: 'https://github.com/octocat/hello-world/releases/tag/v1.0.0' });
    // hello-world: dash is escaped as \- in MarkdownV2
    expect(full).toContain('*octocat/hello\\-world*');
  });

  it('full message escapes special MarkdownV2 chars in plain-text description', () => {
    const { full } = getReleaseMessages(repo, {
      name: 'v1.0.0',
      url: 'https://github.com/octocat/hello-world/releases/tag/v1.0.0',
      description: 'Fix issue #42. Use pkg-name (experimental).',
    });
    // Dots, dashes, parens in plain text must be escaped.
    // URL parts inside []() are exempt — check only the description portion.
    const descPart = full.split('\n').slice(2).join('\n');
    expect(descPart).not.toMatch(/(?<!\\)\./);
    expect(descPart).not.toMatch(/(?<!\\)-/);
    expect(descPart).not.toMatch(/(?<!\\)\(/);
    expect(descPart).not.toMatch(/(?<!\\)\)/);
  });

  it('full message preserves code blocks', () => {
    const { full } = getReleaseMessages(repo, {
      name: 'v1.0.0',
      url: 'https://github.com/octocat/hello-world/releases/tag/v1.0.0',
      description: '```bash\necho hello\n```',
    });
    expect(full).toContain('```');
    expect(full).toContain('echo hello');
  });

  it('full message is within 4096 chars for very long description', () => {
    const { full } = getReleaseMessages(repo, {
      name: 'v1.0.0',
      url: 'https://github.com/octocat/hello-world/releases/tag/v1.0.0',
      description: 'Line of text.\n'.repeat(500),
    });
    expect(full.length).toBeLessThanOrEqual(4096);
  });

  it('handles empty description gracefully', () => {
    expect(() => getReleaseMessages(repo, { name: 'v1.0.0', url: 'https://example.com', description: '' })).not.toThrow();
  });

  it('handles missing url gracefully', () => {
    expect(() => getReleaseMessages(repo, { name: 'v1.0.0' })).not.toThrow();
  });
});
