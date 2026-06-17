/**
 * renderer 에서 분리한 바닥 장식 — 풀·식생·나비·물·절차 바위.
 * 순수 + frame 인자만(상태 없음).
 */

import { TILE, GRID } from "../grid.js";
import { PAL, PAL_PAST } from "./palette.js";

// 잔디 결 텍스처: **베이스 채움 없이**(땅 전체가 이미 grassA 단색) 옅은 풀잎 가닥만 덧그린다.
//   화면 전체 타일에 균일 적용 → detail 영역 사각 경계 없음. 밀도는 낮게(저비용).
export function drawGrassBlades(b, cx, cy, gx, gy) {
  const x = (cx - TILE / 2) | 0;
  const y = (cy - TILE / 2) | 0;
  // 타일별 고정 PRNG(프레임마다 안 흔들리게).
  let seed = ((gx * 374761393) ^ (gy * 668265263)) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // 결 밀도 낮춤(9~15 → 5~8): 전체 균일하게 옅게. 톤 분리 없음.
  const blades = 5 + ((rnd() * 4) | 0);
  for (let i = 0; i < blades; i++) {
    const bx = (x + 1 + rnd() * (TILE - 2)) | 0;
    const by = (y + 2 + rnd() * (TILE - 4)) | 0;
    const r = rnd();
    if (r < 0.16) {
      b.fillStyle = PAL.grassSpeck; // 밝은 점(반짝)
      b.fillRect(bx, by, 1, 1);
    } else {
      b.fillStyle = r < 0.6 ? PAL.grassBlade2 : PAL.grassBlade1; // 풀잎 1~2px
      const h = rnd() < 0.5 ? 1 : 2;
      b.fillRect(bx, by, 1, h);
    }
  }
}

/**
 * 빈 대지(STAGE.EMPTY) 칸 중앙의 작은 흙 패치 — "여기는 빈 자리" 식별.
 *   풀이 둘러싸고 중앙만 맨흙이 약간 비침. 작게(~GRID/6) 점묘·결정적 칸 시드(팬 불변)·정수 도트.
 *   솔리드 디스크(구멍처럼 보임) 금지 — 거리 기반 확률 점묘로 풀이 점 사이로 비치게.
 *   §37-G 의 "칸 단위 큰 랜덤 패치(0.3~0.65×GRID)"와 다른, 식별용 고정 작은 패치.
 * @param {CanvasRenderingContext2D} b 베이크/백버퍼 컨텍스트
 * @param {number} cx 칸 중심 화면 x (gridToScreen 중심)
 * @param {number} cy 칸 중심 화면 y
 * @param {number} gx 칸 그리드 x(월드 시드 — 팬 불변)
 * @param {number} gy 칸 그리드 y
 */
