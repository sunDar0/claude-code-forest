// 시드·수종 단일 소스 회귀 가드. 서버(aggregate)와 클라(seed) speciesFor 가 **비트 단위로 같아야**
// 동결된 과거 수종이 갈리지 않는다(§45-7). 둘이 갈라지면 여기서 잡힌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { speciesFor, hash32, SPECIES_COUNT, ymd } from '../public/js/seed.js';
import { speciesFor as serverSpeciesFor } from '../server/aggregate.js';

test('hash32 결정적 + 알려진 값', () => {
  assert.equal(hash32(''), 2166136261); // FNV-1a offset basis(빈 문자열)
  assert.equal(hash32(42), 42); // 숫자는 그대로 통과
  assert.equal(hash32('2026-06-15'), hash32('2026-06-15')); // 결정적
});

test('speciesFor 는 0..4 범위 + 결정적', () => {
  for (let i = 0; i < 500; i++) {
    const s = speciesFor('2026-06-' + i);
    assert.ok(Number.isInteger(s) && s >= 0 && s < SPECIES_COUNT, `범위 밖: ${s}`);
  }
  assert.equal(speciesFor('seed-x'), speciesFor('seed-x'));
});

test('GOLDEN: 서버 speciesFor === 클라 speciesFor (수종 동결 정합)', () => {
  for (let i = 0; i < 1000; i++) {
    const seed = '2025-' + ((i % 12) + 1) + '-' + (i % 28) + '#' + i;
    assert.equal(serverSpeciesFor(seed), speciesFor(seed), `seed=${seed} 에서 서버↔클라 수종 불일치`);
  }
});

test('수종 분포: 큰 표본에서 5종 모두 등장', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(speciesFor('d' + i));
  assert.equal(seen.size, SPECIES_COUNT);
});

test('ymd 로컬일 변환', () => {
  // 월/일 zero-pad. 로컬 자정 기준(UTC 아님).
  assert.equal(ymd(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(ymd(new Date(2026, 11, 31)), '2026-12-31');
});
