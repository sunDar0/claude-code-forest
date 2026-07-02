/**
 * 캔버스 도트 렌더러. 스타듀밸리식 정사각 타일 탑다운으로 나무 숲을 그린다.
 *
 * 설계 제약(반드시 보존):
 *  - 픽셀퍼펙트: imageSmoothingEnabled=false + 저해상도 백버퍼 정수배 nearest 업스케일, 정수 스냅.
 *  - Y-sorting: 그리기 직전 sort((a,b)=>a.y-b.y). 화면 아래(큰 y)=앞.
 *  - 시드 결정성·팬 불변: 절차 디테일은 월드 좌표 시드 → 카메라 팬에도 안 흔들림.
 *  - 풀스크린, 폴링/오프라인/빈땅 견고성.
 */

import { buildTree, buildForest, STAGE_SCALE, gridPlacement } from "./simulation.js";
import {
  layoutByPlacements, gridToScreen, TILE, GRID,
  MAP_GX0, MAP_GX1, MAP_GY0, MAP_GY1,
} from "./grid.js";
import { STAGE, REF, metricAverages, compareToAvg, avgBadge } from "./metrics.js";
import { AmbientParticles } from "./particles.js";
import { sheet, rockSheet } from "./sprites.js";
import { hash32 } from "./seed.js";
import { PAL, PAL_PAST, LEAF_HI, leafPalFor, hexToRgb, mixHex, skyColorsAt } from "./render/palette.js";
import {
  drawGrassBlades, drawEmptyDirtPatch, drawPendingGround, drawClosedGround, drawGroundShadow,
  drawWaterPool, paintProceduralRock, pickVegSpecies,
  drawDecor, drawDecorItem, drawBentBlade, drawButterfly,
} from "./render/decor.js";
import { vhash, vnoise, fbm } from "./render/noise.js";
import {
  cellGroundDensity as g_cellGroundDensity,
  cellVegNorms as g_cellVegNorms,
  cellCacheWriteN as g_cellCacheWriteN,
  isBundledTile as g_isBundledTile,
  isActiveGridCell as g_isActiveGridCell,
  isActiveTile as g_isActiveTile,
  groundKindCell as g_groundKindCell,
  groundKind as g_groundKind,
  isGroundBoundaryTile as g_isGroundBoundaryTile,
  warpedGroundKind as g_warpedGroundKind,
  ditheredGroundKind as g_ditheredGroundKind,
  groundBaseColor as g_groundBaseColor,
  blockedKind as g_blockedKind,
  isBlockedTile as g_isBlockedTile,
  drawTransitionDetail as g_drawTransitionDetail,
} from "./render/ground.js";
import { paintTreeBody, drawRootScatter, drawCrownBlobs, drawBranches, drawTrunkSegs, thickLineLR, disc, drawOvalLeaf, thickLine } from "./render/tree-art.js";
import { Camera } from "./render/camera.js";

// 카메라 월드 좌표 = 백버퍼 픽셀 공간. 그리드 셀(0,0) 중심 = 월드 원점.
// 그리드 1칸 = 3×3 타일(= GRID). 줌인 끝 = 이게 화면을 꽉 채우는 배율.
const CELL_SPAN = GRID; // 한 그리드 월드 px = 3*TILE = 96

// 정적 바닥 캐시를 화면보다 이만큼(각 변) 크게 구워, 작은 팬은 blit 오프셋만으로 처리(재베이크 0).
//   GRID(=96px) = 그리드 1칸. 한 칸 미만 팬은 마진 안에서 흡수된다.
const GROUND_BAKE_MARGIN = GRID;

// 식생(풀·그늘·흙) 렌더 계수를 한 객체로 모은다 — 단위 4 트윅 패널이 이걸 드래그로 수정한다.
//   렌더 코드는 하드코딩 대신 이 값을 읽는다. 단위 2 가 실제 소비하는 키는 D(shadowRadiusFactor·
//   shadowGrassAtten·grassLushness)뿐. forestDensityCoef·boundaryNoise 는 정의만 — 단위 3·4가 연결.
const VEG_TWEAKS = {
  shadowRadiusFactor: 0.6,  // 그늘 반경 = 나무 스프라이트 실제 너비 × 이 값(=풀잎이 나는 영역)
  grassLushness: 1.4,       // 풀잎 가닥 밀도 + 크기 계수(>1 더 많고 더 큼, <1 성김)
  soilAmount: 0.5,          // 밑동 그늘 흙 비율("약간") — 흙 도트는 작게(빈 대지 흙자국과 같은 1px)
  shadowGrassAtten: 0.6,    // 그늘 중심에서 풀 감쇠 최대 강도(0~1) — 밑동에 닿을수록 1
  forestDensityCoef: 1.05,  // 군집 밀도 계수(단위 3에서 buildForest 와 연결)
  boundaryNoise: 1.5,       // 경계 섞임 강도(단위 3에서 전이대 amp 와 연결)
};

/**
 * 도트 숲 캔버스 렌더러. 일간 사용량 데이터를 받아 그리드 위 나무·묶인 달 숲 군집·바닥/식생·
 * 파티클을 백버퍼에 그리고 화면에 업스케일한다. 카메라 줌/팬·오버뷰 스냅샷·스프라이트 베이크
 * 캐시·미니맵·히트테스트를 담당. UI 표시는 DOM(main.js)이 getter 로 가져간다.
 */
export class ForestRenderer {
  /** @param {HTMLCanvasElement} canvas 렌더 대상 캔버스 */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;

    // 백버퍼(크기는 zoom 에 따라 _recompute 에서 결정). 정수배 nearest 업스케일.
    this.buffer = document.createElement("canvas");
    this.bctx = this.buffer.getContext("2d");
    this.bctx.imageSmoothingEnabled = false;

    this.particles = new AmbientParticles(); // 성목 주변 부유 금색 파티클
    this.debug = false; // 그리드 좌표 라벨(디버그 모드 에서만 ON — main.js 가 설정)
    this.hudCollapsed = false; // HUD 접힘(main 이 설정). 접히면 마지막 활성 금색 아웃라인도 숨김.

    this.cells = []; // layoutByPlacements 결과
    this._shadeStumps = []; // 이번 프레임 나무 밑동 그늘(D·E·F) — _collectShadeStumps 가 채움
    this.bakedByDate = new Map(); // date → buildTree 결과
    this.cellByKey = new Map(); // "gx,gy" → cell (데이터 타일 빠른 조회)

    // 숲 계층(월 단위 묶음).
    this.forests = {}; // ym → { month, bundled, bundledAt, monthly }
    this.drilldownMonth = null; // 펼친(드릴다운) 달 "YYYY-MM" — 그 달은 일 그리드로 표시
    this.forestBlobs = []; // 묶인 달의 숲 군집 [{ ym, cgx, cgy, r, density, trees, ... }]
    // 묶인 숲 닫힌 발자국(C·단위3): 모든 군집의 closedCells("gx,gy") 집합. 빈 셀·브리지 셀이
    //   cellByKey 에 없어도 바닥 종류를 "forest" 로 분류해 셀 사이 흙 구멍을 없앤다(연속 바닥).
    //   파생 렌더 상태일 뿐 — 베이크 키·_contentSignature·무효화와 무관(§28 프리즈 0).
    this.bundledFootprint = new Set();
    // 숲 군집 캐시: ym → { instances, bbox, drawBBox, members, ... }.
    //   buildForest + 그루별 buildTree 를 ym 단위로 1회 베이크(프레임마다 재생성 금지).
    this.forestTrees = new Map();

    // 나무 스프라이트 베이크 캐시: key → {canvas, ax, ay}(ax/ay = 밑동의 스프라이트 내 픽셀 오프셋).
    //   한 그루 전체를 오프스크린에 1회 그려 캐시하고, 매 프레임은 drawImage 1콜만(정수 좌표·스케일
    //   변환 금지 — 픽셀퍼펙트). Map 삽입순 = LRU 근사(get 시 재삽입).
    this.spriteCache = new Map();
    // 화면 밖 셀은 베이크 안 함 → 한 화면 작업집합(보이는 그리드 수십 칸)이 상한 256 안에 들어온다.
    this.spriteCap = 256;
    this._spriteBakes = 0; // 스모크용 베이크 카운터(같은 key 2프레임 → 1회만 베이크 검증)

    // 군집(달) 단위 스프라이트: 묶인 달 나무 수십~수백 그루를 달 1장에 합쳐 베이크한다(그루당 1장이면
    //   스프라이트 수가 LRU 상한을 넘겨 매 프레임 축출·재베이크 스래시 → 행). 캐시 키 = ym.
    //   {canvas, rx, ry, wx0, wy0}: rx/ry = 군집 기준점의 스프라이트 내 픽셀 오프셋.
    this.forestSprites = new Map();
    this._forestBakes = 0; // 스모크 카운터(달 스프라이트 완성 수)

    // 비차단 렌더용 베이크 예산: 한 프레임에 너무 많이 베이크해 멈칫하지 않게 분산한다.
    //   _frameBakeBudget = 프레임당 진행할 "베이크 작업" 수(셀 나무 1콜 또는 군집 청크 1개),
    //   _instBakeBudget = 군집 청크당 그루 수. 둘의 곱이 프레임당 픽셀 작업 상한 → 단일 프레임 < 100ms.
    this._frameBakeBudget = 2;
    this._instBakeBudget = 10;
    this._bakesThisFrame = 0;

    // 정적 바닥 캐시(교정 A): 베이스 흙·풀결·전이대·빈땅 흙을 오프스크린에 1회 베이크 → 매 프레임 blit.
    //   _drawStaticGround 는 frame 무의존·월드 시드 결정적이라 같은 (내용·줌·백버퍼·트윅·베이크 원점)
    //   이면 출력 불변. 화면보다 마진(GROUND_BAKE_MARGIN)만큼 크게 구워, 카메라 팬이 마진 안이면
    //   blit 오프셋만 바꿔 재베이크 0. 마진 밖으로 나가거나 내용/줌/백버퍼/트윅이 바뀌면 재베이크.
    this._groundBake = null; // { canvas, ctx, bakeOx, bakeOy, w, h, key } | null
    this.offline = false;
    this.generatedAt = null;
    this.empty = true;
    this.hud = null; // 집계 HUD 값
    this._contentSig = null; // 직전 setData 콘텐츠 시그니처(내용 불변 폴 조기 반환용)

    // 상호작용 상태.
    this.hoverCell = null;
    this.hoverPos = null;
    this.hoverForestYm = null; // 호버 중인 묶인 달(ym) — 녹색 외곽선 강조 대상(없으면 null)
    this.selectedCell = null;
    this._lastPointer = null;
    // 활성화(심기) UI 상태.
    this.candidateSlots = []; // 후보 빈칸 [{gx,gy}]
    this.selectedSlot = null; // 선택 칸 {gx,gy}|null
    this.plantFx = null; // 활성화 이펙트 { gx, gy, startFrame, dur }|null
    this.cursorGrid = null; // 커서 그리드 하이라이트 { gx, gy, valid }|null
    // 호버 중인 후보 칸 { gx, gy }|null. 후보 위면 선택 디자인(박스+＋)을 프리뷰(클릭=바로 확인 팝업).
    this.hoverSlot = null;
    // 자동 묶기 빛기둥: 서버가 그 달을 bundled=true 로 전환한 순간 멤버 그리드들에 짧게 솟는 빛기둥
    //   { cells:[{gx,gy}], startFrame, dur }|null. 일회성.
    this.bundleFx = null;
    // 차단 집합(닫힘만) — main 이 폴마다 setBlocked 로 갱신. Map("gx,gy" → "closed:…").
    //   activation 과 같은 집합을 참조한다.
    this.blocked = new Set();

    // 카메라 상태·연산은 render/camera.js 의 Camera 가 소유(cam·zoomMin·zoomMax·overview·_camAnim·
    //   _centered). renderer 는 host 로 역참조된다(범위·뷰포트·버퍼·_recompute). _recompute() 보다 앞.
    this.camera = new Camera(this);

    // 오버뷰 스냅샷: 맵 전체를 매 프레임 칠하지 않고 오프스크린 1회 베이크를 축소 blit + 하늘만 →
    //   freeze 회피. (오버뷰 플래그 자체는 camera.overview 가 소유.)
    this._mapSnapshot = null; // { canvas, snapW, snapH, scale } | null. 콜드(완성본 없음)에서만 null.
    // 스냅샷 이중 버퍼: 내용이 바뀌어 재합성할 때 직전 완성본을 즉시 null 하지 않고 stale 로만 표시 →
    //   재합성이 끝날 때까지 직전 완성본을 계속 그려(원자 교체) 초록 임시본 플래시를 없앤다.
    this._mapSnapshotStale = false;
    this._snapBuilder = null; // 진행 중 풀해상 베이크 빌더 | null
    this._snapProvisional = null; // 베이크 중 보여줄 저해상 임시본 | null (콜드 스타트 전용)
    this._forceDetail = false; // 스냅샷 베이크 중 LOD 무시(풀 디테일 강제)
    this._snapComposite = false; // 오버뷰 스냅샷 합성 중 LOD(결 텍스처·장식 생략) 플래그

    // 월드 원점: 그리드 셀(0,0) 중심의 월드 좌표(고정). 카메라가 이 위를 훑는다.
    this.worldOriginX = 0;
    this.worldOriginY = 0;
    // 월드 북쪽 지평선 y(이 위는 하늘). 맵 북단 모서리와 일치시켜 첫 렌더에서도 미채색 띠가 없게 한다.
    this.worldHorizonY = Math.round(this.worldOriginY + MAP_GY0 * GRID - GRID / 2);

    // 백버퍼 크기·하늘높이(매 _recompute 갱신).
    this.bufW = 384;
    this.bufH = 216;
    this.skyH = 36;

    this.frame = 0;

    // 시간대 하늘(작업 3): render 진입에서 로컬 시각(시+분/60)을 1회 읽어 채운다. 외부에서 명시
    //   설정(테스트·스냅샷 고정 주입)되면 그 값을 우선해 결정성 유지. null = 아직 미설정(첫 render 에서 읽음).
    this._skyHour = null;
    // 외부가 시각을 고정 주입했는지 표시(true 면 render 가 시계를 다시 안 읽음 — 골든/스냅샷 결정성).
    this._skyHourPinned = false;

    // 나무 스프라이트 시트 에셋(비동기 로드). 로드 전엔 절차 아트(폴백)로 그리고, 완료되면 모든 베이크
    //   캐시·맵 스냅샷을 1회 무효화해 시트로 전환한다. 실패 시 sheet.ready=false → 절차 아트 유지.
    //   비브라우저(테스트)에서 fetch/Image 부재 → try/catch.
    this.sheet = sheet;
    try {
      sheet.load("/sprite/tree_sprite_10_packed.png", "/sprite/tree_sprite_10_coords.json");
    } catch (_) { /* 비브라우저(테스트)에서 fetch/Image 부재 — 폴백 */ }
    sheet.onReady(() => {
      // 시트 준비 → 절차 베이크 전량 무효화(다음 프레임부터 시트로 재베이크). 데이터·카메라 불변.
      this.spriteCache.clear();
      this.forestSprites.clear();
      this._invalidateSnapshot();
    });

    // 바위 스프라이트 시트(놓인 바위 장식). 로드 전엔 절차 바위 폴백, 준비되면 시트 blit.
    //   바위 베이크 캐시: "frameIdx|targetH" → {canvas, w, h}(밑동=하단중앙 앵커). 매 프레임 재스케일 방지.
    this.rockSheet = rockSheet;
    this.rockSpriteCache = new Map(); // LRU 근사(get 시 재삽입)
    this.rockSpriteCap = 64; // 5프레임×몇 스케일이라 작게
    try {
      rockSheet.load("/sprite/rock_sprite_packed.png", "/sprite/rock_sprite_coords.json");
    } catch (_) { /* 비브라우저 — 폴백 */ }
    rockSheet.onReady(() => {
      // 바위 시트 준비 → 바위 베이크 캐시 무효화 + 오버뷰 스냅샷 무효화(바위가 스냅샷에 베이크되므로).
      this.rockSpriteCache.clear();
      this._invalidateSnapshot();
    });