export function drawEmptyDirtPatch(b, cx, cy, gx, gy) {
  const ccx = cx | 0, ccy = cy | 0;
  let seed = ((gx * 374761393) ^ (gy * 668265263) ^ 0x5bd1e995) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // 작은 반경(~GRID/6). 솔리드 디스크(구멍처럼 보임)가 아니라 거리 기반 확률 점묘 —
  //   풀이 점 사이로 비쳐 "맨흙이 약간 드러난" 정도. 중심은 촘촘하고 가장자리로 성기게 흩어진다.
  const R = Math.max(3, ((GRID / 6) + (rnd() * 2 - 1)) | 0);
  // 칸마다 다른 형태(원형 단조 탈피): 타원율·회전 + 각도별 반경 변조(사인 합성)로 길쭉/둥글/비대칭/울퉁.
  const elong = 0.6 + rnd() * 0.7;       // 장축:단축 비(0.6~1.3) — <1 길쭉, >1 옆으로 퍼짐
  const eang = rnd() * Math.PI;          // 타원 회전
  const ca = Math.cos(eang), sa = Math.sin(eang);
  const f1 = 2 + ((rnd() * 3) | 0), f2 = 4 + ((rnd() * 3) | 0); // 변조 주파수(저/고)
  const p1 = rnd() * Math.PI * 2, p2 = rnd() * Math.PI * 2;     // 위상
  const a1 = 0.16 + rnd() * 0.2, a2 = 0.08 + rnd() * 0.12;      // 변조 진폭(울퉁불퉁)
  const Rmax = Math.ceil(R * 1.4);       // 변조로 늘어날 수 있는 최대 반경(루프 범위)
  for (let dy = -Rmax; dy <= Rmax; dy++) {
    for (let dx = -Rmax; dx <= Rmax; dx++) {
      // 타원 좌표(회전 후 단축 스케일) + 각도별 변조 반경.
      const ex = dx * ca + dy * sa;
      const ey = (-dx * sa + dy * ca) / elong;
      const d = Math.sqrt(ex * ex + ey * ey);
      const ang = Math.atan2(ey, ex);
      const Reff = R * (1 + a1 * Math.sin(f1 * ang + p1) + a2 * Math.sin(f2 * ang + p2));
      if (d > Reff) continue;
      // 중심 코어(t<0.55)는 거의 꽉 찬 맨흙, 바깥은 점묘로 풀에 페이드 — "작은 맨흙 자국".
      const t = d / Reff; // 0 중심 ~ 1 가장자리
      const fill = t < 0.55 ? 0.95 : (1 - t) * 1.4;
      if (rnd() > fill) continue;
      // 흙 3색 위주, 붉은 speck 은 가끔만(떠 보이지 않게).
      const r = rnd();
      b.fillStyle = r < 0.45 ? PAL.pendDirtA : r < 0.78 ? PAL.pendDirtB
        : r < 0.94 ? PAL.pendDirtC : PAL.pendDirtSpeck1;
      b.fillRect(ccx + dx, ccy + dy, 1, 1);
    }
  }
}

// 비활성(대기) 그리드 바닥 결: 밝은 흙 베이스(이미 칠해짐) 위에 흙 얼룩 + 듬성듬성 잡초.
//   미개척/대기 느낌. 잡초는 과하지 않게(타일당 0~2가닥). 타일별 고정 PRNG.
export function drawPendingGround(b, cx, cy, gx, gy) {
  const x = (cx - TILE / 2) | 0;
  const y = (cy - TILE / 2) | 0;
  let seed = ((gx * 374761393) ^ (gy * 668265263) ^ 0x9e3779b9) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // 흙 얼룩 몇 점(진한 흙 베이스에 질감).
  const blotches = 4 + ((rnd() * 4) | 0);
  for (let i = 0; i < blotches; i++) {
    const bx = (x + 2 + rnd() * (TILE - 4)) | 0;
    const by = (y + 2 + rnd() * (TILE - 4)) | 0;
    b.fillStyle = rnd() < 0.5 ? PAL.pendDirtSpeck1 : PAL.pendDirtSpeck2;
    const s = rnd() < 0.3 ? 2 : 1;
    b.fillRect(bx, by, s, 1);
  }
  // 잡초(3~5무더기): 가는 세로 + 옆가닥. 듬성듬성보다 빽빽하되 "잡초 난 흙바닥" 정도(풀밭 아님).
  const weeds = 3 + ((rnd() * 3) | 0);
  for (let i = 0; i < weeds; i++) {
    const wx = (x + 2 + rnd() * (TILE - 4)) | 0;
    const wy = (y + 3 + rnd() * (TILE - 6)) | 0;
    const h = 2 + ((rnd() * 3) | 0);
    b.fillStyle = rnd() < 0.5 ? PAL.pendWeed1 : PAL.pendWeed2;
    b.fillRect(wx, wy, 1, h);
    // 옆가닥 1~2개(무더기 느낌).
    if (rnd() < 0.6) b.fillRect(wx + 1, wy + 1, 1, h - 1);
    if (rnd() < 0.4) b.fillRect(wx - 1, wy + 2, 1, Math.max(1, h - 2));
  }
  // 잡동사니 — 비활성 흙에도 돌 몇 개(차단 칸 바위와 결 통일). 0~2개, 작은 회색 돌.
  const stones = (rnd() * 3) | 0;
  for (let i = 0; i < stones; i++) {
    const stx = (x + 3 + rnd() * (TILE - 6)) | 0;
    const sty = (y + 4 + rnd() * (TILE - 8)) | 0;
    const sw = 2 + ((rnd() * 2) | 0);
    b.fillStyle = rnd() < 0.5 ? PAL.rockA : PAL.rockB;
    b.fillRect(stx, sty, sw, 1 + ((rnd() * 2) | 0));
    b.fillStyle = PAL.rockLight; // 윗면 1px 하이라이트
    b.fillRect(stx, sty - 1, sw, 1);
  }
}

