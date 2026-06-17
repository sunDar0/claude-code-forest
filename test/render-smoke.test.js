// 헤드리스 렌더 스모크 — 그리기 명령 지문으로 렌더 회귀를 잡는다.
//
// 고정 입력(나무 3그루)을 스텁 캔버스로 렌더해, 발생한 모든 그리기 호출의 해시(지문)를 만든다.
// renderer.js 를 모듈로 분할하는 리팩토링이 그리기 동작을 바꾸지 않았다면 이 지문이 그대로 유지된다.
// 스프라이트 시트는 node 에서 로드되지 않아 절차 나무 아트 경로(_paintTreeBody·_drawCrownBlobs 등,
// 분할 대상)가 그대로 실행된다 — 정확히 보호하려는 코드다.
import { test } from "node:test";
import assert from "node:assert/strict";

import { installGlobals, resetOps, getOps, fingerprint } from "./helpers/stub-canvas.js";
import { forestCellParams } from "../public/js/metrics.js";

const REF_MAX = { input: 300000, output: 120000, cacheWrite: 800000, cacheRead: 5000000, requestCount: 400 };
const CAP = 5000000;

// 고정 픽스처. 서버 §18-3 day 스키마.
//   ① 단계별 나무 3그루(성목·묘목·유목) — 나무 그리기 경로.
//   ② 빈 땅(활성 EMPTY) 한 묶음 — 풀·식생·나비·바위(절차 폴백) 그리기 경로를 덮는다.
const TREES = [
  { date: "2026-06-10", active: true, grid: { gx: 10, gy: 10 }, finalized: true,
    usage: { inputTokens: 50000, outputTokens: 20000, cacheWriteTokens: 100000, cacheReadTokens: 2000000, requestCount: 120 },
    tree: { stage: "mature", xp: 3000000, stageProgress: 0.5, seed: "2026-06-10", species: 0 } },
  { date: "2026-06-11", active: true, grid: { gx: 11, gy: 10 }, finalized: false,
    usage: { inputTokens: 8000, outputTokens: 3000, cacheWriteTokens: 5000, cacheReadTokens: 50000, requestCount: 20 },
    tree: { stage: "sapling", xp: 66000, stageProgress: 0.3, seed: "2026-06-11", species: 2 } },
  { date: "2026-06-12", active: true, grid: { gx: 10, gy: 11 }, finalized: false,
    usage: { inputTokens: 30000, outputTokens: 15000, cacheWriteTokens: 40000, cacheReadTokens: 500000, requestCount: 60 },
    tree: { stage: "young", xp: 585000, stageProgress: 0.4, seed: "2026-06-12", species: 3 } },
];
// 나무 둘레 빈 땅 칸(활성·사용량 0 → stage empty). gx7~13 × gy7~13 에서 나무 3칸 제외.
const EMPTY = [];
let _ei = 0;
for (let gx = 7; gx <= 13; gx++) {
  for (let gy = 7; gy <= 13; gy++) {
    if ((gx === 10 && gy === 10) || (gx === 11 && gy === 10) || (gx === 10 && gy === 11)) continue;
    const date = "2026-05-" + String(++_ei).padStart(3, "0"); // 고유 키(달=2026-05)
    EMPTY.push({ date, active: true, grid: { gx, gy }, finalized: true,
      usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requestCount: 0 },
      tree: { stage: "empty", xp: 0, stageProgress: 0, seed: date, species: 0 } });
  }
}
const DAYS = [...TREES, ...EMPTY];
const PLACEMENT = {};
for (const d of DAYS) PLACEMENT[d.date] = d.grid;

/**
 * 고정 씬을 렌더하고 그리기 지문을 만든다.
 * @param {number} seed Math.random PRNG 시드.
 * @param {number} frames 렌더할 프레임 수(베이크가 예산 분산으로 끝나게 충분히).
 * @returns {{ fp: string, len: number }}
 */
async function renderFingerprint(seed = 12345, frames = 12) {
  const g = installGlobals(seed);
  try {
    const { ForestRenderer } = await import("../public/js/renderer.js");
    const cellList = DAYS.map((d) => forestCellParams(d, CAP, REF_MAX));
    const r = new ForestRenderer(g.makeCanvas());
    r.setForests({});
    r.setData(cellList, null, PLACEMENT);
    resetOps();
    for (let i = 0; i < frames; i++) r.render();
    return { fp: fingerprint(), len: getOps().length };
  } finally {
    g.restore();
  }
}

test("렌더 스모크: 예외 없이 그리기 발생", async () => {
  const { len } = await renderFingerprint();
  assert.ok(len > 100, `그리기 호출이 충분히 발생해야 함(실제 ${len})`);
});

test("렌더 스모크: 같은 시드 → 지문 동일(결정성)", async () => {
  const a = await renderFingerprint(777);
  const b = await renderFingerprint(777);
  assert.equal(a.fp, b.fp, "같은 시드인데 지문이 다르다 — 숨은 비결정성");
  assert.equal(a.len, b.len);
});

// 골든 지문 — 현재 렌더 동작의 기준선. renderer.js 분할(C-2/C-3) 후 이 값이 그대로면 동작 보존.
//   의도적으로 렌더를 바꾸면(아트 변경 등) 이 값을 갱신한다.
// 골든 지문 — C-2/C-3 분할 전 현재 렌더 동작의 기준선. 분할 후 이 값이 유지되면 동작 보존.
//   의도적으로 렌더를 바꾸면(아트 변경 등) 새 값으로 갱신한다(env FOREST_GOLDEN 로 임시 override).
// §63 갱신: _viewport() 가 창 크기(1280×800) 대신 16:9 contain(1280×720)을 반환하게 바뀜.
//   백버퍼 높이 800→720(80행 감소)으로 그리기 행이 줄어든 것뿐(나무·바닥·좌표 로직 불변).
// §65 재방향: 활성 풀밭 전반 흙 도트(decor specks) 폐기 → 빈 대지(STAGE.EMPTY) 활성 칸 중앙
//   작은 흙 패치(drawEmptyDirtPatch, ~GRID/4)로 교체. diff 는 EMPTY·!bundled·활성 칸에만 한정
//   (_isActiveGridCell 가드·칸 중심 gridToScreen). 나무 칸·비활성 흙·닫힘·묶인 숲·좌표·레터박스
//   (§63) 미혼입(전반 도트 제거로 drawGrassBlades 원복 → 그 경로 f529097b 와 동일 검증).
// 버그 B 갱신: 마지막 활성 셀(깃발 칸) 타일에서 장식 바위·웅덩이·식생 배치를 제외(깃발 가림 방지,
//   _isLastActiveCellTile). 스모크 픽스처의 최신 셀(2026-06-12) 타일 장식이 빠져 ops 가 줄었다(렌더
//   의도 변경 — 깃발 occlusion 수정). 나무·바닥·좌표·호버(스모크엔 호버 없음) 로직 불변.
const GOLDEN = "ff226893";
const GOLDEN_LEN = 1506909;

test("렌더 스모크: 골든 지문 일치(회귀 가드)", async () => {
  const { fp, len } = await renderFingerprint();
  const expected = process.env.FOREST_GOLDEN || GOLDEN;
  assert.equal(
    fp, expected,
    `렌더 지문 불일치(len ${len} vs 골든 ${GOLDEN_LEN}). 의도된 렌더 변경이면 GOLDEN 갱신, 아니면 회귀.`,
  );
});
