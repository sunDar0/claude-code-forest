// 절차적 활엽수 빌더 (순수 데이터, 캔버스 무관).
//
// 나무 아트는 렌더에서 스프라이트 시트(public/sprite/)로 그린다. 이 빌더의 아트용 출력
// (crown 블롭·trunkSegs 페인팅 형상)은 시트가 로드되면 렌더가 쓰지 않는다(폴백 전용).
// 단 footprint(height/halfWidth)·crownMinY/Max(파티클 발생원 근사)·placement·skeleton 은
// 항상 쓰이므로 buildTree/buildForest 반환 형태는 불변이어야 한다(경계면 보존).
//
// 한 그루 구성:
//   - 굵은 갈색 기둥(아래가 넓고 위로 가늘어짐) + 가지 2~5개
//   - 위에 여러 겹 둥근 초록 수관(뭉게구름 블롭 겹침)
//   - 골격(기둥+가지) 폴리라인을 노출 → 황금 수액이 이 경로를 타고 흐른다(particles)
//
// 좌표계: 원점(0,0)=기둥 밑동(땅), +y 가 위. 렌더러가 y 부호 뒤집어 그린다.

import { STAGE } from "./metrics.js";
import { GRID } from "./grid.js";
import { hash32 } from "./seed.js";

// 결정적 RNG (mulberry32). 같은 날짜=같은 모양 → 깜빡임 없음.
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 단계별 전체 스케일 — 크기 차이를 극적으로(묘목 ≪ 유목 ≪ 성목).
// 묘목은 buildSprout 가 별도로 아주 작게, 유목은 중간, 성목은 크게(몸통 두께도 스케일에 비례).
export const STAGE_SCALE = {
  [STAGE.EMPTY]: 0,
  [STAGE.SAPLING]: 0.4, // 새싹(buildSprout 가 이 스케일로 더 작게)
  [STAGE.YOUNG]: 0.62, // 어린 나무(작게)
  [STAGE.MATURE]: 1.15, // 큰 고목(몸통·수관 모두 크게)
};

// ===========================================================================
// 단계별 방향성 배치 (그리드별 날짜 시드, 결정적)
// ===========================================================================
// 나무를 그리드 중앙에 고정하지 않는다. 날짜 시드로 씨앗 칸을 정하고, 단계별로
// 점유 영역·수관 무게 방향을 결정한다. 반환은 "타일 단위" 오프셋(렌더가 TILE 곱).
// 같은 날짜는 항상 같은 결과(묘목→유목→성목 성장에도 씨앗 일관).

// 씨앗 칸을 포함하는 2×2 모서리 블록(들). 각 블록은 {cx,cy} (블록의 바깥 모서리 방향).
// 2×2 블록 = 타일 {0 또는 -1, 0 또는 +1} 묶음 4종(TL/TR/BL/BR). cx,cy ∈ {-1,+1}.
// 블록 TL(cx=-1,cy=-1) = 타일 {(-1,-1),(0,-1),(-1,0),(0,0)} → 씨앗 tx∈{-1,0}, ty∈{-1,0}.
function cornersForSeed(stx, sty) {
  const out = [];
  for (const cx of [-1, 1]) {
    for (const cy of [-1, 1]) {
      // 모서리 cx 인 2×2 가 덮는 tx: cx<0 → {-1,0}, cx>0 → {0,1}.
      const txOk = cx < 0 ? stx <= 0 : stx >= 0;
      const tyOk = cy < 0 ? sty <= 0 : sty >= 0;
      if (txOk && tyOk) out.push({ cx, cy });
    }
  }
  return out;
}

// 2×2 모서리 블록의 점유 타일 4개. cx,cy ∈ {-1,+1}.
function cornerTiles(cx, cy) {
  const xs = cx < 0 ? [-1, 0] : [0, 1];
  const ys = cy < 0 ? [-1, 0] : [0, 1];
  const t = [];
  for (const x of xs) for (const y of ys) t.push([x, y]);
  return t;
}

/**
 * 날짜·단계 기반 그리드 내 나무 배치를 결정적으로 계산한다.
 * @param {string} date 일자 키(시드 소스 — 같은 날짜=같은 배치)
 * @param {string} stage STAGE.SAPLING|YOUNG|MATURE 등 단계
 * @returns {{seed:{tx:number,ty:number}, corner:({cx:number,cy:number}|null), offsetTiles:{x:number,y:number}, footprint:number[][]}}
 *   seed=씨앗 칸(-1..1)², corner=쏠림 모서리(null=중앙 균형),
 *   offsetTiles=점유 영역 중심 오프셋(타일), footprint=점유 타일(묘목1/유목2×2/성목9)
 */
