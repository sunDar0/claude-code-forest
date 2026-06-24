// 메트릭 → 시각 파라미터 매핑 경계 계약(§2·§45·§62). 순수 변환이라 단위 테스트가 잘 맞는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forestCellParams, logNorm, REF, STAGE, pickDistribution, metricAverages, compareToAvg, avgBadge } from '../public/js/metrics.js';

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

// ===== 작업 4(재설계): 상세 모달 메트릭별 평균 대비 ▲▼ 표식 =====

// cellList 원소는 forestCellParams 결과({params:{raw,stage}}) 또는 {raw,stage} 둘 다 받게 한다.
const cell = (stage, raw) => ({ params: { stage, raw } });

test('metricAverages: 활성일만 산술평균, EMPTY·totalTokens0 은 모수 제외', () => {
  const list = [
    cell(STAGE.MATURE, { input: 100, output: 50, cacheWrite: 10, cacheRead: 1000, requests: 20 }),
    cell(STAGE.YOUNG, { input: 300, output: 150, cacheWrite: 30, cacheRead: 3000, requests: 40 }),
    cell(STAGE.EMPTY, { input: 9999, output: 9999, cacheWrite: 9999, cacheRead: 9999, requests: 9999 }), // 빈 대지 제외
    cell(STAGE.SAPLING, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0 }), // 토큰 0 → 제외
  ];
  const avg = metricAverages(list);
  assert.equal(avg.count, 2); // 활성·사용 있는 날 2개만
  assert.equal(avg.input, 200); // (100+300)/2 — EMPTY/0 의 9999·0 영향 없음
  assert.equal(avg.output, 100);
  assert.equal(avg.cacheWrite, 20);
  assert.equal(avg.cacheRead, 2000);
  assert.equal(avg.requests, 30);
});

test('metricAverages: 빈 배열·null 은 count 0 + 전부 0', () => {
  for (const v of [[], null, undefined]) {
    const avg = metricAverages(v);
    assert.equal(avg.count, 0);
    assert.equal(avg.input, 0);
    assert.equal(avg.cacheRead, 0);
  }
});

test('compareToAvg: value>avg → up, <avg → down, 같음/모수없음 → eq', () => {
  assert.equal(compareToAvg(300, 200), 'up');
  assert.equal(compareToAvg(100, 200), 'down');
  assert.equal(compareToAvg(200, 200), 'eq');
  assert.equal(compareToAvg(100, 0), 'eq'); // 평균 0(모수 없음) → 표식 미표시
  assert.equal(compareToAvg(NaN, 200), 'down'); // NaN → 0 클램프 → 0<200
  assert.equal(compareToAvg(50, NaN), 'eq'); // avg NaN → 0 → eq
});

test('평균 대비는 메트릭마다 갈린다(cacheRead 압도 무관): 같은 날도 ▲·▼ 공존', () => {
  // 두 활성일. 1일차는 input 큼·cacheRead 작음, 2일차는 반대. 각자 다른 메트릭에서 위/아래로 갈린다.
  const d1 = { input: 400, output: 50, cacheWrite: 10, cacheRead: 1000, requests: 80 };
  const d2 = { input: 100, output: 250, cacheWrite: 90, cacheRead: 9000, requests: 20 };
  const avg = metricAverages([cell(STAGE.MATURE, d1), cell(STAGE.MATURE, d2)]);
  // 평균: input 250, output 150, cacheRead 5000, requests 50.
  assert.equal(compareToAvg(d1.input, avg.input), 'up'); // 400>250
  assert.equal(compareToAvg(d1.cacheRead, avg.cacheRead), 'down'); // 1000<5000 — cacheRead 가 절대 크다고 늘 ▲ 가 아님
  assert.equal(compareToAvg(d2.input, avg.input), 'down'); // 100<250
  assert.equal(compareToAvg(d2.cacheRead, avg.cacheRead), 'up'); // 9000>5000
});

// ===== 침엽수 뱃지: 평균 대비 방향 + 정도(삼각형 1~3개) =====

test('avgBadge: 상승률 경계 32%→1, 33%→2, 65%→2, 66%→3 (avg=100)', () => {
  // 상승률 = (val-100)/100. 33%/66% 경계는 미만/이상.
  assert.deepEqual(avgBadge(132, 100), { dir: 'up', level: 1 }); // 0.32 < 0.33
  assert.deepEqual(avgBadge(133, 100), { dir: 'up', level: 2 }); // 0.33 → 2
  assert.deepEqual(avgBadge(165, 100), { dir: 'up', level: 2 }); // 0.65 < 0.66
  assert.deepEqual(avgBadge(166, 100), { dir: 'up', level: 3 }); // 0.66 → 3
});