// 닫힘 칸(다른 달에 둘러싸인 빈칸) 바닥: 둘러싼 달 영역임이 옅게 읽히게 PAST 숲 풀톤(베이스는 이미
//   칠해짐) 위에 옅은 이끼/풀잎 결. 타일별 고정 PRNG(프레임 깜빡임 0).
export function drawClosedGround(b, cx, cy, gx, gy) {
  const x = (cx - TILE / 2) | 0;
  const y = (cy - TILE / 2) | 0;
  let seed = ((gx * 374761393) ^ (gy * 668265263) ^ 0x1e3a5c7b) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // 옅은 풀잎 결 + 이끼 점(PAST 톤). 활성 풀밭보다 성기게(빈 땅 느낌이되 그 달 영역).
  const blades = 3 + ((rnd() * 4) | 0);
  for (let i = 0; i < blades; i++) {
    const bx = (x + 2 + rnd() * (TILE - 4)) | 0;
    const by = (y + 2 + rnd() * (TILE - 4)) | 0;
    const r = rnd();
    if (r < 0.3) {
      b.fillStyle = PAL.rockMoss; // 이끼 점(닫힘=정체된 그 달 땅 느낌)
      b.fillRect(bx, by, rnd() < 0.3 ? 2 : 1, 1);
    } else {
      b.fillStyle = r < 0.65 ? PAL_PAST.grassBlade2 : PAL_PAST.grassBlade1;
      b.fillRect(bx, by, 1, rnd() < 0.5 ? 1 : 2);
    }
  }
}

// 접지 그림자(놓인 오브젝트 발치): 밑동 아래 반투명 어두운 타원(옅게). blit 직전 바닥에.
//   톤은 기존 바닥 녹그늘(rgba(20,40,24,..))·바위 밑동 폭 비례.
//   2~3행 스캔라인으로 납작 타원 근사(저비용·픽셀퍼펙트). 결정적(좌표만 의존, 시드 무관).
export function drawGroundShadow(b, cx, baseY, footW) {
  const rw = Math.max(3, (footW * 0.55) | 0); // 그림자 반폭(밑동 폭 비례)
  b.fillStyle = "rgba(20,40,24,0.20)";
  for (let dy = -1; dy <= 1; dy++) {
    const w = (rw * (1 - Math.abs(dy) * 0.32)) | 0;
    if (w <= 0) continue;
    b.fillRect((cx - w) | 0, (baseY + dy) | 0, w * 2, 1);
  }
}

// 절차 바위(시트 폴백 전용 — 로드 전/실패). 둥근 돔 + 입체 음영.
//   sx=밑동 중앙 x, baseY=접지선. rw=반너비. rh=반높이(묘목 높이 캡: 전체 높이 rh*2 ≤ 묘목).
//   variant 0/1(우측 그늘 등 형태). rnd=호출자 PRNG(결정적). 접지 그림자는 호출자가 drawGroundShadow 로.
export function paintProceduralRock(b, sx, baseY, rw, rh, variant, rnd) {
  rh = Math.max(2, rh | 0);
  const cx = sx | 0;
  baseY = baseY | 0;
  const topY = baseY - rh * 2;
  const midY = baseY - rh;
  // ② 돔 몸통(반원 프로파일·음영 램프).
  for (let yy = baseY; yy >= topY; yy--) {
    const t = (baseY - yy) / Math.max(1, baseY - topY);
    const prof = Math.sin((1 - t) * Math.PI * 0.5 + 0.12);
    const hw = (rw * prof) | 0;
    if (hw <= 0) continue;
    let col;
    if (t > 0.65) col = PAL.rockLight;
    else if (t < 0.22) col = PAL.rockDark;
    else col = ((baseY - yy) & 1) ? PAL.rockA : PAL.rockB; // 월드 불변 행 변주
    b.fillStyle = col;
    b.fillRect(cx - hw, yy, hw * 2 + 1, 1);
  }
  // ③ 우측 그늘.
  b.fillStyle = "rgba(40,42,46,0.28)";
  for (let yy = midY; yy < baseY; yy++) {
    const t = (baseY - yy) / Math.max(1, baseY - topY);
    const prof = Math.sin((1 - t) * Math.PI * 0.5 + 0.12);
    const hw = (rw * prof) | 0;
    if (hw <= 1) continue;
    b.fillRect(cx + hw - 1, yy, 2, 1);
  }
  // ④ 윗면 하이라이트 + ⑤ 이끼 점.
  const hl = 1 + (rnd() < 0.5 ? 0 : 1);
  for (let i = 0; i < hl; i++) {
    b.fillStyle = PAL.rockLight;
    b.fillRect((cx - rw * 0.3 + rnd() * rw * 0.5) | 0, (topY + 1 + rnd() * Math.max(1, rh * 0.5)) | 0, 1, 1);
  }
  if (rnd() < 0.5) {
    b.fillStyle = PAL.rockMoss;
    b.fillRect((cx - rw * 0.4 + rnd() * rw * 0.8) | 0, (midY + rnd() * rh) | 0, 1 + ((rnd() * 2) | 0), 1);
  }
}