export function gridPlacement(date, stage) {
  // 씨앗 칸: 날짜 시드로 9칸 중 1.
  const rng = makeRng(hash32(date + "|seed"));
  const seedIdx = Math.floor(rng() * 9); // 0..8
  const stx = (seedIdx % 3) - 1; // -1,0,1
  const sty = Math.floor(seedIdx / 3) - 1;

  if (stage === STAGE.SAPLING) {
    // 묘목: 씨앗 칸 위치에 작게(중앙 고정 아님).
    return {
      seed: { tx: stx, ty: sty },
      corner: null,
      offsetTiles: { x: stx, y: sty },
      footprint: [[stx, sty]],
    };
  }

  if (stage === STAGE.YOUNG) {
    // 유목: 씨앗 칸을 포함하는 2×2 모서리 중 하나(여럿이면 시드로).
    const cands = cornersForSeed(stx, sty);
    const pick = cands[Math.floor(rng() * cands.length)] || { cx: -1, cy: -1 };
    const tiles = cornerTiles(pick.cx, pick.cy);
    // 2×2 중심 = 모서리 방향으로 0.5 타일.
    return {
      seed: { tx: stx, ty: sty },
      corner: pick,
      offsetTiles: { x: pick.cx * 0.5, y: pick.cy * 0.5 },
      footprint: tiles,
    };
  }

  if (stage === STAGE.MATURE) {
    // 성목: 9칸 전부. 수관 형태 5가지 = 4모서리 쏠림 + 중앙 균형.
    // 그 그리드의 유목 방향(씨앗 기반)을 따르되, 일부는 중앙 균형(대칭).
    const cands = cornersForSeed(stx, sty);
    let corner = cands[Math.floor(rng() * cands.length)] || { cx: -1, cy: -1 };
    // 씨앗이 정중앙(0,0)이거나 시드 일부는 중앙 균형(대칭) — 5번째 형태.
    if ((stx === 0 && sty === 0) || rng() < 0.25) corner = null;
    const full = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) full.push([dx, dy]);
    return {
      seed: { tx: stx, ty: sty },
      corner, // null = 중앙 균형
      offsetTiles: { x: 0, y: 0 }, // 밑동은 그리드 중앙(9칸 대칭), 방향은 수관 무게로만
      footprint: full,
    };
  }

  // 빈땅 등.
  return { seed: { tx: stx, ty: sty }, corner: null, offsetTiles: { x: 0, y: 0 }, footprint: [] };
}

// 골격 노드: 수액이 타는 트리.
class SkelNode {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.children = [];
  }
}

// 골격 노드 트리를 인플레이스로 균등 축소(그리드 폭 맞춤에 사용).
function scaleSkeleton(node, f) {
  node.x *= f;
  node.y *= f;
  for (const child of node.children) scaleSkeleton(child, f);
}

// 골격을 엣지 리스트로 평탄화 — particles 가 t∈[0,1] 이동에 쓰기 쉽게.
// 각 엣지: { ax,ay,bx,by,len, children:[엣지인덱스...] }, roots:[엣지인덱스...]
function flattenSkeleton(root) {
  const edges = [];
  const roots = [];
  function walk(node, parentEdgeIdx) {
    for (const child of node.children) {
      const idx = edges.length;
      const dx = child.x - node.x;
      const dy = child.y - node.y;
      edges.push({
        ax: node.x,
        ay: node.y,
        bx: child.x,
        by: child.y,
        len: Math.hypot(dx, dy) || 0.001,
        children: [],
      });
      if (parentEdgeIdx === null) roots.push(idx);
      else edges[parentEdgeIdx].children.push(idx);
      walk(child, idx);
    }
  }
  walk(root, null);
  return { edges, roots };
}

// 묘목 = 또렷한 새싹: 가는 줄기 + 떡잎 2~3장(잎 모양이 보이게), ~12~16px.
// "씨앗에서 튼 새싹"으로 한눈에 읽히되 유목보다 확실히 작게(묘목≪유목≪성목).
// buildTree 와 같은 반환 형태. 떡잎은 cotyledon(타원 잎)으로 렌더에 모양 정보를 싣는다.
function buildSprout(rng) {
  // 절대값 사이즈(STAGE_SCALE 0.4 곱 안 함 — 점이 안 되게 직접 키움). 줄기 높이 ~9~12px.
  const h = 9 + rng() * 3;
  const stemW = 1.5;
  const lean = (rng() - 0.5) * 1.5;
  // 줄기(아래→위, 살짝 굽게 2단). 중간 마디 위치(잎 부착점).
  const midX = lean * 0.4, midY = h * 0.55;
  const trunkSegs = [
    { x1: 0, y1: 0, x2: midX, y2: midY, w: stemW },
    { x1: midX, y1: midY, x2: lean, y2: h, w: Math.max(1, stemW * 0.85) },
  ];
  // 떡잎이 공중에 안 뜨게: **부착점을 줄기 위(끝·중간)에** 둔다. 타원 잎은 부착점에서
  //   ang 방향으로 뻗으므로 부착점이 줄기에 있으면 잎이 줄기에 붙어 보인다.
  const lr = 3.0 + rng() * 0.9; // 잎 반경(또렷이 보이게)
  const crown = [
    // 줄기 끝(top) 좌측 떡잎 — 부착점=줄기 top, 바깥-위로 뻗음.
    { x: lean, y: h, r: lr, leaf: true, ang: -0.7 - rng() * 0.3 },
    // 줄기 끝(top) 우측 떡잎.
    { x: lean, y: h, r: lr * (0.9 + rng() * 0.2), leaf: true, ang: 0.7 + rng() * 0.3 },
    // 줄기 중간 마디에서 난 작은 새잎(부착점=중간 마디).
    { x: midX, y: midY + lr * 0.1, r: lr * 0.6, leaf: true, ang: (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 0.4) },
  ];
  let crownMinY = Infinity, crownMaxY = -Infinity, maxR = stemW;
  for (const bl of crown) {
    maxR = Math.max(maxR, Math.abs(bl.x) + bl.r);
    crownMinY = Math.min(crownMinY, bl.y - bl.r);
    crownMaxY = Math.max(crownMaxY, bl.y + bl.r);
  }
  return {
    trunkSegs,
    crown,
    skeleton: { edges: [], roots: [] }, // 새싹은 파티클 없음
    height: crownMaxY,
    halfWidth: maxR,
    crownMinY,
    crownMaxY,
    sprout: true,
  };
}