test('avgBadge: 하락률 경계 동일(32%→1, 33%→2, 65%→2, 66%→3, avg=100)', () => {
  // 하락률 = (100-val)/100. 상승과 같은 33%/66% 경계.
  assert.deepEqual(avgBadge(68, 100), { dir: 'down', level: 1 }); // 0.32 < 0.33
  assert.deepEqual(avgBadge(67, 100), { dir: 'down', level: 2 }); // 0.33 → 2
  assert.deepEqual(avgBadge(35, 100), { dir: 'down', level: 2 }); // 0.65 < 0.66
  assert.deepEqual(avgBadge(34, 100), { dir: 'down', level: 3 }); // 0.66 → 3
});

test('avgBadge: 방향 — 위=up, 아래=down, 같음/모수없음=eq(level 0)', () => {
  assert.equal(avgBadge(150, 100).dir, 'up');
  assert.equal(avgBadge(50, 100).dir, 'down');
  assert.deepEqual(avgBadge(100, 100), { dir: 'eq', level: 0 }); // 같음 → 뱃지 없음
  assert.deepEqual(avgBadge(50, 0), { dir: 'eq', level: 0 }); // 모수 없음 → 뱃지 없음
});

test('avgBadge: 0/음수/NaN 값 방어(avg>0 면 0 으로 클램프되어 down)', () => {
  assert.deepEqual(avgBadge(0, 100), { dir: 'down', level: 3 }); // 하락률 100% → 3
  assert.deepEqual(avgBadge(-5, 100), { dir: 'down', level: 3 });
  assert.deepEqual(avgBadge(NaN, 100), { dir: 'down', level: 3 });
});

test('pickDistribution: 경계값 — readRatio>12 weeping, outRatio 경계 spreading/upward/uniform', () => {
  // readRatio = cacheRead/input. input=1000 기준 12배 초과면 weeping.
  assert.equal(pickDistribution({ inputTokens: 1000, cacheReadTokens: 12_001 }), 'weeping');
  // readRatio 정확히 12 는 weeping 아님(>12 만). outRatio 로 넘어감.
  assert.equal(pickDistribution({ inputTokens: 1000, cacheReadTokens: 12_000, outputTokens: 100 }), 'upward');
  // outRatio>0.6 → spreading (read 비율 낮게 유지).
  assert.equal(pickDistribution({ inputTokens: 1000, outputTokens: 700, cacheReadTokens: 0 }), 'spreading');
  // outRatio<0.25 → upward.
  assert.equal(pickDistribution({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 }), 'upward');
  // 균형(0.25~0.6, read 낮음) → uniform.
  assert.equal(pickDistribution({ inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0 }), 'uniform');
});

test('작업 성격은 비율 기반(절대량 아님): cacheRead 가 절대 거대해도 input 도 크면 weeping 아님', () => {
  // cacheRead 1.2억(절대값으로 input·output 압도)이지만 input 도 2천만 → readRatio=6 (≤12) → weeping 아님.
  // output/input=0.5 라 균형 → uniform. 절대량 분류였다면 매일 weeping("캐시 많은 날")로 무의미해짐.
  const u = { inputTokens: 20_000_000, outputTokens: 10_000_000, cacheReadTokens: 120_000_000, cacheWriteTokens: 5_000_000, requestCount: 300 };
  assert.equal(pickDistribution(u), 'uniform');
  // forestCellParams 를 거쳐도 sim.distribution 이 같은 값(단일 소스 재사용).
  const p = forestCellParams({ date: '2026-04-01', usage: u, tree: { stage: 'mature' } }, 0, null);
  assert.equal(p.sim.distribution, 'uniform');
});

test('작업 성격 단일 소스: forestCellParams.sim.distribution = pickDistribution(usage)', () => {
  const u = { inputTokens: 1000, cacheReadTokens: 500_000 }; // readRatio=500 → weeping
  const p = forestCellParams({ date: '2026-05-01', usage: u, tree: { stage: 'young' } }, 0, null);
  assert.equal(p.sim.distribution, 'weeping');
  assert.equal(p.sim.distribution, pickDistribution(u)); // 재계산 없이 동일 결과
});
