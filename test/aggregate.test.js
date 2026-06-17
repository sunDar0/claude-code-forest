// 서버 나무 산식 경계 계약(§13-2·§13-3·§45-7). computeTree 단계 경계와 수종 정합.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeTree, speciesFor, REFMAX_SEED } from '../server/aggregate.js';

test('computeTree: 사용량 0 → empty(빈 땅)', () => {
  const t = computeTree({ totalTokens: 0 }, 1000, '2026-06-15');
  assert.equal(t.stage, 'empty');
  assert.equal(t.xp, 0);
  assert.ok(t.species >= 0 && t.species < 5); // 빈 땅도 수종 시드는 박는다
});

test('computeTree: pct 단계 경계 (sapling/young/mature)', () => {
  const cap = 1000;
  assert.equal(computeTree({ totalTokens: 100 }, cap, 's').stage, 'sapling'); // 0.10 <0.20
  assert.equal(computeTree({ totalTokens: 300 }, cap, 's').stage, 'young');   // 0.30 ∈[0.20,0.50)
  assert.equal(computeTree({ totalTokens: 700 }, cap, 's').stage, 'mature');  // 0.70 ≥0.50
});

test('computeTree: cap 미정인데 사용 있음 → 최소 묘목', () => {
  const t = computeTree({ totalTokens: 500 }, 0, 's');
  assert.equal(t.stage, 'sapling');
  assert.equal(t.stageProgress, 0);
});

test('computeTree: stageProgress 0..1 클램프', () => {
  const t = computeTree({ totalTokens: 5000 }, 1000, 's'); // pct 5.0 (mature 상한 초과)
  assert.ok(t.stageProgress >= 0 && t.stageProgress <= 1);
});

test('computeTree: 수종 = speciesFor(seed) 와 일치', () => {
  const seed = '2026-06-15';
  assert.equal(computeTree({ totalTokens: 100 }, 1000, seed).species, speciesFor(seed));
});

test('REFMAX_SEED: 동결 + 5메트릭 키', () => {
  assert.ok(Object.isFrozen(REFMAX_SEED));
  assert.deepEqual(Object.keys(REFMAX_SEED).sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'requestCount']);
});