/**
 * 한 그루의 절차적 형상 데이터를 빌드한다(순수 데이터, 캔버스 무관).
 * @param {object} params cellParams 결과(sim·norms·stage·seed·date 등)
 * @param {number} [scale=1] STAGE_SCALE[stage] 전체 스케일
 * @param {number} [maxWidth=Infinity] 그리드 footprint 폭(px) — 크라운이 넓으면 전체 축소(겹침 방지)
 * @param {object|null} [placement=null] gridPlacement() 결과. corner 가 있으면 수관 무게를 그 모서리로 부풀린다.
 * @returns {{trunkSegs:object[], crown:object[], skeleton:{edges:object[],roots:number[]}, height:number, halfWidth:number, crownMinY?:number, crownMaxY?:number}}
 *   trunkSegs=기둥·가지·뿌리 라인, crown=수관 블롭, skeleton=수액 경로,
 *   height/halfWidth=풋프린트, crownMinY/MaxY=수관 y 범위(음영용)
 */
export function buildTree(params, scale = 1, maxWidth = Infinity, placement = null) {
  if (!params || !params.sim || scale <= 0) {
    return {
      trunkSegs: [],
      crown: [],
      skeleton: { edges: [], roots: [] },
      height: 0,
      halfWidth: 0,
    };
  }
  const sim = params.sim;
  const outputN = params.norms ? params.norms.outputN : 0.3;
  const stage = params.stage;
  // 형태 재생성 시드는 tree.seed(서버). 없으면 date 폴백(둘 다 날짜라 동일 결과).
  const seed = params.seed || params.date;
  const rng = makeRng(hash32(seed + "|" + params.stage));

  // 묘목 = 또렷한 새싹(미니 나무 아님). 가는 줄기 + 떡잎 2~3장. ~12~16px.
  if (stage === STAGE.SAPLING) {
    return buildSprout(rng);
  }

  // 수관 무게 방향: corner {cx,cy} → 시뮬좌표 단위벡터(cx=+1 동/오른쪽=+x, cy=+1 남/screen아래=-y).
  // 무게 세기는 crownRX/RY 비례. corner=null 이면 대칭(무게 0).
  const wb = placement && placement.corner
    ? { x: placement.corner.cx, y: -placement.corner.cy }
    : { x: 0, y: 0 };

  // --- 메트릭 매핑 ---
  // input → 높이(Height), output → 수관 크기·풍성함(Foliage), cacheWrite → 두께·구조(Structure)
  // 기둥이 굵고 길어 수관 아래로 또렷이 드러나게 바닥값을 크게 올렸다.
  // 성목 몸통 훨씬 굵게+높게. 수관 크기는 maxWidth 캡이 최종 결정하므로
  //   crownR 은 캡 이상으로만 두고(캡이 ~3타일로 키움), 실제 거대화는 renderer 캡에서.
  const trunkThick = stage === STAGE.MATURE ? 1.8 : stage === STAGE.YOUNG ? 0.95 : 1.0;
  const trunkHMul = stage === STAGE.MATURE ? 1.3 : 1.0; // 성목 기둥 더 높이
  const crownMul = stage === STAGE.MATURE ? 1.18 : 1.0; // 성목 수관 키워 캡(3타일)까지 채움
  const trunkH = Math.max(20 * scale, sim.maxHeight * 0.95 * scale) * trunkHMul;
  const trunkBaseW = Math.max(8 * scale, (8 + sim.baseThickness * 4.5) * scale) * trunkThick;
  const crownR = (sim.maxHeight * 0.44 + sim.leafSize * 4) * scale * crownMul; // 수관 반경
  const foliage = 5 + Math.round(outputN * 7); // 수관 블롭 개수↑ (유기적 덩어리)
  // 유목만 가지 끝이 수관 밖으로 비져나옴(묘목은 새싹, 성목은 많이).
  const nBranch =
    stage === STAGE.MATURE
      ? 3 + (outputN > 0.5 ? 1 : 0) // 성목 3~4
      : stage === STAGE.YOUNG
      ? 2 + (outputN > 0.6 ? 1 : 0) // 유목 2~3
      : 0; // 묘목/그 외: 가지 없음

  const root = new SkelNode(0, 0);
  const trunkSegs = [];
  const crown = [];

  // 뿌리 부채살은 fit-scale 후 마지막에 생성한다(footprint 점유). 여기선 기둥부터.

  // --- 기둥: 아래 넓고 위로 가늘게(테이퍼). 약간 굽게. 골격 노드 함께 생성. ---
  const segCount = 5;
  const trunkNodes = [root];
  let prev = root;
  let px = 0;
  let py = 0;
  const lean = (rng() - 0.5) * trunkH * 0.06; // 전체 살짝만 기울임
  // 기둥 좌우 윤곽이 일직선 막대가 안 되게 마디(knot)별 미세 굴곡 위상.
  const wobblePhase = rng() * Math.PI * 2;
  // 직선·직각 금지: 기둥 윤곽을 좌/우 비대칭 폭(wL/wR)으로 노출해 렌더가 픽셀 단위로
  //   불규칙한 실루엣을 그린다. 위로 갈수록 강하게 테이퍼(아래 넓고 위 가늘게) — top 끝이
  //   가늘어져 앞잎 속으로 자연스럽게 사라지고, 직사각 막대 느낌이 사라진다.
  for (let i = 1; i <= segCount; i++) {
    const t = i / segCount;
    const ny = trunkH * t;
    // 하부는 거의 수직(다리처럼 안 벌어지게), 상부만 t² 로 살짝 흔들림.
    // + 마디별 사인 굴곡(절대폭 작게) — 좌우 윤곽이 미세하게 휘어 막대 느낌 제거.
    const knot = Math.sin(wobblePhase + t * Math.PI * 2.2) * trunkBaseW * 0.08;
    const nx = lean * t + Math.sin(t * Math.PI) * (rng() - 0.5) * trunkBaseW * 0.18 * t + knot * t;
    // 테이퍼 강화: 위로 갈수록 ~78% 까지 가늘게 — top 이 잎 속으로 사라지게.
    //   곡선 테이퍼(t^1.4)로 아래는 굵게 유지, 상부에서 급히 가늘어진다(직각 컷 방지).
    const w = trunkBaseW * (1 - Math.pow(t, 1.4) * 0.78);
    // 좌/우 폭 비대칭(마디별 미세 변주) — 윤곽이 같은 폭으로 양쪽 직선이 안 되게.
    const asym = Math.sin(wobblePhase * 1.7 + t * Math.PI * 3.1) * 0.16;
    const wL = Math.max(1.5, w * (1 + asym));
    const wR = Math.max(1.5, w * (1 - asym));
    trunkSegs.push({ x1: px, y1: py, x2: nx, y2: ny, w: Math.max(2, w), wL, wR });
    const node = new SkelNode(nx, ny);
    prev.children.push(node);
    trunkNodes.push(node);
    prev = node;
    px = nx;
    py = ny;
  }
  const topX = px;
  const topY = py;

  // --- 수관 반경 먼저 산정(가지가 이 가장자리까지 닿게). ---
  // 폭이 높이만큼(약간 더) 넓은 원형 클러스터. crownRX(가로) ≈ 1.2 × crownRY(세로).
  const crownRY = crownR;
  const crownRX = crownR * 1.2;
  const cx = topX;
  // 수관 중심을 기둥 top 위로 — 둥근 수관이 기둥 위에 얹힌 활엽수 실루엣(직전 값 복원).
  const cy = topY + crownRY * 0.55;

  // --- 가지: 유목·성목만. 위-바깥으로 다양한 각도, 수관 속으로 들어가 끝만 비져나옴. ---
  // 도장 반복을 깨려고 각 가지의 side·부착높이·각도·길이를 전부 rng(날짜 시드)로 변주한다.
  //  - side: rng 로(엄격 교대 아님, 가끔 같은 쪽 연속).
  //  - 부착 높이: 기둥 0.45~0.95 에 넓게 흩뿌림(한 밴드 금지).
  //  - 각도: 수직 기준 30~70°(위-바깥). 끝점은 그 각도 방향으로 수관 가장자리 근처(끝만 살짝 밖).
  const branchTips = [];
  let lastSide = rng() < 0.5 ? -1 : 1;
  for (let i = 0; i < nBranch; i++) {
    // 부착 높이: 넓게 분산. 가지마다 독립 rng → 한 밴드에 안 몰림.
    const along = 0.45 + rng() * 0.5; // 기둥 45~95%
    const segIdx = Math.min(segCount, Math.max(1, Math.round(along * segCount)));
    const baseNode = trunkNodes[segIdx];

    // side: rng 로. 직전과 같은 쪽도 ~35% 허용(엄격 교대 깸).
    const side = rng() < 0.35 ? lastSide : -lastSide;
    lastSide = side;

    // 각도: 수직(0)에서 바깥으로 30~70°. 위로 뻗는 성분(cos)이 항상 양수 → 수평 팔 금지.
    const angle = (30 + rng() * 40) * (Math.PI / 180); // rad
    // 길이: 제각각. baseNode 에서 각도 방향으로, 수관 가장자리 살짝 안~밖.
    // 가로 도달은 crownRX 의 0.7~1.1, 세로는 crownRY 비례로 위로.
    const len = crownR * (0.85 + rng() * 0.6);
    const bx = baseNode.x + Math.sin(angle) * len * side;
    let by = baseNode.y + Math.cos(angle) * len; // +y 위 → 위로 뻗음

    // 끝이 수관 한참 위로 솟지 않게(크라운 꼭대기 근처에서 클램프) — 끝만 비져나오는 정도.
    const topCap = cy + crownRY * 1.0;
    if (by > topCap) by = topCap;

    const w = Math.max(2, trunkBaseW * (0.28 + rng() * 0.12)); // 굵기도 살짝 변주
    // kind:"branch" → 렌더가 수관 위에 끝부분을 한 번 더 그려 비져나오게.
    trunkSegs.push({ x1: baseNode.x, y1: baseNode.y, x2: bx, y2: by, w, kind: "branch" });
    const branchNode = new SkelNode(bx, by);
    baseNode.children.push(branchNode);
    branchTips.push({ x: bx, y: by });
  }

  // --- 수관: 기둥 위에 얹힌 넓고 둥근 활엽수 크라운(브로콜리/막대사탕). ---
  // 방향성: 수관 무게를 corner 방향으로 살짝 부풀린다. 방향성은 **가로 쏠림** 위주.
  //   세로(남/북)는 실루엣 보호상 중심을 아래로 내리지 않음(남쪽이어도 발치 덤불 금지).
  //   북쪽(wb.y>0)만 약간 위로, 남쪽(wb.y<0)은 중심 고정 — 무게는 둘레 블롭 부풀림으로만.
  const WBX = 0.3; // 가로 치우침 강도
  const wcx = cx + wb.x * crownRX * WBX;
  const wcy = cy + Math.max(0, wb.y) * crownRY * 0.12; // 위로만 살짝

  // 1) 메인 덩어리(무게중심에 큰 원).
  crown.push({ x: wcx, y: wcy, r: crownR });

  // 2) 둘레 블롭: 원형 외곽선(타이트한 공 — 캡이 최종 폭을 결정하므로 아웃라이어 금지).
  //   무게 방향(가로 + 위쪽만) 쪽만 살짝 부풀림. 세로 아래(남)는 안 부풀림(실루엣 보호).
  const bwy = Math.max(0, wb.y);
  for (let i = 0; i < foliage; i++) {
    const a = (i / foliage) * Math.PI * 2 + rng() * 0.4;
    const dot = wb.x * Math.cos(a) + bwy * Math.sin(a);
    const bulge = 1 + Math.max(0, dot) * 0.22; // 무게쪽 +22%(과한 아웃라이어 방지)
    const er = (0.55 + rng() * 0.18) * bulge; // 외곽 도달 타이트하게
    crown.push({
      x: wcx + Math.cos(a) * crownRX * er,
      y: wcy + Math.sin(a) * crownRY * er,
      r: crownR * (0.4 + rng() * 0.22) * bulge,
    });
  }

  // 3) 내부 채움 블롭(무게중심 근처) — 실루엣 안을 메워 한 덩어리로.
  const innerN = 3 + Math.round(outputN * 3);
  for (let i = 0; i < innerN; i++) {
    const a = rng() * Math.PI * 2;
    const ir = rng() * 0.45;
    crown.push({ x: wcx + Math.cos(a) * crownRX * ir, y: wcy + Math.sin(a) * crownRY * ir, r: crownR * (0.45 + rng() * 0.3) });
  }

  // 4) 가지끝 작은 잎 덩어리 — 가지 끝 살짝 위에. 가지 나무(wood)는 그 아래로 비져나옴.
  for (const tip of branchTips) {
    crown.push({ x: tip.x, y: tip.y + crownRY * 0.28, r: crownR * (0.32 + rng() * 0.16) });
  }

  // 4.5) 그리드 폭 맞춤: 크라운이 maxWidth 넘으면 나무 전체를 균등 축소(겹침 방지).
  // (뿌리는 아직 생성 전이라 영향 안 받음 — 뿌리는 footprint 까지 펼쳐야 하므로.)
  if (Number.isFinite(maxWidth)) {
    let cw = 0;
    for (const bl of crown) cw = Math.max(cw, Math.abs(bl.x) + bl.r);
    const fullW = cw * 2;
    if (fullW > maxWidth && fullW > 0) {
      const f = maxWidth / fullW;
      for (const seg of trunkSegs) {
        seg.x1 *= f; seg.y1 *= f; seg.x2 *= f; seg.y2 *= f; seg.w *= f;
        if (seg.wL !== undefined) seg.wL *= f; // 비대칭 폭도 함께 축소
        if (seg.wR !== undefined) seg.wR *= f;
      }
      for (const bl of crown) {
        bl.x *= f; bl.y *= f; bl.r *= f;
      }
      scaleSkeleton(root, f);
    }
  }

  // 4.6) 뿌리 융기(root knee): 밑동에서 바깥-아래로 부드럽게 휘는 자연스러운 뿌리.
  //   딱딱한 가로 막대 금지 — 2 단 곡선(밑동→중간→끝)으로 융기처럼. 안쪽 굵고 끝 가늘게.
  //   유목·성목만(묘목 = 새싹이라 없음).
  if (stage === STAGE.YOUNG || stage === STAGE.MATURE) {
    const baseW = trunkSegs.length ? trunkSegs[0].w : trunkBaseW; // 최종 밑동 폭
    const kneeReach = baseW * (stage === STAGE.MATURE ? 0.75 : 0.5);
    // 뿌리 세로 위치를 밑동 폭(baseW)이 아니라 발치 절대 높이에 묶는다.
    //   폭 비례로 두면 굵은 성목일수록 뿌리가 몸통 중간으로 떠올랐다(단위 혼동).
    //   가로 뻗음(kneeReach)만 폭 비례 유지, 세로는 땅 가까이 고정.
    const rootStartY = Math.min(baseW * 0.18, 6); // 발치 살짝 위(상한 6px)
    for (const side of [-1, 1]) {
      const r = 0.85 + rng() * 0.3;
      const midX = side * kneeReach * 0.5 * r;
      const midY = rootStartY * 0.6; // 중간은 시작보다 아래(바깥-아래로 휨)
      const tipX = side * kneeReach * r;
      const tipY = -1 - rng() * 2; // 끝은 땅에 박힘(살짝 음수 = baseY 아래)
      // 안쪽 굵은 단 + 바깥 가는 단(곡선 융기).
      trunkSegs.push({ x1: 0, y1: rootStartY, x2: midX, y2: midY, w: Math.max(2, baseW * 0.6), kind: "root" });
      trunkSegs.push({ x1: midX, y1: midY, x2: tipX, y2: tipY, w: Math.max(1.5, baseW * 0.38), kind: "root" });
    }
  }

  // 풋프린트 + 수관 y 범위(렌더 음영용).
  let maxR = trunkBaseW;
  let topMost = trunkH;
  let crownMinY = Infinity;
  let crownMaxY = -Infinity;
  for (const bl of crown) {
    if (Math.abs(bl.x) + bl.r > maxR) maxR = Math.abs(bl.x) + bl.r;
    if (bl.y + bl.r > topMost) topMost = bl.y + bl.r;
    if (bl.y - bl.r < crownMinY) crownMinY = bl.y - bl.r;
    if (bl.y + bl.r > crownMaxY) crownMaxY = bl.y + bl.r;
  }

  return {
    trunkSegs,
    crown,
    skeleton: flattenSkeleton(root),
    height: topMost,
    halfWidth: maxR,
    crownMinY,
    crownMaxY,
  };
}

