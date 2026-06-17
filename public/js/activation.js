import { inMapBounds, MAP_GX0, MAP_GX1, MAP_GY0, MAP_GY1 } from "./grid.js";
import { ymd } from "./seed.js";

// 활성화 후보 계산. 순수 함수(localStorage 없음).
//
// 배치·상태는 백엔드 소유. 클라는 "심을 날이 남았나", "후보 빈칸은 어디인가" 만
// 응답 스냅샷(placementMap + startDate)에서 계산하고, 선택→확인 후 POST /api/grid/activate 한다.
//
// 점유 그리드 1개 이상이면 마지막 활성 그리드 기준 8방향 빈칸을 후보로(이미 활성인 칸 제외).
// 콜드 스타트(점유 0개)면 8방향 인접 제약 면제 — 화면 빈 칸 아무 데나 자유 선택(첫 위치는 사용자 클릭).
//
// placementMap = { "YYYY-MM-DD": {gx,gy} } (active 인 날만, state.consumeDays 산출).

const DIRS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

// 로컬 오늘 "YYYY-MM-DD".
export function todayYMD() {
  return ymd(new Date());
}

// 점유 좌표 Set("gx,gy"). placementMap 의 모든 active 그리드.
function occupiedSet(placementMap) {
  const s = new Set();
  for (const date in placementMap) {
    const p = placementMap[date];
    if (p && Number.isFinite(p.gx)) s.add(p.gx + "," + p.gy);
  }
  return s;
}

// 콜드 스타트 = 점유 그리드 0개. 첫 그리드는 자유 선택, 8방향 제약 면제.
export function isColdStart(placementMap) {
  return occupiedSet(placementMap).size === 0;
}

// 상하좌우 4방향(닫힘 판정 — 대각은 트인 걸로 친다).
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// "gx,gy" → ym 역참조(점유 칸이 어느 달인가). 닫힘 영역을 둘러싼 달 톤(렌더)·태그용.
function occupiedYmMap(placementMap) {
  const m = new Map();
  for (const date in placementMap) {
    const p = placementMap[date];
    if (p && Number.isFinite(p.gx)) m.set(p.gx + "," + p.gy, date.slice(0, 7));
  }
  return m;
}

/**
 * 닫힘 태그("closed:M1,M2,…")에서 둘러싼 달 집합 파싱.
 * @param {string} tag 차단 태그
 * @returns {Set<string>|null} 둘러싼 달 집합. 닫힘 아니면 null. "closed:"(달 없음)이면 빈 집합(어느 달도 불가)
 */
export function closedMonths(tag) {
  if (typeof tag !== "string" || !tag.startsWith("closed:")) return null;
  const body = tag.slice(7); // "M1,M2" | ""
  return new Set(body ? body.split(",").filter(Boolean) : []);
}

/**
 * (gx,gy) 칸에 month 달을 심을 수 있나(차단 집합 기준).
 *   blocked 는 닫힘("closed:…")만 담는다. 닫힘이면 그 달 집합에 month 가 있을 때만 허용(그 달 땅이므로).
 * @param {Map|Set|null} blocked 차단 집합(Map: "gx,gy"→tag)
 * @param {number} gx
 * @param {number} gy
 * @param {string} month 심으려는 달("YYYY-MM")
 * @returns {boolean} 심을 수 있으면 true
 */
function canPlantMonthAt(blocked, gx, gy, month) {
  if (!blocked) return true;
  const tag = blocked instanceof Map ? blocked.get(gx + "," + gy) : null;
  if (!tag) return true; // 차단 아님(닫힘 아님)
  const months = closedMonths(tag); // 닫힘
  if (!months) return false; // 알 수 없는 태그 — 안전하게 거부
  return month != null && months.has(month); // 그 달이면 허용
}

