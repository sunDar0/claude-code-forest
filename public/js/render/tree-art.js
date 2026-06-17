/**
 * renderer 에서 분리한 절차 나무 그리기 — 순수 함수.
 * 캔버스 컨텍스트·팔레트(P)·인자만 받고 바깥 인스턴스 상태(this)는 안 쓴다.
 * 베이크(스프라이트 오프스크린) 안에서 1회 호출되어 나무 몸통·수관·가지·뿌리·도트
 * 프리미티브를 그린다. 형제 함수끼리만 서로 부른다.
 */

import { GRID } from "../grid.js";
import { PAL, hexToRgb, mixHex } from "./palette.js";
import { hash32 } from "../seed.js";

export function paintTreeBody(b, baked, sx, baseY, P, ds, sd, withCap) {
  const SX = (vx) => (sx + vx * ds) | 0;
  const SY = (vy) => (baseY - vy * ds) | 0;
  const tw = baked.sprout ? 1.0 : 1.0;

  // 묘목(새싹): 갈색 줄기 + 떡잎.
  if (baked.sprout) {
    for (const seg of baked.trunkSegs) {
      const x1 = SX(seg.x1), y1 = SY(seg.y1), x2 = SX(seg.x2), y2 = SY(seg.y2);
      const w = Math.max(2, Math.round(seg.w * ds));
      thickLine(b, x1, y1, x2, y2, w + 1, P.trunkDark);
      thickLine(b, x1, y1, x2, y2, w, P.trunk);
    }
    for (const bl of baked.crown) {
      const cxp = SX(bl.x), cyp = SY(bl.y), r = Math.max(2, bl.r * ds);
      drawOvalLeaf(b, cxp, cyp, r, bl.ang || 0, P.leafDark || "#3a5a30", P.leafLight, P.leafHi);
    }
    return;
  }

  // 뎁스 레이어링: 뒤잎 → 몸통/가지 → 앞잎.
  const minY = baked.crownMinY ?? 0;
  const maxY = baked.crownMaxY ?? 1;
  const span = Math.max(1, maxY - minY);
  const splitT = 0.5;
  const allBlobs = baked.crown.map((bl) => ({
    x: SX(bl.x), y: SY(bl.y),
    r: Math.max(2, Math.round(bl.r * ds)),
    bx: bl.x, by: bl.y, br: bl.r, // 클럼프 음영용 원본(시뮬) 좌표
    t: (bl.y - minY) / span,
  }));
  const backBlobs = allBlobs.filter((x) => x.t >= splitT).sort((p, q) => p.y - q.y);
  const frontBlobs = allBlobs.filter((x) => x.t < splitT).sort((p, q) => p.y - q.y);

  // 수관 통합 음영(+클럼프 경계 입체감). 뒤잎은 어두운 톤(back=true).
  drawCrownBlobs(b, backBlobs, P, sd ^ 0x1, true);

  let trunkTopSim = 0, trunkTopX = 0;
  for (const seg of baked.trunkSegs) {
    if (seg.kind === "branch" || seg.kind === "root") continue;
    if (seg.y1 > trunkTopSim) { trunkTopSim = seg.y1; trunkTopX = seg.x1; }
    if (seg.y2 > trunkTopSim) { trunkTopSim = seg.y2; trunkTopX = seg.x2; }
  }
  const cMin = baked.crownMinY ?? trunkTopSim;
  const crownH = Math.max(1, (baked.crownMaxY ?? 1) - cMin);
  const trunkDrawTop = Math.min(trunkTopSim, cMin + crownH * 0.38);
  drawTrunkSegs(b, baked.trunkSegs, SX, SY, P, ds, tw, trunkDrawTop);
  drawBranches(b, baked.trunkSegs, SX, SY, P, ds, tw);

  drawCrownBlobs(b, frontBlobs, P, sd, false);

  // 상단 보강 잎 클러스터(일반 나무만 — 군집 작은 나무는 생략, withCap=false).
  if (withCap && cMin < trunkTopSim) {
    const capX = SX(trunkTopX), capY = SY(trunkDrawTop);
    const baseR = Math.max(6, Math.round(crownH * 0.4 * ds));
    let cseed = (sd ^ 0x9e3779b9) >>> 0;
    const crnd = () => { cseed = (cseed * 1664525 + 1013904223) >>> 0; return cseed / 4294967296; };
    const cap = [{ x: capX, y: capY, r: baseR, t: 0.46 }];
    const nCap = 8;
    for (let i = 0; i < nCap; i++) {
      const ang = (i / nCap) * Math.PI * 2 + crnd() * 0.9;
      const rad = baseR * (0.45 + crnd() * 0.85);
      const lr = baseR * (0.55 + crnd() * 0.5);
      cap.push({ x: capX + Math.cos(ang) * rad, y: capY + Math.sin(ang) * rad * 0.5, r: lr, t: 0.34 + crnd() * 0.18 });
    }
    drawCrownBlobs(b, cap, P, sd ^ 0x5, false);
  }

  // 하부 재그림 + 뿌리(밑동 컷 가림).
  const lowerCut = trunkTopSim * (withCap ? 0.34 : 0.3);
  drawTrunkSegs(b, baked.trunkSegs, SX, SY, P, ds, tw, lowerCut);
  drawRootScatter(b, baked, SX, SY, ds, sx, baseY, sd, P);
}

