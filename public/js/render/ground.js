// 바닥 분류·전이대 (순수 렌더 로직, renderer god-file 절단).
//
// renderer.js 에서 옮긴 "땅 종류 판정 + 전이대 디더" 로직. 인스턴스 상태(카메라·스냅샷·베이크)에
//   묶이지 않고, 조회 컨텍스트 ctx={cellByKey, blocked} 와 타일 좌표만으로 결정된다(순수에 가까움).
//   드로잉 orchestrator(_drawGroundAndObjects)·베이크는 renderer 에 남는다(camera/스냅샷/Y-sort 결합).
//
// ctx 규약: { cellByKey: Map<"gx,gy", cell>, blocked: Map<"gx,gy", tag>|null }.
//   renderer 가 `this` 를 ctx 로 넘긴다(같은 필드명). 동작은 옮기기 전과 비트 동일.

import { PAL, PAL_PAST } from "./palette.js";
import { vhash, fbm } from "./noise.js";
import { TILE } from "../grid.js";

// 발치 식생 활력 = 그 타일이 속한 그리드 셀의 요청수 정규화값(ground.density=requestN, metrics.js).
//   "요청수→잔디·꽃 밀도". 셀 없으면(트인 빈 땅) 0(한산). tx/ty → 그리드 매핑은 cellAtTile 과 정합.
export function cellGroundDensity(ctx, tx, ty) {
  const cell = ctx.cellByKey.get(Math.round(tx / 3) + "," + Math.round(ty / 3));
  const g = cell && cell.params && cell.params.ground;
  return g && Number.isFinite(g.density) ? Math.max(0, Math.min(1, g.density)) : 0;
}

// 발치 식생 종류 그룹 비중 = 그 타일 소속 셀의 input/output/cacheWrite 정규화값(refMax). 그날 "어디에
//   치우쳤나"로 식생 종류를 뽑는다(양분/결실/축적). 셀 없으면 null(폴백=고정 분포). log 정규화가 큰
//   값들을 0.7~0.95 로 몰아 변별이 약하므로 멱 강조(norm^2)로 차이를 벌린다.
export function cellVegNorms(ctx, tx, ty) {
  const cell = ctx.cellByKey.get(Math.round(tx / 3) + "," + Math.round(ty / 3));
  const n = cell && cell.params && cell.params.norms;
  if (!n) return null;
  const emph = (v) => { const x = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; return x * x; }; // norm^2
  return { gIn: emph(n.inputN), gOut: emph(n.outputN), gCw: emph(n.cacheWriteN) };
}

// 그 타일 소속 활성 셀의 cacheWrite 정규화값(자갈=축적 그룹 가변용). 활성 셀 아니면 null
//   → 비활성 칸은 기존 고정 배치(데이터 신규 저장 없음·norm 조회만).
export function cellCacheWriteN(ctx, tx, ty) {
  const cell = ctx.cellByKey.get(Math.round(tx / 3) + "," + Math.round(ty / 3));
  if (!cell || cell.bundled || !cell.isActive) return null; // 활성 칸에서만 가변
  const n = cell.params && cell.params.norms;
  return n && Number.isFinite(n.cacheWriteN) ? Math.max(0, Math.min(1, n.cacheWriteN)) : null;
}

// 타일(tx,ty)이 묶인 숲(bundled) 칸에 속하는가. 묶인 칸 베이스는 흙이 아니라 PAST 풀톤이라
//   _drawForestFloor 외곽 인셋에서 흙색 링이 안 비친다(_drawForestFloor 가 그 위 녹색을 덮는다).
export function isBundledTile(ctx, tx, ty) {
  const cell = ctx.cellByKey.get(Math.round(tx / 3) + "," + Math.round(ty / 3));
  return !!(cell && cell.bundled);
}

// 그리드 칸(gx,gy)이 "활성"인가? = 배치된(placement 있는) 데이터 셀이고 묶이지 않음.
//   활성 = 풀밭 톤(나무·활성 빈땅). 비활성(대기/미배치) = 밝은 흙톤 + 잡초.
export function isActiveGridCell(ctx, gx, gy) {
  const cell = ctx.cellByKey.get(gx + "," + gy);
  return !!(cell && !cell.bundled);
}

// 타일(tx,ty) → 소속 그리드가 활성인지. cellAtTile 과 동일한 그리드 매핑(round(t/3)).
export function isActiveTile(ctx, tx, ty) {
  return isActiveGridCell(ctx, Math.round(tx / 3), Math.round(ty / 3));
}