/**
 * 차단 집합(단일 진실 소스) = "다른 달은 못 심는 빈칸" 집합. candidateSlots·isAcceptableSlot·
 *   렌더(달 톤)가 이 한 집합을 참조한다. 비용은 후보 계산 시 1회(매 프레임 금지).
 *
 *   닫힘만 담는다(숲 바깥 인접 칸은 차단 안 함 — 바로 옆에 심기 허용). 닫힘 = 빈칸을 4방향으로
 *   이어(flood-fill) 트인 땅/맵 가장자리에 못 닿는 영역. 그 영역은 둘러싼 달 땅이라 다른 달은 못 심음.
 *   둘러싼 경계 점유 셀의 ym 중 가장 많이 닿은 달을 대표 톤으로(여러 달이면 다수결, 없으면 회청 폴백).
 *   여러 달이 둘러싸면 어느 한 달도 완전 포위 못 함(활로) → 그 달들 전부 허용. 대각은 트임.
 *
 *   반환 태그 "closed:M1,M2,…": 그 달들만 심을 수 있다. 렌더는 "closed:" 접두만 보고 닫힘으로 그리고,
 *   허용 판정은 closedMonths(tag) 집합에 심을 달이 있는지 본다.
 * @param {Object} placementMap { "YYYY-MM-DD": {gx,gy} }
 * @param {*} forestsMap 호환용(미사용)
 * @param {*} drilldownMonth 호환용(미사용)
 * @returns {Map<string,string>} "gx,gy" → "closed:…" 태그
 */
export function blockedSet(placementMap, forestsMap, drilldownMonth) {
  const occ = occupiedSet(placementMap);
  const occYm = occupiedYmMap(placementMap);
  const blocked = new Map(); // "gx,gy" → "closed:YYYY-MM"

  // ② 닫힘: 빈칸을 4방향 flood-fill 해 맵 가장자리에 닿으면 "트임", 못 닿으면 "닫힘".
  //   맵 전체(100×40=4000칸)를 다 훑지 않고, 점유칸의 4방향 빈칸에서만 BFS 를 시작한다
  //   (구멍·주머니는 항상 점유칸에 인접). 가장자리 칸은 항상 트임(맵 밖 = 트인 땅).
  const visited = new Set(); // 이미 판정된 빈칸(트임/닫힘 무관)
  const atEdge = (gx, gy) =>
    gx === MAP_GX0 || gx === MAP_GX1 || gy === MAP_GY0 || gy === MAP_GY1;
  const seeds = new Set();
  for (const key of occ) {
    const [gx, gy] = key.split(",").map(Number);
    for (const [dx, dy] of DIRS4) {
      const nx = gx + dx, ny = gy + dy;
      if (inMapBounds(nx, ny) && !occ.has(nx + "," + ny)) seeds.add(nx + "," + ny);
    }
  }
  for (const seed of seeds) {
    if (visited.has(seed)) continue;
    // seed 가 속한 빈칸 영역을 BFS 로 모은다. 가장자리에 닿으면 open. 경계 점유 셀의 ym 집계.
    const region = [];
    const queue = [seed];
    const inQueue = new Set([seed]);
    let open = false;
    let guard = 0;
    const ymCount = new Map(); // 둘러싼 달 → 닿은 횟수(다수결로 영역 톤 결정)
    while (queue.length && guard < 4001) {
      guard++;
      const cur = queue.shift();
      const [cx, cy] = cur.split(",").map(Number);
      region.push(cur);
      if (atEdge(cx, cy)) open = true; // 맵 가장자리 = 트인 땅
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx, ny = cy + dy;
        if (!inMapBounds(nx, ny)) { open = true; continue; } // 맵 밖 = 트임
        const k = nx + "," + ny;
        if (occ.has(k)) {
          // 경계 점유 셀의 달 집계(닫힘 영역을 둘러싼 달 톤).
          const ym = occYm.get(k);
          if (ym) ymCount.set(ym, (ymCount.get(ym) || 0) + 1);
          continue;
        }
        if (inQueue.has(k)) continue;
        inQueue.add(k);
        queue.push(k);
      }
    }
    // 둘러싼 달 전부(중복 제거). 대표 톤 = 다수결 달(첫 항목), 나머지는 사전순 — 둘 다 허용.
    let topYm = "", topN = -1;
    for (const [ym, n] of ymCount) {
      if (n > topN || (n === topN && ym < topYm)) { topYm = ym; topN = n; }
    }
    // 태그 = "closed:" + [대표달, …나머지 사전순]. 대표달이 없으면(회청 폴백) "closed:".
    const rest = [...ymCount.keys()].filter((ym) => ym !== topYm).sort();
    const months = topYm ? [topYm, ...rest] : [];
    const tag = "closed:" + months.join(",");
    for (const k of region) {
      visited.add(k);
      if (open) continue; // 트인 땅/가장자리에 닿음 → 닫힘 아님
      blocked.set(k, tag); // 닫힘 + 둘러싼 달 집합
    }
  }

  return blocked; // 닫힘(위 flood-fill)만 담는다.
}

