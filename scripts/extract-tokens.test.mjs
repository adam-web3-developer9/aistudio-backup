import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTokens } from './extract-tokens.mjs';

const token =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJleHAiOjE3OTA5NTgyNTgsInVzZXIiOnsiaWQiOiI1NDc5Njk1MTk3NjE4MjU3OTYifX0.' +
  'IX0itElSyxAVE4MweIyBJE-Gl3U1_mfA8DxJWuu1hO0';

test('extracts, trims adjacent noise, and deduplicates HS256 JWTs', () => {
  const text = `前缀@@${token}中文噪声\n重复:${token}!!!`;
  assert.deepEqual(extractTokens(text), [token]);
});

test('ignores malformed JWT-shaped strings', () => {
  assert.deepEqual(
    extractTokens('eyJub3QiOiJqd3QifQ.eyJ2YWx1ZSI6MX0.invalid'),
    [],
  );
});