// 뿌리: x별 1px 세로 기둥 방식 폐기(dx&1 격열 색교차가 수직 줄무늬처럼 보였다). 대체:
//   ① 낮은 둔덕(마운드)을 가로 스캔라인으로 채우고 행별 폭을 노이즈로 변주(세로 줄무늬 제거,
//      색 교차는 행 단위). ② 밑동에서 2~4가닥 사선으로 퍼지는 짧은 테이퍼 뿌리(바깥으로 갈수록
//      가늘고 낮아짐, 좌우 비대칭). ③ 흙 알갱이 산점 유지. 밑동 수평 컷 가리기 보존(마운드 상단이
//      baseY 위까지 올라와 기둥 base 컷을 덮음). 시드는 월드 불변.
//   P = 톤 팔레트(live/past). 스프라이트 베이크 안에서 1회만 계산(프레임 비용 0).
export function drawRootScatter(b, baked, SX, SY, ds, sx, baseY, seedVal, P) {
  if (baked.sprout) return;
  P = P || PAL;
  const baseW = baked.trunkSegs.length ? Math.round(baked.trunkSegs[0].w * ds) : 6;
  const sd = (seedVal != null ? seedVal : hash32(sx)) >>> 0;
  const np = (sd % 6283) / 1000; // 월드 불변 노이즈 위상(0~2π)
  let seed = (sd * 2654435761) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const cx = SX(0);
  const reach = Math.max(6, (baseW * 1.35) | 0);
  const knee = Math.max(7, (baseW * 0.55) | 0); // 마운드 최고 높이(기둥 base 컷 위까지)

  // ① 사선 테이퍼 뿌리(2~4가닥) — 먼저 깔아 마운드가 그 위로 덮게(밑동→흙으로 녹아듦).
  //   각 가닥: 밑동 양옆에서 바깥-아래로 뻗는 짧은 직선. 바깥으로 갈수록 가늘고 낮아짐.
  const nRoot = 2 + ((rnd() * 3) | 0); // 2~4
  for (let i = 0; i < nRoot; i++) {
    const side = rnd() < 0.5 ? -1 : 1;
    // 시작점: 밑동 가장자리(약간 안쪽). 길이·각도는 가닥마다 변주(좌우 비대칭).
    const sxr = cx + side * ((baseW * 0.3) | 0);
    const len = reach * (0.55 + rnd() * 0.55); // 가닥 길이
    const droop = 1 + rnd() * 2.5; // 끝이 아래로 처지는 정도(흙에 박힘)
    const steps = Math.max(3, len | 0);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = (sxr + side * len * t) | 0;
      const py = (baseY + t * t * droop) | 0; // 바깥으로 갈수록 아래로(처짐)
      const rw = Math.max(0, (1 - t) * baseW * 0.32); // 테이퍼: 안쪽 굵고 끝 가늘게
      const half = rw | 0;
      b.fillStyle = t < 0.6 ? P.trunkDark : (P.dirtSpeck1 || PAL.dirtSpeck1);
      b.fillRect(px - half, py, half * 2 + 1, 1);
    }
  }

  // ② 낮은 둔덕(마운드): **가로 스캔라인**(행마다 1 fillRect, 폭은 노이즈 변주). 세로 줄무늬 없음.
  //   마운드 상단(baseY−knee)부터 아래(baseY+여유)까지. 각 행 폭 = 포물선 + 행 노이즈.
  //   색 교차는 **행 단위**(yy 기반) — dx 기반 격열 교차 폐기로 수직 줄무늬 제거.
  const top = baseY - knee;
  const bot = baseY + 3;
  for (let yy = top; yy <= bot; yy++) {
    const ry = baseY - yy; // 마운드 정점(baseY−knee)에서 +knee, 바닥에서 음수
    // 마운드 폭(반): 정점 근처는 좁고, 중앙(baseY 부근)에서 가장 넓게(둥근 둔덕).
    const vn = (yy - top) / Math.max(1, bot - top); // 0(위)~1(아래)
    const widthProfile = Math.sin(vn * Math.PI * 0.85) ; // 위/아래 좁고 중간 넓음
    const rowNoise = 1 + Math.sin(yy * 1.3 + np) * 0.16 + Math.sin(yy * 0.5 - np) * 0.1;
    const hw = Math.max(0, (widthProfile * reach * rowNoise) | 0);
    if (hw <= 0) continue;
    // 색: 행 단위 교차(yy & 1) + 밑동 위(baseY 위, ry>0)는 기둥색 위주(컷 덮음), 아래는 흙 섞임.
    const aboveBase = ry > 0;
    b.fillStyle = aboveBase
      ? ((yy & 1) ? P.trunk : P.trunkDark)
      : ((yy & 1) ? P.trunkDark : (P.dirtSpeck1 || PAL.dirtSpeck1));
    b.fillRect(cx - hw, yy, hw * 2 + 1, 1);
  }

  // ③ 흙 알갱이 산점(마운드 표면 질감, 균일 밴드 금지). 결정적 시드.
  const n = 18 + ((rnd() * 10) | 0);
  for (let i = 0; i < n; i++) {
    const side = rnd() < 0.5 ? -1 : 1;
    const distN = Math.sqrt(rnd());
    const spread = distN * reach * (side < 0 ? 1.0 : 0.8); // 좌우 비대칭
    const px = (cx + side * spread) | 0;
    const depth = ((1 - distN * distN) * 6) | 0;
    const py = (baseY - 3 + rnd() * (depth + 4)) | 0;
    b.fillStyle = rnd() < 0.5 ? (P.dirtSpeck1 || PAL.dirtSpeck1) : P.trunkDark;
    const w = rnd() < 0.4 ? 2 : 1;
    b.fillRect(px, py, w, 1);
  }
}

