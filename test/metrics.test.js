// 메트릭 → 시각 파라미터 매핑 경계 계약(§2·§45·§62). 순수 변환이라 단위 테스트가 잘 맞는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forestCellParams, logNorm, REF, STAGE } from '../public/js/metrics.js';

test('logNorm: 0/음수 클램프, ref 에서 1', () => {
  assert.equal(logNorm(0, REF.input), 0);
  assert.equal(logNorm(-5, REF.input), 0);
  assert.equal(logNorm(REF.input, REF.input), 1);
});

test('forestCellParams: 서버 tree(stage/species) 그대로, 음수 방어', () => {
  const day = {
    date: '2026-01-22',
    active: true,
    grid: { gx: 5, gy: 5 },
    usage: { inputTokens: 50000, outputTokens: 20000, cacheWriteTokens: 0, cacheReadTokens: 120_500_000, requestCount: 100 },
    tree: { stage: 'young', stageProgress: 0.4, species: 2, seed: '2026-01-22', xp: 1000 },
  };
  const refMax = { input: 300000, output: 120000, cacheWrite: 800000, cacheRead: 400_000_000, requestCount: 400 };
  const p = forestCellParams(day, 5000, refMax);

  assert.equal(p.stage, STAGE.YOUNG); // 서버 문자열 → 숫자
  assert.equal(p.species, 2); // 서버 데이터값 그대로(폴백 아님)
  assert.equal(p.raw.cacheRead, 120_500_000); // raw 보존
  // §62: 상세 표시 선형 비중 = raw/refMax 클램프.
  assert.ok(Math.abs(p.linPct.cacheReadN - 120_500_000 / 400_000_000) < 1e-9);
  // logNorm 은 큰 값을 위로 몰아 선형보다 큼(§62 가 풀려던 오해).
  assert.ok(p.norms.cacheReadN > p.linPct.cacheReadN);
});

test('forestCellParams: linPct 1.0 클램프 + species 폴백 null', () => {
  const day = {
    date: '2026-02-01',
    usage: { cacheReadTokens: 600_000_000 },
    tree: { stage: 'mature', stageProgress: 1.2 }, // species 없음
  };
  const refMax = { cacheRead: 400_000_000 };
  const p = forestCellParams(day, 5000, refMax);
  assert.equal(p.linPct.cacheReadN, 1); // raw>refMax → 1 클램프
  assert.equal(p.species, null); // 서버 미제공 → null(renderer 가 speciesFor 폴백)
  assert.equal(p.stageProgress, 1); // 0~1 클램프
});

test('forestCellParams: refMax 없으면 상수 REF 폴백', () => {
  const day = { date: '2026-03-01', usage: { inputTokens: REF.input }, tree: {} };
  const p = forestCellParams(day, 0, null);
  assert.equal(p.norms.inputN, 1); // REF.input 에서 logNorm=1
});