    this._recompute();
  }

  // ── 카메라 공개 API 위임(외부 계약 유지 — main.js·UI 가 renderer.X 로 부른다). ──
  /** @see Camera#zoomAt */
  zoomAt(...a) { return this.camera.zoomAt(...a); }
  /** @see Camera#pan */
  pan(...a) { return this.camera.pan(...a); }
  /** @see Camera#focusLastActive */
  focusLastActive(...a) { return this.camera.focusLastActive(...a); }
  /** @see Camera#hasLastActive */
  hasLastActive(...a) { return this.camera.hasLastActive(...a); }
  /** @see Camera#lastActiveGrid */
  lastActiveGrid(...a) { return this.camera.lastActiveGrid(...a); }
  /** @see Camera#isOverview */
  isOverview(...a) { return this.camera.isOverview(...a); }

  /** 나무 시트 사용 여부(준비+이미지 유효). 아니면 절차 폴백. @returns {boolean} */
  _useSheet() {
    return !!(this.sheet && this.sheet.ready && this.sheet.image);
  }
  /** 바위 시트 사용 여부(준비+이미지+프레임 유효). @returns {boolean} */
  _useRockSheet() {
    return !!(this.rockSheet && this.rockSheet.ready && this.rockSheet.image && this.rockSheet.count() > 0);
  }

  /**
   * 매크로 stage 내 하위프레임 인덱스(캐시 키용). 묘목·유목 0~2, 성목 0~3, 그 외 0.
   *   sprites.frameNameForStage 의 stageProgress 분할(묘목·유목 3등분, 성목 4등분)과 동일.
   *   캐시 키는 stage 도 포함하므로 매크로별 sub 가 겹쳐도 유일성 유지(묘목 sub2 ≠ 유목 sub2).
   * @param {number} stageEnum 단계 enum
   * @param {number} stageProgress 단계 진행도 0~1
   * @returns {number} 0~3
   */
  _subFrame(stageEnum, stageProgress) {
    const p = Number.isFinite(stageProgress) ? Math.max(0, Math.min(1, stageProgress)) : 0;
    if (stageEnum === STAGE.MATURE) return Math.max(0, Math.min(3, Math.floor(p * 4)));
    if (stageEnum === STAGE.SAPLING || stageEnum === STAGE.YOUNG) return Math.max(0, Math.min(2, Math.floor(p * 3)));
    return 0;
  }

  /**
   * 뷰포트(px) = 창 안에 16:9 종횡비로 contain(레터박스)된 콘텐츠 영역 크기.
   * 백버퍼·캔버스·카메라가 모두 이 값을 화면 크기로 간주하므로, 여기서 16:9 를 강제하면
   * 숲 장면이 항상 16:9 로 유지되고 남는 영역은 레터박스(body 검정)가 된다.
   * 창이 16:9 보다 넓으면 높이를 채우고 좌우 레터박스, 좁으면 너비를 채우고 상하 여백.
   * @returns {{w:number,h:number}}
   */
  _viewport() {
    const ww = window.innerWidth;
    const wh = window.innerHeight;
    const AR = 16 / 9;
    let w, h;
    if (ww / wh > AR) {
      // 창이 16:9 보다 넓음(낮고 넓게) → 높이를 채우고 좌우 레터박스.
      h = wh;
      w = Math.round(wh * AR);
    } else {
      // 창이 16:9 보다 높음(세로로 길게) → 너비를 채우고 상하 여백.
      w = ww;
      h = Math.round(ww / AR);
    }
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  /**
   * 16:9 contain 된 캔버스를 창 안에 배치(CSS px). 가로 중앙, 세로 **하단 고정**(땅이 창 바닥에 붙음).
   * 캔버스 intrinsic 크기(buf*zoom)는 _recompute 가 잡고, 화면 표시 크기는 fitW/fitH 로 강제한다.
   * 남는 영역은 body 배경(검정)이 레터박스로 보인다. toCanvasPx 는 getBoundingClientRect 기반이라
   * 이 left/top/width/height 가 입력 좌표 변환에 자동 반영된다(수동 오프셋 보정 불필요).
   */
  _layoutCanvas() {
    const s = this.canvas.style;
    if (!s) return; // 헤드리스(스텁 캔버스) — CSS 배치 없음
    const vp = this._viewport();
    const ww = window.innerWidth;
    const wh = window.innerHeight;
    const left = Math.round((ww - vp.w) / 2);
    const top = Math.round(wh - vp.h); // 하단 고정
    s.left = left + "px";
    s.top = top + "px";
    s.width = vp.w + "px";
    s.height = vp.h + "px";
  }

  /**
   * zoom 에 맞춰 백버퍼·캔버스·하늘높이를 재계산. 픽셀퍼펙트 유지.
   * 백버퍼 = ceil(뷰포트/zoom), 캔버스 = 백버퍼*zoom 으로 화면을 꽉 채운다.
   */
  _recompute() {
    const vp = this._viewport();
    // 오버뷰: 백버퍼·캔버스 = 뷰포트 크기(1:1). 맵 전체는 스냅샷을 축소 blit 하므로 백버퍼를 안 키운다.
    if (this.camera.overview) {
      this.camera.cam.zoom = 1;
      this.bufW = Math.max(CELL_SPAN, vp.w);
      this.bufH = Math.max(CELL_SPAN, vp.h);
      this.buffer.width = this.bufW;
      this.buffer.height = this.bufH;
      this.bctx.imageSmoothingEnabled = false;
      this.canvas.width = this.bufW;
      this.canvas.height = this.bufH;
      this.ctx.imageSmoothingEnabled = false;
      this.skyH = Math.round(this.bufH * 0.17);
      this.scale = 1;
      this._layoutCanvas();
      return;
    }
    const zoom = Math.max(1, this.camera.cam.zoom | 0);
    this.camera.cam.zoom = zoom;
    // 종횡비 무관. 백버퍼 = ceil(뷰포트/zoom), 최소 1그리드(어느 축이든 안 잘리게).
    this.bufW = Math.max(CELL_SPAN, Math.ceil(vp.w / zoom));
    this.bufH = Math.max(CELL_SPAN, Math.ceil(vp.h / zoom));
    this.buffer.width = this.bufW;
    this.buffer.height = this.bufH;
    this.bctx.imageSmoothingEnabled = false;
    this.canvas.width = this.bufW * zoom;
    this.canvas.height = this.bufH * zoom;
    this.ctx.imageSmoothingEnabled = false;
    this.skyH = Math.round(this.bufH * 0.17);
    this.scale = zoom; // 하위호환(HUD 가 scale 참조)
    this._layoutCanvas();
  }

  /** 화면 리사이즈 반영(줌 한계·스냅샷 재계산). */
  resize() {
    this.camera._updateZoomLimits();
    this.camera.cam.zoom = Math.max(this.camera.zoomMin, Math.min(this.camera.zoomMax, this.camera.cam.zoom));
    this._invalidateSnapshot(); // 화면 크기 변하면 스냅샷 스케일이 달라지므로 재베이크
    this._recompute();
  }

  // ===================== 카메라 조작 =====================
  /** 모든 셀(빈땅 포함)의 그리드 좌표 범위. @returns {{minGx,maxGx,minGy,maxGy}} */
  _gridBounds() {
    let any = false;
    let minGx = 0, maxGx = 0, minGy = 0, maxGy = 0;
    for (const cell of this.cells) {
      if (!any) {
        minGx = maxGx = cell.gx;
        minGy = maxGy = cell.gy;
        any = true;
      } else {
        if (cell.gx < minGx) minGx = cell.gx;
        if (cell.gx > maxGx) maxGx = cell.gx;
        if (cell.gy < minGy) minGy = cell.gy;
        if (cell.gy > maxGy) maxGy = cell.gy;
      }
    }
    return { minGx, maxGx, minGy, maxGy };
  }

  /**
   * 월드 북쪽 지평선 Y: 이 위(작은 월드y)는 하늘, 아래는 땅.
   * 지평선을 맵 북단 모서리와 정확히 일치시켜, 하늘 끝~맵 북단 사이 미채색 띠가 안 생기게 한다.
   */
  _computeHorizon() {
    this.worldHorizonY = Math.round(this.worldOriginY + MAP_GY0 * GRID - GRID / 2);
  }

  /**
   * 콘텐츠 월드 px 바운딩 박스. 개별 그리드 + 묶인 숲 군집 전부 포함.
   * 숲 군집은 멤버 셀 발자국 위로 나무 키만큼 솟으므로 그 extent(drawBBox)를 합산해야 줌아웃
   * 끝에서 군집 상단이 안 잘린다.
   * @returns {{x0,x1,y0,y1}}
   */
  _contentWorldBounds() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    let any = false;
    const pad = CELL_SPAN / 2;
    // 개별 그리드(묶인 셀 포함 — 숲의 위치 근거이기도).
    for (const cell of this.cells) {
      const cx = this.worldOriginX + cell.gx * GRID;
      const cy = this.worldOriginY + cell.gy * GRID;
      x0 = Math.min(x0, cx - pad); x1 = Math.max(x1, cx + pad);
      y0 = Math.min(y0, cy - pad); y1 = Math.max(y1, cy + pad);
      any = true;
    }
    // 묶인 숲 군집 extent. drawBBox(그릴 사각 합집합) 우선 — 베이크/컬링과 동일 기준이라 줌아웃 끝 잘림 0.
    for (const fb of this.forestBlobs) {
      const cluster = this.forestTrees.get(fb.ym);
      if (cluster && (cluster.drawBBox || cluster.bbox)) {
        const bb = cluster.drawBBox || cluster.bbox;
        x0 = Math.min(x0, bb.x0); x1 = Math.max(x1, bb.x1);
        y0 = Math.min(y0, bb.y0); y1 = Math.max(y1, bb.y1);
      } else {
        // 캐시 전(폴백): 멤버 셀 발자국 + 여유.
        for (const m of fb.members) {
          const cx = this.worldOriginX + m.gx * GRID;
          const cy = this.worldOriginY + m.gy * GRID;
          x0 = Math.min(x0, cx - GRID); x1 = Math.max(x1, cx + GRID);
          y0 = Math.min(y0, cy - GRID * 2); y1 = Math.max(y1, cy + GRID);
        }
      }
      any = true;
    }
    if (!any) {
      x0 = this.worldOriginX - pad; x1 = this.worldOriginX + pad;
      y0 = this.worldOriginY - pad; y1 = this.worldOriginY + pad;
    }
    return { x0, x1, y0, y1 };
  }

  /**
   * 콘텐츠 bbox 를 사방으로 넉넉히 확장한 범위(콘텐츠 변 × MARGIN_FRAC, 전체 ~1.8배).
   * 무한 아님(콘텐츠 비례 + 백버퍼 상한으로 제한).
   * @returns {{x0,x1,y0,y1}}
   */
  _paddedBounds() {
    const c = this._contentWorldBounds();
    const MARGIN_FRAC = 0.4; // 각 변마다 콘텐츠 크기의 40% → 전체 ~1.8배 범위
    const w = Math.max(CELL_SPAN, c.x1 - c.x0);
    const h = Math.max(CELL_SPAN, c.y1 - c.y0);
    // 작은 콘텐츠(1~2그루)도 여백이 화면만큼은 되게 최소 여백 보장.
    const mx = Math.max(w * MARGIN_FRAC, GRID * 4);
    const my = Math.max(h * MARGIN_FRAC, GRID * 4);
    return { x0: c.x0 - mx, x1: c.x1 + mx, y0: c.y0 - my, y1: c.y1 + my };
  }

  /**
   * 고정 맵 월드 px bbox. 콘텐츠가 아니라 맵 전체가 기준이라 콘텐츠 흩어짐에 안 흔들린다.
   * 외곽선 좌표와 정합: 셀 중심 = worldOrigin + g*GRID, 맵 경계 = 중심 ± GRID/2.
   * 폭 = 100*GRID = 5400, 높이 = 40*GRID = 2160 (GRID=54).
   * @returns {{x0,x1,y0,y1}}
   */
  _mapWorldBounds() {
    const half = GRID / 2;
    return {
      x0: this.worldOriginX + MAP_GX0 * GRID - half,
      x1: this.worldOriginX + MAP_GX1 * GRID + half,
      y0: this.worldOriginY + MAP_GY0 * GRID - half,
      y1: this.worldOriginY + MAP_GY1 * GRID + half,
    };
  }

  /**
   * 줌아웃 프레이밍 bbox = 맵 전체 + 약간 여백(그리드 2~3칸). 맵 기준(콘텐츠 흩어짐 무관).
   * @returns {{x0,x1,y0,y1}}
   */
  _zoomFrameBounds() {
    const m = this._mapWorldBounds();
    const MARGIN = GRID * 2.5; // 맵 경계 밖 여백(그리드 2~3칸)
    return { x0: m.x0 - MARGIN, x1: m.x1 + MARGIN, y0: m.y0 - MARGIN, y1: m.y1 + MARGIN };
  }

  /** 줌아웃 한계용 bbox(맵+여백). 위쪽은 지평선까지 포함 — 북단 나무·하늘이 안 잘리게. */
  _activeBBox() {
    const c = this._zoomFrameBounds();
    const wy0 = this.worldHorizonY != null ? Math.min(this.worldHorizonY, c.y0) : c.y0;
    const wy1 = c.y1;
    return {
      w: Math.max(CELL_SPAN, c.x1 - c.x0),
      h: Math.max(CELL_SPAN, wy1 - wy0),
      wx0: c.x0, wx1: c.x1, wy0, wy1,
    };
  }

  /**
   * 대칭 클램프: [lo,hi] 안에 묶되, lo>hi(콘텐츠가 화면보다 작아 여백 음수)면 center 로 강제하지
   * 않고 [hi,lo] 로만 클램프해 현재 카메라 위치를 유지한다(콘텐츠 1~2개일 때 심은 위치를 안 흩뜨림).
   * @param {number} v 현재값
   * @param {number} lo 하한
   * @param {number} hi 상한
   * @param {number} center 중심값
   * @returns {number} 정수 스냅된 클램프 결과
   */
  _clampSym(v, lo, hi, center) {
    if (lo > hi) return Math.round(Math.max(hi, Math.min(lo, v)));
    return Math.round(Math.max(lo, Math.min(hi, v)));
  }

  /**
   * 마지막 활성 그리드 셀 = 배치된(non-bundled) 셀 중 가장 최근 date. 없으면 null.
   * bundled(묶인 달)은 숲으로 표시되므로 제외.
   * @returns {object|null}
   */
  _lastActiveCell() {
    // 프레임 메모이즈: 배치 루프(바위·웅덩이·식생)에서 타일마다 호출돼 O(cells×tiles) 되는 것 방지.
    if (this._lacFrame === this.frame && this._lacCached !== undefined) return this._lacCached;
    let best = null;
    for (const cell of this.cells) {
      if (cell.bundled) continue;
      if (cell.params.stage === STAGE.EMPTY && !cell.isActive) {
        // 빈땅이지만 배치된 활성 칸(오늘 빈땅)은 후보로 인정. 미배치(placement 없는)면 cellByKey 에 없음.
      }
      if (!best || cell.params.date > best.params.date) best = cell;
    }
    this._lacFrame = this.frame;
    this._lacCached = best;
    return best;
  }

  // 마지막 활성 셀(깃발 칸)의 타일인지 — 그 칸 9타일 + 깃발 닿는 우/하/우하 인접 타일. 장식 바위·
  //   웅덩이·식생을 이 타일에 안 두어 깃발이 가려지지 않게 한다(깃발 Y-sort §52 는 불변).
  _isLastActiveCellTile(tx, ty) {
    const la = this._lastActiveCell();
    if (!la) return false;
    const gx = Math.round(tx / 3), gy = Math.round(ty / 3);
    if (gx === la.gx && gy === la.gy) return true; // 그 칸 9타일
    // 깃발은 칸 우하단(§52) — 우·하·우하 인접 타일도 제외(펄럭·바위 크기 여유).
    if (tx === la.gx * 3 + 2 && (ty === la.gy * 3 + 1 || ty === la.gy * 3 + 2)) return true;
    if (ty === la.gy * 3 + 2 && (tx === la.gx * 3 + 1 || tx === la.gx * 3 + 2)) return true;
    return false;
  }

  // 커서(캔버스 px) 아래 나무 — 스프라이트 그릴 사각(_drawTree 동일 식)에 커서가 든 나무의 base 셀.
  //   성목 수관(밑동 칸 위로 솟은 잎)을 호버해도 그 나무를 잡는다(그리드 칸 조회는 밑동 칸만 맞춰
  //   수관을 놓침). 여럿이면 가장 앞(큰 baseY=아래) 우선. 묶인 셀·빈땅·overview 제외. 화면 밖 컬링.
  _treeAtCanvas(cx, cy) {
    if (this.camera.overview) return null;
    const zoom = this.camera.cam.zoom || 1;
    const bx = cx / zoom, by = cy / zoom; // 캔버스 px → 백버퍼 px(나무가 그려진 공간)
    const ox = Math.round(this.worldOriginX - this.camera.cam.x);
    const oy = Math.round(this.worldOriginY - this.camera.cam.y);
    let best = null, bestY = -Infinity;
    for (const cell of this.cells) {
      if (cell.bundled || cell.params.stage === STAGE.EMPTY) continue;
      const sc = gridToScreen(cell.gx, cell.gy, ox, oy);
      const off = cell.placement ? cell.placement.offsetTiles : { x: 0, y: 0 };
      const sx = (sc.x + off.x * TILE) | 0;
      const sy = (sc.y + off.y * TILE) | 0;
      const baseY = sy + 5; // _drawTree 와 동일
      // 스프라이트 그릴 사각: 캐시된 스프라이트(밑동 앵커 ax,ay·w,h) 우선, 없으면 footprint 근사.
      const sub = this._subFrame(cell.params.stage, cell.params.stageProgress);
      const key = "d|" + cell.params.date + "|" + (cell.isActive ? "L" : "P") + "|" + cell.params.stage + "|s" + sub;
      const sp = this.spriteCache.get(key);
      let left, top, w, h;
      if (sp) {
        w = sp.canvas.width; h = sp.canvas.height;
        left = sx - sp.ax; top = baseY - sp.ay;
      } else {
        const fw = this._footprintWidth(cell.params.stage);
        const ww = Number.isFinite(fw) ? fw * 1.4 : GRID;
        w = ww; h = ww * 2; left = sx - ww / 2; top = baseY - h;
      }
      if (bx >= left && bx < left + w && by >= top && by < top + h) {
        if (baseY > bestY) { bestY = baseY; best = cell; } // 가장 앞(아래) 나무 우선
      }
    }
    return best;
  }

  /**
   * 나무 잎 라이브 오버레이(베이크 본체 위 덧그림 — 베이크 무관·재베이크 0).
   * 대상: 활성 그리드 개별 나무 YOUNG·MATURE 만(SAPLING·EMPTY·묶인 숲 군집 제외). 화면 컬링.
   * 세 가지: ①잎 흔들림(수종색·frame 1px) ②햇빛 반짝(좌상·가끔) ③낙엽(동시≤2).
   * 색은 LEAF_PAL 상수 사용(스프라이트 픽셀 샘플 금지). 시드는 칸 위상(팬 불변).
   * render 순서상 나무 blit 다음(위)에 호출 → 잎이 본체 위에 얹힘.
   * @param {CanvasRenderingContext2D} b 백버퍼 ctx
   * @param {number} ox 카메라 적용 유효 원점 x
   * @param {number} oy 카메라 적용 유효 원점 y
   */
  _drawLeafOverlay(b, ox, oy) {
    const MARGIN = GRID * 2;
    const W = this.bufW, H = this.bufH;
    for (const cell of this.cells) {
      if (cell.bundled) continue; // 묶인 숲 군집은 금가루·나비가 담당(여기 제외)
      const st = cell.params.stage;
      if (st !== STAGE.YOUNG && st !== STAGE.MATURE) continue; // SAPLING 생략·EMPTY 제외
      if (!cell.isActive) continue; // 활성 그리드만(과거 나무 제외)
      // 화면 밑동 = _drawTree(_drawGroundAndObjects)와 **동일** 식: gridToScreen + placement offset, baseY=sy+5.
      const sc = gridToScreen(cell.gx, cell.gy, ox, oy);
      const off = cell.placement ? cell.placement.offsetTiles : { x: 0, y: 0 };
      const sx = (sc.x + off.x * TILE) | 0;
      const sy = (sc.y + off.y * TILE) | 0;
      if (sx < -MARGIN || sx > W + MARGIN || sy < -GRID * 4 || sy > H + MARGIN) continue;
      const baseY = sy + 5; // 나무 밑동(땅 접지)
      const crownHalf = (this._footprintWidth(st) * 0.5) | 0; // 수관 반폭
      // 수관 세로 범위(밑동 위). 단계별 키 높이 어림: YOUNG 낮고 MATURE 높음.
      const crownH = st === STAGE.MATURE ? (GRID * 1.5) | 0 : (GRID * 0.9) | 0;
      const crownTop = baseY - 6 - crownH; // 수관 상단 y(화면)
      const crownMidY = (crownTop + (baseY - 6)) / 2; // 수관 중앙 y
      // 칸 위상(월드 시드 — 팬 불변). species = 서버값 우선, 없으면 시드 폴백.
      const ph = hash32(cell.gx + "L" + cell.gy) % 6283 / 1000;
      const sp = cell.params.species != null ? cell.params.species
        : this.sheet.speciesFor(cell.params.seed || cell.params.date);
      const pal = leafPalFor(sp);

      // ① 잎 흔들림: 수관 가장자리 잎 도트 3~6개가 frame 사인 1px 살랑(좌우). 수종 2톤 교차.
      const nSway = st === STAGE.MATURE ? 6 : 3;
      for (let i = 0; i < nSway; i++) {
        const a = ph + i * 2.39963; // 황금각으로 잎 분산
        const rx = Math.cos(a) * crownHalf * 0.85;
        const ry = Math.sin(a * 1.7) * crownH * 0.38;
        const lx0 = (sx + rx) | 0;
        const ly0 = (crownMidY + ry) | 0;
        const wob = Math.round(Math.sin(this.frame * 0.11 + a * 3)); // -1..1 → 1px 살랑
        b.fillStyle = (i & 1) ? pal[1] : pal[0];
        b.fillRect(lx0 + wob, ly0, 1, 1);
      }

      // ② 햇빛 반짝: 수관 **좌상**(햇빛 쪽) 밝은 점 1~2개가 가끔·짧게 점멸(frame+타일 시드).
      //   주기적으로 짧은 창에서만 보이게(과밀 0). 은은한 하이라이트 톤.
      const glPh = hash32(cell.gx + "g" + cell.gy) % 1000;
      const gl = (this.frame + glPh) % 140; // 140프레임 주기
      if (gl < 8) { // 8프레임 창에서만(짧게)
        b.fillStyle = LEAF_HI;
        const gx0 = (sx - crownHalf * 0.5) | 0;
        const gy0 = (crownTop + crownH * 0.25) | 0;
        b.fillRect(gx0, gy0, 1, 1);
        if (st === STAGE.MATURE && gl < 4) b.fillRect(gx0 + 2, gy0 + 1, 1, 1);
      }

      // ③ 낙엽: 나무당 가끔 잎 1장이 수관에서 좌우 지그재그로 하강 → 바닥 근처 페이드. 수종색.
      //   frame+타일 시드로 결정(Math.random 없음·팬 불변). 동시 ≤2(슬롯 2개)·빈도 캡(슬롯 주기 380f).
      const fall = baseY - crownTop + 14; // 낙하 거리(수관 상단~바닥 아래)
      for (let slot = 0; slot < 2; slot++) {
        const sPh = hash32(cell.gx + "f" + slot + cell.gy) % 380;
        const t = (this.frame + sPh) % 380; // 0..379
        if (t >= 120) continue; // 120프레임만 낙하, 나머지(260f)는 없음 → 빈도 캡
        const prog = t / 120; // 0..1 하강 진행
        const fy = (crownTop + prog * fall) | 0;
        const zig = Math.round(Math.sin(prog * 12 + sPh) * 3); // 좌우 지그재그
        const fx = (sx + (slot ? crownHalf * 0.4 : -crownHalf * 0.4) + zig) | 0;
        // 바닥 근처 페이드(마지막 25%): 색을 어두운 톤으로(알파 대신 톤 — 정수 도트 유지).
        b.fillStyle = prog > 0.75 ? pal[1] : pal[0];
        if (prog > 0.9 && (this.frame & 1)) continue; // 끝에서 깜빡 페이드
        b.fillRect(fx, fy, 1, 1);
      }
    }
  }

  /**
   * 마지막 활성 그리드 시각 표식 = 붉은 깃발. 밑동(접지점) = 그 칸 우하단 꼭지점에서 안쪽 5px 고정
   * (나무 형태 무관 — 수관 회피 오프셋은 성목에서 깃발을 옆 칸으로 밀어내 폐기). 깃대는 위로(높이 ≤
   * GRID*0.4), 천만 frame 사인 펄럭(깃대 고정)·칸 안 클램프. 깊이는 Y-sort 큐 편입(_drawGroundAndObjects).
   * gridToScreen 은 칸 중심을 주므로 칸 bbox = 중심 ± GRID/2 로 계산해야 나무와 같은 칸에 놓인다.
   * EMPTY 칸도 동일. 콜드 없음·오버뷰 작게·팬 불변.
   * @param {CanvasRenderingContext2D} b 백버퍼 ctx
   * @param {number} ox 카메라 적용 유효 원점 x
   * @param {number} oy 카메라 적용 유효 원점 y
   */
  _drawLastActiveFlag(b, ox, oy) {
    const cell = this._lastActiveCell();
    if (!cell) return; // 콜드 스타트 — 표식 없음
    const small = this.camera.overview;
    const cellCx = (ox + cell.gx * GRID) | 0; // 칸 중심 x(나무 앵커 기준)
    const cellCy = (oy + cell.gy * GRID) | 0; // 칸 중심 y
    const half = GRID >> 1;
    const cellL = cellCx - half;
    const cellT = cellCy - half;
    const cellR = cellCx + half;
    const cellB = cellCy + half;
    const flagW = small ? 4 : 7; // 천 폭(가로). 천은 깃대서 오른쪽으로 나부낀다.
    const maxWob = 2; // 천 펄럭 최대 우측 변위(아래 wob 식 상한). 칸 클램프에 반영.
    const lean = small ? 1 : 2; // 사선 기울기(꼭대기 x 오프셋)
    // 밑동 = 칸 우하단 꼭지점에서 안쪽 5px(나무 형태 무관·고정).
    const baseY = (cellB - 5) | 0;
    const clothReach = lean + 1 + flagW + maxWob; // cx 기준 천 우측 끝까지의 폭
    let cx = (cellR - 5) | 0; // 우하단 -5px
    if (cx + clothReach > cellR - 1) cx = (cellR - 1 - clothReach) | 0; // 천 우측 끝이 칸 경계 안
    if (cx < cellL + 1) cx = cellL + 1; // 깃대 좌측도 칸 경계 안(좁은 칸 안전)
    const poleH = small ? (GRID * 0.28) | 0 : (GRID * 0.4) | 0; // 깃대 높이 ≤ GRID*0.4(수관 안 닿음)
    // ① 깃대(짙은 막대) — 밑동(cx,baseY)에서 꼭대기(cx+lean, baseY-poleH)로 1~2px 사선.
    const topX = cx + lean, topY = baseY - poleH;
    b.fillStyle = "#4a3b2a"; // 짙은 갈색 깃대
    for (let s = 0; s <= poleH; s++) {
      const t = s / poleH;
      const px = (cx + lean * t) | 0;
      b.fillRect(px, baseY - s, small ? 1 : 1 + (s < poleH * 0.4 ? 1 : 0), 1); // 밑동 약간 굵게
    }
    // ② 붉은 깃발 천(펜넌트) — 깃대 꼭대기에서 오른쪽으로 나부끼는 삼각/사각 천. frame 사인으로 펄럭
    //   (천 가장자리 픽셀이 frame 따라 좌우 파동 → 나부끼는 느낌). 깃대는 고정, 천만 흔들림.
    const flagH = small ? 3 : 5; // 천 높이(세로). flagW 는 위 앵커 블록에서 선언(cx 계산 공용).
    const ph = (hash32(cell.gx + "f" + cell.gy) % 1000) / 1000 * 6.283; // 칸 위상(팬 불변)
    for (let fy = 0; fy < flagH; fy++) {
      // 행마다 펄럭 파동(아래 행일수록 더 흔들림 — 천 끝이 더 나부낌).
      const wob = Math.round(Math.sin(this.frame * 0.18 + ph + fy * 0.7) * (0.4 + fy * 0.35));
      // 펜넌트(삼각): 위쪽 행은 길게, 아래로 갈수록 짧게(깃발 끝 뾰족).
      const rowLen = Math.max(1, flagW - (fy >= flagH - 1 ? flagW - 2 : (fy * 2) | 0));
      const ry = topY + fy + 1; // 천은 깃대 꼭대기 살짝 아래부터
      for (let fx = 0; fx < rowLen; fx++) {
        const rx = topX + 1 + fx + (fx > rowLen - 2 ? wob : Math.round(wob * (fx / rowLen)));
        // 천 음영: 끝쪽·펄럭 깊은 곳 약간 어두운 빨강.
        b.fillStyle = (fx > rowLen * 0.6 || wob < 0) ? "#a82828" : "#e23434";
        b.fillRect(rx | 0, ry, 1, 1);
      }
    }
  }

  /**
   * 안정 콘텐츠 시그니처: 폴링 응답이 내용 불변이면 스냅샷·캐시를 안 건드리기 위한 비교 키.
   * generatedAt 같은 비콘텐츠 필드는 제외하고 배치·각 날짜 stage/seed/usage 5메트릭·묶임·드릴다운만
   * 반영 → 같은 내용 = 같은 문자열 → setData 가 재배치/재베이크/스냅샷 무효화를 모두 건너뛴다.
   * @param {object[]} cellList forestCellParams (date 오름차순)
   * @param {object} placementMap {date:{gx,gy}}
   * @returns {string}
   */
  _contentSignature(cellList, placementMap) {
    const parts = [];
    parts.push("dd:" + (this.drilldownMonth || ""));
    // 배치(활성 날짜→그리드 좌표). 키 정렬로 안정.
    const pk = Object.keys(placementMap).sort();
    for (const d of pk) parts.push("p:" + d + "=" + placementMap[d].gx + "," + placementMap[d].gy);
    // 묶인 달 시그니처(forests 의 bundled 상태가 셀의 bundled 를 결정).
    const fk = Object.keys(this.forests || {}).sort();
    for (const ym of fk) {
      const f = this.forests[ym];
      if (f && f.bundled) parts.push("b:" + ym);
    }
    // 각 날짜 셀 내용(stage·seed·usage). 성목 하위프레임(stageProgress 3구간)도 반영 —
    //   진행도가 하위프레임 경계를 넘으면 시트 프레임이 바뀌므로 재베이크가 일어나야 한다.
    for (const c of cellList) {
      const r = c.raw || {};
      const sub = this._subFrame(c.stage, c.stageProgress);
      parts.push(
        "c:" + c.date + "|" + c.stage + "|" + sub + "|" + (c.seed || "") + "|" +
        r.input + "," + r.output + "," + r.cacheWrite + "," + r.cacheRead + "," + r.requests
      );
    }
    return parts.join(";");
  }

  /**
   * 새 데이터 반영(재배치·베이크·카메라·HUD 갱신). 내용 불변 폴이면 전부 건너뛴다.
   * @param {object[]} cellList forestCellParams (date 오름차순)
   * @param {Set<string>|null} changedDates 변경된 날짜(강제 재베이크 대상)
   * @param {object} placementMap {date:{gx,gy}} (active 인 날만)
   */
  setData(cellList, changedDates, placementMap) {
    const map = placementMap || {};
    // 내용 불변 폴 → 전부 건너뛴다(재배치·재베이크·스냅샷 무효화 0).
    const sig = this._contentSignature(cellList, map);
    if (this._contentSig === sig && this.cells.length > 0) {
      // HUD 만 갱신(파생 표시값은 동일하지만 generatedAt 등 비콘텐츠는 main 이 따로 처리). 렌더 무변.
      return;
    }
    this._contentSig = sig;
    // 상세 모달 "평균 대비 ▲▼" 모수: 활성일 5메트릭 평균을 폴(콘텐츠 변경)마다 1회 캐시.
    //   매 상세 표시마다 전체 재계산하지 않게 여기서 1회만(EMPTY·사용 0 날 제외는 metricAverages 내부).
    this._metricAvg = metricAverages(cellList);
    // 배치된(active) 날이 하나도 없으면 빈 대지(흙만). cellList 자체는 비어있지 않을 수 있다.
    this.empty = Object.keys(map).length === 0;
    this.cells = layoutByPlacements(cellList, map);

    // 숲 계층: 묶인 달이고 펼침(drilldown) 아닌 셀은 개별 나무 대신 숲 한 덩어리로 시각 교체.
    for (const cell of this.cells) {
      const ym = cell.params.date.slice(0, 7);
      const f = this.forests[ym];
      cell.bundled = !!(f && f.bundled) && this.drilldownMonth !== ym;
    }

    this.cellByKey.clear();
    const liveDates = new Set();
    for (const cell of this.cells) {
      liveDates.add(cell.params.date);
      this.cellByKey.set(cell.gx + "," + cell.gy, cell);
      // 방향성 배치(형태 재생성 시드 = tree.seed 로 결정적 재계산).
      cell.placement = gridPlacement(cell.params.seed || cell.params.date, cell.params.stage);
      const needBake =
        !this.bakedByDate.has(cell.params.date) ||
        (changedDates && changedDates.has(cell.params.date));
      if (cell.params.stage === STAGE.EMPTY) {
        this.bakedByDate.set(cell.params.date, buildTree(cell.params, 0));
      } else if (needBake) {
        const scale = STAGE_SCALE[cell.params.stage] ?? 1;
        const maxWidth = this._footprintWidth(cell.params.stage);
        // placement.corner 로 수관 무게 방향 부여(점유는 나무 크기로).
        this.bakedByDate.set(
          cell.params.date,
          buildTree(cell.params, scale, maxWidth, cell.placement)
        );
        // 형태가 재베이크되면 그 날짜의 스프라이트 캐시(양 톤·모든 stage)도 무효화.
        this._invalidateSprite(cell.params.date);
      }
    }
    for (const date of [...this.bakedByDate.keys()]) {
      if (!liveDates.has(date)) {
        this.bakedByDate.delete(date);
        this._invalidateSprite(date); // 사라진 날 스프라이트도 제거
      }
    }

    this._computeForestBlobs(); // 묶인 달 → 숲 실루엣(나무 수·총사용량으로 크기/밀도)
    this._computeHorizon(); // 월드 북쪽 지평선(나무가 하늘에 안 뜨게)

    // 카메라: 셀이 늘면 줌 한계 갱신·zoom 클램프. 첫 데이터 1회만 콘텐츠 중심으로 배치.
    //   이후 폴링/활성화는 카메라를 끌어오지 않는다.
    this.camera._updateZoomLimits();
    this.camera.cam.zoom = Math.max(this.camera.zoomMin, Math.min(this.camera.zoomMax, this.camera.cam.zoom));
    this._recompute();
    if (!this.camera._centered) {
      // 첫 데이터 1회만 콘텐츠 중심. 콜드 스타트(cells 0)는 중심 잡을 콘텐츠가 없으니 플래그만
      //   세운다 — 안 그러면 첫 나무를 심는 순간 _centerOnContent 가 심은 위치를 센터로 끌어온다.
      if (this.cells.length > 0) {
        this.camera.cam.zoom = this.camera.zoomMin; // 시작은 개요(배치 콘텐츠 전체 보임)
        this._recompute();
        this.camera._centerOnContent();
      }
      this.camera._centered = true;
    } else {
      this.camera._clampPan();
    }

    this._rebuildHud(cellList);
    // 여기까지 왔다는 건 콘텐츠가 실제로 바뀐 것(내용 불변 폴은 위에서 조기 반환) → 무효화는 진짜 변경 시만.
    this._invalidateSnapshot();
    // 성목 파티클 발생원은 카메라가 움직이면 화면 위치가 바뀌므로 render() 에서 매 프레임 계산.

    // 선택/호버 셀을 새 스냅샷의 같은 날짜로 재바인딩(폴링 갱신에도 패널 유지). 없어지면 해제.
    const rebind = (c) =>
      c ? this.cells.find((x) => x.params.date === c.params.date) || null : null;
    this.selectedCell = rebind(this.selectedCell);
    this.hoverCell = rebind(this.hoverCell);
  }

  /** 숲 목록 설정(폴링마다). @param {object} forestsMap { ym: { bundled, bundledAt, monthly } } */
  setForests(forestsMap) {
    this.forests = forestsMap || {};
  }
  /** 드릴다운: 묶인 달을 일 그리드로 펼침(null=펼침 없음). @param {string|null} ym */
  setDrilldown(ym) {
    this.drilldownMonth = ym || null;
  }
  /** @returns {string|null} 현재 드릴다운 중인 달 ym */
  isDrilldown() {
    return this.drilldownMonth;
  }

  /**
   * 묶인(펼침 아닌) 달마다 숲 군집(blob)을 산출. 멤버 셀(그리드) 좌표 목록을 보존해 나무를 각 멤버
   * 셀의 실제 그리드 영역에 심으므로 군집 모양 = 그리드 묶음 모양(드릴다운 전후 위치 자동 일치).
   */
  /**
   * 단위4 식생 트윅 적용(디버그 슬라이더 전용). VEG_TWEAKS 키 1개를 갱신하고, 필요한 재계산만 한다.
   *   - 일반 폴 무영향: 이 메서드는 슬라이더 드래그(명시적 트윅) 시에만 호출된다. _contentSignature·setData
   *     시그니처에는 VEG_TWEAKS 가 안 들어가므로 같은 내용 폴 → 재베이크 0·무효화 0(§28 프리즈 0).
   *   - shadow·grass: 바닥 라이브 패스라 다음 프레임 자동 반영. 재계산 불필요.
   *   - boundaryNoise: 경계도 라이브 ground 패스라 자동 반영. (둘 다 오버뷰 스냅샷엔 구워져 있어 무효화.)
   *   - forestDensityCoef: 군집 density 가 바뀌므로 _computeForestBlobs 재실행 → density 시그니처 변경 →
   *     _computeForestClusters 가 그 달 forestSprites/forestTrees 무효화·재베이크.
   * @param {string} key VEG_TWEAKS 키
   * @param {number} val 새 값
   */
  setVegTweak(key, val) {
    if (!Object.prototype.hasOwnProperty.call(VEG_TWEAKS, key)) return;
    VEG_TWEAKS[key] = val;
    if (key === "forestDensityCoef") {
      // 군집 밀도 재산출 → sig 변경 → 군집 스프라이트 재베이크(명시적 트윅이라 §28 예외).
      this._computeForestBlobs();
    }
    // 바닥·경계·숲은 오버뷰 스냅샷에 구워져 있으므로 무효화(다음 합성에서 새 트윅 반영, 이중버퍼로 플래시 0).
    this._invalidateSnapshot();
  }

  /** 현재 VEG_TWEAKS 스냅샷(트윅 패널 초기값용). */
  getVegTweaks() {
    return { ...VEG_TWEAKS };
  }

  _computeForestBlobs() {
    const byMonth = new Map();
    for (const cell of this.cells) {
      if (!cell.bundled) continue;
      const ym = cell.params.date.slice(0, 7);
      if (!byMonth.has(ym)) byMonth.set(ym, []);
      byMonth.get(ym).push(cell);
    }
    const blobs = [];
    for (const [ym, cells] of byMonth) {
      let sx = 0, sy = 0, trees = 0, total = 0;
      // 멤버 셀 좌표 목록(buildForest 입력). 실제 그리드 발자국이 군집 모양을 정한다.
      const members = [];
      for (const c of cells) {
        sx += c.gx; sy += c.gy;
        if (c.params.stage !== STAGE.EMPTY) trees++;
        total += c.params.xp || 0;
        members.push({ gx: c.gx, gy: c.gy, xp: c.params.xp || 0, stage: c.params.stage });
      }
      const n = cells.length || 1;
      // centroid(히트테스트·호환용만 — 배치엔 안 씀).
      const cgx = sx / n, cgy = sy / n;
      // 밀도: 총사용량(로그) → 그루 밀도·단계분포. monthly.totalTokens 있으면 그걸 우선.
      const f = this.forests[ym];
      const monthlyTotal = f && f.monthly ? (f.monthly.totalTokens || total) : total;
      // VEG_TWEAKS.forestDensityCoef(단위4 트윅): 군집 그루 밀도 계수. density 가 sig 에 들어가
      //   (_computeForestClusters) 계수가 바뀌면 다음 _computeForestBlobs 에서 sig 가 달라져 재베이크된다.
      //   단 일반 폴은 setData 가 _contentSig 로 조기반환 → 이 함수 자체가 안 불려 재베이크 0(§28).
      const densRaw = Math.log10(1 + monthlyTotal) / 8 * VEG_TWEAKS.forestDensityCoef;
      const density = Math.max(0.2, Math.min(1, densRaw));
      blobs.push({ ym, cgx, cgy, members, density, trees, dayCount: n });
    }
    this.forestBlobs = blobs;
    this._computeForestClusters(blobs);
  }

  // 숲 = 멤버 셀 좌표 기반 나무 군집: 각 묶인 달마다 멤버 셀들의 실제 그리드 영역 안에
  //   나무를 심고(ym+셀좌표 시드, 화면 무관), 그루별 buildTree 결과를 ym 단위로 캐시(프레임마다
  //   재생성 금지). 좌표는 월드 px 절대값 → 카메라 팬에도 안 흔들림.
  _computeForestClusters(blobs) {
    const live = new Set(blobs.map((fb) => fb.ym));
    // 사라진 달(드릴다운·언번들) 캐시 제거 + 그 달 군집 스프라이트도 무효화.
    for (const ym of [...this.forestTrees.keys()]) {
      if (!live.has(ym)) {
        this.forestSprites.delete(ym);
        this.forestTrees.delete(ym);
      }
    }
    for (const fb of blobs) {
      // 캐시 키 = ym + 멤버 셀 집합 + 밀도. 멤버/밀도 바뀌면 재베이크.
      const memSig = fb.members.map((m) => m.gx + "," + m.gy + ":" + m.stage).join(";");
      const sig = `${memSig}|${fb.density.toFixed(3)}`;
      const cached = this.forestTrees.get(fb.ym);
      if (cached && cached.sig === sig) continue;
      // 멤버/밀도 변화 → 이전 달 스프라이트 무효화(명시 제거로 stale 캔버스 즉시 GC 대상화).
      this.forestSprites.delete(fb.ym);
      const forest = buildForest({
        ym: fb.ym,
        cells: fb.members,
        density: fb.density,
        originX: this.worldOriginX,
        originY: this.worldOriginY,
      });
      // 그루별 나무 형태 베이크(결정적 seed). 작은 스케일이라 가볍다.
      for (const inst of forest.instances) {
        const params = {
          sim: {
            maxHeight: 30 + fb.density * 30,
            resourceCount: 14,
            leafSize: 1.0 + fb.density * 1.2,
            leafCount: 3,
            baseThickness: 0.8 + fb.density * 1.2,
            distribution: "uniform",
            lightSensitivity: 0.4,
          },
          norms: { outputN: 0.35 + fb.density * 0.3 },
          stage: inst.stage,
          seed: inst.seed,
          date: inst.seed,
        };
        const placement = gridPlacement(inst.seed, inst.stage);
        inst.baked = buildTree(params, inst.scale, Infinity, placement);
      }
      // 베이크 캔버스 bounds = 그루 실제 그릴 사각 합집합(∪ 바닥 ∪ 풀잎 결). 군집 외곽 나무 세로
      //   직선 잘림 방지를 위해 forest.bbox(footprint) 대신 drawBBox/drawUp/drawDown 으로 정합.
      //   바닥·bounds 는 닫힌 발자국(closedCells = 멤버 + 브리지)으로 — 코너 갭이 메워져 한 덩어리.
      const floorCells = forest.closedCells || fb.members;
      const draw = this._computeClusterDrawBounds(forest, floorCells);
      this.forestTrees.set(fb.ym, {
        sig,
        instances: forest.instances,
        bbox: forest.bbox,
        up: forest.up,
        down: forest.down,
        // 그릴 사각 합집합 기준(베이크·extent·컬링 공통).
        drawBBox: draw.drawBBox,
        drawUp: draw.drawUp,
        drawDown: draw.drawDown,
        members: floorCells, // 군집 바닥(닫힌 셀 발자국)용
      });
    }
    // C: 모든 살아있는 군집의 닫힌 발자국(closedCells)을 한 집합에 모은다. 캐시가 증분(미변경 달은
    //   continue)이라도 매번 전 군집을 순회해 재구성한다 — 드릴다운/언번들로 사라진 달이 빠져야 한다.
    //   순수 파생(렌더용)이라 베이크·무효화와 무관.
    this.bundledFootprint = new Set();
    for (const [ym, ft] of this.forestTrees) {
      if (this.drilldownMonth === ym) continue; // 펼친 달은 일 그리드로 — 숲 바닥 아님
      for (const m of ft.members || []) this.bundledFootprint.add(m.gx + "," + m.gy);
    }
  }

  setOffline(v) {
    this.offline = v;
  }
  setGeneratedAt(ts) {
    this.generatedAt = ts;
  }

  // 성목 파티클 발생원(화면 px). 매 프레임 카메라 반영해 계산.
  //   성목 크라운 중심·반경을 화면 좌표로. ox/oy = 유효 원점.
  _rebuildParticleSources(ox, oy) {
    const sources = [];
    for (const cell of this.cells) {
      if (cell.params.stage !== STAGE.MATURE) continue;
      if (cell.bundled) continue; // 묶인 달은 숲 군집으로 표시 — 개별 파티클 발생원 제외
      const baked = this.bakedByDate.get(cell.params.date);
      if (!baked) continue;
      const off = cell.placement ? cell.placement.offsetTiles : { x: 0, y: 0 };
      const sx = ox + cell.gx * GRID + off.x * TILE;
      const sy = oy + cell.gy * GRID + off.y * TILE;
      const baseY = sy + 5;
      // 캐시읽기 → 일 나무 금가루 weight. 그 날 cacheReadN(0~1) 비례. 0.3~2 클램프(40캡·독점 방지).
      const crN = (cell.params.norms && cell.params.norms.cacheReadN) || 0;
      const weight = Math.max(0.3, Math.min(2, 0.3 + crN * 1.7));
      // 시트 사용 시 파티클 발생원 = 스프라이트 수관 영역(상단 중앙 부근)으로 근사.
      //   시트 나무는 절차보다 작으므로 sheet sprite 높이로 크라운 중심·반경을 잡는다(없으면 절차).
      const sub = this._subFrame(cell.params.stage, cell.params.stageProgress);
      const key = "d|" + cell.params.date + "|" + (cell.isActive ? "L" : "P") + "|" + cell.params.stage + "|s" + sub;
      const sp = this.spriteCache.get(key);
      if (this._useSheet() && sp) {
        // 수관 ≈ 스프라이트 상단 ~55% 영역. 중심을 그 중앙에, 반경은 폭/높이 기반.
        const sh = sp.canvas.height, sw = sp.canvas.width;
        const crownCenterFromBase = sh * 0.62; // 밑동에서 위로(상단 수관 중심)
        sources.push({
          id: cell.params.date,
          cx: sx,
          cy: baseY - crownCenterFromBase,
          r: Math.max(6, Math.min(sw, sh) * 0.3),
          weight, // 캐시읽기 비례
        });
      } else {
        // 크라운 중심·반경(시뮬→화면). crownMinY/Max 로 대략.
        const cyMid = (baked.crownMinY + baked.crownMaxY) / 2;
        const r = (baked.crownMaxY - baked.crownMinY) / 2;
        sources.push({
          id: cell.params.date,
          cx: sx,
          cy: baseY - cyMid,
          r: Math.max(6, r),
          weight, // 캐시읽기 비례
        });
      }
    }
    // 묶인 달(숲 군집)도 구운 스프라이트 위에 라이브 금가루(베이크 무관, 매 프레임).
    //   발생원 = 군집 월드 bbox 상단 영역(수관 위). 강도(weight) ∝ 그 달 cacheReadTokens(개수 대신
    //   weight 로 — 40캡 유지). cacheReadTokens 없으면 totalTokens 폴백. 화면 밖 군집은 컬링.
    for (const fb of this.forestBlobs) {
      const cluster = this.forestTrees.get(fb.ym);
      if (!cluster || !cluster.bbox) continue;
      const bb = cluster.drawBBox || cluster.bbox;
      const sx0 = ox + (bb.x0 - this.worldOriginX);
      const sx1 = ox + (bb.x1 - this.worldOriginX);
      const sy0 = oy + (bb.y0 - this.worldOriginY);
      const sy1 = oy + (bb.y1 - this.worldOriginY);
      // 화면 밖 컬링(여유 GRID).
      if (sx1 < -GRID || sx0 > this.bufW + GRID || sy1 < -GRID || sy0 > this.bufH + GRID) continue;
      const f = this.forests[fb.ym];
      const m = (f && f.monthly) || {};
      const tok = m.cacheReadTokens || m.totalTokens || 0; // 우선 cacheRead, 폴백 total
      // 로그 스케일: 토큰 수억~수십억을 선형으로 weight 에 넣으면 한 숲이 40캡 독점. log10 으로 압축.
      const weight = Math.max(0.3, Math.min(3, Math.log10(1 + tok) / 4));
      sources.push({
        id: "F:" + fb.ym,
        cx: (sx0 + sx1) / 2,
        cy: sy0 + (sy1 - sy0) * 0.32, // 수관 상단 영역(군집 위)
        rx: Math.max(8, (sx1 - sx0) / 2), // 가로로 넓게 부유(타원 영역)
        r: Math.max(8, (sy1 - sy0) * 0.3),
        weight,
      });
    }
    this.particles.setSources(sources);
  }

  // 로그정규화 역변환 → 표시용 실값 복원 (metrics 가 raw 토큰을 안 넘겨주므로).
  // v = 10^(norm * log10(1+REF)) - 1
  _recover(norm, ref) {
    if (norm <= 0) return 0;
    return Math.round(Math.pow(10, norm * Math.log10(1 + ref)) - 1);
  }

  // HUD 집계: 활성(오늘) 셀 메트릭 + 파생값(Oxygen, Forest Level).
  _rebuildHud(cellList) {
    let active = null;
    for (const c of cellList) active = c; // 마지막(최신)
    const n = active ? active.norms : { inputN: 0, outputN: 0, cacheWriteN: 0, cacheReadN: 0, requestN: 0 };

    // Oxygen: 고목(과거 비활성, 나무가 선 셀) 수 기반 단순 파생값(표시용만).
    let oxygen = 0;
    for (const c of cellList) {
      if (c.stage !== STAGE.EMPTY) oxygen++;
    }
    // 활성 셀 1개는 "살아있는 나무"라 고목에서 제외(있으면).
    if (active && active.stage !== STAGE.EMPTY) oxygen = Math.max(0, oxygen - 1);

    // Forest Level: 누적 마일스톤(데이터 있는 날 수) 기반 단순 단계. (완전한 경제 아님)
    const treeDays = cellList.filter((c) => c.stage !== STAGE.EMPTY).length;
    const level = 1 + Math.floor(treeDays / 5);

    this.hud = {
      input: this._recover(n.inputN, REF.input),
      output: this._recover(n.outputN, REF.output),
      cacheWrite: this._recover(n.cacheWriteN, REF.cacheWrite),
      cacheRead: this._recover(n.cacheReadN, REF.cacheRead),
      requests: this._recover(n.requestN, REF.requestCount),
      oxygen,
      level,
    };
  }

  // ===================== 렌더 루프 =====================
  /**
   * 시간대 하늘 시각을 고정 주입(테스트·스냅샷 결정성). 호출하면 render 가 시계를 다시 안 읽는다.
   * @param {number} hour 0~24 (시 + 분/60)
   */
  setSkyHour(hour) {
    this._skyHour = hour;
    this._skyHourPinned = true;
  }

  // 로컬 시각(시 + 분/60) 1 회 읽기 — Date 접근을 이 한 곳에만 격리(skyColorsAt 은 순수 유지).
  //   비브라우저(테스트)에서도 동작하나, 결정성을 위해 테스트는 setSkyHour 로 고정 주입한다.
  _readClockHour() {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  }

  render() {
    this.frame++;
    this._bakesThisFrame = 0; // 프레임 베이크 예산 리셋
    // 시간대 하늘: 외부 고정 주입이 없으면 진입에서 시각을 1회 읽어 상태로 둔다(이후 _drawSky·
    //   _renderOverview 가 이 주입값으로 skyColorsAt 호출). 하늘은 라이브(스냅샷 미포함)라 재베이크 0.
    if (!this._skyHourPinned) this._skyHour = this._readClockHour();
    this.camera._stepCamAnim(); // 카메라 포커스 보간(있으면 1프레임 진행). 오버뷰 해제는 focusLastActive 가 함.
    // 오버뷰: 맵 전체 스냅샷을 축소 blit + 하늘만. 매 프레임 칠 비용 = drawImage 1회.
    if (this.camera.overview) {
      this._renderOverview();
      return;
    }
    const b = this.bctx;
    const W = this.bufW;
    const H = this.bufH;

    // 월드 지평선의 화면 y. 이 위는 하늘, 아래는 땅. 카메라 따라 같이 움직인다.
    const screenHorizonY = Math.round(this.worldHorizonY - this.camera.cam.y);

    this._drawSky(b, W, H, screenHorizonY);
    this._drawGroundAndObjects(b, W, H, screenHorizonY);

    // 카메라 적용 유효 원점(파티클·좌표 패스 공용).
    const ox = Math.round(this.worldOriginX - this.camera.cam.x);
    const oy = Math.round(this.worldOriginY - this.camera.cam.y);

    // 마우스 오버 강조: 호버 칸·묶인 숲 footprint 외곽에 옅은 녹색 외곽선(움직임 없음). 나무 위.
    this._drawHoverHighlight(b, ox, oy);

    // 성목 부유 파티클: 발생원(화면 px) 갱신 → 진행 → 그리기(나무 위).
    this._rebuildParticleSources(ox, oy);
    this.particles.update();
    this._drawAmbientParticles(b);
    // 묶인 숲 수관 위 나비 두어 마리 배회(라이브, 베이크 무관). 금가루(파티클)와 별개.
    this._drawForestButterflies(b, ox, oy);

    // 나무 잎 라이브 오버레이(활성 YOUNG·MATURE 개별 나무 위 — 흔들림·햇빛 반짝·낙엽). 베이크 무관.
    this._drawLeafOverlay(b, ox, oy);

    // 깃발은 _drawGroundAndObjects 의 Y-sort 큐(kind:"flag")에서 그린다.

    // 좌표 패스(최상단): 뷰포트에 보이는 모든 그리드 칸(빈 칸 포함)에 (gx,gy) 를 그린다.
    //   디버그 모드 전용(디버그 모드, main.js 가 renderer.debug 설정). 기본 OFF.
    if (this.debug) this._drawCoordLabels(b, W, H, ox, oy, screenHorizonY);

    // 업스케일. 캔버스는 숲(월드)만 그린다. HUD·툴팁·상세는 DOM 오버레이(main.js).
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
  }

  // 오버뷰 렌더: 하늘 그라데이션 + 맵 스냅샷(하단 고정) 축소 blit. 매 프레임 가벼움.
  //   맵은 화면 **너비**에 맞춰 축소(scale = vpW/mapW), 하단 고정·위는 하늘. 좌표/파티클 생략.
  _renderOverview() {
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const snap = this._ensureMapSnapshot();
    c.imageSmoothingEnabled = false;
    // 하늘(위 전체). 그라데이션은 맵 상단까지. 일반 모드 _drawSky 와 같은 시간대 색(주입 시각).
    const mapTop = snap ? Math.round(H - snap.snapH) : 0;
    const skyBottom = Math.max(0, Math.min(H, mapTop));
    const sky = skyColorsAt(this._skyHour == null ? 12 : this._skyHour);
    const c0 = sky.skyTop, c1 = sky.skyBot;
    for (let y = 0; y < skyBottom; y++) {
      const t = skyBottom > 1 ? y / (skyBottom - 1) : 0;
      const r = (c0.r + (c1.r - c0.r) * t) | 0;
      const g = (c0.g + (c1.g - c0.g) * t) | 0;
      const bl = (c0.b + (c1.b - c0.b) * t) | 0;
      c.fillStyle = `rgb(${r},${g},${bl})`;
      c.fillRect(0, y, W, 1);
    }
    if (mapTop < H) {
      c.fillStyle = `rgb(${c1.r},${c1.g},${c1.b})`;
      if (mapTop > skyBottom) c.fillRect(0, skyBottom, W, mapTop - skyBottom);
    }
    // 오버뷰 하늘에도 구름(일반 모드 _drawSky 와 동일 흐름, 매 프레임 — 비용 미미).
    const drift = (this.frame * 0.12) % (W + 60);
    for (let i = 0; i < 5; i++) {
      const cx = ((i * 150 + drift) % (W + 60)) - 30;
      const cy = 6 + (i % 3) * Math.max(10, Math.round((skyBottom - 24) / 3));
      if (cy + 16 < skyBottom) this._cloud(c, cx | 0, cy, 1 + (i % 2) * 0.3);
    }
    if (snap) {
      // 스냅샷은 이미 맵 폭=화면 폭으로 베이크됨 → 1:1 blit(추가 스케일 없음, 픽셀 또렷).
      c.drawImage(snap.canvas, 0, mapTop);
    }
  }

  // 맵 스냅샷 보장 — 점진(progressive) 베이크. 풀해상 임시 캔버스에 _drawGroundAndObjects 를
  //   프레임마다 1회씩 유한 베이크 예산으로 다시 그린다. 군집·나무 스프라이트는 점진 베이크로 캐시에
  //   차오르고, 재-그리기는 캐시된 스프라이트만 blit → 프레임당 픽셀 작업 상한(< 100ms) 유지. 모든
  //   가시 스프라이트가 준비되면 1회 다운스케일해 _mapSnapshot 에 확정. 진행 중에는 (a) 직전 완성본,
  //   (b) 없으면 진행 중 캔버스의 저해상 임시본을 보여 화면이 비지 않는다.
  // 스냅샷 무효화 = 이중 버퍼 stale 표시. 직전 완성본은 그대로 두고 _mapSnapshotStale=true 로만 표시
  //   → 새 합성이 끝날 때까지 직전 완성본이 계속 나간다(원자 교체). 완성본이 없으면(콜드) null 유지.
  _invalidateSnapshot() {
    if (this._mapSnapshot) this._mapSnapshotStale = true; // 완성본 유지(원자 교체 대기)
    this._snapBuilder = null;
    this._snapProvisional = null;
  }

  _ensureMapSnapshot() {
    // 신선한(stale 아님) 완성본이면 그대로. 없거나 stale 이면 한 프레임치 재합성을 전진시키되,
    //   _advanceMapSnapshot 이 완성 전까지 stale 완성본을 표시 소스로 돌려준다(플래시 0).
    if (this._mapSnapshot && !this._mapSnapshotStale) return this._mapSnapshot;
    return this._advanceMapSnapshot();
  }

  // 한 프레임치 스냅샷 베이크 전진. 2단계로 비차단:
  //   ① 워밍업 단계: 가시 군집·셀 나무 스프라이트를 프레임당 예산만큼 점진 베이크만 한다(풀해상
  //      ground 패스 없음). 화면엔 직전 완성본 또는 간이 저해상 임시본으로 채워 빈 화면 방지.
  //   ② 합성 단계: 모든 스프라이트가 준비되면(_snapAllBaked) 딱 한 번 풀 _drawGroundAndObjects
  //      (캐시된 스프라이트만 blit) → 1회 다운스케일 → 확정.
  //   풀맵 ground 패스를 빌드 내내 매 프레임 반복하던 것을 마지막 1프레임으로 옮긴다.
  _advanceMapSnapshot() {
    const vp = this._viewport();
    const m = this._mapWorldBounds();
    const mapW = m.x1 - m.x0, mapH = m.y1 - m.y0; // 5400×2160 (GRID=54)
    const scale = vp.w / mapW;
    const snapW = Math.max(1, Math.round(mapW * scale));
    const snapH = Math.max(1, Math.round(mapH * scale));

    // ① 워밍업: 가시 스프라이트를 예산만큼 굽는다(풀맵 ground 패스 없이). 카메라 임시 변경 불필요.
    this._bakesThisFrame = 0;
    this._warmSnapshotSprites();
    const allDone = this._snapAllBaked();

    if (!allDone) {
      // 이중 버퍼: 재합성이 끝나기 전엔 직전 완성본(stale)을 계속 표시한다(원자 교체 대기).
      //   완성본이 아예 없을 때만(콜드 스타트) 저해상 임시본을 노출.
      if (this._mapSnapshot) return this._mapSnapshot;
      if (!this._snapProvisional || this._snapProvisional.snapW !== snapW) {
        this._snapProvisional = this._buildProvisionalSnapshot(m, snapW, snapH, scale);
      }
      return this._snapProvisional;
    }

    // ② 합성(완성): 풀해상 1회 그리기 → 다운스케일. 가짜 카메라 + UI 강조 비움. 종료 후 복원.
    const tmp = document.createElement("canvas");
    tmp.width = mapW; tmp.height = mapH;
    const tctx = tmp.getContext("2d");
    tctx.imageSmoothingEnabled = false;
    const saved = {
      cam: this.camera.cam,
      candidateSlots: this.candidateSlots,
      selectedSlot: this.selectedSlot,
      cursorGrid: this.cursorGrid,
      plantFx: this.plantFx,
      hoverSlot: this.hoverSlot,
      bundleFx: this.bundleFx,
    };
    this.camera.cam = { x: m.x0, y: m.y0, zoom: 1 };
    this.candidateSlots = [];
    this.selectedSlot = null;
    this.cursorGrid = null;
    this.plantFx = null;
    this.hoverSlot = null;
    this.bundleFx = null;
    this._forceDetail = true;
    this._snapComposite = true; // 합성 LOD(결 텍스처·장식 생략, 나무/숲/흙 유지)
    this._bakesThisFrame = 0; // 모든 스프라이트 캐시됨 → 이 패스는 blit 만(새 베이크 0)
    try {
      const hY = Math.round(this.worldHorizonY - this.camera.cam.y);
      this._drawGroundAndObjects(tctx, mapW, mapH, hY);
    } finally {
      this._forceDetail = false;
      this._snapComposite = false;
      this.camera.cam = saved.cam;
      this.candidateSlots = saved.candidateSlots;
      this.selectedSlot = saved.selectedSlot;
      this.cursorGrid = saved.cursorGrid;
      this.plantFx = saved.plantFx;
      this.hoverSlot = saved.hoverSlot;
      this.bundleFx = saved.bundleFx;
    }
    const cv = document.createElement("canvas");
    cv.width = snapW; cv.height = snapH;
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, 0, 0, snapW, snapH);
    const snap = { canvas: cv, snapW, snapH, scale, offX: m.x0, offY: m.y0 };
    // 원자 교체: 새 완성본 준비 완료 → 직전 완성본을 이 순간 한 번에 교체. stale 해제.
    this._mapSnapshot = snap;
    this._mapSnapshotStale = false;
    this._snapBuilder = null;
    this._snapProvisional = null;
    return snap;
  }

  // 워밍업: 가시(맵 안 전부) 군집·셀 나무 스프라이트를 프레임당 예산만큼 점진 베이크.
  //   풀맵 ground 패스 없이 스프라이트 캐시만 채운다(가벼움). 군집은 cluster.bbox 가 있으면 모두 대상.
  _warmSnapshotSprites() {
    // 군집 먼저(무거운 쪽). _forestSprite 가 청크 단위로 굽고 예산 소비.
    for (const fb of this.forestBlobs) {
      const cluster = this.forestTrees.get(fb.ym);
      if (!cluster || !cluster.bbox) continue;
      if (this._bakesThisFrame >= this._frameBakeBudget) return;
      this._forestSprite(fb.ym, cluster);
    }
    // 셀 나무: 미캐시분만 예산 내에서 굽는다.
    for (const cell of this.cells) {
      if (cell.bundled || cell.params.stage === STAGE.EMPTY) continue;
      if (this._bakesThisFrame >= this._frameBakeBudget) return;
      const baked = this.bakedByDate.get(cell.params.date);
      if (!baked) continue;
      const live = cell.isActive;
      const P = live ? PAL : PAL_PAST;
      const ds = live ? 1.0 : 0.85;
      const sd = cell.params.seed || cell.params.date;
      const sub = this._subFrame(cell.params.stage, cell.params.stageProgress);
      const key = "d|" + cell.params.date + "|" + (live ? "L" : "P") + "|" + cell.params.stage + "|s" + sub;
      if (this.spriteCache.has(key)) continue;
      const sheetInfo = {
        // 수종 = 서버 데이터값(params.species) 우선, 없으면 speciesFor(seed) 폴백(하위호환).
        species: cell.params.species != null ? cell.params.species : this.sheet.speciesFor(sd),
        stage: cell.params.stage,
        stageProgress: cell.params.stageProgress,
        past: !live,
      };
      this._treeSprite(key, baked, P, ds, sd, true, sheetInfo);
    }
  }

  // 간이 저해상 임시본: 완성 전 화면용. 풀밭 한 톤 + 묶인 군집 발자국을 옅은 숲 블록으로 대략 표시.
  //   절차 픽셀 루프 없이 fillRect 몇 개 — 매우 가볍다.
  _buildProvisionalSnapshot(m, snapW, snapH, scale) {
    const cv = document.createElement("canvas");
    cv.width = snapW; cv.height = snapH;
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.fillStyle = PAL.grassA;
    g.fillRect(0, 0, snapW, snapH);
    // 묶인 군집 위치 대략 표시(완성 전에도 "여기 숲이 온다" 가시).
    g.fillStyle = "rgba(60,110,55,0.55)";
    for (const fb of this.forestBlobs) {
      const cl = this.forestTrees.get(fb.ym);
      const bb = cl && cl.bbox;
      if (!bb) continue;
      const x = ((bb.x0 - m.x0) * scale) | 0;
      const y = ((bb.y0 - m.y0) * scale) | 0;
      const w = Math.max(1, ((bb.x1 - bb.x0) * scale) | 0);
      const h = Math.max(1, ((bb.y1 - bb.y0) * scale) | 0);
      g.fillRect(x, y, w, h);
    }
    return { canvas: cv, snapW, snapH, scale, offX: m.x0, offY: m.y0 };
  }

  // 스냅샷 완성 판정: 가시 묶인 군집 스프라이트 모두 done + 미베이크 셀 나무 없음.
  _snapAllBaked() {
    for (const fb of this.forestBlobs) {
      const cluster = this.forestTrees.get(fb.ym);
      if (!cluster || !cluster.bbox) continue;
      // 그루 0(전부 empty 인 묶인 달)은 베이크할 스프라이트가 없다(_forestSprite=null). 바닥은
      //   ground 패스가 bundledFootprint 로 그리므로 "구울 게 없음 = 완성"으로 본다. 이 가드가
      //   없으면 영영 false → 합성 미도달 → 임시본(균일 초록 + 숲 bbox 사각)이 고정 노출(회귀).
      if (!cluster.instances || cluster.instances.length === 0) continue;
      const sp = this.forestSprites.get(fb.ym);
      if (!sp || sp.sig !== cluster.sig || !sp.done) return false;
    }
    for (const cell of this.cells) {
      if (cell.bundled || cell.params.stage === STAGE.EMPTY) continue;
      const sub = this._subFrame(cell.params.stage, cell.params.stageProgress);
      const key = "d|" + cell.params.date + "|" + (cell.isActive ? "L" : "P") + "|" + cell.params.stage + "|s" + sub;
      if (!this.spriteCache.has(key)) return false;
    }
    return true;
  }

  // 성목 주변 부유 금색 파티클 그리기: 반짝임 + 페이드. 작고 은은하게.
  _drawAmbientParticles(b) {
    for (const p of this.particles.particles) {
      const px = p.x | 0;
      const py = p.y | 0;
      // 반짝임(사인) × 수명 페이드.
      const tw = 0.55 + 0.45 * Math.sin(p.tw);
      const a = (p.life * tw).toFixed(2);
      // 옅은 글로우 + 밝은 코어 1px.
      b.fillStyle = `rgba(255,220,120,${(a * 0.4).toFixed(2)})`;
      b.fillRect(px - 1, py, 3, 1);
      b.fillRect(px, py - 1, 1, 3);
      b.fillStyle = `rgba(255,240,180,${a})`;
      b.fillRect(px, py, 1, 1);
    }
  }

  // 숲 나비: 묶인 숲마다 두어 마리가 수관 위를 천천히 배회(라이브, 매 프레임). 베이크 무관 —
  //   구운 숲 스프라이트가 정지해 보이던 걸 살린다. 떠돎·날갯짓·몸통·색은 빈칸 장식 나비
  //   (_drawButterfly)와 동일. 진폭 ≤6px·주파수 0.05(천천히). 숲당 2마리·ym+k 시드 위상·화면밖 컬링.
  _drawForestButterflies(b, ox, oy) {
    const wings = ["#f0a0c0", "#a0c8f0", "#f0e090"]; // 빈칸 장식 나비와 같은 파스텔 3색
    for (let fi = 0; fi < this.forestBlobs.length; fi++) {
      const fb = this.forestBlobs[fi];
      const cluster = this.forestTrees.get(fb.ym);
      if (!cluster || !cluster.bbox) continue;
      const bb = cluster.drawBBox || cluster.bbox;
      const cx0 = ox + (bb.x0 - this.worldOriginX);
      const cx1 = ox + (bb.x1 - this.worldOriginX);
      const cy0 = oy + (bb.y0 - this.worldOriginY);
      const cy1 = oy + (bb.y1 - this.worldOriginY);
      if (cx1 < 0 || cx0 > this.bufW || cy1 < 0 || cy0 > this.bufH) continue; // 화면 밖 컬링
      const midX = (cx0 + cx1) / 2;
      const topY = cy0 + (cy1 - cy0) * 0.28; // 수관 상단 부근
      for (let k = 0; k < 2; k++) {
        // 나비별 위상(ym+k 시드, 결정적). 떠돎 진폭 ≤6px·주파수 0.05(빈칸 나비와 같은 느린 거동).
        const seedN = hash32(fb.ym + "b" + k);
        const ph = (seedN % 6283) / 1000; // 0~2π 시드 위상
        // 2마리가 안 겹치게 가로 베이스 위치를 좌우로 살짝 분리(±span). 떠돎은 진폭 4~6px.
        const baseX = midX + (k === 0 ? -10 : 10);
        const bx = (baseX + Math.sin(this.frame * 0.05 + ph) * 5) | 0;
        const by = (topY + Math.cos(this.frame * 0.06 + ph) * 4) | 0;
        const wing = wings[seedN % wings.length];
        drawButterfly(b, bx, by, ph, wing, this.frame);
      }
    }
  }

  // 하늘 = 월드 북쪽 지평선 위. hY = 지평선의 화면 y. 그 위만 하늘, 아래는 땅.
  // 지평선이 화면 위로 벗어나면(hY<=0) 하늘 안 그림(전부 땅).
  _drawSky(b, W, H, hY) {
    if (hY <= 0) return; // 지평선이 화면 위 → 보이는 건 전부 땅
    const top = Math.min(hY, H);
    // 시간대 하늘(작업 3): 주입 시각의 {skyTop, skyBot}. 단일 그라데이션 유지(2단 밴드 금지).
    const sky = skyColorsAt(this._skyHour == null ? 12 : this._skyHour);
    // 부드러운 그라데이션(하드 밴드 제거). 위(skyTop)→아래(skyBot) 행별 보간.
    const c0 = sky.skyTop, c1 = sky.skyBot;
    for (let y = 0; y < top; y++) {
      const t = top > 1 ? y / (top - 1) : 0; // 0(위)~1(지평선)
      const r = (c0.r + (c1.r - c0.r) * t) | 0;
      const g = (c0.g + (c1.g - c0.g) * t) | 0;
      const bl = (c0.b + (c1.b - c0.b) * t) | 0;
      b.fillStyle = `rgb(${r},${g},${bl})`;
      b.fillRect(0, y, W, 1);
    }
    // 지평선 헤이즈: 하늘 바닥(skyBot)과 풀밭(grassA) 사이 하드 라인 제거 — 가는 띠로 옅게 안개처럼
    //   섞어 자연스러운 경계. 하늘→옅은 안개색→풀밭으로 몇 줄 보간(어중간한 컷 방지).
    //   상단은 시간대 skyBot 을 따라가고 하단은 땅(grassA, 불변) — 시각 따라 경계가 자연히 어우러진다.
    const g0 = c1, g1 = hexToRgb(PAL.grassA);
    const hazeH = Math.min(10, Math.max(4, (top * 0.12) | 0));
    for (let i = 0; i < hazeH; i++) {
      const yy = top - hazeH + i;
      if (yy < 0 || yy >= H) continue;
      const t = (i + 1) / (hazeH + 1);
      const r = (g0.r + (g1.r - g0.r) * t) | 0;
      const g = (g0.g + (g1.g - g0.g) * t) | 0;
      const bl = (g0.b + (g1.b - g0.b) * t) | 0;
      b.fillStyle = `rgba(${r},${g},${bl},0.6)`;
      b.fillRect(0, yy, W, 1);
    }

    // 구름(지평선 위 영역 안에서만, 천천히 가로로 흐름). 하늘 커지면 구름도 더 분산.
    const drift = (this.frame * 0.12) % (W + 60);
    const nClouds = 5;
    for (let i = 0; i < nClouds; i++) {
      const cx = ((i * 150 + drift) % (W + 60)) - 30;
      const cy = 6 + (i % 3) * Math.max(10, Math.round((top - 24) / 3));
      if (cy + 16 < top) this._cloud(b, cx | 0, cy, 1 + (i % 2) * 0.3);
    }
  }

  // 시드 해시(_seedNum)·노이즈(_vhash/_vnoise/_fbm)는 공유 모듈로 이관:
  //   hash32 → seed.js, vhash/vnoise/fbm → render/noise.js (위 import).

  _cloud(b, x, y, s) {
    b.fillStyle = PAL.cloud;
    const blobs = [
      [0, 4, 7],
      [8, 2, 8],
      [17, 5, 6],
      [9, 6, 9],
    ];
    for (const [dx, dy, r] of blobs) {
      disc(b, x + (dx * s) | 0, y + (dy * s) | 0, (r * s) | 0);
    }
  }

  // 1 그리드 = 3×3 타일. 나무·흙 패치는 그리드 중심에 방사형(radial).
  // 코너 정렬 블록 금지(3×3 홀수에 2×2 짝수는 쏠려 어색). 단계는 중앙 기준 크기만 키운다:
  //   묘목 = 중앙 1타일, 유목 = 중앙 + 상하좌우(plus, ~2타일 지름), 성목 = 9타일 전부.
  // (논리 점유 1/4/9 수치는 향후 밀도 계산용으로만 보존, 렌더/패치는 중앙 radial.)
  _footprintOffsets(stage) {
    if (stage === STAGE.SAPLING) return [[0, 0]]; // 중앙 1
    if (stage === STAGE.YOUNG) return [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]; // plus(중앙+상하좌우)
    if (stage === STAGE.MATURE) {
      const o = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) o.push([dx, dy]);
      return o; // 9칸 전부
    }
    return []; // 빈땅: 점유 없음
  }

  // 단계별 크라운 폭 상한(px) = 최종 수관 폭의 결정자. 묘목 ≪ 유목 ≪ 성목.
  // GRID=54(TILE 18): 성목 수관 ~3타일(자기 3×3 압도), 유목 ~1.7타일, 묘목(새싹) 아주 작게.
  _footprintWidth(stage) {
    if (stage === STAGE.SAPLING) return 0.8 * TILE; // ~14px (새싹)
    if (stage === STAGE.YOUNG) return 1.7 * TILE; // ~31px (작은 나무)
    if (stage === STAGE.MATURE) return 3.4 * TILE; // 캡(자연 수관 ~3타일 안 깎이게 여유)
    return Infinity;
  }

  // 타일(tx,ty)이 어느 그리드 셀의 footprint(placement) 안이면 그 cell 반환, 아니면 null.
  // 묘목=씨앗 1칸 / 유목=2×2 모서리 / 성목=9칸 — placement.footprint 를 따른다(중앙 고정 아님).
  _cellAtTile(tx, ty) {
    const gx = Math.round(tx / 3);
    const gy = Math.round(ty / 3);
    const cell = this.cellByKey.get(gx + "," + gy);
    if (!cell || cell.params.stage === STAGE.EMPTY) return null;
    if (cell.bundled) return null; // 묶인 달은 숲 덩어리로 그리므로 발치 흙 패치 안 깖
    const dx = tx - gx * 3;
    const dy = ty - gy * 3;
    const fp = cell.placement ? cell.placement.footprint : this._footprintOffsets(cell.params.stage);
    for (const [ox, oy] of fp) {
      if (ox === dx && oy === dy) return cell;
    }
    return null;
  }

  // 바닥 분류·전이대는 render/ground.js 로 추출(순수). 인스턴스 메서드는 this(={cellByKey,blocked})를
  //   조회 컨텍스트로 넘기는 얇은 위임만 — 호출부 동작·시그니처 불변(god-file 절단).
  _cellGroundDensity(tx, ty) { return g_cellGroundDensity(this, tx, ty); }
  _cellVegNorms(tx, ty) { return g_cellVegNorms(this, tx, ty); }
  _cellCacheWriteN(tx, ty) { return g_cellCacheWriteN(this, tx, ty); }
  _isBundledTile(tx, ty) { return g_isBundledTile(this, tx, ty); }
  _isActiveGridCell(gx, gy) { return g_isActiveGridCell(this, gx, gy); }
  _isActiveTile(tx, ty) { return g_isActiveTile(this, tx, ty); }
  _groundKindCell(gx, gy) { return g_groundKindCell(this, gx, gy); }
  _groundKind(tx, ty) { return g_groundKind(this, tx, ty); }
  _isGroundBoundaryTile(tx, ty) { return g_isGroundBoundaryTile(this, tx, ty); }
  _warpedGroundKind(u, v, amp) { return g_warpedGroundKind(this, u, v, amp); }
  _ditheredGroundKind(u, v, amp, dith) { return g_ditheredGroundKind(this, u, v, amp, dith); }
  _groundBaseColor(kind, vv) { return g_groundBaseColor(kind, vv); }

  // 땅 타일을 화면에 가득 깔고(데이터 없는 칸도), 그 위 나무/장식을 Y-sort 로 그린다.
  // hY = 월드 지평선 화면 y. 땅은 지평선부터 아래로만 그린다(하늘 침범 금지).
  _drawGroundAndObjects(b, W, H, hY) {
    // 카메라 적용 유효 원점 = 월드원점 - 카메라오프셋(정수 스냅, 픽셀퍼펙트).
    const ox = Math.round(this.worldOriginX - this.camera.cam.x);
    const oy = Math.round(this.worldOriginY - this.camera.cam.y);

    // ── 정적 바닥 레이어(베이스 흙·풀결·전이대·빈땅 흙·그리드 외곽선) ──
    //   프레임 무의존(this.frame 안 씀)·월드 시드 결정적 → 오프스크린 1회 베이크 후 blit.
    //   흔들림 레이어(잡초·나비·숲풀결·파티클·잎 오버레이)는 아래 Y-sort 패스에서 매 프레임 그대로.
    //   베이크/스냅샷 패스(_forceDetail·_snapComposite)에선 캐시 우회(직접 그려 풀해상 베이크).
    if (this._forceDetail || this._snapComposite) {
      this._drawStaticGround(b, W, H, hY, ox, oy);
    } else {
      this._blitStaticGround(b, W, H, hY, ox, oy);
    }

    // ── 흔들림·객체 레이어(매 프레임) ──
    this._drawDynamicObjects(b, W, H, hY, ox, oy);
  }

  // 정적 바닥 레이어를 주어진 원점(ox,oy)·크기(W,H)로 직접 그린다. 프레임 무의존·월드 시드 결정적이라
  //   캐시 blit 출력과 비트 동일. 베이크(오프스크린)·라이브(캐시 미스 폴백) 양쪽에서 호출된다.
  _drawStaticGround(b, W, H, hY, ox, oy) {
    // 타일 픽셀 원점: 그리드 중심(gx*GRID)은 타일 경계(3gx*TILE)에 놓이는데, 타일 블록
    //   {3gx-1,3gx,3gx+1}(=round(tx/3) 그룹핑)의 중심은 (3gx+0.5)*TILE 로 반 타일 쏠린다.
    //   타일 렌더만 -TILE/2 당겨 블록 중심을 그리드 중심(=외곽선·나무·라벨 기준)에 맞춘다.
    const tox = ox - TILE / 2;
    const toy = oy - TILE / 2;

    // 화면(백버퍼)을 덮는 타일 범위(여유 1타일). 타일 단위(TILE).
    // 위쪽 시작은 지평선(hY) — 그 위는 하늘이라 땅 타일을 안 그린다.
    const groundTop = Math.max(0, hY);
    // 맵 밖은 그리지 않는다. 타일 루프를 뷰포트 ∩ 맵 타일 범위로 클램프한다.
    //   맵 그리드 gx∈[0,99]·gy∈[0,39] → 타일 tx∈[3gx-1,3gx+1]=[-1,298], ty∈[-1,118]
    //   (_cellAtTile 의 gx=round(tx/3) 매핑과 정합).
    const TX_LO = MAP_GX0 * 3 - 1, TX_HI = MAP_GX1 * 3 + 1;
    const TY_LO = MAP_GY0 * 3 - 1, TY_HI = MAP_GY1 * 3 + 1;
    const txMin = Math.max(TX_LO, Math.floor((0 - ox) / TILE) - 1);
    const txMax = Math.min(TX_HI, Math.ceil((W - ox) / TILE) + 1);
    const tyMin = Math.max(TY_LO, Math.floor((groundTop - oy) / TILE));
    const tyMax = Math.min(TY_HI, Math.ceil((H - oy) / TILE) + 1);

    // 풀↔흙 전이대 파라미터(베이스 ①·결 텍스처 ② 공용). STEP=도트 블록, TRANS_AMP=전이대 폭(타일).
    const STEP = 2; // 도트 감성: 2px 블록 단위 분류(안티앨리어싱 0·정수)
    // 그리드 간 경계 노이즈 강도 = VEG_TWEAKS.boundaryNoise(단위3 연결). 전이대 폭·디더 띠 폭을
    //   함께 스케일한다. 그리드 내부 9타일은 같은 종류라 isGroundBoundaryTile=false → 노이즈 없이
    //   solid(이음매 0). 노이즈는 종류가 다른 그리드 간 경계 타일에만 작동(§40 유지).
    const bN = Math.max(0, VEG_TWEAKS.boundaryNoise);
    const TRANS_AMP = 1.2 * bN; // 전이대 폭(타일) ±1.2 ≈ 1~1.5타일
    const TRANS_DITHER = 1.0 * bN; // 디더 띠 폭(타일) — 경계 근처 블록이 두 종류 도트로 섞이는 범위

    // 바닥 베이스: ① 풀밭 한 톤. 맵 밖은 비우므로 맵 타일 범위의 화면 사각형만 풀밭으로 채운다.
    {
      const gx0 = Math.max(0, (tox + txMin * TILE) | 0);
      const gy0 = Math.max(groundTop | 0, (toy + tyMin * TILE) | 0);
      const gx1 = Math.min(W, (tox + (txMax + 1) * TILE) | 0);
      const gy1 = Math.min(H, (toy + (tyMax + 1) * TILE) | 0);
      if (gx1 > gx0 && gy1 > gy0) {
        b.fillStyle = PAL.grassA;
        b.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
      }
    }

    // LOD: 줌아웃 끝(가장 큰 백버퍼)에선 화면 가득 잔디결·잡초 디테일을 매 프레임 그려 무거워진다.
    //   그 배율에선 결이 거의 안 보이므로 3색 흙 베이스(가벼움·변형 유지)는 남기고 결 텍스처·장식·라벨만
    //   끈다. 줌인은 풀 디테일. 오버뷰 스냅샷 합성(_snapComposite)에서도 LOD ON — 다운스케일되어 안
    //   보이는 결/잡초를 끄고 나무·숲 스프라이트·3색 흙 베이스·외곽선만 유지해 합성 블록을 낮춘다.
    const lod = this._snapComposite || (!this._forceDetail && W * H > 1_500_000);

    // ① 비활성 타일 3색 흙 베이스 — 항상(타일당 fill 1회, 변형 유지). 활성 칸은 풀밭(위 grassA).
    //   바닥 종류 경계 타일은 월드 노이즈 전이대(per-block 워프 분류) — 칸 직각 이분법 제거. 풀↔흙·
    //   닫힘 편입. 묶인 숲만 crisp. LOD/스냅샷도 동작(베이크 1회).
    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        const tilePx = (tox + tx * TILE) | 0, tilePy = (toy + ty * TILE) | 0;
        // 바닥 종류 경계 타일: per-block 노이즈 워프로 풀/흙/닫힘을 섞어 칸 경계를 흩뜨린다.
        if (!lod && this._isGroundBoundaryTile(tx, ty)) {
          for (let by = 0; by < TILE; by += STEP) {
            for (let bx = 0; bx < TILE; bx += STEP) {
              // 블록 중심의 월드 타일좌표(u,v) — 팬 불변(tx,ty 는 월드 타일 인덱스).
              const u = tx + (bx + STEP / 2) / TILE;
              const v = ty + (by + STEP / 2) / TILE;
              // 거리 기반 디더(경계 근처 두 종류 도트 50:50). 워프 + 블록별 지터로 분류.
              let kind = this._ditheredGroundKind(u, v, TRANS_AMP, TRANS_DITHER);
              if (!kind) kind = this._groundKind(tx, ty); // 워프가 범위 밖(묶인 숲) → 비워프 폴백
              // 3색 변주는 블록 월드좌표 해시(팬 불변). 종류별 색은 _groundBaseColor.
              const vv = (((((u * 4) | 0) * 374761393) ^ (((v * 4) | 0) * 668265263)) >>> 0) % 3;
              b.fillStyle = this._groundBaseColor(kind, vv);
              b.fillRect(tilePx + bx, tilePy + by, STEP, STEP);
            }
          }
          continue; // 경계 타일은 위 per-block 으로 완료(아래 solid 스킵)
        }
        // 비경계 3색 변주 시드(월드 타일 해시 — 팬 불변, 흙·풀 공용).
        const v = (((tx * 374761393) ^ (ty * 668265263)) >>> 0) % 3;
        // 활성(풀): 위 grassA 한 톤 위에 초록 3톤(A/B/C) 결을 흙(pendDirt 3색)과 같은 per-타일 방식으로
        //   덮는다. 미세 명도차·타일당 fill 1회·칸 단위 큰 패치 0. 풀잎 결(_drawGrassTile)은 그 위.
        if (this._isActiveTile(tx, ty)) {
          if (!lod) {
            b.fillStyle = v === 0 ? PAL.grassA : v === 1 ? PAL.grassB : PAL.grassC;
            b.fillRect(tilePx, tilePy, TILE, TILE);
          }
          continue;
        }
        // 차단 베이스: 닫힘("closed:ym")=둘러싼 달 PAST 풀톤(활성불가 바위 폐기).
        const kind = this._blockedKind(tx, ty);
        if (kind) {
          // 닫힘: 그 달 영역임이 옅게 읽히게 PAST 숲 바닥 초록. PAST 풀밭 3톤 A/B/C 미세 변주.
          b.fillStyle = v === 0 ? PAL_PAST.grassA : v === 1 ? PAL_PAST.grassB : PAL_PAST.grassC;
        } else if (this._isBundledTile(tx, ty)) {
          // 묶인 숲 칸 베이스 = PAST 풀톤(흙 아님). _drawForestFloor 가 위에 녹색을 깔되 외곽을 E 인셋
          //   하므로, 베이스가 흙이면 숲 외곽에 흙색 링이 비친다(버그). 풀톤으로.
          b.fillStyle = v === 0 ? PAL_PAST.grassA : v === 1 ? PAL_PAST.grassB : PAL_PAST.grassC;
        } else {
          b.fillStyle = v === 0 ? PAL.pendDirtA : v === 1 ? PAL.pendDirtB : PAL.pendDirtC;
        }
        b.fillRect(tilePx, tilePy, TILE, TILE);
      }
    }

    // ② 결 텍스처(활성=잔디결 / 비활성=얼룩+잡초) — 비용 큼 → 줌아웃(LOD)에선 생략.
    //    활성 풀결은 나무 밑동 그늘(D)에 따라 점진 감쇠하고, 그늘 안엔 흙을 소량 복원(E).
    //    그늘 밑동 좌표는 _collectShadeStumps 로 이번 프레임 한 번만 모은다(월드 좌표·팬 불변·결정적).
    if (!lod) {
      this._shadeStumps = this._collectShadeStumps(ox, oy, W, H);
      for (let ty = tyMin; ty <= tyMax; ty++) {
        for (let tx = txMin; tx <= txMax; tx++) {
          const sx = tox + tx * TILE, sy = toy + ty * TILE;
          const bk = this._blockedKind(tx, ty);
          // 바닥 종류 경계 타일: 전이대 결(노이즈 따라 풀잎/흙/닫힘 질감 섞기). bk 는 닫힘만.
          if (this._isGroundBoundaryTile(tx, ty)) {
            this._drawTransitionDetail(b, sx, sy, tx, ty, TRANS_AMP, TRANS_DITHER);
          } else if (this._isActiveTile(tx, ty)) {
            // D: 타일 중심에서 가장 가까운 밑동 거리 → 그늘. grassLushness 로 그늘 밖 무성도 보정.
            const sh = this._shadeAt(sx + TILE / 2, sy + TILE / 2);
            const atten = 1 - VEG_TWEAKS.grassLushness * (1 - sh.atten); // lush>1 → 풀↑(atten<0 → 가닥 ↑)
            // E: 그늘(=밑동 근처) 안이면 흙을 약간 먼저 깔고, 그 위에 풀잎(감쇠된 가닥)을 덧그린다.
            if (sh.soil > 0) this._drawShadeSoil(b, sx, sy, tx, ty, sh.soil);
            drawGrassBlades(b, sx, sy, tx, ty, atten, VEG_TWEAKS.grassLushness);
          } else if (bk) {
            drawClosedGround(b, sx, sy, tx, ty); // 닫힘 = 그 달 톤 옅은 이끼/풀
          } else if (this._isBundledTile(tx, ty)) {
            // 묶인 숲 칸: 흙 얼룩·잡초 안 그림(_drawForestFloor 가 풀결로 덮음). 흙 비침 0.
          } else {
            drawPendingGround(b, sx, sy, tx, ty);
          }
        }
      }
    }

    // 차단 칸 외곽 유기화는 노이즈 전이대(①·②)가 담당.

    // ②-b 빈 대지(STAGE.EMPTY) 활성 칸 중앙에 작은 흙 패치 — "여기는 빈 자리" 식별.
    //   칸 단위(타일 분산 도트 아님)·풀결 위·결정적 칸 시드(팬 불변). LOD/스냅샷에선 생략(결과 동일 패스).
    if (!lod) {
      for (const cell of this.cells) {
        // 활성 칸(배치됨·묶이지 않음 = 풀밭 톤) 중 STAGE.EMPTY(데이터는 있으나 나무 없음)만.
        //   cell.isActive 는 "오늘 한 칸"이라 좁다 — 빈 대지 식별엔 _isActiveGridCell(배치 영역).
        if (cell.bundled || cell.params.stage !== STAGE.EMPTY) continue;
        if (!this._isActiveGridCell(cell.gx, cell.gy)) continue;
        // 칸 중심 = gridToScreen(중심 규약, §52-4). 화면 컬링.
        const sc = gridToScreen(cell.gx, cell.gy, ox, oy);
        if (sc.x < -GRID || sc.x > W + GRID || sc.y < hY - GRID || sc.y > H + GRID) continue;
        drawEmptyDirtPatch(b, sc.x, sc.y, cell.gx, cell.gy);
      }
    }
  }

  // 흔들림·객체 레이어(매 프레임). 그리드 외곽선(금색 펄스·빛기둥·후보/호버 — frame 의존)·식생 장식
  //   (나비·잡초 frame 의존)·바위·물웅덩이·나무·숲 군집(swayBase)·깃발(펄스)을 Y-sort 후 그린다.
  //   정적 바닥 캐시 위에 매 프레임 덧그린다 — 흔들림을 캐시에 넣으면 멈춰 외형 회귀라 분리한다.
  _drawDynamicObjects(b, W, H, hY, ox, oy) {
    const tox = ox - TILE / 2;
    const toy = oy - TILE / 2;
    // 타일 루프 범위·LOD·전이대 파라미터를 정적 패스와 동일 식으로 재계산(공유 상태 없이 자족).
    const groundTop = Math.max(0, hY);
    const TX_LO = MAP_GX0 * 3 - 1, TX_HI = MAP_GX1 * 3 + 1;
    const TY_LO = MAP_GY0 * 3 - 1, TY_HI = MAP_GY1 * 3 + 1;
    const txMin = Math.max(TX_LO, Math.floor((0 - ox) / TILE) - 1);
    const txMax = Math.min(TX_HI, Math.ceil((W - ox) / TILE) + 1);
    const tyMin = Math.max(TY_LO, Math.floor((groundTop - oy) / TILE));
    const tyMax = Math.min(TY_HI, Math.ceil((H - oy) / TILE) + 1);
    const lod = this._snapComposite || (!this._forceDetail && W * H > 1_500_000);

    // 그늘 밑동 좌표를 이번 프레임용으로 갱신한다. 정적 바닥 캐시가 히트되면 _drawStaticGround 가 안
    //   불려 _shadeStumps 가 갱신되지 않으므로, 묶인 숲 바닥(swayBase 패스, line ~1920)이 옛 그늘을
    //   쓰지 않게 여기서 항상 다시 모은다(화면 W,H 기준·결정적·팬 불변·fillRect 0이라 저렴).
    if (!lod) this._shadeStumps = this._collectShadeStumps(ox, oy, W, H);

    // 1.5) 그리드(3×3=하루) 외곽 경계 + 오늘 그리드 점등. 타일 위, 나무 아래.
    //   금색 펄스·빛기둥·후보/호버 강조 모두 frame 의존 → 캐시 불가(매 프레임).
    this._drawGridBorders(b, ox, oy);

    // 2) 빈 타일 장식(꽃·나비 등) — **활성(풀밭) 칸에만**. 비활성(흙) 칸은 잡초만(꽃 없음).
    //    LOD(줌아웃)에선 생략 — 그 배율에선 안 보이고 비용만 큼.
    const objs = [];
    if (!lod) {
      for (let ty = tyMin; ty <= tyMax; ty++) {
        for (let tx = txMin; tx <= txMax; tx++) {
          if (this._cellAtTile(tx, ty)) continue; // 나무 발치 타일은 장식 생략
          if (this._isLastActiveCellTile(tx, ty)) continue; // 마지막 활성 깃발 칸 — 깃발 가림 방지
          if (!this._isActiveTile(tx, ty)) continue; // 비활성 흙 칸은 장식 없음
          const sx = tox + tx * TILE;
          const sy = toy + ty * TILE;
          // 요청수(ground.density)=개수, input/output/cacheWrite 비중=종류.
          objs.push({ kind: "decor", tx, ty, sx, sy, y: sy, density: this._cellGroundDensity(tx, ty), veg: this._cellVegNorms(tx, ty) });
        }
      }
      // 놓인 바위 장식: 심을 수 있는 땅(활성 풀밭·비활성 흙·묶인 숲 바닥)의 빈 타일에 듬성. 차단 칸·
      //   나무 발치·물웅덩이와 겹침 제외. 칸 좌표 시드(팬 깜빡임 0). Y-sort 편입(뒤 나무에 가려짐).
      //   1개~군집(2~4)은 _drawVolumeRock 내부에서 시드로 결정.
      for (let ty = tyMin; ty <= tyMax; ty++) {
        for (let tx = txMin; tx <= txMax; tx++) {
          if (this._cellAtTile(tx, ty)) continue; // 나무 발치 회피
          if (this._isLastActiveCellTile(tx, ty)) continue; // 마지막 활성 깃발 칸 — 바위가 깃발 가림 방지
          if (this._isBlockedTile(tx, ty)) continue; // 차단 바닥과 구분 — 놓인 바위 안 둠
          // 물웅덩이 타일과 겹침 제외(아래 pool 패스와 같은 시드 판정).
          const ph = (((tx * 668265263) ^ (ty * 2246822519)) >>> 0);
          if ((ph % 1000) < 9) continue; // 이 타일은 물웅덩이 — 바위 안 둠
          // 타일 좌표 시드 결정적. 기본 ~2.8%(들판이 자갈밭 안 되게). 자갈=cacheWrite 축적 그룹:
          //   활성 칸에서만 cacheWriteN 으로 배치 임계 가변(축적 많은 날 자갈↑). 비활성 고정.
          const cwN = this._cellCacheWriteN(tx, ty);
          const thr = cwN != null ? 28 + ((cwN * 50) | 0) : 28; // 활성: 28~78(2.8~7.8%)·비활성: 28
          const h = (((tx * 2654435761) ^ (ty * 40503)) >>> 0);
          if ((h % 1000) >= thr) continue; // 임계 미만만 바위(자갈)
          const sx = (tox + tx * TILE + TILE / 2) | 0; // 타일 중심
          const sy = (toy + ty * TILE + TILE / 2) | 0;
          objs.push({ kind: "rock", sx, sy, tx, ty, y: sy + (TILE / 2) | 0 }); // 접지점 y
        }
      }
      // 물·지형(순수 장식): 작은 웅덩이(물+이끼 가장자리)를 아주 듬성(희귀, ~1%) 배치.
      //   ⚠️ 순수 렌더 장식 — 그리드 활성화·닫힘·차단 로직에 영향 0. 빈 칸 장식 계열로만(못 심는 칸
      //   안 만듦). 차단 칸·나무 발치 제외. Y-sort.
      for (let ty = tyMin; ty <= tyMax; ty++) {
        for (let tx = txMin; tx <= txMax; tx++) {
          if (this._cellAtTile(tx, ty)) continue; // 나무 발치 회피
          if (this._isLastActiveCellTile(tx, ty)) continue; // 마지막 활성 깃발 칸 — 웅덩이가 깃발 가림 방지
          if (this._isBlockedTile(tx, ty)) continue; // 차단 바닥과 구분
          const h = (((tx * 668265263) ^ (ty * 2246822519)) >>> 0);
          if ((h % 1000) >= 9) continue; // ~0.9% 만 웅덩이(한 화면에 한둘)
          const sx = (tox + tx * TILE + TILE / 2) | 0;
          const sy = (toy + ty * TILE + TILE / 2) | 0;
          objs.push({ kind: "pool", sx, sy, tx, ty, y: sy }); // 평면이라 타일 중심 y
        }
      }
    }

    // 3) 나무: 셀(그리드) 단위. 방향성 — 밑동을 점유 칸 쪽으로 오프셋(중앙 고정 아님).
    //    묶인(bundled) 달 셀은 개별 나무로 안 그린다(아래 숲 덩어리로 대체).
    //    화면 밖 컬링: 백버퍼 밖(여유 GRID*2)인 셀은 objs 에 넣지도, 베이크하지도 않는다.
    //    → 한 화면 작업집합 = 보이는 그리드 수십 칸뿐(427일 전체 아님) → 베이크 작업집합 < 상한.
    const MARGIN = GRID * 2;
    for (const cell of this.cells) {
      if (cell.params.stage === STAGE.EMPTY) continue;
      if (cell.bundled) continue;
      const sc = gridToScreen(cell.gx, cell.gy, ox, oy);
      const off = cell.placement ? cell.placement.offsetTiles : { x: 0, y: 0 };
      const tsx = (sc.x + off.x * TILE) | 0;
      const tsy = (sc.y + off.y * TILE) | 0;
      // 나무는 밑동 위로 솟고(키 ~120px) 옆으로 ~GRID 퍼지므로 위쪽 여유를 넉넉히.
      if (tsx < -MARGIN || tsx > W + MARGIN || tsy < -GRID * 4 || tsy > H + MARGIN) continue;
      objs.push({ kind: "tree", cell, sx: tsx, sy: tsy, y: tsy });
    }

    // 3.5) 숲 군집: 묶인 달마다 달 1장(군집 전체를 합친 스프라이트). 그루당 1장으로 펼치면 스프라이트
    //   수가 LRU 상한을 넘어 매 프레임 전량 재베이크로 행 → 달 단위 1장으로 스프라이트 수 = 달 수로 축소.
    //   군집 내부는 베이크 시점에 Y-sort 닫힘. 전역 Y-sort 에는 군집 바닥 y 기준 1객체로 참여.
    for (const fb of this.forestBlobs) {
      const cluster = this.forestTrees.get(fb.ym);
      if (!cluster || !cluster.bbox) continue;
      // 화면 밖 군집 컬링: 군집 월드 bbox 가 백버퍼 밖이면 베이크·그리기 스킵. 그릴 사각 합집합(drawBBox)
      //   기준 — 베이크 캔버스와 같은 범위라 외곽 나무가 컬링 경계에서 잘려 사라지지 않는다.
      const cb = cluster.drawBBox || cluster.bbox;
      const sx0 = ox + (cb.x0 - this.worldOriginX);
      const sx1 = ox + (cb.x1 - this.worldOriginX);
      const sy0 = oy + (cb.y0 - this.worldOriginY);
      const sy1 = oy + (cb.y1 - this.worldOriginY);
      if (sx1 < -MARGIN || sx0 > W + MARGIN || sy1 < -MARGIN || sy0 > H + MARGIN) continue;
      // 군집 바닥 음영(셀 발자국 기반) — Y-sort 전에 한 번에 깔아 나무 발치를 묶는다.
      this._drawForestFloor(b, cluster, ox, oy);
      // 군집 바닥 y(월드) = 멤버 셀 bbox 하단 → Y-sort 키. 인접 일반 나무와 군집 y 범위 기준 겹침.
      const floorY = (oy + (cluster.bbox.y1 - this.worldOriginY)) | 0;
      objs.push({ kind: "forest", ym: fb.ym, cluster, ox, oy, y: floorY });
    }

    // 3.6) 마지막 활성 깃발을 Y-sort 큐에 편입(나무·바위·식생과 한 큐). 접지 y = 칸 우하단-5px 의 y →
    //   그 칸 나무 밑동보다 약간 아래라 같은 칸 나무가 깃발 앞. gridToScreen(gx,gy) = 칸 중심(좌상단
    //   아님)이라 칸 하단 = 중심 + GRID/2. 깃발은 라이브 화면 패스에서만(맵 스냅샷 합성 패스 제외).
    const fcell = this._snapComposite ? null : this._lastActiveCell();
    if (fcell) {
      const fy = (oy + fcell.gy * GRID + (GRID >> 1) - 5) | 0; // 칸 하단(중심+GRID/2)-5px 접지 y
      objs.push({ kind: "flag", ox, oy, y: fy });
    }

    // 그리기 직전 Y-sort: 화면 위(작은 y)부터 → 아래(큰 y)가 앞. 호버는 위치를 바꾸지 않는다(떠오름 폐기)
    //   — 마우스 오버 강조는 _drawHoverHighlight(옅은 녹색 외곽선)가 render 패스에서 별도로 그린다.
    objs.sort((a, c) => a.y - c.y);
    for (const o of objs) {
      if (o.kind === "tree") this._drawTree(b, o.cell, o.sx, o.sy);
      else if (o.kind === "forest") this._drawForest(b, o.ym, o.cluster, o.ox, o.oy);
      else if (o.kind === "rock") this._drawVolumeRock(b, o.sx, o.sy, o.tx, o.ty); // 입체 바위
      else if (o.kind === "pool") drawWaterPool(b, o.sx, o.sy, o.tx, o.ty); // 물 웅덩이(장식)
      else if (o.kind === "flag") this._drawLastActiveFlag(b, o.ox, o.oy); // Y-sort 편입 깃발
      else drawDecor(b, o.tx, o.ty, o.sx, o.sy, o.density, o.veg, this.frame); // 식생 개수 + 종류 비중
    }
  }

  // 정적 바닥 캐시 키 — 같으면 재베이크 0(같은 캔버스 blit). 내용·줌·백버퍼·지평선·차단·정적 출력에
  //   영향 주는 VEG_TWEAKS 만 포함한다. 카메라 위치(ox,oy)는 키에서 제외 — 팬은 마진 안이면 blit
  //   오프셋으로 흡수하기 때문(키에 넣으면 1px 팬마다 미스 → §28 프리즈 재발). frame 도 제외(정적).
  // hY 는 키에서 제외: 지평선의 베이크 원점 대비 위치(hY-oy = worldHorizonY-worldOriginY)는 상수라
  //   세로 팬으로 hY 가 바뀌어도 blit 오프셋(oy 변화)이 그대로 보정한다. 키에 넣으면 세로 1px 팬마다
  //   미스 → §28 프리즈 재발.
  _groundBakeKey(W, H) {
    let blk = "";
    if (this.blocked && this.blocked.size) {
      const keys = [...this.blocked.keys()].sort();
      for (const k of keys) {
        const tag = this.blocked instanceof Map ? this.blocked.get(k) : "1";
        blk += k + "=" + tag + ";";
      }
    }
    const t = VEG_TWEAKS;
    // 정적 출력에 영향 주는 트윅만(grassLushness·boundaryNoise·그늘 3종). forestDensityCoef 는 군집
    //   스프라이트(별도 캐시)라 정적 바닥과 무관 → 제외.
    const tw = `${t.grassLushness},${t.boundaryNoise},${t.shadowRadiusFactor},${t.shadowGrassAtten},${t.soilAmount}`;
    return `${this._contentSig || ""}|z${this.camera.cam.zoom | 0}|${W}x${H}|${tw}|b:${blk}`;
  }

  // 정적 바닥을 캐시에서 blit. 키가 같고 카메라 팬이 베이크 마진 안이면 재베이크 0(drawImage 1).
  //   키가 바뀌거나(내용·줌·백버퍼·트윅·차단·지평선) 카메라가 마진 밖으로 나가면 1회 재베이크.
  //   출력은 _drawStaticGround 직접 그리기와 비트 동일(월드 시드 결정·팬 불변) — 외형 회귀 0.
  _blitStaticGround(b, W, H, hY, ox, oy) {
    const key = this._groundBakeKey(W, H);
    let bake = this._groundBake;
    // 현재 화면이 베이크 영역 안에 완전히 들어오는지(blit 오프셋이 음수~마진 범위). 마진을 넘으면 재베이크.
    const inRange =
      bake && bake.key === key &&
      bake.w === W + 2 * GROUND_BAKE_MARGIN && bake.h === H + 2 * GROUND_BAKE_MARGIN &&
      (ox - bake.bakeOx) <= 0 && (ox - bake.bakeOx) >= -2 * GROUND_BAKE_MARGIN &&
      (oy - bake.bakeOy) <= 0 && (oy - bake.bakeOy) >= -2 * GROUND_BAKE_MARGIN;

    if (!inRange) {
      // 재베이크: 베이크 원점 = 현재 화면 원점 + 마진(화면이 베이크 영역 중앙에 오게). 정수.
      const bw = W + 2 * GROUND_BAKE_MARGIN, bh = H + 2 * GROUND_BAKE_MARGIN;
      if (!bake || bake.w !== bw || bake.h !== bh) {
        const c = document.createElement("canvas");
        c.width = bw; c.height = bh;
        const cx = c.getContext("2d");
        cx.imageSmoothingEnabled = false;
        bake = this._groundBake = { canvas: c, ctx: cx, bakeOx: 0, bakeOy: 0, w: bw, h: bh, key: null };
      }
      bake.bakeOx = (ox + GROUND_BAKE_MARGIN) | 0;
      bake.bakeOy = (oy + GROUND_BAKE_MARGIN) | 0;
      bake.key = key;
      bake.ctx.clearRect(0, 0, bw, bh);
      // 지평선도 베이크 좌표계로 평행이동(toy 기준 동일). hY 는 화면 y → 베이크 y = hY + (bakeOy - oy).
      const bakeHY = hY + (bake.bakeOy - oy);
      this._drawStaticGround(bake.ctx, bw, bh, bakeHY, bake.bakeOx, bake.bakeOy);
    }
    // blit: 베이크 캔버스에서 현재 화면이 차지하는 사각을 잘라 (0,0)에 그린다. dx = bakeOx - ox(≥0).
    const dx = (bake.bakeOx - ox) | 0;
    const dy = (bake.bakeOy - oy) | 0;
    b.imageSmoothingEnabled = false;
    b.drawImage(bake.canvas, dx, dy, W, H, 0, 0, W, H);
  }

  // 마우스 오버 강조: 호버된 그리드 칸(hoverCell, EMPTY 포함·비묶음)·묶인 숲(hoverForestYm) footprint
  //   외곽에 옅은 녹색 strokeRect(rgba(170,225,150,0.4)·1px·정수·펄스 없음·금색 마지막활성보다 은은).
  //   움직임 없음 — 정상 위치(칸 중심±GRID/2 / 군집 bbox)에 외곽선만. 라이브 전용(overview/스냅샷 합성 제외).
  _drawHoverHighlight(b, ox, oy) {
    if (this.camera.overview || this._snapComposite) return;
    // 그리드 칸(나무·빈땅). 묶인 셀은 숲 외곽선으로 따로(중복 방지).
    const h = (this.hoverCell && !this.hoverCell.bundled) ? this.hoverCell : null;
    if (!h && !this.hoverForestYm) return; // 그릴 게 없으면 스타일 설정도 안 함(비호버 ops 0)
    b.strokeStyle = "rgba(170,225,150,0.4)";
    b.lineWidth = 1;
    if (h) {
      const sc = gridToScreen(h.gx, h.gy, ox, oy); // 칸 중심(§52-4)
      b.strokeRect((sc.x - GRID / 2) | 0, (sc.y - GRID / 2) | 0, GRID, GRID);
    }
    // 묶인 숲: bbox 사각 외곽선이 아니라 멤버 셀별 채움 글로우 + 은은한 펄스.
    //   군집은 모양이 들쭉날쭉하므로 큰 네모 대신 실제 멤버 셀 footprint 만 옅게 빛낸다.
    //   셀 좌표는 _drawForestFloor 와 동일 식(중심 = ox+m.gx*GRID, footprint = 중심±GRID/2, §52-4).
    if (this.hoverForestYm) {
      const cl = this.forestTrees.get(this.hoverForestYm);
      const members = cl && cl.members;
      if (members && members.length) {
        const half = (GRID / 2) | 0;
        // 펄스: frame 사인으로 alpha 약하게 맥동(0.10~0.22). 진폭 작게·녹색·채움이라 깃발/금가루와 구분.
        //   frame 기반이라 결정적(Math.random 금지).
        const pulse = 0.16 + 0.06 * Math.sin(this.frame * 0.06);
        b.fillStyle = `rgba(170,225,150,${pulse.toFixed(3)})`;
        for (const m of members) {
          const cx = (ox + m.gx * GRID) | 0;
          const cy = (oy + m.gy * GRID) | 0;
          b.fillRect((cx - half) | 0, (cy - half) | 0, GRID, GRID);
        }
      }
    }
  }


  // 군집 바닥 질감. 숲 바닥의 base fill·외곽 침식은 폐기됨 — 묶인 숲 칸이 _groundKind="forest" 로
  //   편입돼 땅 베이스 패스(_drawGroundAndObjects ①②)가 숲 바닥을 그린다(내부 solid PAST 풀톤 +
  //   외곽 노이즈 전이대). 이 함수는 숲 내부 질감(잡동사니·그늘·풀결 흔들림)만 그린다.
  _drawForestFloor(b, cluster, ox, oy) {
    if (!cluster.bbox) return;
    const members = cluster.members || [];
    const half = (GRID / 2) | 0;
    // 풀잎 결(활성 풀밭과 같은 결, PAST 톤) — 줌아웃/스냅샷 LOD 에선 생략(비용).
    if (this._snapComposite || (!this._forceDetail && this.buffer && this.buffer.width * this.buffer.height > 1_500_000)) {
      // LOD: 결 생략(풀밭 베이스만).
    } else {
      // 잡동사니 소량(낙엽·이끼 돌·고사리 — 칸당 ~2개). 얼룩 그늘은 나무 인스턴스 아래만 작은 타원
      //   (반경 ≤ 칸 1/4·옅게). 칸 좌표 시드(팬 깜빡임 0).
      // ② 잡동사니 — 칸당 1~3개. 낙엽·이끼 돌·고사리.
      for (const m of members) {
        const sx = (ox + m.gx * GRID) | 0;
        const sy = (oy + m.gy * GRID) | 0;
        let s = (((m.gx * 374761393) ^ (m.gy * 668265263) ^ 0x2545f491) >>> 0) | 1;
        const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
        const litter = 1 + ((r() * 3) | 0); // 1~3 (이전 3~6 → 소량)
        for (let i = 0; i < litter; i++) {
          const px = (sx - half * 0.9 + r() * GRID * 0.9) | 0;
          const py = (sy - half * 0.7 + r() * GRID * 0.7) | 0;
          const kind = r();
          if (kind < 0.4) {
            // 낙엽: 갈색·주황 2px 점.
            b.fillStyle = r() < 0.5 ? "#a86a3a" : "#c98a3f";
            b.fillRect(px, py, 2, 1);
          } else if (kind < 0.7) {
            // 이끼 낀 돌(비활성 칸 돌과 결 통일 — rock 톤 + 이끼).
            b.fillStyle = r() < 0.5 ? PAL.rockA : PAL.rockB;
            b.fillRect(px, py, 2, 2);
            b.fillStyle = PAL.rockMoss;
            b.fillRect(px, py - 1, 1 + ((r() * 2) | 0), 1);
          } else if (kind < 0.88) {
            // 고사리: 짧은 진녹색 세로 가닥 2~3px.
            b.fillStyle = "#2f6a30";
            b.fillRect(px, py, 1, 2 + ((r() * 2) | 0));
          } else {
            // 버섯(숲 바닥에도 같은 식생이 가끔): 베이지 줄기 + 빨강/갈색 갓.
            b.fillStyle = "#d8cbb0";
            b.fillRect(px, py, 1, 2);
            b.fillStyle = r() < 0.5 ? "#c0503a" : "#a86a3a";
            b.fillRect(px - 1, py - 1, 3, 1);
          }
        }
      }
      // ③ 얼룩 그늘 — **나무 인스턴스 밑동 아래만** 아주 작은 타원(반경 ≤ GRID/4·옅게 0.14). 나무 없는
      //    칸엔 0(instances 기준). 칸 단위 노이즈 아님 — 나무 위치 기준이라 칸 경계와 무관.
      const insts = cluster.instances || [];
      const shadeCap = (GRID / 4) | 0; // 그늘 반경 상한 = 칸 1/4
      for (const inst of insts) {
        const tx = (ox + (inst.wx - this.worldOriginX)) | 0;
        const ty = (oy + (inst.wy - this.worldOriginY)) | 0;
        const rw = Math.min(shadeCap, Math.max(3, (7 * (inst.scale || 0.5)) | 0)); // ≤ GRID/4
        b.fillStyle = "rgba(20,40,24,0.14)"; // 차가운 녹그늘(옅게 — 이전 0.22 → 0.14)
        // 발치 타원 그늘(가로 납작) — 2~3행 스캔라인 근사(저비용).
        for (let dy = -1; dy <= 1; dy++) {
          const w = (rw * (1 - Math.abs(dy) * 0.35)) | 0;
          if (w <= 0) continue;
          b.fillRect(tx - w, ty + dy, w * 2, 1);
        }
      }
      // 풀결 굽이침: 묶인 숲 바닥 풀잎을 짧은 줄기로 그리고 밑동 고정·끝 최대로 휜다. 줄기 높이만큼
      //   y비례 오프셋(밑동 0 → 끝 sway). 프레임 사인 + 가닥별 위상(시드). 진폭 작게(끝 ~1~2px). 라이브만.
      const swayBase = this.frame * 0.06;
      for (const m of members) {
        const sx = (ox + m.gx * GRID) | 0;
        const sy = (oy + m.gy * GRID) | 0;
        let seed = (((m.gx * 374761393) ^ (m.gy * 668265263)) >>> 0) ^ 0x51ed2701;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        const blades = 8 + ((rnd() * 6) | 0); // 셀당 8~13 가닥(셀=9타일이라 옅게)
        const reach = GRID * 0.42;
        for (let i = 0; i < blades; i++) {
          const phase = rnd() * 6.283; // 가닥별 흔들림 위상(시드 결정적)
          const bx = (sx + (rnd() - 0.5) * 2 * reach) | 0;
          const byBase = (sy + (rnd() - 0.5) * 2 * reach * 0.66) | 0; // 밑동 y
          // D(공통 F): 군집 나무 밑동 그늘 안이면 가닥을 확률로 스킵 — 활성 풀밭과 같은 _shadeAt 로직.
          const sh = this._shadeAt(bx, byBase);
          if (sh.atten > 0 && rnd() < sh.atten) continue;
          const r = rnd();
          if (r < 0.16) {
            // 반짝 점: 줄기 없음(밑동만).
            b.fillStyle = PAL_PAST.grassSpeck;
            b.fillRect(bx, byBase, 1, 1);
          } else {
            // 짧은 줄기(2~3px) + 끝으로 갈수록 휨(밑동 0·끝 최대). 픽셀별 오프셋.
            b.fillStyle = r < 0.6 ? PAL_PAST.grassBlade2 : PAL_PAST.grassBlade1;
            const h = 2 + (rnd() < 0.5 ? 0 : 1); // 줄기 높이 2~3
            const tip = Math.sin(swayBase + phase); // -1~1 (끝 휨)
            for (let s = 0; s < h; s++) {
              const t = (s + 1) / h; // 0(밑동 근처)~1(끝)
              const off = Math.round(tip * t); // y비례 휨: 밑동 0·끝 최대
              b.fillRect(bx + off, byBase - s, 1, 1);
            }
          }
        }
      }
    }
  }

  // 숲 군집 = 달 1장 스프라이트: 묶인 달의 모든 그루를 오프스크린 1장에 합쳐 베이크하고 매 프레임
  //   drawImage 1콜만. 군집 내부는 베이크 시점에 Y-sort 닫힘. 캐시 키 = ym. 군집은 항상 PAST 톤.
  _drawForest(b, ym, cluster, ox, oy) {
    const sp = this._forestSprite(ym, cluster);
    if (!sp) return; // 베이크 예산 초과 + 캐시 없음 → 이 프레임 스킵(다음 프레임에 채워짐)
    // 스프라이트 원점 = 군집 월드 bbox 좌상단(wx0,wy0)에서 up 만큼 위. 화면으로 변환해 blit.
    //   진행 중(미완성) 스프라이트도 그린다(채워진 만큼). 빈 곳은 _drawForestFloor 바닥 음영이 이미
    //   깔려 있어 플레이스홀더 잔류로 안 보인다. 매 프레임 일부 그루가 늘어 자연스럽게 완성.
    const dx = (ox + (sp.wx0 - this.worldOriginX) - sp.rx) | 0;
    const dy = (oy + (sp.wy0 - this.worldOriginY) - sp.ry) | 0;
    b.drawImage(sp.canvas, dx, dy);
  }

  // 달 1장 점진(progressive) 베이크: 묶인 달의 그루(수십~수백)를 한 프레임에 다 굽지 않고 프레임마다
  //   _instBakeBudget 그루씩 같은 오프스크린 캔버스에 누적 그린다(한 동기 호출이면 빽빽한 달이 수십초
  //   블록 → freeze). 진행 상태(bakedCount·sorted)를 스프라이트 객체에 보존해 매 프레임 다음 청크만
  //   그린다. 완성 전이라도 캔버스를 반환(부분 렌더) → 바닥 음영 위에 그루가 점점 차오른다.
  //   캐시 키 = ym. cluster.sig 가 바뀌면 _computeForestClusters 가 forestSprites.delete → 재시작.
  _forestSprite(ym, cluster) {
    let sp = this.forestSprites.get(ym);
    // 시그니처 불일치(내용 변경) → 폐기하고 새로 시작(아래에서 재생성).
    if (sp && sp.sig !== cluster.sig) { this.forestSprites.delete(ym); sp = null; }

    // 신규: 캔버스·정렬목록 준비(그리기 0). 이 단계는 베이크 예산을 소비하지 않는다(픽셀 0).
    if (!sp) {
      const insts = cluster.instances || [];
      if (insts.length === 0) return null;
      // 캔버스 = 그루 실제 그릴 사각 합집합(drawBBox). footprint bbox 만 쓰면 시트/성목 프레임 폭·오버행을
      //   못 덮어 외곽 나무가 세로 직선으로 잘린다. drawBBox 는 모든 그루 사각·바닥·풀잎 결·안전 마진을
      //   포함하므로 추가 PAD 없이 그대로 쓰고, rx/ry = 그루 footprint bbox(wx0,wy0)의 캔버스 내 위치.
      const fb = cluster.bbox;
      const db = cluster.drawBBox || fb;
      const wx0 = fb.x0, wy0 = fb.y0; // 앵커 = 나무 footprint bbox 좌상단(_drawForest 의 dx/dy 식과 정합)
      const w = Math.max(1, Math.ceil(db.x1 - db.x0));
      const h = Math.max(1, Math.ceil(db.y1 - db.y0));
      if (w > 8192 || h > 8192) return null; // 비정상 크기 방어
      const rx = Math.round(wx0 - db.x0); // wx0 의 캔버스 내 x(= footprint 좌상단까지의 좌측 여백)
      const ry = Math.round(wy0 - db.y0); // wy0 의 캔버스 내 y(= 위쪽 그릴 여유)
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const sctx = cv.getContext("2d");
      sctx.imageSmoothingEnabled = false;
      // 그루를 군집 로컬 밑동 좌표로 변환 후 Y-sort(밑동 y) → 군집 내부 앞뒤 겹침 닫힘.
      const sorted = insts
        .map((inst) => ({ inst, lx: (inst.wx - wx0) + rx, ly: (inst.wy - wy0) + ry }))
        .sort((a, c) => a.ly - c.ly);
      sp = { canvas: cv, ctx: sctx, sorted, bakedCount: 0, done: false, rx, ry, wx0, wy0, sig: cluster.sig };
      this.forestSprites.set(ym, sp);
    } else {
      // LRU 갱신.
      this.forestSprites.delete(ym);
      this.forestSprites.set(ym, sp);
    }

    // 이미 완성이면 픽셀 작업 0 — 즉시 반환(정지 상태 베이크 0/프레임, 요구 3).
    if (sp.done) return sp;

    // 프레임당 그루 예산: 이 프레임에 아직 쓸 수 있는 만큼만 누적 그린다(전역 _bakesThisFrame 는
    //   청크당 1 소비 → 여러 군집이 한 프레임을 독점하지 않게 분산). 예산 0 이면 부분 캔버스라도 반환.
    if (this._bakesThisFrame >= this._frameBakeBudget) {
      return sp.bakedCount > 0 ? sp : (this.forestSprites.has(ym) ? sp : null);
    }
    this._bakesThisFrame++;
    const sctx = sp.ctx;
    const sorted = sp.sorted;
    const end = Math.min(sorted.length, sp.bakedCount + this._instBakeBudget);
    const useSheet = this._useSheet();
    for (let i = sp.bakedCount; i < end; i++) {
      const it = sorted[i];
      const baked = it.inst.baked;
      if (!baked) continue;
      const sd = hash32(it.inst.seed);
      if (useSheet) {
        // 군집 작은 나무도 시트 blit(항상 PAST 톤). inst.scale(0.34~0.56)로 더 작게.
        this._blitSheetTreeInto(sctx, it.lx | 0, it.ly | 0, it.inst, true);
      } else {
        // 절차 폴백: 군집 작은 나무 — withCap=false(상단 보강 잎 생략). 직접 본체 그리기.
        paintTreeBody(sctx, baked, it.lx | 0, it.ly | 0, PAL_PAST, 1.0, sd, false);
      }
    }
    sp.bakedCount = end;
    if (sp.bakedCount >= sorted.length) {
      sp.done = true;
      this._forestBakes++; // 스모크 카운터: 군집 1장 완성 시 1 증가(완료 단위)
    }
    return sp;
  }

  // 시트 나무 목적지 폭(px): 성목 최상위 프레임(sprite_S_9)이 맞춰질 성목 가독 폭. 전 프레임 공유
  //   스케일의 기준이다(매크로별 정규화 폐기). _footprintWidth 가 절차 수관 폭 캡을 주므로 같은 가독
  //   폭으로 통일한다. Infinity(빈땅) 방어.
  _sheetTargetWidth() {
    const w = this._footprintWidth(STAGE.MATURE);
    if (!Number.isFinite(w)) return 0;
    // 시트 수관은 프레임 전체(잎+여백)라 발자국 폭보다 조금 넓게 잡아 잎이 시원하게 퍼지게.
    return Math.round(w * 1.15);
  }

  // 시트 나무 전 프레임 공유 스케일(수종별 단순분수). sprite_S_9(성목 최상위)가 성목 가독 폭에 맞도록
  //   _niceScale 로 한 번 정한 스케일을 0~9 모든 프레임에 동일 적용한다. 그러면 시트가 인코딩한 자연
  //   성장(프레임 w·h 단조 증가)이 화면에 그대로 나타나 10단계가 점점 커진다. 프레임마다 독립 스냅하면
  //   들쭉날쭉해지므로 금지 — 프레임9 기준 1회 결정·전 프레임 공유. 결정적.
  _sheetScale(species) {
    const fr9 = this.sheet.frame("sprite_" + species + "_9");
    const targetW = this._sheetTargetWidth();
    if (!fr9 || !(fr9.w > 0) || !(targetW > 0)) return 1;
    return this._niceScale(targetW, fr9.w);
  }

  // 묘목 최하위(sprite_S_0) 나무의 실제 렌더 높이(px). 바위 크기 상한(≤ 묘목)에 쓴다. 공유 스케일
  //   _sheetScale 로 묘목 최하위 프레임 높이를 정규화 — 10단계 중 가장 작은 나무 높이. 시트 미준비/
  //   실패면 절차 묘목 높이 근사로 폴백. 결정적.
  _saplingRenderHeight() {
    if (this._useSheet()) {
      // 수종 0 대표(묘목 프레임은 수종 간 크기 유사). 절대 프레임 sprite_0_0(묘목 최하위).
      const fr = this.sheet.frame("sprite_0_0");
      if (fr && fr.h > 0) {
        return Math.max(6, Math.round(fr.h * this._sheetScale(0)));
      }
    }
    // 폴백: 절차 묘목(새싹)은 _footprintWidth(SAPLING) 폭 ~14px·키도 그 정도.
    const w = this._footprintWidth(STAGE.SAPLING);
    return Math.max(6, Number.isFinite(w) ? Math.round(w) : 14);
  }

  // 보기 좋은 스케일(단순 분수 nearest): targetW/frameW 를 1/2·1/3·2/3·3/4·1 등 작은 분모
  //   분수로 스냅해 다운스케일 픽셀 정렬을 깔끔하게. 너무 작아지지 않게 하한.
  _niceScale(targetW, frameW) {
    if (!(frameW > 0) || !(targetW > 0)) return 1;
    const raw = targetW / frameW;
    const cand = [1, 3 / 4, 2 / 3, 1 / 2, 2 / 5, 1 / 3, 1 / 4, 1 / 5, 1 / 6];
    let best = cand[0], bestErr = Infinity;
    for (const c of cand) {
      const e = Math.abs(c - raw);
      if (e < bestErr) { bestErr = e; best = c; }
    }
    return best;
  }

  // 시트 프레임 한 장을 (밑동=하단중앙 앵커) 베이크해 {canvas, ax, ay} 반환. PAST 톤이면
  //   살짝 어둡고 채도 낮은 멀티플라이 오버레이(픽셀퍼펙트: source-atop 로 알파 보존, 정수 스케일).
  //   scale = _sheetScale(species) 공유 분수 — 절대 프레임(0~9) 크기에 비례 다운스케일해 10단계가
  //   화면에서 점점 커진다(매크로별 정규화 안 함). nearest(imageSmoothing=false)로 1회 다운스케일.
  _bakeSheetFrame(species, stageEnum, stageProgress, past) {
    const fr = this.sheet.frameFor(species, stageEnum, stageProgress);
    if (!fr) return null;
    const scale = this._sheetScale(species);
    const dw = Math.max(1, Math.round(fr.w * scale));
    const dh = Math.max(1, Math.round(fr.h * scale));
    const PAD = 2;
    const cv = document.createElement("canvas");
    cv.width = dw + PAD * 2;
    cv.height = dh + PAD * 2;
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    // 프레임 영역만 잘라 다운스케일 blit.
    g.drawImage(this.sheet.image, fr.x, fr.y, fr.w, fr.h, PAD, PAD, dw, dh);
    if (past) {
      // PAST 톤 보정: 멀티플라이 오버레이(채도·명도 낮춤). source-atop 로 나무 픽셀에만 적용
      //   (투명 배경 유지 → 픽셀퍼펙트 알파 보존).
      g.globalCompositeOperation = "source-atop";
      g.fillStyle = "rgba(70,86,74,0.34)"; // 차분한 청록 회색 멀티플라이 근사(어둡고 탈채도)
      g.fillRect(0, 0, cv.width, cv.height);
      g.globalCompositeOperation = "source-over";
    }
    // 앵커: 밑동 = 하단 중앙. ax = 캔버스 중앙 x, ay = 하단(PAD 만큼 여유 위).
    const ax = (cv.width / 2) | 0;
    const ay = cv.height - PAD;
    return { canvas: cv, ax, ay };
  }

  // 군집 작은 나무: 시트 프레임을 군집 캔버스 ctx 의 (lx,ly=밑동 하단중앙)에 직접 blit한다.
  //   inst.scale(0.34~0.56)로 더 작게(원근감), 항상 PAST 톤(군집=묶인 과거 달)이면 멀티플라이.
  //   nearest(imageSmoothing=false) 다운스케일. 시트 프레임 누락 시 절차 폴백(false 반환은 안 하고
  //   호출부가 useSheet 로 분기하므로 여기선 프레임 있을 때만 그린다).
  _blitSheetTreeInto(ctx, lx, ly, inst, past) {
    const species = this.sheet.speciesFor(inst.seed);
    const fr = this.sheet.frameFor(species, inst.stage, inst.stageProgress);
    if (!fr) return;
    // 공유 스케일 × inst.scale(원근감). 군집은 작은 나무라 더 줄인다. 절대 프레임 크기 비례라
    //   군집 안에서도 단계가 크면 더 크게 보인다. _instDrawRect 와 반드시 같은 식(잘림 0).
    const scale = Math.max(0.08, this._sheetScale(species) * (inst.scale || 0.45) * 2.0);
    const dw = Math.max(1, Math.round(fr.w * scale));
    const dh = Math.max(1, Math.round(fr.h * scale));
    const dx = (lx - dw / 2) | 0;
    const dy = (ly - dh) | 0; // 밑동(ly)이 하단
    if (past) {
      // 군집은 한 캔버스에 누적 → 멀티플라이를 그루 단위로 적용하려면 임시 캔버스 경유(알파 보존).
      const tcv = document.createElement("canvas");
      tcv.width = dw; tcv.height = dh;
      const tg = tcv.getContext("2d");
      tg.imageSmoothingEnabled = false;
      tg.drawImage(this.sheet.image, fr.x, fr.y, fr.w, fr.h, 0, 0, dw, dh);
      tg.globalCompositeOperation = "source-atop";
      tg.fillStyle = "rgba(70,86,74,0.34)";
      tg.fillRect(0, 0, dw, dh);
      tg.globalCompositeOperation = "source-over";
      ctx.drawImage(tcv, dx, dy);
    } else {
      ctx.drawImage(this.sheet.image, fr.x, fr.y, fr.w, fr.h, dx, dy, dw, dh);
    }
  }

  // 나무 스프라이트 베이크 + LRU 캐시. key 로 캐시 조회, 없으면 한 그루 전체를 오프스크린 캔버스에
  //   1회 그려(_paintTreeBody) 캐시한다. 반환 {canvas, ax, ay}: ax/ay = 밑동의 스프라이트 내 픽셀
  //   좌표(drawImage 위치 = 화면밑동 − ax/ay). 픽셀퍼펙트: 오프스크린 imageSmoothing=false, 백버퍼에
  //   1:1 정수 좌표 drawImage(스케일 변환 없음). 시트가 준비됐으면 절차 대신 시트 프레임 blit(폴백=절차).
  _treeSprite(key, baked, P, ds, seedVal, withCap, sheetInfo) {
    if (!baked) return null;
    const cached = this.spriteCache.get(key);
    if (cached) {
      // LRU 갱신: 재삽입으로 최근 사용 표시.
      this.spriteCache.delete(key);
      this.spriteCache.set(key, cached);
      return cached;
    }
    // 프레임당 베이크 예산: 한 프레임에 budget 장까지만 새로 굽는다(콜드/줌 진입 분산). 초과분은 이
    //   프레임 null 반환 → 호출자가 1회 스킵(다음 프레임에 채워짐).
    if (this._bakesThisFrame >= this._frameBakeBudget) return null;
    this._bakesThisFrame++;
    // 시트 경로: 준비됐고 sheetInfo 가 있으면 절차 _paintTreeBody 대신 시트 프레임 blit 베이크.
    if (sheetInfo && this._useSheet()) {
      const sp = this._bakeSheetFrame(
        sheetInfo.species, sheetInfo.stage, sheetInfo.stageProgress, sheetInfo.past
      );
      if (sp) {
        this.spriteCache.set(key, sp);
        this._spriteBakes++;
        if (this.spriteCache.size > this.spriteCap) {
          const oldest = this.spriteCache.keys().next().value;
          this.spriteCache.delete(oldest);
        }
        return sp;
      }
      // 프레임 누락 등 → 절차 폴백으로 계속.
    }
    const sd = hash32(seedVal);
    // 로컬 밑동(ax,ay) 기준 bbox 산정(여유 패딩). 빈 나무 방어.
    const bb = this._treeBBox(baked, ds);
    const PAD = 3;
    const ax = Math.ceil(-bb.minX) + PAD; // 밑동 x 의 스프라이트 내 위치
    const ay = Math.ceil(-bb.minY) + PAD; // 밑동 y(baseY)의 스프라이트 내 위치
    const w = Math.max(1, Math.ceil(bb.maxX - bb.minX) + PAD * 2);
    const h = Math.max(1, Math.ceil(bb.maxY - bb.minY) + PAD * 2);
    if (w > 2048 || h > 2048) return null; // 비정상 크기 방어
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const sctx = cv.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    // 스프라이트 내부 밑동 = (ax, ay). 베이크는 카메라/화면과 무관(월드 불변 시드만).
    paintTreeBody(sctx, baked, ax, ay, P, ds, sd, withCap);
    const sp = { canvas: cv, ax, ay };
    this.spriteCache.set(key, sp);
    this._spriteBakes++;
    // LRU 상한 초과 시 가장 오래된 항목 제거.
    if (this.spriteCache.size > this.spriteCap) {
      const oldest = this.spriteCache.keys().next().value;
      this.spriteCache.delete(oldest);
    }
    return sp;
  }

  // 일반 셀 나무 스프라이트 무효화: 그 date 의 양 톤·모든 stage 키 제거(재베이크·삭제 시).
  _invalidateSprite(date) {
    const prefix = "d|" + date + "|";
    for (const k of [...this.spriteCache.keys()]) {
      if (k.startsWith(prefix)) this.spriteCache.delete(k);
    }
  }


  // 나무 한 그루의 로컬(밑동=원점) 화면 bbox {minX,minY,maxX,maxY}. SX/SY 변환과 동일한
  //   규칙(SX=vx*ds, SY=−vy*ds)으로 크라운 블롭·기둥·가지·뿌리 플레어·cap 잎 여유까지 포함.
  _treeBBox(baked, ds) {
    let minX = -2, maxX = 2, minY = -2, maxY = 2; // 밑동 주변 최소 여유
    const add = (x, y, r) => {
      if (x - r < minX) minX = x - r; if (x + r > maxX) maxX = x + r;
      if (y - r < minY) minY = y - r; if (y + r > maxY) maxY = y + r;
    };
    for (const bl of baked.crown || []) {
      const x = bl.x * ds, y = -bl.y * ds;
      // sprout 떡잎은 타원이라 r*1.8 까지 뻗음.
      const r = (baked.sprout ? bl.r * 1.9 : bl.r + 1) * ds + 2;
      add(x, y, r);
    }
    for (const seg of baked.trunkSegs || []) {
      const w = (seg.wL ?? seg.w) * ds + (seg.wR ?? seg.w) * ds + 4;
      add(seg.x1 * ds, -seg.y1 * ds, w);
      add(seg.x2 * ds, -seg.y2 * ds, w);
    }
    // 뿌리 플레어·흙 산점(밑동 아래·옆) 여유. baseW 기준 reach·아래로 박힘.
    if (!baked.sprout && baked.trunkSegs && baked.trunkSegs.length) {
      const baseW = Math.round(baked.trunkSegs[0].w * ds);
      const reach = Math.max(6, (baseW * 1.5) | 0);
      add(-reach, 0, 4); add(reach, 0, 4);
      maxY = Math.max(maxY, baseW + 8); // 밑동 아래(흙 박힘) 여유
    }
    return { minX, minY, maxX, maxY };
  }

  // 군집 한 그루의 실제 그릴 사각(밑동=하단중앙 앵커 기준, 로컬 px). _forestSprite 가 그루를 그리는
  //   방식(시트=_blitSheetTreeInto, 절차=_paintTreeBody/_treeBBox)과 정확히 같은 식으로 x:[-dw/2,
  //   +dw/2], y:[-dh, 0] 의 rect 를 돌려준다. 군집 베이크 캔버스 bounds = 모든 그루 이 rect 의 합집합.
  //   시트/절차 어느 경로든 같은 함수가 산정해 베이크 캔버스와 drawImage 위치가 같은 기준이 된다(잘림 0).
  //   { left, right, up, down } = 밑동에서 좌/우/위/아래로 뻗는 px(모두 ≥0).
  _instDrawRect(inst) {
    if (this._useSheet()) {
      // 시트 경로: _blitSheetTreeInto 와 동일한 dw/dh 산정(밑동 = 하단중앙).
      const species = this.sheet.speciesFor(inst.seed);
      const fr = this.sheet.frameFor(species, inst.stage, inst.stageProgress);
      if (fr && fr.w > 0) {
        // _blitSheetTreeInto 와 동일한 scale 식(공유 스케일 × inst.scale × 2.0).
        const scale = Math.max(0.08, this._sheetScale(species) * (inst.scale || 0.45) * 2.0);
        const dw = Math.max(1, Math.round(fr.w * scale));
        const dh = Math.max(1, Math.round(fr.h * scale));
        // dx = (lx - dw/2)|0 → 좌측 = ceil(dw/2), 우측 = dw - ceil(dw/2). 밑동 dy=(ly-dh)|0 → up=dh.
        const left = Math.ceil(dw / 2);
        return { left, right: dw - left, up: dh, down: 0 };
      }
      // 시트 프레임 누락 → 절차 폴백 rect 로 계속.
    }
    // 절차 경로: _treeBBox(밑동 원점, ds=1.0 — 군집은 _paintTreeBody 를 ds=1.0 으로 호출).
    const baked = inst.baked;
    if (!baked) return { left: 1, right: 1, up: 1, down: 1 };
    const bb = this._treeBBox(baked, 1.0);
    // _treeBBox 는 SY=baseY-vy → minY(=위) 음수, maxY(=아래·뿌리) 양수. 좌/우는 minX/maxX.
    return {
      left: Math.ceil(Math.max(0, -bb.minX)),
      right: Math.ceil(Math.max(0, bb.maxX)),
      up: Math.ceil(Math.max(0, -bb.minY)),
      down: Math.ceil(Math.max(0, bb.maxY)),
    };
  }

  // 군집 베이크 캔버스 bounds(월드 px) = 모든 그루의 실제 그릴 사각 합집합 ∪ 바닥 합집합(침식/확장
  //   ±E 포함) ∪ 풀잎 결 범위 + 안전 마진. floor 는 멤버 셀 footprint(중심 ±GRID/2) + 외곽 E 확장 +
  //   풀잎 결 reach. 반환 drawBBox/drawUp/drawDown 은 cluster.bbox(나무 footprint) 와 별개로 저장해
  //   베이크·extent·컬링이 동일 기준을 쓰게 한다(잘림 0). 나무 월드 위치는 불변 — bounds 만 넓힌다.
  _computeClusterDrawBounds(forest, members) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    // 1) 그루 그릴 사각 합집합.
    for (const inst of forest.instances) {
      const r = this._instDrawRect(inst);
      x0 = Math.min(x0, inst.wx - r.left);
      x1 = Math.max(x1, inst.wx + r.right);
      y0 = Math.min(y0, inst.wy - r.up); // 위(상단)
      y1 = Math.max(y1, inst.wy + r.down); // 아래(뿌리·발치)
    }
    // 2) 바닥 합집합(멤버 셀 footprint + 외곽 침식/확장 E + 풀잎 결 reach).
    //    _drawForestFloor 와 정합: footprint = 셀중심 ±GRID/2, 외곽 변 +E, 풀잎 결 reach = GRID*0.42.
    const half = GRID / 2;
    const E = Math.max(4, (GRID * 0.12) | 0);
    const bladeReach = GRID * 0.42;
    const floorPad = Math.max(E, Math.ceil(bladeReach - half) + 1); // 결이 셀 밖으로 더 나가면 그만큼
    for (const m of members) {
      const cx = this.worldOriginX + m.gx * GRID;
      const cy = this.worldOriginY + m.gy * GRID;
      x0 = Math.min(x0, cx - half - floorPad); x1 = Math.max(x1, cx + half + floorPad);
      y0 = Math.min(y0, cy - half - floorPad); y1 = Math.max(y1, cy + half + floorPad);
    }
    if (!Number.isFinite(x0)) {
      x0 = this.worldOriginX - half; x1 = this.worldOriginX + half;
      y0 = this.worldOriginY - half; y1 = this.worldOriginY + half;
    }
    // 3) 안전 마진(2~4px).
    const SAFE = 4;
    x0 -= SAFE; x1 += SAFE; y0 -= SAFE; y1 += SAFE;
    // drawBBox = 그루 footprint bbox(forest.bbox) 기준 up/down 으로 환산(기존 인터페이스 호환).
    //   _forestSprite 는 drawBBox 를 직접 쓰고, _contentWorldBounds/컬링은 drawBBox 가 있으면 우선.
    const fb = forest.bbox;
    const drawUp = Math.max(0, Math.round(fb.y0 - y0));
    const drawDown = Math.max(0, Math.round(y1 - fb.y1));
    return {
      drawBBox: { x0: Math.floor(x0), x1: Math.ceil(x1), y0: Math.floor(y0), y1: Math.ceil(y1) },
      drawUp, drawDown,
    };
  }

  // 그리드(3×3=하루) 외곽 경계 + 오늘 그리드 펄스 점등.
  // 외곽선 일관 1px, 인접 변 공유(겹쳐 2px 안 되게 — 오른/아래 변을 x0+GRID·y0+GRID 에 둬 이웃의
  //   왼/위 변과 같은 픽셀 공유), active 펄스는 최소 밝기 보장(어두워도 안 사라짐).
  _drawGridBorders(b, ox, oy) {
    const half = GRID / 2;
    // 마지막 활성 그리드 금색 아웃라인(기본 식별 — 깃발만으론 부족). 한 칸·펄스. 오버뷰 스냅샷 제외.
    //   debug 의 전체 칸 격자선(아래 this.debug 블록)과 별개 — 그건 디버그 모드 전용 유지.
    //   HUD 접힘(hudCollapsed) 시엔 같이 숨긴다(사용자 요청).
    if (!this._snapComposite && !this.hudCollapsed) {
      const lac = this._lastActiveCell();
      if (lac) {
        const pulse = 0.72 + 0.28 * Math.sin(this.frame * 0.08); // 0.44~1.00
        const lx = (ox + lac.gx * GRID - half) | 0;
        const ly = (oy + lac.gy * GRID - half) | 0;
        b.fillStyle = `rgba(255,225,90,${(0.9 * pulse).toFixed(2)})`;
        this._gridOutline(b, lx, ly);
      }
    }
    // 그리드 격자선 제거: 풀↔흙 경계가 노이즈로 자연스러워졌는데 칸 외곽선이 격자를 다시 드러내 인위적
    //   → 맵 경계선 + 칸마다 1px 외곽선은 기본 OFF, `디버그 모드`(this.debug)에서만. 아래 숲생성 딤·후보/
    //   호버/커서 강조·빛기둥은 격자선과 별개 — 유지.
    if (this.debug) {
      // 맵 경계 시각화(디버그): 고정 맵 가장자리 1px 선.
      {
        const mx0 = (ox + MAP_GX0 * GRID - half) | 0;
        const mx1 = (ox + MAP_GX1 * GRID + half) | 0;
        const my0 = (oy + MAP_GY0 * GRID - half) | 0;
        const my1 = (oy + MAP_GY1 * GRID + half) | 0;
        b.fillStyle = "rgba(70,60,40,0.45)";
        this._rectOutline(b, mx0, my0, mx1 - mx0, my1 - my0, 1);
      }
      // 칸마다 1px 외곽선(디버그). 오늘 그리드는 금색 펄스, 과거/빈 그리드는 차분한 구분선.
      const pulse = 0.72 + 0.28 * Math.sin(this.frame * 0.08); // 0.44~1.00
      for (const cell of this.cells) {
        if (cell.bundled) continue; // 묶인 달은 일 그리드 경계 안 그림(숲 덩어리로 표시)
        const cx = ox + cell.gx * GRID;
        const cy = oy + cell.gy * GRID;
        const x0 = (cx - half) | 0, y0 = (cy - half) | 0;
        if (cell.isActive) {
          b.fillStyle = `rgba(255,225,90,${(0.85 * pulse).toFixed(2)})`;
          this._gridOutline(b, x0, y0);
        } else {
          b.fillStyle = PAL.gridBorder;
          this._gridOutline(b, x0, y0);
        }
      }
    }

    // 자동 묶기 빛기둥: 서버가 그 달을 bundled=true 로 바꾼 순간(폴 비교), 멤버 그리드들에 짧게 동시에
    //   솟는 빛기둥(plantFx 와 같은 결). 개별 나무 → 숲 군집 전환을 시각화. 일회성.
    if (this.bundleFx) {
      const fx = this.bundleFx;
      const t = (this.frame - fx.startFrame) / fx.dur; // 0~1
      if (t >= 1) {
        this.bundleFx = null;
      } else {
        const a = (1 - t) * 0.95; // 페이드아웃
        const spread = 1 + Math.round(t * 5);
        for (const c of fx.cells) {
          const cx = ox + c.gx * GRID, cy = oy + c.gy * GRID;
          const x0 = (cx - half) | 0, y0 = (cy - half) | 0;
          for (let i = spread; i >= 0; i--) {
            const ga = a * (1 - i / (spread + 1));
            b.fillStyle = `rgba(200,255,190,${ga.toFixed(2)})`;
            this._rectOutline(b, x0 - i, y0 - i, GRID + i * 2, GRID + i * 2, 1);
          }
        }
      }
    }

    // 후보 빈칸 강조(은은). 콜드 스타트는 후보 목록이 비어(자유 선택) 강조 없음.
    const pa = (0.4 + 0.35 * Math.abs(Math.sin(this.frame * 0.07)));
    for (const s of this.candidateSlots) {
      const hov = this.hoverSlot && this.hoverSlot.gx === s.gx && this.hoverSlot.gy === s.gy;
      if (hov) continue; // 호버 칸은 아래에서 별도(밝게 + ＋ 프리뷰)
      const cx = ox + s.gx * GRID, cy = oy + s.gy * GRID;
      const x0 = (cx - half) | 0, y0 = (cy - half) | 0;
      b.fillStyle = `rgba(120,210,120,${(pa * 0.5).toFixed(2)})`;
      this._rectOutline(b, x0, y0, GRID, GRID, 1);
    }

    // 호버 프리뷰: 마우스 아래가 활성화 가능 후보 칸이면 "선택" 디자인(밝은 박스 + 중앙 ＋)을 표시한다
    //   (클릭 한 번에 바로 심기 팝업 — 중간 선택 상태 없음). 콜드 스타트 자유 선택도 동일.
    if (this.hoverSlot) {
      const s = this.hoverSlot;
      const cx = ox + s.gx * GRID, cy = oy + s.gy * GRID;
      const x0 = (cx - half) | 0, y0 = (cy - half) | 0;
      b.fillStyle = `rgba(180,255,170,${pa.toFixed(2)})`;
      this._rectOutline(b, x0 - 1, y0 - 1, GRID + 2, GRID + 2, 1);
      b.fillStyle = `rgba(220,255,200,${pa.toFixed(2)})`;
      this._rectOutline(b, x0, y0, GRID, GRID, 1);
      // 픽셀 십자 ＋ 버튼(도트 스타일). 중앙에 2px 두께 십자.
      const mx = cx | 0, my = cy | 0;
      b.fillStyle = `rgba(235,255,220,${Math.min(1, pa + 0.25).toFixed(2)})`;
      b.fillRect(mx - 5, my - 1, 11, 2);
      b.fillRect(mx - 1, my - 5, 2, 11);
    }

    // 커서 그리드 하이라이트: 후보가 아닌 칸 위에선 아주 옅은 외곽만(후보와 구분).
    //   후보 칸은 위 호버 프리뷰가 담당하므로 여기선 그리지 않는다.
    if (this.cursorGrid) {
      const g = this.cursorGrid;
      const isHov = this.hoverSlot && this.hoverSlot.gx === g.gx && this.hoverSlot.gy === g.gy;
      if (!isHov && !g.valid) {
        const cx = ox + g.gx * GRID, cy = oy + g.gy * GRID;
        const x0 = (cx - half) | 0, y0 = (cy - half) | 0;
        const a = 0.5 + 0.25 * Math.abs(Math.sin(this.frame * 0.12));
        {
          b.fillStyle = `rgba(200,210,200,${(a * 0.3).toFixed(2)})`; // 비후보: 아주 흐리게
          this._rectOutline(b, x0, y0, GRID, GRID, 1);
        }
      }
    }

    // 활성화 이펙트: 심은 그리드 외곽선을 사방으로 감싸는 글로우가 바깥으로 번지며 페이드.
    if (this.plantFx) {
      const fx = this.plantFx;
      const t = (this.frame - fx.startFrame) / fx.dur; // 0~1
      if (t >= 1) {
        this.plantFx = null;
      } else {
        const cx = ox + fx.gx * GRID, cy = oy + fx.gy * GRID;
        const x0 = (cx - half) | 0, y0 = (cy - half) | 0;
        const a = (1 - t) * 0.95; // 페이드아웃
        // 그리드 외곽선을 사방으로 감싸는 글로우(여러 겹, 바깥으로 번지며 옅어짐).
        const spread = 1 + Math.round(t * 5);
        for (let i = spread; i >= 0; i--) {
          const ga = a * (1 - i / (spread + 1));
          b.fillStyle = `rgba(200,255,190,${ga.toFixed(2)})`;
          this._rectOutline(b, x0 - i, y0 - i, GRID + i * 2, GRID + i * 2, 1);
        }
      }
    }
  }

  // 좌표 라벨(최상단 패스): 뷰포트에 보이는 모든 그리드 칸(빈 칸 포함)에 (gx,gy) 를 나무·잔디·숲·
  //   파티클 위로 그린다. 좌표=화면위치 대조용. 어떤 배경에서도 읽히게 어두운 1px 그림자 + 밝은 글자.
  //   hY 위(하늘)는 건너뛴다.
  _drawCoordLabels(b, W, H, ox, oy, hY) {
    // LOD: 줌아웃 조망(큰 백버퍼)에선 수천 개 라벨을 매 프레임 그리면 멈춘다. 그 배율에선 좌표가
    //   어차피 안 읽히므로 생략(상시 표시는 줌인 뷰에서만).
    if (W * H > 1_500_000) return;
    const half = GRID / 2;
    // 보이는 그리드 칸 좌표 범위(여유 1칸). 그리드 중심 = ox + gx*GRID.
    // 맵 밖 좌표 라벨 금지 — gx∈[0,99]·gy∈[0,39] 로 클램프.
    const gxMin = Math.max(MAP_GX0, Math.floor((0 - ox) / GRID) - 1);
    const gxMax = Math.min(MAP_GX1, Math.ceil((W - ox) / GRID) + 1);
    const gyMin = Math.max(MAP_GY0, Math.floor((Math.max(0, hY) - oy) / GRID) - 1);
    const gyMax = Math.min(MAP_GY1, Math.ceil((H - oy) / GRID) + 1);
    b.font = "bold 9px monospace";
    b.textAlign = "center";
    b.textBaseline = "middle";
    for (let gy = gyMin; gy <= gyMax; gy++) {
      for (let gx = gxMin; gx <= gxMax; gx++) {
        const cx = (ox + gx * GRID) | 0;
        const cy = (oy + gy * GRID) | 0;
        // 셀이 화면 밖이면 skip(중심 기준 여유 half).
        if (cx < -half || cx > W + half || cy < Math.max(0, hY) - half || cy > H + half) continue;
        const ty = (cy + half - 7) | 0; // 칸 하단 근처(나무 밑동 위, 잘 안 가림)
        const txt = gx + "," + gy;
        // 어두운 외곽(상하좌우 1px) → 밝은 글자. 모든 배경에서 또렷.
        b.fillStyle = "rgba(0,0,0,0.85)";
        b.fillText(txt, cx + 1, ty);
        b.fillText(txt, cx - 1, ty);
        b.fillText(txt, cx, ty + 1);
        b.fillText(txt, cx, ty - 1);
        b.fillStyle = "rgba(255,255,255,0.96)";
        b.fillText(txt, cx, ty);
      }
    }
  }

  // 사각 외곽선(채움 사각형 4개, 두께 t). 픽셀퍼펙트.
  _rectOutline(b, x, y, w, h, t) {
    b.fillRect(x, y, w, t); // 상
    b.fillRect(x, y + h - t, w, t); // 하
    b.fillRect(x, y, t, h); // 좌
    b.fillRect(x + w - t, y, t, h); // 우
  }

  // 그리드 1px 외곽: 변을 격자 위치(x0..x0+GRID)에 둬 인접 셀과 변을 공유한다.
  //   오른 변 = x0+GRID, 아래 변 = y0+GRID 에 그려 이웃 셀의 왼/위 변과 정확히 같은 픽셀 →
  //   인접 그리드 사이가 2px 로 두꺼워지거나 어긋나지 않고 일관 1px.
  _gridOutline(b, x0, y0) {
    const x1 = x0 + GRID, y1 = y0 + GRID;
    b.fillRect(x0, y0, GRID + 1, 1); // 상 (x0..x1)
    b.fillRect(x0, y1, GRID + 1, 1); // 하 (y1 = 이웃 위 변)
    b.fillRect(x0, y0, 1, GRID + 1); // 좌
    b.fillRect(x1, y0, 1, GRID + 1); // 우 (x1 = 이웃 좌 변)
  }

  // 풀↔흙 전이대 결 텍스처: 베이스(①)가 노이즈 워프로 풀/흙을 섞어 칠한 위에, 각 결 점의 월드 워프
  //   분류를 따라 풀잎(풀 픽셀)·흙 얼룩(흙 픽셀)을 흩뿌린다 → 결도 노이즈 경계를 따라간다. sx/sy =
  //   타일 좌상단(베이스와 동일 정렬). 타일 시드 결정적(팬 불변).
  _drawTransitionDetail(b, sx, sy, tx, ty, amp, dith) {
    g_drawTransitionDetail(this, b, sx, sy, tx, ty, amp, dith);
  }

  // 놓인 바위 장식(절차 바위 → 사용자 시트 blit 교체). 땅 위 풍경 오브젝트(차단 칸 바닥 바위와 별개).
  //   밑동 접지점 = (sx,sy). 타일 좌표(tx,ty) 시드 결정적(팬 깜빡임 0).
  //   - 바위군(2~4개): 큰 바위 발치에 작은 돌이 모인 군집도 시드로 허용(크기·프레임 섞임).
  //   - 크기 자유: 시드 변주. 5프레임(sprite_0_0..4) 중 시드 택1.
  //   - 시트 준비 전/실패 시 절차 폴백(_paintProceduralRock). 시트는 nearest 정수 스케일 베이크(캐시).
  //   - 군집 내부는 밑동 y(접지점) 기준 back→front 그려 겹침 닫음. Y-sort 로 호출되어 뒤 나무에 가려짐.
  _drawVolumeRock(b, sx, sy, tx, ty) {
    let seed = (((tx * 2654435761) ^ (ty * 40503) ^ 0x6b43a9c5) >>> 0) | 1;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    // 크기 상한 = 묘목 렌더 높이. 프레임 종횡비가 제각각이라 높이로 정규화해 어떤 프레임도 묘목을
    //   넘지 않게 한다(폭 정규화는 세로 바위가 묘목보다 훨씬 커짐).
    const capH = this._saplingRenderHeight();
    // 바위군 멤버 수: 60% 단일, 40% 2~4개 군집(작은 돌이 큰 바위 발치에 모임).
    let groupN = 1;
    if (rnd() < 0.4) groupN = 2 + ((rnd() * 3) | 0); // 2~4
    const members = [];
    for (let i = 0; i < groupN; i++) {
      // 첫 멤버 = 주 바위(묘목 이하), 이후 = 발치 작은 돌(더 작게).
      const isMain = i === 0;
      // 목표 높이: 주 바위 0.5~0.75×묘목, 위성 0.3~0.5×묘목. 묘목 상한 유지.
      const hFrac = isMain ? (0.5 + rnd() * 0.25) : (0.3 + rnd() * 0.2);
      const targetH = Math.max(4, Math.min(capH, Math.round(capH * hFrac)));
      // 프레임 가중 분포(작은 돌 多·큰 바위 少). 시트 준비 시 weightedIndex, 아니면 균등(폴백).
      const frameIdx = this._useRockSheet() ? this.rockSheet.weightedIndex(rnd()) : ((rnd() * 5) | 0);
      // 위치: 주 바위 = 타일 중심, 위성 = 주 바위 발치 둘레(±~0.7타일, 약간 앞·옆).
      const jx = isMain ? 0 : Math.round((rnd() - 0.5) * TILE * 1.4);
      const jy = isMain ? 0 : Math.round(rnd() * TILE * 0.5); // 위성은 살짝 앞(아래)
      members.push({ frameIdx, targetH, mx: (sx + jx) | 0, my: (sy + jy) | 0, isMain });
    }
    // 군집 내부 back→front: 밑동 y(my) 작은(뒤) → 큰(앞) 순.
    members.sort((a, c) => a.my - c.my);
    const useSheet = this._useRockSheet();
    for (const m of members) {
      if (useSheet) {
        const sp = this._rockSprite(m.frameIdx, m.targetH);
        if (sp) {
          // 접지 그림자(밑동 아래 반투명 타원) — blit 직전 바닥에 깔아 "땅에 놓인" 느낌.
          drawGroundShadow(b, m.mx, m.my, sp.w);
          // 밑동=하단중앙 앵커: 스프라이트 하단중앙을 (mx,my)에 맞춤. 정수 좌표(픽셀퍼펙트).
          b.drawImage(sp.canvas, (m.mx - (sp.w >> 1)) | 0, (m.my - sp.h) | 0);
          continue;
        }
        // 베이크 실패 시 절차 폴백(아래).
      }
      // 절차 폴백: 목표 높이 → 반높이·반너비(돔 종횡비 ~). 변형은 프레임 인덱스로 근사(낮음/높음).
      const rh = Math.max(2, (m.targetH * 0.5) | 0);
      const rw = Math.max(3, ((m.frameIdx & 1) ? rh * 1.05 : rh * 1.4) | 0); // 변형별 폭
      drawGroundShadow(b, m.mx, m.my, rw * 2); // 절차 바위도 그림자
      paintProceduralRock(b, m.mx, m.my, rw, rh, m.frameIdx & 1, rnd);
    }
  }

  // 바위 시트 1프레임을 목표 높이(targetH)로 nearest 정수 스케일 베이크(캐시). 반환 {canvas,w,h}.
  //   폭이 아니라 높이로 맞춰 어떤 프레임도 묘목 높이를 안 넘게(세로 바위 포함). 종횡비 유지.
  //   밑동=하단중앙 앵커는 그리는 쪽. nearest(imageSmoothing=false) 픽셀퍼펙트. 캐시 키 = frameIdx|targetH.
  _rockSprite(frameIdx, targetH) {
    const key = frameIdx + "|" + targetH;
    let sp = this.rockSpriteCache.get(key);
    if (sp) { this.rockSpriteCache.delete(key); this.rockSpriteCache.set(key, sp); return sp; }
    const fr = this.rockSheet.frameByIndex(frameIdx);
    if (!fr) return null;
    const scale = targetH / fr.h; // 높이 맞춤(폭도 같은 비율 — 종횡비 유지)
    const dw = Math.max(1, Math.round(fr.w * scale));
    const dh = Math.max(1, Math.round(fr.h * scale));
    if (dw > 4096 || dh > 4096) return null;
    const cv = document.createElement("canvas");
    cv.width = dw; cv.height = dh;
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false; // nearest(픽셀퍼펙트)
    g.drawImage(this.rockSheet.image, fr.x, fr.y, fr.w, fr.h, 0, 0, dw, dh);
    sp = { canvas: cv, w: dw, h: dh };
    this.rockSpriteCache.set(key, sp);
    // LRU 상한.
    if (this.rockSpriteCache.size > this.rockSpriteCap) {
      const oldest = this.rockSpriteCache.keys().next().value;
      this.rockSpriteCache.delete(oldest);
    }
    return sp;
  }

  // 절차적 활엽수 정면 스프라이트: 굵은 기둥(껍질 결 + 황금 균열) + 입체 수관 + 수액.
  // 일반 셀 나무: 스프라이트(베이크 캐시) 한 장을 화면 밑동에 drawImage 1콜.
  //   프레임당 절차 픽셀 루프(통합 음영 마스크·root scatter)는 베이크로 이동 → 버벅임 해소.
  //   캐시 키 = date + 톤(live/past) + stage(형태 시그니처). 셀 데이터 갱신·스테이지 변화 시
  //   setData 가 _invalidateSprite 로 해당 키 무효화(아래). 밑동 = sy+5(땅에 박힌 느낌) 유지.
  _drawTree(b, cell, sx, sy) {
    const baked = this.bakedByDate.get(cell.params.date);
    if (!baked) return;
    const live = cell.isActive;
    const P = live ? PAL : PAL_PAST;
    // 과거 나무는 살짝 작게 → 개별 구분. 활성은 1.0.
    const ds = live ? 1.0 : 0.85;
    const sd = cell.params.seed || cell.params.date;
    // 시트: 수종(시드 결정적)·성목 하위단계(stageProgress)도 키에 반영(같은 날 진행도가 하위프레임
    //   경계를 넘으면 재베이크). 절차 폴백은 sheetInfo 를 무시한다.
    const sub = this._subFrame(cell.params.stage, cell.params.stageProgress);
    const key = "d|" + cell.params.date + "|" + (live ? "L" : "P") + "|" + cell.params.stage + "|s" + sub;
    const sheetInfo = {
      // 수종 = 서버 데이터값(params.species) 우선, 없으면 speciesFor(seed) 폴백(하위호환).
      species: cell.params.species != null ? cell.params.species : this.sheet.speciesFor(sd),
      stage: cell.params.stage,
      stageProgress: cell.params.stageProgress,
      past: !live,
    };
    const sp = this._treeSprite(key, baked, P, ds, sd, true, sheetInfo);
    if (!sp) return;
    const baseY = sy + 5; // 밑동을 타일 중심보다 아래(땅에 박힌 느낌)
    b.drawImage(sp.canvas, (sx - sp.ax) | 0, (baseY - sp.ay) | 0);
  }

  // 그늘 밑동 수집(D·E·F): 이번 프레임 그릴 나무 밑동의 월드 좌표(wx,wy)와 그늘 반경(rad)을 한 번 모은다.
  //   풀(바닥) 패스가 _shadeAt 로 가장 가까운 밑동을 조회한다. 화면 범위(tox/toy 기준 컬링된 그리드/숲)만
  //   모아 작업집합 = 보이는 칸 수십 개. 월드 좌표라 팬 불변·결정적. 베이크와 무관(매 프레임 바닥 패스).
  //   반경 = _footprintWidth(stage) × shadowRadiusFactor — 단계별 자동 비례(묘목<유목<성목). 시트 blit dw 도
  //   _sheetTargetWidth=_footprintWidth(MATURE)×1.15 로 정규화돼 같은 비례라 절차/시트 공통 기준.
  _collectShadeStumps(ox, oy, W, H) {
    const stumps = [];
    const MARGIN = GRID * 2;
    const rf = VEG_TWEAKS.shadowRadiusFactor;
    // 활성 그리드: 각 셀 placement 밑동(나무 그리기와 동일 식: gridToScreen + offsetTiles, baseY=sy+5).
    for (const cell of this.cells) {
      if (cell.params.stage === STAGE.EMPTY) continue; // empty=나무 없음 → 그늘 0(D 자동)
      if (cell.bundled) continue; // 묶인 달은 숲 instances 로(아래)
      const sc = gridToScreen(cell.gx, cell.gy, ox, oy);
      const off = cell.placement ? cell.placement.offsetTiles : { x: 0, y: 0 };
      const sx = sc.x + off.x * TILE;
      const sy = sc.y + off.y * TILE + 5; // baseY
      if (sx < -MARGIN || sx > W + MARGIN || sy < -MARGIN || sy > H + MARGIN) continue;
      const fw = this._footprintWidth(cell.params.stage);
      if (!Number.isFinite(fw)) continue;
      stumps.push({ wx: sx, wy: sy, rad: fw * rf });
    }
    // 묶인 숲: forest.instances 밑동(월드 px wx/wy). 같은 그늘 로직(F 공통).
    for (const fb of this.forestBlobs) {
      const cluster = this.forestTrees.get(fb.ym);
      if (!cluster) continue;
      const insts = cluster.instances || [];
      for (const inst of insts) {
        const sx = ox + (inst.wx - this.worldOriginX);
        const sy = oy + (inst.wy - this.worldOriginY);
        if (sx < -MARGIN || sx > W + MARGIN || sy < -MARGIN || sy > H + MARGIN) continue;
        // 군집 그루는 scale(0.4~1.0)로 묘목~성목. 폭 ≈ _footprintWidth(MATURE)×scale 근사.
        const fw = this._footprintWidth(STAGE.MATURE) * (inst.scale || 0.5);
        stumps.push({ wx: sx, wy: sy, rad: fw * rf });
      }
    }
    return stumps;
  }

  // E 활성 그리드 흙: 그늘(밑동 근처) 안 타일에 흙 도트를 §40식 월드 노이즈로 소량 복원한다.
  //   풀이 주·흙은 보조 — soil(≤0.35) 보다 노이즈가 큰 블록만 흙(=일부만). 흙 3색은 비활성 흙과 통일.
  //   **흙 도트 크기 = 1px**(빈 대지 흙자국 drawEmptyDirtPatch 의 1×1 도트와 동일·기존 2px 블록의 1/4).
  //   블록 격자 STEP=2 는 노이즈 샘플 간격으로 유지하되, 찍는 도트는 격자 중심에 1×1 만.
  _drawShadeSoil(b, sx, sy, tx, ty, soil) {
    const STEP = 2; // 노이즈 샘플 간격(흙 도트 자체는 1px — 기존 도트 치수의 1/4)
    const x0 = sx | 0, y0 = sy | 0;
    for (let by = 0; by < TILE; by += STEP) {
      for (let bx = 0; bx < TILE; bx += STEP) {
        const u = tx + (bx + STEP / 2) / TILE; // 블록 중심 월드 타일좌표(팬 불변)
        const v = ty + (by + STEP / 2) / TILE;
        const n = fbm(u * 1.6, v * 1.6, 0); // §40식 월드 노이즈(0~1)
        if (n >= soil) continue; // soil 보다 큰 블록은 풀 유지 — 흙은 "약간"만
        // 3색 변주(블록 월드좌표 해시·팬 불변). 비활성 흙과 같은 pendDirt 3색.
        const vv = (((((u * 4) | 0) * 374761393) ^ (((v * 4) | 0) * 668265263)) >>> 0) % 3;
        b.fillStyle = vv === 0 ? PAL.pendDirtA : vv === 1 ? PAL.pendDirtB : PAL.pendDirtC;
        // 도트 1px(빈 대지 흙자국과 동일 치수): 블록 좌상단 대신 블록 중심 근처 1px.
        b.fillRect(x0 + bx, y0 + by, 1, 1);
      }
    }
  }

  // 그늘 조회(F 공통): 화면 좌표(sx,sy)에서 가장 가까운 밑동까지 거리를 보고 풀 감쇠(atten)와
  //   흙 비율(soil)을 반환. 그늘(=풀잎 영역) 안에선 밑동에 가까울수록 풀잎이 적고(그늘) 흙이 약간
  //   드러난다. 흙 영역도 이 그늘 반경 안(밑동 근처)이다. 그늘 반경 밖이면 {atten:0, soil:0}(무성).
  //   이진 아닌 거리 점진(반경 0 → 중심 1·선형). _shadeStumps 가 비면 전부 무성. empty 셀은 가까운
  //   밑동이 없어 자동 0.
  _shadeAt(sx, sy) {
    const stumps = this._shadeStumps;
    if (!stumps || stumps.length === 0) return { atten: 0, soil: 0 };
    let best = Infinity; // 가장 강한 그늘(반경 대비 가장 깊이 든) 우선
    for (let i = 0; i < stumps.length; i++) {
      const st = stumps[i];
      const dx = sx - st.wx, dy = sy - st.wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= st.rad) continue; // 반경 밖
      const t = d / st.rad; // 0(밑동) ~ 1(반경 끝)
      if (t < best) best = t;
    }
    if (best === Infinity) return { atten: 0, soil: 0 };
    const depth = 1 - best; // 1(밑동) ~ 0(반경 끝)
    const atten = depth * VEG_TWEAKS.shadowGrassAtten; // 풀 감쇠
    const soil = depth * VEG_TWEAKS.soilAmount; // 밑동 근처 흙 비율("약간")
    return { atten, soil };
  }

  // ===================== UI 데이터 노출 (DOM 오버레이용) =====================
  // 캔버스에 UI 를 안 그린다. DOM(main.js)이 아래 getter 로 텍스트·표시를 갱신한다.
  getHud() {
    return this.hud; // { input,output,cacheWrite,cacheRead,requests,oxygen,level } | null
  }
  isOffline() {
    return this.offline;
  }
  isEmpty() {
    return this.empty;
  }
  // 호버 셀 + 포인터 위치(없으면 null). DOM 툴팁이 이걸로 표시·배치.
  getHover() {
    if (!this.hoverCell) return null;
    return { info: this.cellInfo(this.hoverCell), pos: this._lastPointer };
  }
  // 선택(상세) 셀(없으면 null).
  getSelected() {
    return this.selectedCell ? this.cellInfo(this.selectedCell) : null;
  }

  // 선택 칸(selectedCell)을 sizePx 정사각 오프스크린에 렌더 → dataURL(PNG). 상세 모달 상단 프리뷰용.
  //   나무 + 바닥 블록만(식생 없음). **바닥 블록은 단계 무관 고정 너비**(나무 폭에 안 묶임): 캔버스 중앙
  //   하단에 고정폭 grass/dirt 윗면 + 짙은 흙 측벽(2.5D 단면) + 접지 그림자. 나무는 그 위에 가로중앙·밑동
  //   앵커로 얹되 스케일은 정수배 nearest(readability — 묘목 크게·성목 ~1x). 나무가 블록보다 넓어도
  //   블록은 불변(위로 시원하게 퍼짐 OK). 바닥색 = _isActiveGridCell(배치 칸=풀·아니면 흙). EMPTY=블록만.
  //   묶인 셀 null. 같은 키 캐시(폴마다 재생성 0)·imageSmoothing=false.
  //   @returns {string|null} "data:image/png;..." 또는 null
  selectedCellPreview(sizePx) {
    const cell = this.selectedCell;
    if (!cell || cell.bundled) return null;
    const size = sizePx || 128;
    const stage = cell.params.stage;
    const sub = this._subFrame(stage, cell.params.stageProgress);
    const liveGrid = this._isActiveGridCell(cell.gx, cell.gy); // 배치된 칸이면 풀밭(맵과 동일)
    const key = "pv|" + size + "|" + cell.params.date + "|" + (liveGrid ? "A" : "I") + "|" + stage + "|s" + sub;
    if (this._previewCache && this._previewCache.key === key) return this._previewCache.url;

    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;

    // 1) 바닥 블록(단계 무관 고정 너비) — 두꺼운 흙 덩이(slab). 입체 레버: 흙벽 세로 음영 램프 +
    //   윗면 앞 오버행 립(처마 그늘) + 양옆 측면 슬리버 + 접지 그림자. 중앙·하단·정수.
    const blockW = Math.round(size * 0.72);
    const wallH = Math.round(blockW * 0.20);  // 흙 두께(두툼하게)
    const faceH = Math.round(blockW * 0.42);
    const lip = 2;                            // 윗면 앞 오버행(처마) px
    const bx0 = ((size - blockW) / 2) | 0;
    const bottomPad = Math.round(size * 0.07);
    const wallBottom = size - bottomPad;
    const wallTop = (wallBottom - wallH) | 0;  // 흙벽 위(윗면 본체 하단·립이 이 위로 덮음)
    const faceTop = (wallTop - faceH) | 0;
    const groundLine = wallTop;                // 나무 밑동이 놓일 지면선
    // 접지 그림자 — 블록보다 넓게 2단(부드러운 덩이감).
    g.fillStyle = "rgba(12,20,12,0.14)";
    g.fillRect((size / 2 - blockW * 0.60) | 0, wallBottom + 2, (blockW * 1.20) | 0, 3);
    g.fillStyle = "rgba(12,20,12,0.22)";
    g.fillRect((size / 2 - blockW * 0.48) | 0, wallBottom + 1, (blockW * 0.96) | 0, 2);
    // 흙벽 세로 음영 램프 — 위(밝은 갈색)→아래(짙은 갈색), 행 단위. 빛 받는 면.
    const topC = [0x6f, 0x52, 0x32], botC = [0x29, 0x1c, 0x11];
    for (let y = 0; y < wallH; y++) {
      const f = wallH > 1 ? y / (wallH - 1) : 0;
      const r = Math.round(topC[0] + (botC[0] - topC[0]) * f);
      const gg = Math.round(topC[1] + (botC[1] - topC[1]) * f);
      const bb = Math.round(topC[2] + (botC[2] - topC[2]) * f);
      g.fillStyle = "rgb(" + r + "," + gg + "," + bb + ")";
      g.fillRect(bx0, (wallTop + y) | 0, blockW, 1);
    }
    // 윗면(grass/dirt) — 앞 오버행 립: 본체 + 아래로 lip 만큼 더 내밀어 처마. 배치 칸=풀·아니면 흙.
    g.fillStyle = liveGrid ? PAL.grassA : PAL.pendDirtA;
    g.fillRect(bx0, faceTop, blockW, faceH + lip);
    // 오버행 그늘선 — 립 바로 아래 흙벽에 얇은 그늘(처마 그림자) → 두께 인지.
    g.fillStyle = "rgba(18,10,4,0.55)";
    g.fillRect(bx0, (wallTop + lip) | 0, blockW, 1);
    // 윗면 앞엣지 밝은 립 1px(빛 받는 처마 윗면) — grassC/밝은 톤.
    g.fillStyle = liveGrid ? (PAL.grassC || PAL.grassA) : PAL.pendDirtB || PAL.pendDirtA;
    g.fillRect(bx0, (wallTop + lip - 1) | 0, blockW, 1);
    // 양옆 측면 슬리버 — 블록 좌·우 가장자리 2px 짙은(두께 암시). 윗면+흙벽 전체 높이.
    g.fillStyle = "rgba(20,12,6,0.45)";
    g.fillRect(bx0, faceTop, 2, (wallBottom - faceTop) | 0);
    g.fillRect((bx0 + blockW - 2) | 0, faceTop, 2, (wallBottom - faceTop) | 0);
    // EMPTY: 윗면 중앙에 작은 흙 패치.
    if (stage === STAGE.EMPTY) drawEmptyDirtPatch(g, (size / 2) | 0, (faceTop + faceH / 2) | 0, cell.gx, cell.gy);

    // 2) 나무(블록 위·가로중앙·밑동 앵커·정수배 nearest). 블록 폭과 무관(자기 스케일).
    if (stage !== STAGE.EMPTY) {
      const baked = this.bakedByDate.get(cell.params.date);
      if (baked) {
        const past = !cell.isActive;
        const P = past ? PAL_PAST : PAL;
        const ds = past ? 0.85 : 1.0;
        const sd = cell.params.seed || cell.params.date;
        const tkey = "d|" + cell.params.date + "|" + (past ? "P" : "L") + "|" + stage + "|s" + sub;
        const sheetInfo = {
          species: cell.params.species != null ? cell.params.species : this.sheet.speciesFor(sd),
          stage, stageProgress: cell.params.stageProgress, past,
        };
        const saved = this._bakesThisFrame;
        this._bakesThisFrame = 0;
        const sp = this._treeSprite(tkey, baked, P, ds, sd, true, sheetInfo);
        this._bakesThisFrame = saved;
        if (sp) {
          const spW = sp.canvas.width, spH = sp.canvas.height;
          // 정수배: 가로 size·세로 지면선 위 공간에 맞춤(밑동 앵커라 ay*scale ≤ groundLine).
          const scale = Math.max(1, Math.floor(Math.min((size - 8) / spW, (groundLine - 4) / spH)));
          const dw = spW * scale, dh = spH * scale;
          const dx = ((size / 2) - sp.ax * scale) | 0; // 밑동 ax 를 캔버스 중앙에
          const dy = (groundLine - sp.ay * scale) | 0;  // 밑동 ay 를 지면선에
          g.drawImage(sp.canvas, 0, 0, spW, spH, dx, dy, dw, dh);
        }
      }
    }
    const url = cv.toDataURL("image/png");
    this._previewCache = { key, url };
    return url;
  }

  // ===================== 히트테스트 / 상호작용 =====================
  // 캔버스 px(cx,cy) → 그리드 좌표(gx,gy). 카메라 cam/zoom 역변환. 하늘이면 null.
  hitTestGrid(cx, cy) {
    // 오버뷰: 스냅샷 분수 스케일 역변환. 맵은 하단 고정(snapTop) 이라 그 위(하늘)는 null.
    if (this.camera.overview) {
      const snap = this._mapSnapshot;
      if (!snap) return null;
      const mapTop = this.canvas.height - snap.snapH;
      if (cy < mapTop) return null; // 하늘
      const worldX = snap.offX + cx / snap.scale;
      const worldY = snap.offY + (cy - mapTop) / snap.scale;
      const gx = Math.round((worldX - this.worldOriginX) / GRID);
      const gy = Math.round((worldY - this.worldOriginY) / GRID);
      if (gx < MAP_GX0 || gx > MAP_GX1 || gy < MAP_GY0 || gy > MAP_GY1) return null;
      return { gx, gy };
    }
    const zoom = this.camera.cam.zoom || 1;
    const worldX = this.camera.cam.x + cx / zoom;
    const worldY = this.camera.cam.y + cy / zoom;
    if (worldY < this.worldHorizonY) return null; // 하늘
    return {
      gx: Math.round((worldX - this.worldOriginX) / GRID),
      gy: Math.round((worldY - this.worldOriginY) / GRID),
    };
  }
  // 캔버스 px → 셀(빈땅 포함) 또는 null. 상세 패널·툴팁·호버 떠오름용. 묶인 달 셀은 제외(숲 히트로 처리).
  //   ① 나무 스프라이트 bbox 우선(성목 수관 호버도 밑동 셀 잡음) ② 폴백 그리드 칸 조회.
  hitTestCanvas(cx, cy) {
    const t = this._treeAtCanvas(cx, cy);
    if (t) return t; // 나무 시각 영역(수관 포함) 안 → 그 나무 base 셀
    const g = this.hitTestGrid(cx, cy);
    if (!g) return null;
    const cell = this.cellByKey.get(g.gx + "," + g.gy) || null;
    if (cell && cell.bundled) return null; // 묶인 달은 숲 단위 — 일 셀 상세 막음(드릴다운 우선)
    return cell;
  }

  // 캔버스 px → 묶인 달 ym(숲 덩어리 영역) 또는 null. 클릭=드릴다운 토글, 호버=요약 툴팁.
  hitTestForest(cx, cy) {
    const g = this.hitTestGrid(cx, cy);
    if (!g) return null;
    const cell = this.cellByKey.get(g.gx + "," + g.gy);
    if (cell && cell.bundled) return cell.params.date.slice(0, 7);
    return null;
  }

  // 호버 셀 설정(null = 해제). 드래그 중엔 main 이 null 로 숨김.
  setHover(cell) {
    this.hoverCell = cell || null;
    this.hoverPos = cell ? this._lastPointer : null;
  }
  // 호버 중인 묶인 달(ym) 설정(null = 해제). 숲 군집 떠오름 대상.
  setHoverForest(ym) {
    this.hoverForestYm = ym || null;
  }
  // 마지막 포인터 위치(캔버스 px) — 툴팁 배치용.
  setPointer(cx, cy) {
    this._lastPointer = { x: cx, y: cy };
    if (this.hoverCell) this.hoverPos = this._lastPointer;
  }
  // 클릭 상세 토글. cell=null 이면 닫기.
  setSelected(cell) {
    this.selectedCell = cell || null;
  }
  toggleSelected(cell) {
    if (!cell) { this.selectedCell = null; return; }
    if (this.selectedCell && this.selectedCell.params.date === cell.params.date) {
      this.selectedCell = null; // 같은 셀 다시 클릭 → 닫기
    } else {
      this.selectedCell = cell;
    }
  }
  // 활성화 UI 갱신: 후보 빈칸 목록 + 선택 칸. main 이 pending 일 때만 세팅.
  setPlantUI(candidates, selected) {
    this.candidateSlots = candidates || [];
    this.selectedSlot = selected || null;
  }
  // 커서 그리드 하이라이트 세팅. g = {gx,gy,valid}|null. main 이 활성화 가능 시 매 mousemove.
  setCursorGrid(g) {
    this.cursorGrid = g || null;
  }
  // 호버 후보 칸 세팅. s = {gx,gy}|null. main 이 후보 칸 위에 마우스가 있을 때만 세팅 →
  //   선택 디자인(밝은 박스 + ＋)을 프리뷰로 표시(클릭 1번에 바로 확인 팝업).
  setHoverSlot(s) {
    this.hoverSlot = s ? { gx: s.gx, gy: s.gy } : null;
  }
  // 차단 집합(Map("gx,gy" → tag))을 받는다. main 이 폴마다 갱신. activation 의 blockedSet 과 동일한
  //   집합 — 후보 거름·클릭 거부·렌더가 한 소스를 참조. tag 로 종류별로 다르게 그린다(렌더만 분기).
  //   하위호환: Set 이 와도 안전.
  setBlocked(set) {
    this.blocked = (set instanceof Map || set instanceof Set) ? set : new Map();
  }
  // 타일(tx,ty)이 어느 차단 종류인가. null=비차단, "closed:YYYY-MM"=닫힘.
  //   활성불가 바위 폐기 → Map 의 tag(닫힘)만 반환. Set 폴백이 와도 종류 알 수 없으니 null.
  //   그리드 매핑은 _cellAtTile 과 동일(round(t/3)).
  _blockedKind(tx, ty) { return g_blockedKind(this, tx, ty); }
  // 차단 칸 여부(종류 무관). 기존 _drawGroundAndObjects 분기 호환.
  _isBlockedTile(tx, ty) { return g_isBlockedTile(this, tx, ty); }

  // 활성화 이펙트 재생(심은 그리드에서 빛기둥). 짧게 1회.
  playPlantEffect(gx, gy) {
    this.plantFx = { gx, gy, startFrame: this.frame, dur: 40 };
  }
  // 자동 묶기 빛기둥 재생: 묶인 달 멤버 그리드들에 동시에 짧게 솟는 빛기둥. cells=[{gx,gy}].
  //   main 이 forests[ym].bundled false→true 감지 시 그 달 placement 좌표들로 호출(일회성).
  playBundleEffect(cells) {
    if (!Array.isArray(cells) || cells.length === 0) return;
    this.bundleFx = { cells: cells.map((c) => ({ gx: c.gx, gy: c.gy })), startFrame: this.frame, dur: 48 };
  }

  // 그리드 한 칸의 자원 정보(DOM UI 가 표시). 빈땅이면 empty:true. 정확값(콤마).
  // 단계 진행(stageProgress)·전체 pct·다음 단계 정보도 노출(XP 바·다음 단계 표시).
  cellInfo(cell) {
    if (!cell || cell.params.stage === STAGE.EMPTY) {
      return { date: cell ? cell.params.date : "", empty: true, stage: 0, rows: [] };
    }
    const p = cell.params;
    const raw = p.raw || {};
    const num = (v) => (v || 0).toLocaleString("en-US");
    // 상세 모달 구체화: 수종·시드·정규화 비중 노출(rows 는 무회귀 유지).
    const sp = p.species != null ? p.species : this.sheet.speciesFor(p.seed || p.date);
    //   totalTokens = 토큰 4종 합(요청 수 제외) — 0 이면 평균 대비 표식을 그리지 않는다.
    const totalTokens =
      (raw.input || 0) + (raw.output || 0) + (raw.cacheWrite || 0) + (raw.cacheRead || 0);
    // 평균 대비 표식(▲/▼): 그날 raw 값 vs 활성일 평균(setData 가 1회 캐시한 _metricAvg).
    //   totalTokens 0(사용 없는 날)은 표식 미표시(빈 객체) — 모수에서도 빠진 날이라 비교 의미 없음.
    const avg = this._metricAvg || {};
    const avgCompare = totalTokens > 0
      ? {
          requests: compareToAvg(raw.requests, avg.requests),
          input: compareToAvg(raw.input, avg.input),
          output: compareToAvg(raw.output, avg.output),
          cacheWrite: compareToAvg(raw.cacheWrite, avg.cacheWrite),
          cacheRead: compareToAvg(raw.cacheRead, avg.cacheRead),
        }
      : null;
    // 침엽수 뱃지({dir,level}): 방향 + 평균 대비 정도(삼각형 1~3개). 상세 모달 표시 전용.
    //   avgCompare(방향 문자열)는 계약 유지(무회귀), 뱃지는 별도 필드로 더한다.
    const avgBadges = totalTokens > 0
      ? {
          requests: avgBadge(raw.requests, avg.requests),
          input: avgBadge(raw.input, avg.input),
          output: avgBadge(raw.output, avg.output),
          cacheWrite: avgBadge(raw.cacheWrite, avg.cacheWrite),
          cacheRead: avgBadge(raw.cacheRead, avg.cacheRead),
        }
      : null;
    return {
      date: p.date,
      empty: false,
      stage: p.stage,
      stageProgress: p.stageProgress ?? 0, // 0~1 (현재 단계 진행)
      pct: p.pct ?? 0, // 0~1+ (전체)
      isActive: !!cell.isActive,
      species: sp,
      norms: p.norms || null, // {inputN,...} logNorm — 나무 렌더용(상세 표시엔 linPct 사용)
      linPct: p.linPct || null, // 상세 표시 전용 선형 비중(역대 최대 대비, raw/refMax)
      avgCompare, // 메트릭별 평균 대비 {requests,input,...} = "up"|"down"|"eq" (없으면 null)
      avgBadges, // 메트릭별 침엽수 뱃지 {requests,input,...} = {dir,level} (없으면 null)
      totalTokens, // 토큰 4종 합 — 0 이면 평균 대비 표식 미표시
      raw: { // 원시 수치(툴팁 한글 약식용). rows 는 정밀 콤마 유지(상세 모달).
        requests: raw.requests || 0,
        input: raw.input || 0,
        output: raw.output || 0,
        cacheWrite: raw.cacheWrite || 0,
        cacheRead: raw.cacheRead || 0,
      },
      rows: [
        ["Requests", num(raw.requests)],
        ["Input Tokens", num(raw.input)],
        ["Output Tokens", num(raw.output)],
        ["Cache Creation", num(raw.cacheWrite)],
        ["Cache Read", num(raw.cacheRead)],
      ],
    };
  }

  // 묶인 달 숲 요약(툴팁/표기용). forests[ym].monthly 직접 사용(클라 재계산 줄임).
  forestInfo(ym) {
    const f = this.forests[ym];
    if (!f) return null;
    const m = f.monthly || {};
    const num = (v) => (v || 0).toLocaleString("en-US");
    return {
      month: ym,
      bundled: !!f.bundled,
      rows: [
        ["나무", `${m.treeCount || 0} 그루 (활성 ${m.activeDays || 0}일)`],
        ["Requests", num(m.requestCount)],
        ["Input Tokens", num(m.inputTokens)],
        ["Output Tokens", num(m.outputTokens)],
        ["Cache Creation", num(m.cacheWriteTokens)],
        ["Cache Read", num(m.cacheReadTokens)],
      ],
    };
  }

  // 미니맵 그리기. 별도 작은 캔버스(mctx, mw×mh px)에 전체 맵(_mapWorldBounds)을 축소해 그린다.
  //   표시만(상호작용 없음). 좌표는 맵 bbox·카메라 변환 재사용 — 매 프레임 저비용.
  //   박스 6:4. 땅은 가로 꽉(스케일 s=mw/맵폭) + 비율 유지하며 아래쪽, 위 남는 공간은 하늘.
  //     세로도 같은 s 를 써 땅 비율(5:2) 유지 → 땅 높이 = 맵높이*s. 박스 위 여백(mh-땅높이)=하늘.
  //     하늘은 카메라가 맵 북단(지평선) 위로 올라가 볼 수 있는 영역(_clampPan SKY_VIEW)에 대응.
  //   · 하늘 = 그라데이션(skyTop→skyBot), 땅 = 흙톤.
  //   · 점: 활성 나무=초록·묶인 숲 멤버=진초록·배치된 빈칸=옅은 흙.
  //   · 뷰포트 사각: 카메라 보는 월드 범위 [cam.x,cam.x+bufW]×[cam.y,cam.y+bufH] → 하늘 포함 좌표.
  drawMinimap(mctx, mw, mh) {
    if (!mctx) return;
    const m = this._mapWorldBounds();
    const wW = Math.max(1, m.x1 - m.x0);
    // 가로를 꽉 채우는 단일 스케일(세로도 동일 → 땅 비율 유지). 땅은 아래쪽, 위는 하늘.
    const s = mw / wW;
    const landH = (m.y1 - m.y0) * s;          // 미니맵 내 땅 높이(px)
    const landTop = mh - landH;                // 땅 시작 y(아래쪽 정렬) → 위 [0..landTop]=하늘
    // 월드 → 미니맵 px. y 는 땅 상단(m.y0)이 landTop 에 오도록(하늘은 그 위로 음수 월드까지 매핑).
    const mapX = (wx) => (wx - m.x0) * s;
    const mapY = (wy) => landTop + (wy - m.y0) * s;

    mctx.clearRect(0, 0, mw, mh);
    // 하늘(위 [0..landTop]) — 그라데이션. 땅(아래) — 흙톤.
    if (landTop > 0) {
      const g = mctx.createLinearGradient(0, 0, 0, landTop);
      g.addColorStop(0, "rgba(70, 110, 150, 0.85)");
      g.addColorStop(1, "rgba(120, 160, 190, 0.85)");
      mctx.fillStyle = g;
      mctx.fillRect(0, 0, mw, Math.ceil(landTop));
    }
    mctx.fillStyle = "rgba(58, 46, 32, 0.88)";
    mctx.fillRect(0, Math.floor(landTop), mw, Math.ceil(landH) + 1);

    // 칸 점(셀당 GRID 월드 = s*GRID px). 최소 1px 보장(축소 심해도 보이게).
    const dot = Math.max(1, Math.round(GRID * s));
    for (const cell of this.cells) {
      if (!cell || !cell.params) continue;
      const empty = cell.params.stage === STAGE.EMPTY;
      // 색: 묶인 숲 멤버 > 활성 나무 > 배치된 빈칸.
      let color;
      if (cell.bundled) color = "#1f6b2e";              // 진초록(숲)
      else if (!empty) color = "#4fb84a";               // 초록(활성 나무)
      else if (cell.isActive) color = "#8a7a52";        // 오늘 빈땅(배치됨) — 옅은 흙
      else continue;                                     // 미배치 빈칸은 안 그림
      const px = Math.round(mapX(this.worldOriginX + cell.gx * GRID - GRID / 2));
      const py = Math.round(mapY(this.worldOriginY + cell.gy * GRID - GRID / 2));
      mctx.fillStyle = color;
      mctx.fillRect(px, py, dot, dot);
    }

    // 뷰포트 사각(현재 카메라가 보는 범위, 하늘 포함). 흰 테두리.
    const vx = mapX(this.camera.cam.x);
    const vy = mapY(this.camera.cam.y);
    const vw = Math.max(2, this.bufW * s);
    const vh = Math.max(2, this.bufH * s);
    // 미니맵 박스(0..mw, 0..mh) 안으로 클램프(테두리만 보이게). 하늘 쪽(y<landTop)도 허용.
    const cx0 = Math.max(0, vx), cy0 = Math.max(0, vy);
    const cx1 = Math.min(mw, vx + vw), cy1 = Math.min(mh, vy + vh);
    mctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    mctx.lineWidth = 1;
    mctx.strokeRect(Math.round(cx0) + 0.5, Math.round(cy0) + 0.5, Math.max(1, Math.round(cx1 - cx0)), Math.max(1, Math.round(cy1 - cy0)));
  }

  /**
   * 미니맵 클릭/드래그 내비게이션: 미니맵 px (mx,my) 아래 월드 지점을 화면 중앙으로 팬한다.
   *   drawMinimap 의 mapX/mapY 역변환(같은 s·landTop). 오버뷰면 무시(뷰포트 사각이 맵 전체라
   *   팬 의미 없음).
   * @param {number} mx 미니맵 캔버스 px x
   * @param {number} my 미니맵 캔버스 px y
   * @param {number} mw 미니맵 캔버스 너비
   * @param {number} mh 미니맵 캔버스 높이
   * @returns {boolean} 팬했으면 true(오버뷰로 무시하면 false).
   */
  minimapPanTo(mx, my, mw, mh) {
    if (this.camera.overview) return false;
    const m = this._mapWorldBounds();
    const wW = Math.max(1, m.x1 - m.x0);
    const s = mw / wW;
    const landH = (m.y1 - m.y0) * s;
    const landTop = mh - landH;
    // 미니맵 px → 월드(drawMinimap mapX/mapY 의 역).
    const worldX = m.x0 + mx / s;
    const worldY = m.y0 + (my - landTop) / s;
    this.camera.centerOnWorld(worldX, worldY);
    return true;
  }

}