// 수관 통합 음영(블롭별 구체 음영 폐기 — 풍선 묶음 현상 해소).
//   음영 단위를 블롭 → **수관 전체**로 바꾼다:
//   ① 모든 블롭의 합집합 실루엣을 스캔라인 마스크로 만들고 기본 잎색 한 덩어리로 채운다.
//      (외곽 1px 어두운 톤 테두리 — 도트 스타일에 맞게.)
//   ② 하이라이트·그늘은 수관 **전체 기준**: 마스크 안에서 위/좌(빛 방향)는 밝게, 아래·안쪽은
//      어둡게(y, 약간의 x 기반 띠). 개별 원 단위 하이라이트 금지.
//   ③ 잎 질감: 마스크 안에 결정적 시드(나무 고유 sd)로 작은 잎뭉치 점을 흩어 표면 질감.
//   back=true(뒤잎)는 전체적으로 어두운 톤. blobs 한 레이어(back 또는 front)씩 호출.
export function drawCrownBlobs(b, blobs, P, sd, back) {
  if (!blobs || blobs.length === 0) return;
  // 합집합 bbox.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const bl of blobs) {
    minX = Math.min(minX, bl.x - bl.r); maxX = Math.max(maxX, bl.x + bl.r);
    minY = Math.min(minY, bl.y - bl.r); maxY = Math.max(maxY, bl.y + bl.r);
  }
  minX = minX | 0; maxX = maxX | 0; minY = minY | 0; maxY = maxY | 0;
  const W = maxX - minX + 1, H = maxY - minY + 1;
  if (W <= 0 || H <= 0 || W > 4096 || H > 4096) return;
  // ① 합집합 마스크(0/1). 각 행마다 union span 채움(스캔라인). 픽셀퍼펙트.
  const mask = new Uint8Array(W * H);
  for (const bl of blobs) {
    const r = bl.r, r2 = r * r;
    const bx = bl.x | 0, by = bl.y | 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = by + dy - minY;
      if (yy < 0 || yy >= H) continue;
      const dx = Math.floor(Math.sqrt(Math.max(0, r2 - dy * dy)));
      let xs = bx - dx - minX, xe = bx + dx - minX;
      if (xs < 0) xs = 0;
      if (xe >= W) xe = W - 1;
      const row = yy * W;
      for (let x = xs; x <= xe; x++) mask[row + x] = 1;
    }
  }
  // 빛 방향 = 좌상. 음영 색(어두움→밝음) 5단 램프. back 은 한 톤 어둡게 쉬프트.
  const cBody = back ? hexToRgb(P.leafDark) : hexToRgb(P.leafMid);
  const cShade = hexToRgb(P.leafShadow);
  const cMid = hexToRgb(P.leafMid);
  const cLight = back ? hexToRgb(P.leafMid) : hexToRgb(P.leafLight);
  const cHi = back ? hexToRgb(P.leafLight) : hexToRgb(P.leafHi);
  // 차가운 그늘: 그늘색을 단순 어두운 초록이 아니라 hue 가 청록·남보라로 시프트된 톤으로. 깊은
  //   그늘(아래·rim 그늘)일수록 cool 톤으로 섞어 밑면을 차갑게.
  const cCool = hexToRgb(P.leafCool || P.leafShadow);
  const cCoolDeep = hexToRgb(P.leafCoolDeep || P.leafShadow);
  const cTierCap = hexToRgb(P.leafTierCap || P.leafHi);
  const lerp = (a, c, t) => `rgb(${(a.r + (c.r - a.r) * t) | 0},${(a.g + (c.g - a.g) * t) | 0},${(a.b + (c.b - a.b) * t) | 0})`;
  const lerpObj = (a, c, t) => ({ r: (a.r + (c.r - a.r) * t) | 0, g: (a.g + (c.g - a.g) * t) | 0, b: (a.b + (c.b - a.b) * t) | 0 });
  const rgbStr = (a) => `rgb(${a.r | 0},${a.g | 0},${a.b | 0})`;

  // 클럼프 경계 입체감("판떼기" 방지). 구체(풍선) 음영으로 돌아가지 않는다:
  //   음영 기준이 클럼프(블롭) 경계선이지 원 중심 그라데이션이 아니다. 각 블롭의 아래/오른쪽
  //   가장자리(rim)를 따라 어두운 초승달 띠(인접 클럼프와의 경계 그늘), 위/왼쪽 rim 에 밝은 캡.
  //   모든 값은 합집합 마스크 안으로 클립(실루엣은 한 덩어리 유지). 수관 하단·전체적으로 +깊은 그늘.
  //   clumpDelta = 픽셀별 밝기 가감(−=그늘, +=하이라이트). 베이크 1회라 비용 무관.
  const clumpDelta = new Float32Array(W * H);
  // 차가운 그늘 강도(0~1, 단 아랫면 rim 그늘에서 높음) + 티어 캡 강도(0~1, 단 윗면 밝은 캡).
  //   단마다 윗면 밝은 캡 / 아랫면 차가운 그늘 → 부채꼴 단(티어)이 층져 보인다.
  const coolDelta = new Float32Array(W * H);
  const capDelta = new Float32Array(W * H);
  // 빛 방향 단위벡터(좌상): 화면 x 우=+, y 아래=+ 이므로 빛은 (−,−). rim·캡 판정에 사용.
  for (const bl of blobs) {
    const r = Math.max(1, bl.r), inv = 1 / r;
    const bx = bl.x, by = bl.y;
    const x0 = Math.max(0, (bx - r - minX) | 0), x1c = Math.min(W - 1, (bx + r - minX) | 0);
    const y0 = Math.max(0, (by - r - minY) | 0), y1c = Math.min(H - 1, (by + r - minY) | 0);
    for (let yy = y0; yy <= y1c; yy++) {
      const row = yy * W;
      const ly = (yy + minY - by) * inv; // -1(위)~+1(아래)
      for (let xx = x0; xx <= x1c; xx++) {
        if (!mask[row + xx]) continue;
        const lx = (xx + minX - bx) * inv; // -1(좌)~+1(우)
        const rr = lx * lx + ly * ly;
        if (rr > 1) continue; // 블롭 원 밖
        const rim = Math.sqrt(rr); // 0(중심)~1(가장자리)
        // 빛 방향 투영: 아래·오른쪽(빛 반대)일수록 dir>0, 위·왼쪽(빛쪽)일수록 dir<0.
        const dir = lx * 0.55 + ly * 0.83; // |(0.55,0.83)|≈1
        // rim 가중(가장자리에서만 강하게): 경계 그늘/캡이 클럼프 윤곽을 따른다(중심 그라데이션 아님).
        const edge = Math.max(0, rim - 0.45) / 0.55; // 0.45 안쪽은 0, 가장자리 1
        if (dir > 0) {
          // 아래·오른쪽 rim → 초승달 그늘(인접 클럼프 경계). edge·dir 강도.
          const sh = dir * edge;
          clumpDelta[row + xx] -= sh * 0.5;
          // 단 아랫면(ly>0, 아래쪽 rim)일수록 차가운 그늘로 hue 시프트.
          const under = Math.max(0, ly); // 0(위)~1(아래)
          const c = coolDelta[row + xx] + sh * under * 0.9;
          if (c > coolDelta[row + xx]) coolDelta[row + xx] = c > 1 ? 1 : c;
        } else {
          // 위·왼쪽 rim → 밝은 캡(빛 받는 둥근 단).
          clumpDelta[row + xx] += (-dir) * edge * 0.32;
          // 단 윗면(ly<0, 위쪽 rim)일수록 밝은 티어 캡.
          const over = Math.max(0, -ly); // 0(아래)~1(위)
          const cp = capDelta[row + xx] + (-dir) * edge * over * 0.7;
          if (cp > capDelta[row + xx]) capDelta[row + xx] = cp > 1 ? 1 : cp;
        }
      }
    }
  }

  // ② 수관 전체 기준 음영 + 클럼프 경계 입체감 합성: 픽셀별 정규화 위치(nx,ny)로 전역 밝기,
  //    여기에 clumpDelta(클럼프 rim 그늘/캡)를 더한다. 행 단위 같은 색 구간은 fillRect 한 번.
  for (let yy = 0; yy < H; yy++) {
    const ny = H > 1 ? yy / (H - 1) : 0;
    let runStart = -1, runColor = null;
    for (let xx = 0; xx <= W; xx++) {
      let col = null;
      if (xx < W && mask[yy * W + xx]) {
        const idx = yy * W + xx;
        const nx = W > 1 ? xx / (W - 1) : 0.5;
        // 전역 밝기 t: 위·좌 밝음, 아래·우 어두움(빛 좌상). + 수관 하단 깊은 그늘(이전 leafShadow).
        let lightT = (1 - ny) * 0.62 + (1 - nx) * 0.22 + 0.08;
        lightT += clumpDelta[idx]; // 클럼프 경계 그늘/캡
        if (lightT < 0) lightT = 0; else if (lightT > 1) lightT = 1;
        // 색 램프(어두운 그늘 → 밝은 하이라이트) 5구간.
        let c;
        if (lightT < 0.25) c = lerpObj(cShade, cBody, lightT / 0.25);
        else if (lightT < 0.5) c = lerpObj(cBody, cMid, (lightT - 0.25) / 0.25);
        else if (lightT < 0.72) c = lerpObj(cMid, cLight, (lightT - 0.5) / 0.22);
        else c = lerpObj(cLight, cHi, Math.min(1, (lightT - 0.72) / 0.28));
        // 차가운 그늘 hue 시프트: 단 아랫면 rim 그늘(coolDelta) + 수관 하단(ny)일수록 cool 톤.
        //   깊을수록 cCoolDeep 까지.
        const coolBase = Math.max(0, ny - 0.55) / 0.45; // 하단 0.55 아래부터 차가워짐
        let coolT = coolDelta[idx] * 0.85 + coolBase * 0.5;
        if (coolT > 0.92) coolT = 0.92;
        if (coolT > 0.02) {
          // cool 톤 자체도 깊이(coolT)에 따라 청록→남보라.
          const coolCol = lerpObj(cCool, cCoolDeep, Math.min(1, coolT));
          c = lerpObj(c, coolCol, coolT);
        }
        // 티어 캡: 단 윗면 밝은 캡 → leafTierCap 으로 살짝 띄움(부채꼴 단의 밝은 윗면).
        const capT = capDelta[idx];
        if (capT > 0.04 && !back) c = lerpObj(c, cTierCap, Math.min(0.55, capT * 0.7));
        col = rgbStr(c);
      }
      if (col === runColor) continue;
      if (runStart >= 0 && runColor) {
        b.fillStyle = runColor;
        b.fillRect(minX + runStart, minY + yy, xx - runStart, 1);
      }
      runStart = col ? xx : -1;
      runColor = col;
    }
  }
  // ①b 외곽 1px 어두운 테두리(도트 실루엣 강조): 마스크 가장자리(빈 이웃 있는 픽셀) 어둡게.
  //   실루엣 외곽선을 차가운 어두운 톤으로(단순 어두운 초록 아님).
  b.fillStyle = back
    ? mixHex(P.leafShadow, P.leafCoolDeep || P.leafShadow, 0.5)
    : mixHex(P.leafCool || P.leafShadow, P.leafCoolDeep || P.leafShadow, 0.45);
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      if (!mask[yy * W + xx]) continue;
      const up = yy > 0 ? mask[(yy - 1) * W + xx] : 0;
      const dn = yy < H - 1 ? mask[(yy + 1) * W + xx] : 0;
      const lf = xx > 0 ? mask[yy * W + xx - 1] : 0;
      const rt = xx < W - 1 ? mask[yy * W + xx + 1] : 0;
      if (up && dn && lf && rt) continue; // 내부 픽셀 skip
      // 위/좌 가장자리는 밝은 빛이 닿으니 테두리 생략(아래·우 외곽만 어둡게).
      if ((dn === 0 || rt === 0)) b.fillRect(minX + xx, minY + yy, 1, 1);
    }
  }
  // ③ 잎 질감: 마스크 안에 결정적 시드로 작은 잎뭉치 점(밝은/어두운). 표면 결.
  if (sd != null) {
    let s = (sd ^ (W * 0x9e3779b9) ^ (H << 8)) >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const speckN = Math.min(60, Math.max(6, ((W * H) / 90) | 0));
    const specHi = back ? P.leafMid : P.leafSpec;
    const specLo = back ? P.leafShadow : P.leafDark;
    for (let i = 0; i < speckN; i++) {
      const xx = (rnd() * W) | 0, yy = (rnd() * H) | 0;
      if (!mask[yy * W + xx]) continue;
      const ny = H > 1 ? yy / (H - 1) : 0;
      // 위쪽(빛)엔 밝은 점, 아래쪽(그늘)엔 어두운 점.
      b.fillStyle = (rnd() < (1 - ny)) ? specHi : specLo;
      const cl = rnd();
      b.fillRect(minX + xx, minY + yy, 1, 1);
      if (cl < 0.4) b.fillRect(minX + xx + 1, minY + yy, 1, 1);
      if (cl < 0.2) b.fillRect(minX + xx, minY + yy + 1, 1, 1);
    }
  }
}