// ===========================================================================
// 숲 = **멤버 셀(그리드) 좌표 기반** 나무 군집.
// ===========================================================================
// 각 묶인 셀의 실제 그리드 영역(GRID px) 안에 1~N 그루를 심는다. 군집 모양 = 실제 그리드
// 묶음 모양(가로줄=가로숲, L자=L자숲)이 되어 드릴다운(펼침) 전후 위치가 자동 일치한다.
// 좌표는 **월드 px 절대값**(originX/originY + gx*GRID 기준) — 화면좌표 시드 금지(팬 요동 방지).
// 각 instance 의 tree 빌드는 렌더가 buildTree 로 만들어 ym 단위로 캐시한다(프레임마다 재생성 금지).
/**
 * 묶인 달의 셀 좌표로부터 나무 군집 인스턴스를 결정적으로 배치한다.
 * @param {object} spec
 * @param {string} spec.ym 달 키(시드 소스)
 * @param {Array<{gx:number,gy:number,xp?:number,stage:string}>} spec.cells 묶인 셀 목록
 * @param {number} [spec.density=0.5] 밀도(0.2~1) — 그루 수·성목 비율에 영향
 * @param {number} [spec.originX=0] 월드 px 원점 X
 * @param {number} [spec.originY=0] 월드 px 원점 Y
 * @returns {{instances:Array<{wx:number,wy:number,scale:number,stage:string,seed:string}>, bbox:{x0:number,x1:number,y0:number,y1:number}, up:number, down:number, closedCells:Array<{gx:number,gy:number,stage:string}>}}
 *   instances=월드 px 절대좌표 밑동, bbox=군집 px 범위, up/down=나무 키/바닥 여유,
 *   closedCells=원 멤버+브리지(닫힌 발자국, 렌더 바닥용)
 */