// 물 웅덩이(순수 장식): 작은 타원 물웅덩이 + 이끼/진흙 가장자리 + 수면 반짝. 평면(접지점=중심).
//   타일 좌표(tx,ty) 시드 결정적(팬 깜빡임 0). ⚠️ 배치/차단 로직과 무관 — 렌더만.
export function drawWaterPool(b, sx, sy, tx, ty) {
  let seed = (((tx * 668265263) ^ (ty * 2246822519) ^ 0x3c79f1a5) >>> 0) | 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const cx = sx | 0, cy = sy | 0;
  const rw = Math.max(4, ((0.55 + rnd() * 0.2) * TILE * 0.5) | 0); // 가로 반경(타일보다 작게)
  const rh = Math.max(2, (rw * 0.6) | 0); // 세로 반경(납작 타원 — 탑다운 물)
  // ① 가장자리 이끼/진흙(웅덩이 둘레 1px 링).
  b.fillStyle = PAL.waterEdge;
  for (let dy = -rh - 1; dy <= rh + 1; dy++) {
    const t = dy / (rh + 1);
    const w = (rw + 1) * Math.sqrt(Math.max(0, 1 - t * t));
    if (w < 0.5) continue;
    b.fillRect((cx - w) | 0, cy + dy, (w * 2) | 0 || 1, 1);
  }
  // ② 물(타원 채움) — 깊은 톤 베이스 + 중앙 살짝 밝은 톤.
  for (let dy = -rh; dy <= rh; dy++) {
    const t = dy / rh;
    const w = rw * Math.sqrt(Math.max(0, 1 - t * t));
    if (w < 0.5) continue;
    b.fillStyle = Math.abs(t) < 0.5 ? PAL.waterMid : PAL.waterDeep;
    b.fillRect((cx - w) | 0, cy + dy, (w * 2) | 0 || 1, 1);
  }
  // ③ 수면 반짝 1~2(하늘 반사) — 좌상단 편향.
  const shine = 1 + (rnd() < 0.5 ? 0 : 1);
  for (let i = 0; i < shine; i++) {
    b.fillStyle = PAL.waterShine;
    b.fillRect((cx - rw * 0.4 + rnd() * rw * 0.5) | 0, (cy - rh * 0.4 + rnd() * rh * 0.4) | 0, 1 + ((rnd() * 2) | 0), 1);
  }
}