/**
 * 다음에 심을(활성화할) 날 = [startDate, 오늘] 범위에서 placementMap 에 없는 가장 오래된 날.
 *   콜드 스타트면 startDate 가 먼저, 그 다음 날들 순서. "오늘만 활성화" 가정은 없다.
 * @param {Object} placementMap 배치된 날 맵
 * @param {string|null} startDate 시작일("YYYY-MM-DD")
 * @param {string[]} [knownDates] 서버가 아는 날짜 키(startDate 비어도 가장 이른 날 보강)
 * @returns {string|null} 심을 가장 오래된 날, 없으면 null
 */
export function oldestPendingDate(placementMap, startDate, knownDates) {
  const today = todayYMD();
  // 시작 기준일 = startDate 와 서버가 아는 가장 이른 날 중 더 이른 것(startDate 우선·없으면 보강).
  let from = startDate || null;
  if (Array.isArray(knownDates) && knownDates.length) {
    let earliest = null;
    for (const d of knownDates) if (d && (earliest == null || d < earliest)) earliest = d;
    if (earliest && (!from || earliest < from)) from = earliest;
  }
  if (!from) {
    // 시작일 정보가 전혀 없음(서버 빈 응답·오프라인): 오늘을 폴백 대상으로(최후 수단).
    return placementMap[today] ? null : today;
  }
  if (today < from) return null; // 아직 시작 전
  let cursor = from;
  let guard = 0;
  while (cursor <= today && guard < 800) {
    if (!placementMap[cursor]) return cursor; // 가장 오래된 미배치 날
    cursor = nextYMD(cursor);
    guard++;
  }
  return null;
}

// 심을 날이 남았나(활성화 UI 표시 여부).
export function hasPending(placementMap, startDate, knownDates) {
  return oldestPendingDate(placementMap, startDate, knownDates) !== null;
}

/**
 * 후보 빈칸 좌표 목록 = 마지막 활성 그리드(가장 최근 심은 칸) 8방향. 점유 1개 이상일 때만.
 *   콜드 스타트(점유 0개)는 자유 선택이라 후보가 없다 → 빈 배열. 8방향이 닫힘/맵 경계로 0개여도 [].
 *   닫힘은 심을 달(pendingMonth)이 허용 집합에 있으면 포함.
 * @param {Object} placementMap 배치된 날 맵
 * @param {string|null} startDate 시작일(미사용 호환 인자)
 * @param {Map|Set} blocked 차단 집합
 * @param {string} pendingMonth 지금 심으려는 날의 달("YYYY-MM")
 * @param {{gx,gy}|null} anchorGrid 마지막 활성 그리드. 없으면 placementMap 최근 date 좌표 폴백
 * @returns {Array<{gx:number,gy:number}>} 후보 좌표 목록
 */