export function buildForest(spec) {
  const ym = spec.ym || "0000-00";
  const cells = spec.cells || [];
  const density = Math.max(0.2, Math.min(1, spec.density ?? 0.5));
  const originX = spec.originX || 0;
  const originY = spec.originY || 0;

  // 셀당 그루 수 **1~2 기본**(density 최상위에서만 3). 빽빽하면 수관 사이 바닥이 안 보여
  //   1+density 로 낮춰 대부분 1~2, density>~0.9 에서만 3.
  const perCell = Math.max(1, Math.min(3, Math.round(1 + density))); // 1~2 (최상위 density 에서만 3)
  // 셀 안 심는 반경(반 타일 정도 셀 경계 넘는 지터 허용 — 유기적 외곽). GRID/2 = 셀 반폭.
  const half = GRID / 2;
  const spread = half * 0.9; // 셀 중심에서 이만큼 흩뿌림(가장자리 살짝 넘음)
  // 최소 간격(포아송 비슷한 시드 리젝션): 나무 폭(~크라운 지름) 기반으로 두 그루 밑동이
  //   너무 가까우면 기각해 수관 사이로 바닥이 보이게.
  const minGap = half * 0.75; // 수관 사이 바닥이 확실히 보이게 밑동 간격 확대
  const minGap2 = minGap * minGap;

  // 숲 경계 유기화: 경계 셀(이웃 셀이 비어 군집 외곽에 닿는 셀)의 나무는 **모든**
  //   빈 이웃 방향(모서리 셀은 대각 포함)으로 독립 오버행시키고, 오버행량·확률을 셀 좌표 시드로
  //   탈상관시켜 같은 변의 이웃 셀끼리 정렬되지 않게 한다(어떤 변도 3셀 이상 직선 금지). 8방향 이웃을
  //   본다(대각 포함 → 모서리 셀이 대각 바깥으로도 삐져나옴).
  // 형태적 닫기: 모서리(대각)만 맞닿은 두 멤버 셀 사이의 틈을 메워 한 덩어리로 잇는다.
  //   A=(x,y), B=(x+1,y+1) 가 둘 다 멤버이고 직교 연결칸((x+1,y)·(x,y+1))이 둘 다 비면 코너 접촉 →
  //   연결칸 하나를 **브리지 셀**로 추가해 발자국·수관을 잇는다(사각 조각·직선 띠 방지). 브리지 셀은
  //   원 멤버 좌표를 안 바꾸므로(입력 불변) 펼침 전후 위치 일치 유지. 브리지엔 작은 나무 1그루만.
  const memberSet = new Set(cells.map((c) => c.gx + "," + c.gy));
  const bridgeMap = new Map(); // "gx,gy" → {gx,gy,stage,bridge:true}
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  // 코너 갭(대각쌍)을 **정렬된 쌍 키**로 묶어 **갭당 한 번만** 처리한다. 양쪽 셀이 각자
  //   처리하면 직교 연결칸을 둘 다 추가해 2×2 가 꽉 차므로(사각 조각 재발), 같은 갭의 두
  //   직교 후보 중 시드로 **하나만** 택해 추가한다.
  const seenGaps = new Set();
  for (const c of cells) {
    for (const [dx, dy] of DIAG) {
      const bx = c.gx + dx, by = c.gy + dy;
      if (!memberSet.has(bx + "," + by)) continue; // 대각 이웃이 멤버여야 코너 접촉
      // 갭 키 = 두 대각 셀 좌표를 정렬한 단일 키(양쪽 셀이 같은 키 → 갭당 1회). 좌표 비교로 정렬.
      const aKey = c.gx + "," + c.gy, bKey = bx + "," + by;
      const gapKey = aKey < bKey ? aKey + "|" + bKey : bKey + "|" + aKey;
      if (seenGaps.has(gapKey)) continue; // 이미 이 갭 처리됨(반대편 셀에서)
      seenGaps.add(gapKey);
      // 직교 연결칸 둘: (c.gx+dx, c.gy)·(c.gx, c.gy+dy). 둘 다 비어 있으면 코너 갭 → 하나만 채움.
      const o1 = (c.gx + dx) + "," + c.gy;
      const o2 = c.gx + "," + (c.gy + dy);
      if (memberSet.has(o1) || memberSet.has(o2)) continue; // 이미 연결됨(틈 없음)
      // 둘 중 하나만 브리지로(결정적: 갭 키 시드 — 양쪽 셀이 같은 키라 처리 순서 무관 동일 선택).
      const pick = (hash32(gapKey + "|bridge") & 1) ? o1 : o2;
      if (memberSet.has(pick) || bridgeMap.has(pick)) continue;
      const [pgx, pgy] = pick.split(",").map(Number);
      bridgeMap.set(pick, { gx: pgx, gy: pgy, stage: c.stage, bridge: true });
    }
  }
  const allCells = bridgeMap.size ? cells.concat([...bridgeMap.values()]) : cells;

  const cellSet = new Set(allCells.map((c) => c.gx + "," + c.gy));
  const NEI8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  function openNeighbors(cell) {
    // 빈 이웃 방향 목록(군집 바깥, 8방향). 한 줄(상·하 모두 열림)이어도 합산 상쇄되지 않게 **개별** 보존.
    const dirs = [];
    for (const [ddx, ddy] of NEI8) {
      if (!cellSet.has((cell.gx + ddx) + "," + (cell.gy + ddy))) dirs.push([ddx, ddy]);
    }
    return dirs;
  }

  const instances = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  let maxScale = 0;
  const overhang = half * 1.2; // 경계 셀 바깥 오버행 최대(~1.2타일 — 셀 경계를 확실히 넘음)
  for (const cell of allCells) {
    // 셀 월드 중심.
    const cwx = originX + cell.gx * GRID;
    const cwy = originY + cell.gy * GRID;
    // 셀+좌표 시드(결정적, 화면 무관). 같은 셀=같은 배치.
    const rng = makeRng(hash32(ym + "|" + cell.gx + "," + cell.gy + "|cellforest"));
    const cellMature = cell.stage === STAGE.MATURE;
    const openDirs = openNeighbors(cell);
    const isBoundary = openDirs.length > 0;
    // 탈상관: 같은 변 이웃 셀끼리 오버행 패턴이 비슷해 직선 정렬되는 걸 막으려 셀 좌표 기반
    //   per-cell 오버행 위상/강도를 뽑는다(이웃과 무관하게 흔들림).
    const cellPhase = (hash32(cell.gx + "x" + cell.gy + "|oh") % 1000) / 1000; // 0~1
    const cellStrength = 0.55 + ((hash32(cell.gy + "y" + cell.gx + "|os") % 1000) / 1000) * 0.45; // 0.55~1.0
    // 경계 셀: 그루 수를 시드로 ±1 변주(들쭉날쭉한 외곽). 내부 셀은 perCell 고정.
    //   셀당 상한도 **1~2 기본**으로 묶고, density 최상위(>~0.9)에서만 3을 허용한다(빽빽함 방지).
    //   변주 결과를 maxPer(=density≥0.9?3:2)로 clamp.
    const maxPer = density >= 0.9 ? 3 : 2;
    let cellTrees = perCell;
    if (isBoundary) cellTrees = Math.max(1, Math.min(maxPer, perCell + (((rng() * 3) | 0) - 1)));
    if (cell.bridge) cellTrees = 1; // 브리지 셀은 작은 나무 1그루만(코너 갭 잇기 — 과밀 방지)
    const placed = []; // 이 셀에 심은 밑동(월드 px) — 최소 간격 리젝션용
    for (let i = 0; i < cellTrees; i++) {
      // 최소 간격 리젝션: 후보를 몇 번 뽑아 기존 그루와 minGap 이상 떨어진 위치를 채택.
      //   끝내 못 찾으면(빽빽) 마지막 후보 사용(빈 셀 방지 — 최소 1그루는 항상 심김).
      let wx = 0, wy = 0, dx = 0, dy = 0, rr = 0;
      const TRIES = 12; // minGap 상향에 맞춘 시도 횟수(충족률 개선, 못 찾으면 마지막 후보)
      for (let attempt = 0; attempt < TRIES; attempt++) {
        const a = rng() * Math.PI * 2;
        rr = Math.pow(rng(), 0.7); // 중심 편향
        dx = Math.cos(a) * spread * rr;
        dy = Math.sin(a) * spread * 0.62 * rr; // 세로 살짝 납작(평면 바닥)
        // 오버행: 경계 셀의 일부 그루(시드로)를 빈 이웃 방향으로 밀어 셀 밖으로 삐져나오게.
        //   ★ 모든 빈 이웃 방향에 **독립** 적용(개별 dx,dy 누적 — 모서리 셀은 대각까지). 상·하 동시
        //   열림이어도 방향별로 쌓여 상쇄되지 않고, 셀 위상(cellPhase)으로 탈상관 → 같은 변 정렬 깸.
        if (isBoundary) {
          for (const pick of openDirs) {
            // 그루·방향별 푸시 확률·강도(셀 위상으로 흔들어 이웃 셀과 비상관).
            const g = rng();
            const push = g * cellStrength * (0.6 + (((cellPhase + i * 0.37 + (pick[0] + pick[1] * 2) * 0.13) % 1)) * 0.7);
            if (push > 0.45) {
              const mag = overhang * (0.4 + rng() * 0.6) * Math.min(1, push);
              // 대각 방향은 정규화(√2 보정) — 대각이 과도하게 멀리 안 나가게.
              const norm = pick[0] !== 0 && pick[1] !== 0 ? 0.7071 : 1;
              dx += pick[0] * mag * norm;
              dy += pick[1] * mag * norm * 0.9;
            }
          }
        }
        wx = Math.round(cwx + dx);
        wy = Math.round(cwy + dy);
        // 최소 간격 충족 검사.
        let ok = true;
        for (const p of placed) {
          const ddx = wx - p[0], ddy = wy - p[1];
          if (ddx * ddx + ddy * ddy < minGap2) { ok = false; break; }
        }
        if (ok) break; // 충분히 떨어짐 → 채택
      }
      placed.push([wx, wy]);
      // bbox 는 실제 그루 위치로 확장(오버행 포함 — extent 정합, 줌아웃에서 안 잘림).
      x0 = Math.min(x0, wx - half * 0.5); x1 = Math.max(x1, wx + half * 0.5);
      y0 = Math.min(y0, wy - half * 0.5); y1 = Math.max(y1, wy + half * 0.5);
      // 스케일: 작은 나무(군집). 셀 중심 큰 나무, 가장자리 작은 나무(원근감).
      const baseScale = 0.34 + (1 - rr) * 0.22; // 0.34~0.56
      // 경계 셀은 크기 변주 폭을 키워(작은~큰 섞임) 실루엣을 더 들쭉날쭉하게.
      const scaleVar = isBoundary ? (0.7 + rng() * 0.55) : (0.85 + rng() * 0.3);
      const scale = baseScale * scaleVar;
      maxScale = Math.max(maxScale, scale);
      // 단계: 셀 단계·밀도·중심도로 가중. 성목 셀이면 성목 비율↑.
      //   그루 수를 줄인 만큼 "사용량 많은 달=빽빽"을 큰 단계(MATURE) 비중으로 일부 이전 —
      //   density 가 높을수록 성목 비율↑(같은 그루 수라도 큰 나무가 많아 풍성).
      const sv = rng();
      const matureP = (cellMature ? 0.4 : 0.2) + density * 0.45 + (1 - rr) * 0.18;
      const youngP = 0.45;
      const stage =
        sv < matureP ? STAGE.MATURE : sv < matureP + youngP ? STAGE.YOUNG : STAGE.SAPLING;
      instances.push({
        wx,
        wy,
        scale,
        stage,
        seed: ym + "|" + cell.gx + "," + cell.gy + "|t" + i, // 결정적·화면무관 형태 시드
      });
    }
  }
  if (!Number.isFinite(x0)) {
    x0 = originX - half; x1 = originX + half; y0 = originY - half; y1 = originY + half;
  }
  // up/down: 나무 키(군집 위로 솟음)·바닥 여유. 스케일 최대 그루 기준 보수적.
  //   buildTree 의 trunkH(~30~60)·crownR 합산 근사 + 여유. extent 정합용.
  const up = Math.round(120 * maxScale + half); // 나무 키만큼 위로 솟음
  const down = Math.round(half * 0.6 + 8); // 바닥 발치 여유
  // closedCells = 원 멤버 + 브리지 셀(형태적으로 닫힌 발자국). 렌더 바닥이 이걸 채워 코너 갭을 메운다.
  const closedCells = allCells.map((c) => ({ gx: c.gx, gy: c.gy, stage: c.stage }));
  return { instances, bbox: { x0, x1, y0, y1 }, up, down, closedCells };
}