// 가지(kind:"branch") 그리기 — 몸통 두께감으로. 잎 사이에 묻혀 끝만 비친다.
export function drawBranches(b, segs, SX, SY, P, ds, tw) {
  for (const seg of segs) {
    if (seg.kind !== "branch") continue;
    const x1 = SX(seg.x1), y1 = SY(seg.y1), x2 = SX(seg.x2), y2 = SY(seg.y2);
    const w = Math.max(2, Math.round(seg.w * ds * tw));
    thickLine(b, x1, y1, x2, y2, w + 1, P.trunkDark);
    thickLine(b, x1, y1, x2, y2, w, P.trunk);
  }
}

// 기둥·뿌리 세그먼트 그리기. maxSimY 이하(시뮬y) 세그먼트만(하부 덧그림용). 가지 제외.
// 직선·직각 금지: 세그먼트를 maxSimY 에서 클립(straddle 세그먼트가 컷 위 평면을 노출
//   하지 않게)하고, 좌/우 비대칭 폭(seg.wL/wR)으로 윤곽을 픽셀 단위 불규칙하게 그린다.
export function drawTrunkSegs(b, segs, SX, SY, P, ds, tw, maxSimY) {
  for (const seg of segs) {
    if (seg.kind === "branch") continue;
    if (seg.y1 > maxSimY && seg.y2 > maxSimY) continue; // 둘 다 컷 위면 skip
    // straddle 세그먼트는 maxSimY 에서 끝점을 선형 보간 클립 — 컷 위 평면 노출 방지.
    let vx1 = seg.x1, vy1 = seg.y1, vx2 = seg.x2, vy2 = seg.y2;
    // root(kind:"root")는 음수 y 로 내려가므로 클립 안 함(밑동 융기). 기둥만 클립.
    if (seg.kind !== "root") {
      if (vy2 > maxSimY) {
        const f = (maxSimY - vy1) / (vy2 - vy1 || 1);
        vx2 = vx1 + (vx2 - vx1) * f; vy2 = maxSimY;
      } else if (vy1 > maxSimY) {
        const f = (maxSimY - vy2) / (vy1 - vy2 || 1);
        vx1 = vx2 + (vx1 - vx2) * f; vy1 = maxSimY;
      }
    }
    const x1 = SX(vx1), y1 = SY(vy1), x2 = SX(vx2), y2 = SY(vy2);
    const baseW = Math.max(2, Math.round(seg.w * ds * tw));
    if (seg.kind === "root") {
      // 뿌리는 거의 수평이라 좌우폭 대신 일반 두꺼운 라인(thickLineLR 는 수직 윤곽용).
      thickLine(b, x1, y1, x2, y2, baseW + 1, P.trunkDark);
      thickLine(b, x1, y1, x2, y2, baseW, P.trunk);
      continue;
    }
    // 기둥: 좌/우 비대칭 폭(불규칙 윤곽). 없으면 seg.w 폴백.
    const wL = Math.max(1, Math.round((seg.wL ?? seg.w) * ds * tw));
    const wR = Math.max(1, Math.round((seg.wR ?? seg.w) * ds * tw));
    // 어두운 외곽(좌우 비대칭 폭 + 2) → 본체 → 좌측 하이라이트.
    thickLineLR(b, x1, y1, x2, y2, wL + 2, wR + 2, P.trunkDark);
    thickLineLR(b, x1, y1, x2, y2, wL, wR, P.trunk);
    thickLine(b, x1 - ((baseW / 4) | 0), y1, x2 - ((baseW / 4) | 0), y2, Math.max(1, (baseW / 3) | 0), P.trunkLight);
    if (baseW >= 4) {
      thickLine(b, x1 + ((baseW / 4) | 0), y1, x2 + ((baseW / 4) | 0), y2, 1, P.trunkBark);
    }
  }
}

