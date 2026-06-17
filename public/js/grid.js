// 논리 격자 grid[x][y] + 정사각 타일 탑다운 배치.
//
// 정사각형 타일 그리드를 살짝 위에서 본 탑다운(다이아몬드/대각 변환 없음).
// 1 그리드 = 3×3 = 9 타일, 하루 = 1 그리드. 인접 그리드는 3 타일 간격이라
// 그리드 좌표(gx,gy)는 화면에서 GRID(=3*TILE) 간격으로 매핑한다.

// 정사각 타일 한 변(백버퍼 픽셀). 나무가 footprint 를 채우도록 작게.
export const TILE = 18;
// 그리드(셀) 1칸 = 3×3 타일. 그리드 간 화면 간격.
export const GRID = 3 * TILE; // 54px

// 경계 있는 고정 맵: 100×40 그리드, 좌상단 원점. 유효 좌표 gx∈[0,99], gy∈[0,39](음수 없음).
//   월드 px = 100*GRID × 40*GRID = 5400×2160(GRID=54).
//   이 4개 상수가 배치(activation)·카메라(renderer)·커서 가드의 단일 진실 소스.
export const MAP_GX0 = 0;
export const MAP_GX1 = 99;
export const MAP_GY0 = 0;
export const MAP_GY1 = 39;

/**
 * (gx,gy)가 맵 범위 안인가.
 * @param {number} gx
 * @param {number} gy
 * @returns {boolean} 유효 좌표면 true
 */
export function inMapBounds(gx, gy) {
  return (
    Number.isFinite(gx) && Number.isFinite(gy) &&
    gx >= MAP_GX0 && gx <= MAP_GX1 && gy >= MAP_GY0 && gy <= MAP_GY1
  );
}

/**
 * 배치는 백엔드 소유. placementMap(active 인 날만)에 따라 셀을 배치한다.
 *   placementMap 에 없는 날(대기/미활성)은 건너뛴다. 최신 배치 날(가장 늦은 date)이 활성.
 * @param {Array<Object>} cellParamsList forestCellParams 결과 목록(각 .date 보유)
 * @param {Object} placementMap { "YYYY-MM-DD": {gx,gy} }
 * @returns {Array<{gx,gy,params,isActive,dayIndexFromNewest}>} 배치된 셀 목록
 */
export function layoutByPlacements(cellParamsList, placementMap) {
  // 최신 날(활성) 판정용 — 배치된 날들 중 가장 늦은 date.
  let activeDate = null;
  for (const c of cellParamsList) {
    if (placementMap[c.date] && (activeDate == null || c.date > activeDate)) activeDate = c.date;
  }
  const placed = [];
  for (const params of cellParamsList) {
    const p = placementMap[params.date];
    if (!p) continue; // 배치 안 된 날 skip
    placed.push({
      gx: p.gx,
      gy: p.gy,
      params,
      isActive: params.date === activeDate,
      dayIndexFromNewest: 0,
    });
  }
  return placed;
}

/**
 * 그리드 좌표 → 화면(백버퍼) 좌표. 정사각, 대각 변환 없음. GRID 간격으로 매핑.
 *   (gx,gy)는 그리드 중심 기준.
 * @param {number} gx
 * @param {number} gy
 * @param {number} originX (0,0) 그리드 중심의 화면 x
 * @param {number} originY (0,0) 그리드 중심의 화면 y
 * @returns {{x:number,y:number}} 화면 좌표(정수 반올림)
 */
export function gridToScreen(gx, gy, originX, originY) {
  return {
    x: Math.round(originX + gx * GRID),
    y: Math.round(originY + gy * GRID),
  };
}
