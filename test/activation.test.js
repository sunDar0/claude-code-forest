// 활성화/차단 순수 함수 회귀 가드(§18-9·§47·§50·§55). 배치 규칙이 조용히 바뀌면 여기서 잡힌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isColdStart,
  closedMonths,
  blockedSet,
  candidateSlots,
  isAcceptableSlot,
  oldestPendingDate,
  hasPending,
  todayYMD,
} from '../public/js/activation.js';

test('isColdStart: 점유 0개면 콜드', () => {
  assert.equal(isColdStart({}), true);
  assert.equal(isColdStart({ '2026-06-01': { gx: 3, gy: 3 } }), false);
});

test('closedMonths: 태그 파싱', () => {
  assert.deepEqual([...closedMonths('closed:2026-05')], ['2026-05']);
  assert.deepEqual([...closedMonths('closed:2026-05,2026-06')], ['2026-05', '2026-06']);
  assert.deepEqual([...closedMonths('closed:')], []); // 달 없음(회청 폴백)
  assert.equal(closedMonths('whatever'), null); // 닫힘 아님
});

test('blockedSet: 4방향 둘러싸인 빈칸 = 닫힘(둘러싼 달 태그)', () => {
  // (5,5)의 상하좌우를 2026-05 로 채우면 (5,5)는 갇힘(대각은 트인 걸로 침).
  const placement = {
    '2026-05-01': { gx: 4, gy: 5 },
    '2026-05-02': { gx: 6, gy: 5 },
    '2026-05-03': { gx: 5, gy: 4 },
    '2026-05-04': { gx: 5, gy: 6 },
  };
  const blocked = blockedSet(placement);
  assert.equal(blocked.get('5,5'), 'closed:2026-05');
  assert.equal(blocked.has('3,5'), false); // 트인 칸은 차단 아님
});

test('candidateSlots: 앵커 8방향 빈칸(맵 범위 안)', () => {
  const placement = { '2026-06-01': { gx: 10, gy: 10 } };
  const slots = candidateSlots(placement, '2026-06-01', new Map(), '2026-06', { gx: 10, gy: 10 });
  assert.equal(slots.length, 8);
  assert.ok(slots.some((s) => s.gx === 9 && s.gy === 9));
  assert.ok(slots.some((s) => s.gx === 11 && s.gy === 11));
});

test('candidateSlots: 콜드 스타트는 빈 배열(자유 선택)', () => {
  assert.deepEqual(candidateSlots({}, '2026-06-01', new Map(), '2026-06', null), []);
});

test('isAcceptableSlot: 콜드는 범위 안 자유 / 점유 시 후보만', () => {
  assert.equal(isAcceptableSlot({}, [], 20, 20, new Map(), '2026-06'), true); // 콜드 자유
  assert.equal(isAcceptableSlot({}, [], -1, 20, new Map(), '2026-06'), false); // 범위 밖
  const placement = { '2026-06-01': { gx: 10, gy: 10 } };
  const cands = [{ gx: 11, gy: 10 }];
  assert.equal(isAcceptableSlot(placement, cands, 11, 10, new Map(), '2026-06'), true);
  assert.equal(isAcceptableSlot(placement, cands, 15, 15, new Map(), '2026-06'), false); // 비후보
});

test('oldestPendingDate / hasPending: 시작일=오늘 기준', () => {
  const today = todayYMD();
  assert.equal(oldestPendingDate({}, today, [today]), today); // 오늘 미배치 → 오늘
  assert.equal(hasPending({}, today, [today]), true);
  const placed = { [today]: { gx: 1, gy: 1 } };
  assert.equal(oldestPendingDate(placed, today, [today]), null); // 다 심음
  assert.equal(hasPending(placed, today, [today]), false);
});