export function candidateSlots(placementMap, startDate, blocked, pendingMonth, anchorGrid) {
  const occ = occupiedSet(placementMap);
  if (occ.size === 0) return []; // 콜드 스타트: 화면 빈 칸 아무 데나(자유 선택, 사전 강조 없음)
  const blk = blocked || new Set();
  const out = [];
  const seen = new Set();
  const addNeighbors = (gx, gy) => {
    for (const [dx, dy] of DIRS) {
      const nx = gx + dx, ny = gy + dy;
      // 8방향 후보 ∩ 맵 범위. 경계에 닿으면 그 방향 후보는 빠진다.
      if (!inMapBounds(nx, ny)) continue;
      const k = nx + "," + ny;
      if (occ.has(k) || seen.has(k)) continue;
      // 닫힘 칸은 심을 달이 허용 집합에 있을 때만 후보 포함.
      if (!canPlantMonthAt(blk, nx, ny, pendingMonth)) continue;
      seen.add(k);
      out.push({ gx: nx, gy: ny });
    }
  };
  // 앵커 = 마지막 활성 그리드. main 이 anchorGrid 를 주면 그걸, 없으면 placementMap 최근 date 좌표.
  const anchor = anchorGrid && Number.isFinite(anchorGrid.gx)
    ? anchorGrid
    : latestPlacement(placementMap);
  if (anchor && Number.isFinite(anchor.gx)) addNeighbors(anchor.gx, anchor.gy);
  return out;
}

// placementMap 에서 가장 최근 date 의 좌표(폴백 앵커 — main 이 anchorGrid 안 줄 때). bundled 구분 없음.
function latestPlacement(placementMap) {
  let bestDate = null, best = null;
  for (const date in placementMap) {
    const p = placementMap[date];
    if (!p || !Number.isFinite(p.gx)) continue;
    if (bestDate == null || date > bestDate) { bestDate = date; best = p; }
  }
  return best;
}

/**
 * (gx,gy)가 활성화 가능한 칸인가.
 *   콜드 스타트(점유 0개): 점유 안 된 칸이면 아무 칸이나 가능(자유 선택).
 *   점유 1개 이상: candidateSlots(8방향) 안에 있어야 함. 비인접 칸은 불가.
 *   닫힘은 pendingMonth 가 그 칸 허용 달 집합에 있으면 허용(자유 선택 폴백 시에도 다른 달 닫힘은 거부).
 * @param {Object} placementMap 배치된 날 맵
 * @param {Array<{gx,gy}>} candidates 후보 목록
 * @param {number} gx
 * @param {number} gy
 * @param {Map|Set} blocked 차단 집합
 * @param {string} pendingMonth 지금 심으려는 날의 달("YYYY-MM")
 * @returns {boolean} 활성화 가능하면 true
 */
export function isAcceptableSlot(placementMap, candidates, gx, gy, blocked, pendingMonth) {
  if (!inMapBounds(gx, gy)) return false; // 맵 범위 밖이면 불가(콜드 스타트 첫 칸도 범위 안만)
  const occ = occupiedSet(placementMap);
  const k = gx + "," + gy;
  if (occ.has(k)) return false; // 이미 점유 — 불가
  const blk = blocked || new Set();
  // 닫힘 칸은 심을 달이 허용 집합에 있을 때만 허용.
  if (!canPlantMonthAt(blk, gx, gy, pendingMonth)) return false;
  if (occ.size === 0) return true; // 콜드 스타트 자유 선택(범위 안)
  // 후보 0개 폴백: 8방향 후보가 전부 막혀 candidates 가 비면(도넛 가운데 갇힘) 자유 선택.
  if (!candidates || candidates.length === 0) return true;
  return candidates.some((c) => c.gx === gx && c.gy === gy);
}

// (gx,gy)가 후보 목록에 있나(강조용).
export function isCandidate(candidates, gx, gy) {
  return candidates.some((c) => c.gx === gx && c.gy === gy);
}

// "YYYY-MM-DD" → 하루 후 "YYYY-MM-DD".
function nextYMD(ymd) {
  const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