// 빈 칸 발치 장식: 식생(새싹·풀·꽃·버섯·클로버·갈대)·나비. **타일 좌표 시드 결정적**(팬 깜빡임 0).
//   density(= 그 셀 요청수 정규화)로 개수(밀도) 조절. veg(input/output/cacheWrite 비중)로 종류
//   선택 — 그룹 확률(양분=새싹·풀 / 결실=꽃·클로버 / 축적=버섯·갈대) 택1 → 종 택1.
//   나비는 별도 작은 고정 확률. veg 없으면(셀 없음·sum=0) 기존 고정 분포 폴백. 타일 시드(팬 불변).
export function drawDecor(b, gx, gy, cx, cy, density, veg, frame) {
  const d = Number.isFinite(density) ? Math.max(0, Math.min(1, density)) : 0;
  let seed = ((gx * 73856093) ^ (gy * 19349663)) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // 개수 = 활력 비례. 한산(d≈0)=0~1, 북적(d≈1)=2~3. 듬성 유지(과밀 금지).
  const base = rnd() < (0.35 + d * 0.55) ? 1 : 0;
  const extra = (rnd() < d * 0.8 ? 1 : 0) + (rnd() < d * 0.5 ? 1 : 0);
  const count = Math.min(3, base + extra);
  for (let i = 0; i < count; i++) {
    const jx = (cx + (rnd() - 0.5) * (TILE - 6)) | 0;
    const jy = (cy + (rnd() - 0.5) * (TILE - 6)) | 0;
    const species = pickVegSpecies(veg, rnd);
    drawDecorItem(b, species, jx, jy, rnd, gx, gy, frame);
  }
}

// 발치 식생 종류 선택. veg = {gIn,gOut,gCw}(refMax 정규화·멱 강조)|null.
//   ① 나비는 별도 작은 고정 확률(~8%). ② 나머지는 그룹 확률(gIn/gOut/gCw 비중)로 그룹 택1 → 종 택1.
//   veg 없거나 sum=0 → 기존 고정 분포 폴백(균등 비중). 반환 = 종 id(0새싹·1풀·2꽃·3클로버·4버섯·5갈대·6나비).
export function pickVegSpecies(veg, rnd) {
  if (rnd() < 0.08) return 6; // 나비(별도 고정)
  let gIn = veg ? veg.gIn : 0, gOut = veg ? veg.gOut : 0, gCw = veg ? veg.gCw : 0;
  const sum = gIn + gOut + gCw;
  if (!(sum > 0)) { gIn = gOut = gCw = 1; } // sum=0 폴백: 세 그룹 균등(고정 분포)
  const total = gIn + gOut + gCw;
  let r = rnd() * total;
  let group; // 0 양분 / 1 결실 / 2 축적
  if (r < gIn) group = 0; else if (r < gIn + gOut) group = 1; else group = 2;
  // 그룹 안 종 택1(2종 균등).
  if (group === 0) return rnd() < 0.5 ? 0 : 1; // 새싹·풀
  if (group === 1) return rnd() < 0.5 ? 2 : 3; // 꽃·클로버
  return rnd() < 0.5 ? 4 : 5; // 버섯·갈대
}

