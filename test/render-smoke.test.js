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
// 식생 재설계(단위 1~4) 갱신: 나무 밑동 거리 그늘이 그늘 안 풀 가닥을 감쇠하고(drawGrassBlades atten)
//   그늘 안에 흙 도트를 소량 복원(_drawShadeSoil). 스모크 픽스처에서 grass blade 색(grassBlade1/2·
//   grassSpeck) fillRect 396개·관련 fillStyle 396개가 줄고, 흙(pendDirtA/B) fillRect 60개·fillStyle 60개가
//   추가됨(순 ops 1506909→1506237). 풀↔흙 색상 fillStyle 교체일 뿐 — 나무·좌표·베이크·데이터 로직 불변.
//   empty 셀은 그늘 0 이라 풀 가닥 불변(설계 의도 일치). integration-qa 종합 검증 후 갱신.
// 그늘 흙 제거 갱신(사용자 정정): 그늘에는 풀 가닥만 적게(atten 유지), 흙 도트는 원한 적 없음 →
//   _drawShadeSoil·soilAmount 제거. 스모크 픽스처에서 그늘 안 흙(pendDirt) fillRect 60개·fillStyle 60개가
//   사라짐(ops 1506237→1506117). 풀 가닥 감쇠(atten)·녹색 바닥·empty 셀·나무·좌표·베이크 로직 불변.
// 흙 복원 + 흙 도트 1/4 + 풀 크기 갱신(사용자 재정정): 위 제거가 오해였음 → soilAmount(0.35)·
//   _drawShadeSoil·_shadeAt soil 반환을 단위 2 형태로 복원하되, 흙 도트는 2px 블록 대신 **1px**(빈 대지
//   흙자국과 동일·기존 치수의 1/4). drawGrassBlades 에 lush(=grassLushness) 인자 추가로 풀 가닥 크기(길이·
//   굵기)도 함께 조절(기본 1.0=비트 동일 의도지만 가닥 길이 round 식 변화로 미세 diff). 그늘 안 흙(pendDirt)
//   fillRect/fillStyle 복귀(ops 1506117→1506237). 나무·좌표·베이크·데이터 로직 불변. empty 셀 그늘 0 불변.
// 바닥 종류 위상 정합 갱신: 경계 타일 per-block 분류(ditheredGroundKind·warpedGroundKind)가 셀을
//   타일 내부 소수좌표 u 로 round(u/3) 매핑해, 각 셀의 우·하단 타일 절반이 다음 셀로 새어(우상단 반 타일
//   밀림) 외곽선·솔리드 분류(round(tx/3))와 어긋났다. 매핑 기준점을 정수 타일 인덱스 floor(u) 로 바꿔
//   솔리드와 같은 위상으로 정합(노이즈 0 에서 비트 동일·헤드리스 20655/20655 블록 일치, 수정 전 31.8%
//   불일치). 경계 타일 per-block 바닥 색 픽셀이 (정확한 위치로) 이동 — ops 개수 불변(len 1506237 동일),
//   fillStyle/fillRect 값만 변경. 나무·외곽선·라벨·좌표·베이크·데이터 로직 불변(분류 위상만 교정).
// VEG_TWEAKS 기본값 확정(사용자 실모드 트윅 세팅 반영): grassLushness 1.0→1.4·soilAmount 0.35→0.5·
//   shadowGrassAtten 0.85→0.6·forestDensityCoef 1.0→1.05·boundaryNoise 1.0→1.5(shadowRadiusFactor 0.6 불변).
//   풀 가닥 밀도·크기↑·흙 도트↑·경계 노이즈 폭↑ 로 fillRect 증가(ops 1506237→1562661). 식생 계수 기본값만
//   변경 — 나무·좌표·베이크·데이터 로직 불변.
const GOLDEN = "fc3a063f";
const GOLDEN_LEN = 1562661;

test("렌더 스모크: 골든 지문 일치(회귀 가드)", async () => {
  const { fp, len } = await renderFingerprint();
  const expected = process.env.FOREST_GOLDEN || GOLDEN;
  assert.equal(
    fp, expected,
    `렌더 지문 불일치(len ${len} vs 골든 ${GOLDEN_LEN}). 의도된 렌더 변경이면 GOLDEN 갱신, 아니면 회귀.`,
  );
});

