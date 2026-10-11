import { describe, expect, it } from 'vitest';
import {
  clampVideoEditSeconds,
  hasVideoEditWrapper,
  wrapVideoEditPrompt
} from './higgsfield-prompt.js';

describe('wrapVideoEditPrompt', () => {
  it('states the requested length everywhere it appears, not a fixed one', () => {
    const wrapped = wrapVideoEditPrompt({ prompt: '一只猫在玩泥巴', seconds: 8, aspectRatio: '9:16' });

    expect(wrapped).toContain('exactly 8.0 seconds');
    expect(wrapped).toContain('shorter than 8 seconds');
    expect(wrapped).toContain('from 0 seconds through 8 seconds');
    expect(wrapped).toContain('approximately 8 seconds');
    expect(wrapped).toContain('Video duration requirement: 8s; aspect ratio: 9:16.');
    expect(wrapped).not.toContain('30');
  });

  it('keeps the caller prompt verbatim, between the two blocks', () => {
    const prompt = 'A cat plays with slime.\n第二行也要原样带上。';
    const wrapped = wrapVideoEditPrompt({ prompt, seconds: 10 });

    expect(wrapped).toContain(`[Customer's Original Prompt]\n${prompt}\n[Final Acceptance Criteria]`);
  });

  it('leaves the aspect ratio out when the job did not ask for one', () => {
    const wrapped = wrapVideoEditPrompt({ prompt: 'hi', seconds: 5 });
    expect(wrapped).toContain('Video duration requirement: 5s.');
    expect(wrapped).not.toContain('aspect ratio');
  });

  it('clamps to what the model accepts rather than sending a length it will refuse', () => {
    expect(clampVideoEditSeconds(2)).toBe(4);
    expect(clampVideoEditSeconds(45)).toBe(30);
    expect(clampVideoEditSeconds(7.4)).toBe(7);
    expect(clampVideoEditSeconds(Number.NaN)).toBe(4);
    expect(wrapVideoEditPrompt({ prompt: 'hi', seconds: 120 })).toContain('exactly 30.0 seconds');
  });
});

describe('hasVideoEditWrapper', () => {
  it('recognises a prompt a caller wrapped themselves, so it is not wrapped twice', () => {
    expect(hasVideoEditWrapper(wrapVideoEditPrompt({ prompt: 'hi', seconds: 6 }))).toBe(true);
    expect(hasVideoEditWrapper('just a prompt')).toBe(false);
  });
});