// 발치 식생 1개 그리기. species = 종 id(0새싹·1풀·2꽃·3클로버·4버섯·5갈대·6나비).
//   작은 도트 오브젝트(과밀 금지). 전부 결정적(호출자 per-타일 PRNG).
export function drawDecorItem(b, species, jx, jy, rnd, gx, gy, frame) {
  if (species === 0) {
    // 새싹: 줄기 + 잎 두 장.
    b.fillStyle = "#3f8b39";
    b.fillRect(jx, jy, 1, 4);
    b.fillStyle = "#5aa84a";
    b.fillRect(jx - 2, jy, 2, 1);
    b.fillRect(jx + 1, jy - 1, 2, 1);
  } else if (species === 1) {
    // 풀 무더기(양분): 세로 가닥 + 끝 굽이침(밑동 0·끝 최대, 프레임 사인).
    b.fillStyle = "#4a8a2f";
    for (let i = 0; i < 4; i++) {
      const gxp = jx + i - 2;
      const h = 2 + ((rnd() * 3) | 0); // 가닥 높이 2~4
      const ph = rnd() * 6.283; // 가닥별 위상(per-타일 PRNG·결정적)
      drawBentBlade(b, gxp, jy, h, ph, frame);
    }
  } else if (species === 2) {
    // 꽃(결실): 꽃잎 + 중심.
    const pal = ["#e8d24a", "#e36a7a", "#c79be0", "#f0f0f0"];
    const col = pal[(rnd() * pal.length) | 0];
    b.fillStyle = "#3f8b39";
    b.fillRect(jx, jy + 1, 1, 2);
    b.fillStyle = col;
    b.fillRect(jx - 1, jy, 3, 1);
    b.fillRect(jx, jy - 1, 1, 3);
    b.fillStyle = "#ffe9a0";
    b.fillRect(jx, jy, 1, 1);
  } else if (species === 3) {
    // 클로버(결실): 3잎(작은 둥근 점 3개) + 짧은 줄기.
    b.fillStyle = "#3f8b39";
    b.fillRect(jx, jy + 1, 1, 2);
    b.fillStyle = "#5fb04a";
    b.fillRect(jx - 1, jy, 1, 1);
    b.fillRect(jx + 1, jy, 1, 1);
    b.fillRect(jx, jy - 1, 1, 1);
  } else if (species === 4) {
    // 버섯(축적): 가는 갈색 줄기 + 빨강·갈색 갓(흰 점).
    const cap = rnd() < 0.5 ? "#c0503a" : "#a86a3a";
    b.fillStyle = "#d8cbb0"; // 줄기(밝은 베이지)
    b.fillRect(jx, jy, 1, 2);
    b.fillStyle = cap;
    b.fillRect(jx - 1, jy - 1, 3, 1); // 갓
    b.fillStyle = "#f0e8d8";
    b.fillRect(jx + (rnd() < 0.5 ? -1 : 1), jy - 1, 1, 1); // 갓 흰 점
  } else if (species === 5) {
    // 갈대/덤불(축적): 키 큰 가닥 2~3 + 끝 솜털. 끝 굽이침(밑동 0·끝 최대).
    const n = 2 + ((rnd() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const rx = jx + i - 1;
      const h = 4 + ((rnd() * 3) | 0);
      const ph = rnd() * 6.283;
      b.fillStyle = "#6f8a3a";
      const tipOff = drawBentBlade(b, rx, jy, h, ph, frame); // 줄기 + 끝 오프셋 반환
      b.fillStyle = "#b8c870"; // 끝 솜털(휜 끝 위치에)
      b.fillRect(rx + tipOff, jy - h, 1, 1);
    }
  } else {
    // 나비(앰비언트). 떠돎·날갯짓·몸통은 drawButterfly 공통.
    const wing = ["#f0a0c0", "#a0c8f0", "#f0e090"][(rnd() * 3) | 0];
    const bx = (jx + Math.sin(frame * 0.05 + gx) * 2) | 0;
    const by = (jy - 6 + Math.cos(frame * 0.06 + gy) * 2) | 0;
    drawButterfly(b, bx, by, gx + gy, wing, frame);
  }
}

// 휘는 풀 줄기 1가닥: 밑동(jx,jy)에서 위로 h px, 끝으로 갈수록 x오프셋(밑동 0·끝 최대) — 프레임
//   사인 굽이침(위상 ph). 색은 호출자가 fillStyle 로 지정. 반환 = 끝 픽셀 x오프셋(솜털 위치 등).
export function drawBentBlade(b, jx, jy, h, ph, frame) {
  const tip = Math.sin(frame * 0.05 + ph); // -1~1 (끝 휨)
  let tipOff = 0;
  for (let s = 0; s < h; s++) {
    const t = (s + 1) / h; // 0(밑동)~1(끝)
    tipOff = Math.round(tip * t); // y비례 휨
    b.fillRect(jx + tipOff, jy - s - 1, 1, 1);
  }
  return tipOff;
}

// 공통 나비 그리기(빈칸 장식·숲 나비 공유). 날갯짓 = 펼침↔접힘 2자세 토글(자세 전환이
//   보이게 — 가로 2×1 ↔ 세로 1×2), 어두운 몸통 1px. phase = 자세 토글 위상(시드/좌표 결정적).
//   위치(bx,by)·떠돎은 호출자가 정한다(여기선 자세·날개·몸통만).
export function drawButterfly(b, bx, by, phase, wing, frame) {
  const fl = Math.sin(frame * 0.15 + phase) > 0 ? 1 : 0;
  b.fillStyle = wing;
  if (fl) {
    // 펼침: 가로로 펼친 날개(2×1 좌우).
    b.fillRect(bx - 2, by, 2, 1);
    b.fillRect(bx + 1, by, 2, 1);
  } else {
    // 접힘: 세로로 접은 날개(1×2 좌우).
    b.fillRect(bx - 1, by - 1, 1, 2);
    b.fillRect(bx + 1, by - 1, 1, 2);
  }
  b.fillStyle = "#3a2a1a"; // 어두운 몸통
  b.fillRect(bx, by, 1, 1);
}