// 회귀 가드(오버뷰 스냅샷 — 전부 empty 인 묶인 달): 그루 0 인 묶인 달은 _forestSprite=null 이라
//   스프라이트가 안 생긴다. _snapAllBaked 가 그 부재를 미완성으로 오판하면 합성에 영영 못 가
//   임시본(균일 초록 + 숲 bbox 사각)이 고정 노출된다(실 data 4월=전부 empty 회귀). 그루 0 군집을
//   "구울 게 없음=완성"으로 건너뛰어야 합성이 도달한다.
test("오버뷰 스냅샷: 전부 empty 인 묶인 달이 있어도 합성 도달(임시본 고정 안 됨)", async () => {
  const g = installGlobals(1);
  try {
    const { ForestRenderer } = await import("../public/js/renderer.js");
    // 묶인 달 2026-04: 전부 empty(treeCount 0). 활성 달 2026-06: 나무.
    const days = [];
    let i = 14;
    for (let gy = 25; gy <= 27; gy++) for (let gx = 15; gx <= 17; gx++) {
      const date = "2026-04-" + String(++i).padStart(2, "0");
      days.push({ date, active: true, grid: { gx, gy }, finalized: true,
        usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requestCount: 0 },
        tree: { stage: "empty", xp: 0, stageProgress: 0, seed: date, species: 1 } });
    }
    let j = 0;
    for (let gx = 11; gx <= 15; gx++) {
      const date = "2026-06-" + String(++j).padStart(2, "0");
      days.push({ date, active: true, grid: { gx, gy: 9 }, finalized: false,
        usage: { inputTokens: 30000, outputTokens: 15000, cacheWriteTokens: 40000, cacheReadTokens: 500000, requestCount: 60 },
        tree: { stage: "mature", xp: 585000, stageProgress: 0.4, seed: date, species: 3 } });
    }
    const placement = {};
    for (const d of days) placement[d.date] = d.grid;
    const forests = { "2026-04": { month: "2026-04", bundled: true, monthly: { totalTokens: 0, treeCount: 0 } } };

    const r = new ForestRenderer(g.makeCanvas());
    r.setForests(forests);
    const cellList = days.map((d) => forestCellParams(d, CAP, REF_MAX));
    r.setData(cellList, null, placement);

    // 4월 군집은 그루 0·bbox 존재.
    const april = r.forestTrees.get("2026-04");
    assert.ok(april && april.bbox, "4월 군집 bbox 존재");
    assert.equal(april.instances.length, 0, "4월은 전부 empty → 그루 0");

    // 오버뷰 합성을 끝까지 돌린다(예전엔 영영 false 라 무한 임시본).
    r.camera.cam = { x: 0, y: 0, zoom: r.camera.zoomMin || 0.0278 };
    r.camera.overview = true;
    let composited = false;
    for (let f = 0; f < 60; f++) {
      r._advanceMapSnapshot();
      if (r._mapSnapshot && !r._mapSnapshotStale) { composited = true; break; }
    }
    assert.ok(composited, "전부 empty 묶인 달이 있어도 합성 도달해야 함(임시본 고정 회귀)");
    assert.ok(r._snapAllBaked(), "_snapAllBaked 가 그루 0 군집을 완성으로 봐야 함");

    // 합성 스냅샷에 임시본 사각(rgba(60,110,55..))이 없어야 한다(균일 초록 아님).
    r._mapSnapshot = null; r._mapSnapshotStale = false; r._snapProvisional = null; r._snapBuilder = null;
    resetOps();
    r._advanceMapSnapshot();
    const ops = getOps();
    assert.ok(!ops.some((o) => o.includes("rgba(60,110,55")), "합성에 임시본 숲 사각이 없어야 함");
    // 흙(pendDirt) 다수 + 4월 footprint=PAST 풀톤이 둘 다 등장(라이브 지형 반영).
    assert.ok(ops.some((o) => o.includes("pendDirt") || o.includes("8a6238") || o.includes("785530")), "흙 베이스 등장");
  } finally {
    g.restore && g.restore();
  }
});