// 그리드 칸(gx,gy)의 바닥 종류(노이즈 전이대 대상). 풀↔흙·닫힘·묶인 숲(forest)까지 편입 →
//   모든 바닥 경계가 노이즈로 흐른다(칸 네모 제거). null 없음(모든 칸이 종류를 가짐). 활성 불가
//   바위 종류는 폐기 — blocked 는 닫힘만 담음. 반환 "grass"|"dirt"|"closed"|"forest".
export function groundKindCell(ctx, gx, gy) {
  if (isActiveGridCell(ctx, gx, gy)) return "grass";
  const key = gx + "," + gy;
  if (ctx.blocked && ctx.blocked.has(key)) {
    // blocked Map 은 닫힘("closed:ym")만 담는다.
    const tag = ctx.blocked instanceof Map ? ctx.blocked.get(key) : null;
    if (tag) return "closed"; // "closed:ym"
  }
  const cell = ctx.cellByKey.get(key);
  if (cell && cell.bundled) return "forest"; // 묶인 숲 = PAST 풀톤(경계 노이즈 편입)
  return "dirt"; // 평범한 비활성 흙
}

// 타일(tx,ty) → 바닥 종류(범위 밖이면 null). 타일→그리드 매핑은 isActiveTile 과 정합.
export function groundKind(ctx, tx, ty) {
  return groundKindCell(ctx, Math.round(tx / 3), Math.round(ty / 3));
}

// 이 타일이 바닥 종류 경계 타일인가(전이대 적용 대상). 자신과 4방향 이웃 중 다른 종류가 있어야
//   한다. 모든 칸이 종류를 가짐(null 없음). 내부(전 이웃 동일 종류)는 solid(성능).
export function isGroundBoundaryTile(ctx, tx, ty) {
  const k = groundKind(ctx, tx, ty);
  if (!k) return false;
  const diff = (nx, ny) => { const nk = groundKind(ctx, nx, ny); return nk && nk !== k; };
  return diff(tx + 1, ty) || diff(tx - 1, ty) || diff(tx, ty + 1) || diff(tx, ty - 1);
}

// 도메인 워프 분류: 월드 타일좌표(u,v float)를 노이즈로 흔든 뒤 바닥 종류 판정. 칸 경계가 노이즈를
//   따라 칸을 가로질러 흐른다(칸 주기성 제거). amp = 전이대 폭(타일). 워프 결과가 범위 밖(묶인 숲)
//   이면 null → 호출자가 비워프(crisp) 폴백. 월드 좌표라 팬 불변.
export function warpedGroundKind(ctx, u, v, amp) {
  const f = 0.34; // 노이즈 주파수(타일당). 낮을수록 큰 굽이.
  const nx = (fbm(u * f, v * f, 0) - 0.5) * 2 * amp;
  const ny = (fbm(u * f, v * f, 97.3) - 0.5) * 2 * amp;
  const gx = Math.round((u + nx) / 3), gy = Math.round((v + ny) / 3);
  return groundKindCell(ctx, gx, gy);
}

// 거리 기반 디더 분류(전 경계 일관 — 풀↔흙·바위·숲·닫힘). warpedGroundKind 의 워프점에 블록별 고른
//   지터를 더해 분류 → 경계 가까운 블록은 지터가 종류를 넘나들어 두 종류가 도트로 50:50 섞이고(디더),
//   먼 블록은 지터가 경계에 못 닿아 순수. 지터 폭(dith)이 디더 띠 폭.
//   월드 좌표 시드(vhash u,v)라 팬 불변·정수·안티앨리어싱 0. amp=노이즈 굽이, dith=디더 띠 폭(타일).
export function ditheredGroundKind(ctx, u, v, amp, dith) {
  const f = 0.34;
  const nx = (fbm(u * f, v * f, 0) - 0.5) * 2 * amp;
  const ny = (fbm(u * f, v * f, 97.3) - 0.5) * 2 * amp;
  // 블록별 디더 지터(월드 좌표 해시·2축 탈상관). 경계 근처에서만 분류를 뒤집어 도트 섞임.
  const jx = (vhash((u * 8) | 0, (v * 8) | 0) - 0.5) * dith;
  const jy = (vhash((v * 8) | 0, ((u * 8) | 0) ^ 0x5bd1e995) - 0.5) * dith;
  const gx = Math.round((u + nx + jx) / 3), gy = Math.round((v + ny + jy) / 3);
  return groundKindCell(ctx, gx, gy);
}