// 좌/우 비대칭 폭 두꺼운 라인 — 거의 수직인 기둥의 좌우 윤곽을 다른 폭으로(불규칙 실루엣).
//   가로 방향으로 wL(왼) / wR(오른) 만큼 도트를 채운다. Bresenham 경로 각 점에서 가로 채움.
export function thickLineLR(b, x0, y0, x1, y1, wL, wR, color) {
  b.fillStyle = color;
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    // 가로 폭: 왼쪽 wL, 오른쪽 wR(중심 1px 포함). 세로로 살짝 겹쳐 끊김 방지.
    b.fillRect(x0 - wL, y0, wL + wR + 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

// ---- 도트 프리미티브 ----
// 채운 원(정수 스냅 디스크).
export function disc(b, cx, cy, r, color) {
  if (color) b.fillStyle = color;
  if (r <= 0) {
    b.fillRect(cx, cy, 1, 1);
    return;
  }
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    const dx = Math.floor(Math.sqrt(Math.max(0, r2 - dy * dy)));
    b.fillRect((cx - dx) | 0, (cy + dy) | 0, dx * 2 + 1, 1);
  }
}

// 타원 떡잎: 각도 ang 로 기운 잎(길이>폭) + 중앙 잎맥. 어두운 외곽→본체→하이라이트.
// cx,cy = 잎 부착점(밑동 쪽). 잎은 부착점에서 ang 방향으로 뻗는다.
export function drawOvalLeaf(b, cx, cy, r, ang, dark, body, hi) {
  const len = r * 1.8; // 잎 길이(긴 축)
  const wid = r * 0.85; // 잎 폭(짧은 축)
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // 잎 중심 = 부착점에서 길이 절반만큼 ang 방향(위로). 화면 y 는 위가 작으므로 -.
  const lx = cx + sa * len * 0.5;
  const ly = cy - ca * len * 0.5;
  // 타원을 점들로 채움(긴 축 u, 짧은 축 v). 외곽 어둡게 1px 크게, 본체, 하이라이트.
  const fillEllipse = (ox, oy, rl, rw, col) => {
    b.fillStyle = col;
    const steps = Math.max(6, Math.round(rl * 2));
    for (let i = -steps; i <= steps; i++) {
      const u = (i / steps) * rl; // 긴 축 위치
      const t = 1 - (u / rl) * (u / rl);
      if (t < 0) continue;
      const w = Math.sqrt(t) * rw; // 그 지점의 폭 절반
      // u,w → 화면(ang 회전). 긴 축 방향 (sa,-ca), 짧은 축 (ca, sa).
      const px = ox + sa * u;
      const py = oy - ca * u;
      // 폭 방향으로 -w..w 선분.
      for (let k = -w; k <= w; k += 1) {
        b.fillRect((px + ca * k) | 0, (py + sa * k) | 0, 1, 1);
      }
    }
  };
  fillEllipse(lx, ly, len * 0.5 + 1, wid * 0.5 + 1, dark); // 외곽
  fillEllipse(lx, ly, len * 0.5, wid * 0.5, body); // 본체
  // 중앙 잎맥(부착점→잎 끝).
  const tipX = cx + sa * len, tipY = cy - ca * len;
  thickLine(b, cx | 0, cy | 0, tipX | 0, tipY | 0, 1, dark);
  // 하이라이트(잎 위쪽 절반 작게).
  fillEllipse(lx - sa * len * 0.15, ly + ca * len * 0.15, len * 0.28, wid * 0.3, hi);
}

// 두꺼운 도트 라인(Bresenham + 정사각 도트).
export function thickLine(b, x0, y0, x1, y1, width, color) {
  b.fillStyle = color;
  x0 |= 0;
  y0 |= 0;
  x1 |= 0;
  y1 |= 0;
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  const r = (width / 2) | 0;
  for (;;) {
    if (width <= 1) b.fillRect(x0, y0, 1, 1);
    else b.fillRect(x0 - r, y0 - r, width, width);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}
