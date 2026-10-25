import { describe, it, expect } from 'vitest';
import { agentAuthorName, modelLabel, isAgentAuthor } from '../packages/core/src/agentname.ts';

describe('how agents sign their changes', () => {
  it('names models as people say them', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5');
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(modelLabel('anthropic/claude-opus-4.5')).toBe('Opus 4.5');
    expect(modelLabel('gpt-5.5')).toBe('GPT-5.5');
    expect(modelLabel('gpt-5.1-codex-max')).toBe('GPT-5.1 Codex Max');
    expect(modelLabel('google/gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
    expect(modelLabel('Opus 5.5')).toBe('Opus 5.5');   // as the agent said it
  });

  it('"Claude (Opus 5.5) [Jan]"', () => {
    expect(agentAuthorName('Claude', 'claude-opus-5-5', 'Jan Bauer')).toBe('Claude (Opus 5.5) [Jan]');
    expect(agentAuthorName('Claude', 'Claude Opus 5.5', 'Jan')).toBe('Claude (Opus 5.5) [Jan]');
    expect(agentAuthorName('Codex', 'gpt-5.5', 'Ada')).toBe('Codex (GPT-5.5) [Ada]');
    expect(agentAuthorName('Claude', null, 'Jan')).toBe('Claude [Jan]');
    expect(agentAuthorName('Claude', 'Opus 5.5', '')).toBe('Claude (Opus 5.5)');
    // nothing that would break LaTeX, LyX's \author line or a comment header
    expect(agentAuthorName('Claude', 'Opus} \\x "5"', 'J{an}')).toBe('Claude (Opus x 5) [J an]');
  });

  it('tells agents from people', () => {
    expect(isAgentAuthor('Claude (Opus 5.5) [Jan]')).toBe(true);
    expect(isAgentAuthor('Codex [Ada]')).toBe(true);
    expect(isAgentAuthor('Agent panel (MCP)')).toBe(true);
    expect(isAgentAuthor('Jan Bauer')).toBe(false);
    expect(isAgentAuthor('Ada (UCL)')).toBe(false);
  });
});