// 바닥 종류 → 베이스 색(3색 변주 인덱스 vv). closed·forest=PAST 풀톤.
export function groundBaseColor(kind, vv) {
  if (kind === "grass") return PAL.grassA;
  // 활성불가 바위("rock") 종류 폐기 — groundKindCell 이 더는 "rock" 을 반환하지 않는다.
  // forest·closed 동일 PAST 풀톤(둘 다 묶인/그 달 영역 초록 — 시각 동일 톤).
  if (kind === "closed" || kind === "forest") return vv === 0 ? PAL_PAST.grassA : vv === 1 ? PAL_PAST.grassBlade2 : PAL_PAST.grassBlade1;
  return vv === 0 ? PAL.pendDirtA : vv === 1 ? PAL.pendDirtB : PAL.pendDirtC; // dirt
}

// 차단 칸 종류 태그("closed:ym"). blocked Map 은 닫힘만 담는다. 없으면 null.
export function blockedKind(ctx, tx, ty) {
  if (!ctx.blocked || ctx.blocked.size === 0) return null;
  const k = Math.round(tx / 3) + "," + Math.round(ty / 3);
  if (ctx.blocked instanceof Map) return ctx.blocked.get(k) || null;
  return null;
}

// 차단 칸 여부(종류 무관). 기존 _drawGroundAndObjects 분기 호환.
export function isBlockedTile(ctx, tx, ty) {
  return blockedKind(ctx, tx, ty) != null;
}

// 전이대 결 텍스처: 경계 타일에 노이즈 따라 풀잎/흙/닫힘 질감 점을 흩뿌린다(베이스와 같은 디더 분류).
export function drawTransitionDetail(ctx, b, sx, sy, tx, ty, amp, dith) {
  const x0 = sx | 0, y0 = sy | 0;
  // 전이대는 grass/dirt/closed/forest 만(활성불가 바위 종류 폐기).
  let seed = (((tx * 374761393) ^ (ty * 668265263)) >>> 0) ^ 0x40a0b0c0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const n = 6 + ((rnd() * 5) | 0); // 결 점 수(풀결 5~8 + 흙얼룩/잡초 수준 합쳐 약간 더)
  for (let i = 0; i < n; i++) {
    const px = (x0 + 1 + rnd() * (TILE - 2)) | 0;
    const py = (y0 + 2 + rnd() * (TILE - 4)) | 0;
    // 이 점의 월드 타일좌표 → 디더 분류(베이스와 같은 식). 범위 밖(묶인 숲)이면 타일 기본 종류.
    const u = tx + (px - x0) / TILE;
    const v = ty + (py - y0) / TILE;
    let kind = ditheredGroundKind(ctx, u, v, amp, dith || 0) || groundKind(ctx, tx, ty);
    const r = rnd();
    if (kind === "grass") {
      if (r < 0.16) { b.fillStyle = PAL.grassSpeck; b.fillRect(px, py, 1, 1); }
      else { b.fillStyle = r < 0.6 ? PAL.grassBlade2 : PAL.grassBlade1; b.fillRect(px, py, 1, rnd() < 0.5 ? 1 : 2); }
    } else if (kind === "closed" || kind === "forest") {
      // 닫힘·묶인 숲 질감: PAST 풀잎 결 + 이끼 점(_drawClosedGround·_drawForestFloor 결 통일).
      if (r < 0.3) { b.fillStyle = PAL.rockMoss; b.fillRect(px, py, rnd() < 0.3 ? 2 : 1, 1); }
      else { b.fillStyle = r < 0.65 ? PAL_PAST.grassBlade2 : PAL_PAST.grassBlade1; b.fillRect(px, py, 1, rnd() < 0.5 ? 1 : 2); }
    } else {
      // 흙: 얼룩 점 또는 잡초 가닥(드물게).
      if (r < 0.7) { b.fillStyle = rnd() < 0.5 ? PAL.pendDirtSpeck1 : PAL.pendDirtSpeck2; b.fillRect(px, py, rnd() < 0.3 ? 2 : 1, 1); }
      else { b.fillStyle = rnd() < 0.5 ? PAL.pendWeed1 : PAL.pendWeed2; b.fillRect(px, py, 1, 2 + ((rnd() * 2) | 0)); }
    }
  }
}
