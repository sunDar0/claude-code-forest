// 자동 숲묶기 규칙 가드. `isPastMonth` 가 "현재월 이전 달 = 묶기 대상" 규칙을
// 한 곳에 고정한다. 서버(store)·목(mock)·콜드(cold-source) 가 이 술어로 통일됐으므로,
// 누군가 비교 방향을 뒤집거나 경계를 흐리면 여기서 잡힌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPastMonth } from '../public/js/bundle-rule.js';

test('과거월은 묶기 대상(true)', () => {
  assert.equal(isPastMonth('2026-05', '2026-06'), true);
  assert.equal(isPastMonth('2026-01', '2026-06'), true);
  assert.equal(isPastMonth('2020-12', '2026-06'), true);
});

test('현재월은 묶지 않음(false)', () => {
  assert.equal(isPastMonth('2026-06', '2026-06'), false);
});

test('미래월은 묶지 않음(false)', () => {
  assert.equal(isPastMonth('2026-07', '2026-06'), false);
  assert.equal(isPastMonth('2027-01', '2026-06'), false);
});

test('연 경계: 2025-12 는 2026-01 의 과거(true), 2026-01 은 2025-12 의 미래(false)', () => {
  assert.equal(isPastMonth('2025-12', '2026-01'), true);
  assert.equal(isPastMonth('2026-01', '2025-12'), false);
});

test('YYYY-MM 사전식 비교 = 시간순(0-pad 월 경계)', () => {
  // 9월 < 10월 (사전식이 9 > 1 로 뒤집히지 않음 — zero-pad 덕분).
  assert.equal(isPastMonth('2026-09', '2026-10'), true);
  assert.equal(isPastMonth('2026-10', '2026-09'), false);
});
