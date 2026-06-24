// 메트릭 → 시각 파라미터 매핑.
//
// 모든 토큰 매핑은 로그 스케일을 쓴다. 토큰은 하루 수십만~수백만까지
// 폭발하므로 선형 매핑하면 큰 값에서 나무가 화면 밖으로 나간다.
//   norm = log10(1 + v) / log10(1 + REF)   (0~1 로 클램프)

// REF = "이 값이면 시각 요소가 거의 최대(norm≈1)" 가 되는 로그 분모 기준선.
//   셀별 절대 강도를 날짜 간 비교 가능하게 유지하려고 고정 상수를 쓴다(관측 상위권 기준).
export const REF = {
  input: 300_000, // 하루 input 상위권 ~30만
  output: 120_000, // output 은 input 보다 작게 나오는 경향
  cacheWrite: 800_000, // cache_creation 은 크게 튄다
  cacheRead: 5_000_000, // cache_read 가 가장 크게 폭발 (메인 재화)
  requestCount: 400, // 하루 assistant 메시지 수 상위권
};

/**
 * 로그 정규화. 음수/NaN 은 0 으로 클램프.
 * @param {number} value 원시 메트릭 값
 * @param {number} ref 로그 분모 기준값
 * @returns {number} 0~1 로 클램프된 정규화 강도
 */
export function logNorm(value, ref) {
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  const n = Math.log10(1 + v) / Math.log10(1 + ref);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// 식생 단계. 빈땅 → 묘목(1×1) → 유목(2×2) → 성목(3×3).
export const STAGE = {
  EMPTY: 0, // 빈땅 (흙 타일만)
  SAPLING: 1, // 묘목 1×1
  YOUNG: 2, // 유목 2×2
  MATURE: 3, // 성목 3×3
};

// 서버의 문자열 stage → 내부 숫자 STAGE. 단계는 서버가 확정 시점에 정하고,
// 클라는 재계산하지 않고 그대로 받는다(과거 나무 안정화).
const STAGE_FROM_STR = {
  empty: STAGE.EMPTY,
  sapling: STAGE.SAPLING,
  young: STAGE.YOUNG,
  mature: STAGE.MATURE,
};

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 메트릭별 정규화 분모 결정. 서버 refMax(영속 관측 최대치)가 있으면 그 값, 없으면 상수 REF 폴백.
 * @param {Object|null} refMax 메트릭 키별 관측 최대치 맵
 * @param {string} key 메트릭 키(input|output|cacheWrite|cacheRead|requestCount)
 * @returns {number} 분모로 쓸 기준값
 */
function refFor(refMax, key) {
  const v = refMax && Number.isFinite(refMax[key]) && refMax[key] > 0 ? refMax[key] : null;
  return v != null ? v : REF[key];
}

/**
 * day 원소 1개 → 그 셀의 모든 시각 파라미터로 변환(순수 함수).
 *   sim/norms/sap/ground 는 day.usage 로 재생성(가지 좌표는 클라가 결정).
 *   stage/stageProgress/pct(xp)/species 는 day.tree 를 그대로 받는다 — 서버가 확정 시점에 정함.
 *   클라가 cap 으로 재계산하지 않는다(과거 나무가 cap 변동으로 흔들리는 것 방지).
 * @param {Object} day { date, active, grid{gx,gy}, usage{5메트릭}, tree{stage,xp,stageProgress,seed,species}, finalized }
 * @param {number} [dailyCapTokens=0] xp 분모(전체 pct 표시용, 단계 판정 아님)
 * @param {Object|null} [refMax=null] 메트릭별 관측 최대치 맵(없으면 상수 REF 폴백)
 * @returns {Object} 셀 렌더·툴팁이 읽는 파라미터 묶음
 */
export function forestCellParams(day, dailyCapTokens = 0, refMax = null) {
  const u = (day && day.usage) || {};
  // 음수/NaN 방어는 logNorm 내부 0 클램프. 분모는 refMax 우선·상수 폴백.
  const inputN = logNorm(u.inputTokens, refFor(refMax, "input"));
  const outputN = logNorm(u.outputTokens, refFor(refMax, "output"));
  const cacheWriteN = logNorm(u.cacheWriteTokens, refFor(refMax, "cacheWrite"));
  const cacheReadN = logNorm(u.cacheReadTokens, refFor(refMax, "cacheRead"));
  const requestN = logNorm(u.requestCount, refFor(refMax, "requestCount"));

  // 상세 패널 전용 선형 비중(raw/refMax, 0~1 클램프) = "역대 최대 사용량 대비 실제 비율".
  //   norms(logNorm) 와 별개 — 나무·식생 렌더는 norms 를 쓰고, 이 값은 상세 표시만. log 가 큰 값을
  //   80~95% 로 몰아 오해 주던 것을 선형으로 보여 해소.
  const linNorm = (v, key) => clamp01(num(v) / refFor(refMax, key));
  const linPct = {
    inputN: linNorm(u.inputTokens, "input"),
    outputN: linNorm(u.outputTokens, "output"),
    cacheWriteN: linNorm(u.cacheWriteTokens, "cacheWrite"),
    cacheReadN: linNorm(u.cacheReadTokens, "cacheRead"),
    requestN: linNorm(u.requestCount, "requestCount"),
  };

  const tree = (day && day.tree) || {};
  // stage: 서버 문자열(empty|sapling|young|mature) → 숫자. 모르는 값은 빈땅.
  const stage = STAGE_FROM_STR[tree.stage] ?? STAGE.EMPTY;
  const stageProgress = clamp01(tree.stageProgress);
  // 전체 pct(표시용): xp(=totalTokens) / cap. cap 없으면 0.
  const xp = num(tree.xp);
  const cap = Number.isFinite(dailyCapTokens) && dailyCapTokens > 0 ? dailyCapTokens : 0;
  const pct = cap > 0 ? xp / cap : 0;
  // 형태 재생성 시드. 서버가 주면 그걸, 없으면 날짜로 폴백(둘 다 날짜라 동일).
  const seed = tree.seed || day.date;
  // 수종(데이터값). 서버가 0~4 로 영속(동결). 없으면 null → renderer 가 speciesFor(seed) 폴백.
  const species = Number.isFinite(tree.species) ? (tree.species | 0) : null;

  return {
    date: day.date,
    seed,
    species,
    active: !!day.active,
    finalized: !!day.finalized,
    grid: day.grid && Number.isFinite(day.grid.gx) ? { gx: day.grid.gx, gy: day.grid.gy } : null,
    stage,
    pct, // 0~1+ (전체 진행, 표시 클램프는 UI 에서)
    stageProgress, // 현재 단계 진행 0~1 (XP 바, 서버값)
    xp,
    norms: { inputN, outputN, cacheWriteN, cacheReadN, requestN },
    // 상세 패널 선형 비중(역대 최대 대비). norms 와 별개 — 표시 전용(렌더 매핑은 norms 사용).
    linPct,
    // --- raw 일일 실값 (호버 툴팁/클릭 상세용). 서버 usage 그대로. ---
    raw: {
      input: num(u.inputTokens),
      output: num(u.outputTokens),
      cacheWrite: num(u.cacheWriteTokens),
      cacheRead: num(u.cacheReadTokens),
      requests: num(u.requestCount),
    },
    // --- 시뮬레이션이 읽는 파라미터 ---
    // 단위는 "셀 풋프린트(48×24px) 안에 들어가는 시뮬 픽셀". 저해상도 백버퍼라
    // 나무 한 그루는 ~25~60px 높이, 가지 수백 개 이하로 묶는다(12k 라인 폭주 방지).
    sim: {
      // input → 기둥 높이 + 분기량(리소스 수)
      maxHeight: 22 + inputN * 42, // 시뮬 단위 픽셀 (최대 ~64)
      resourceCount: Math.round(8 + inputN * 34), // 최대 ~42 (셀이 작아 적게)
      // output → 잎 덩어리 크기·개수
      leafSize: 0.8 + outputN * 2.0,
      leafCount: Math.round(2 + outputN * 4),
      // cache_write → 기둥 두께 (Pipe Model base thickness)
      baseThickness: 0.6 + cacheWriteN * 1.8,
      // 형태 다양성: 그날 강도로 분포 선택 (고정 5수종 아님)
      distribution: pickDistribution(u),
      lightSensitivity: 0.35 + outputN * 0.25,
    },
    // --- 파티클(황금 수액)이 읽는 파라미터 ---
    sap: {
      density: cacheReadN, // 0~1, 속도·Glow 로 환산 (개수 아님)
    },
    // --- 발치 생태계(잔디·꽃) ---
    ground: {
      density: requestN, // 0~1
    },
  };
}

/**
 * 형태 다양성: 메트릭 비율로 분포 타입 선택.
 *   output/input 비율이 높으면 잎 위주(spreading), 낮으면 위로 뻗음(upward),
 *   cache_read 가 압도적이면 늘어짐(weeping) 으로 변주.
 *
 *   ★ 비율(치우침) 기준이지 절대량 기준이 아니다. cacheRead 는 절대량으로 늘 input·output 을
 *   압도(보통 95%+)하므로 절대량으로 분류하면 매일 "캐시 많은 날"이 되어 의미가 없다.
 *   그래서 readRatio = cacheRead/input 처럼 그날 안의 비율로만 판정한다.
 * @param {Object} u usage(5메트릭)
 * @returns {string} "weeping"|"spreading"|"upward"|"uniform"
 */
export function pickDistribution(u) {
  const input = Math.max(1, (u && u.inputTokens) || 0);
  const output = Math.max(0, (u && u.outputTokens) || 0);
  const cacheRead = Math.max(0, (u && u.cacheReadTokens) || 0);
  const outRatio = output / input;
  const readRatio = cacheRead / input;

  if (readRatio > 12) return "weeping"; // 캐시 재사용이 압도적
  if (outRatio > 0.6) return "spreading"; // 출력 풍부 → 넓게 퍼짐
  if (outRatio < 0.25) return "upward"; // 출력 적음 → 위로 집중
  return "uniform";
}

// 상세 모달 평균 대비 표식이 쓰는 5메트릭 키. cellInfo.raw 와 동일 키(input|output|cacheWrite|cacheRead|requests).
const METRIC_KEYS = ["input", "output", "cacheWrite", "cacheRead", "requests"];

/**
 * 활성일들의 5메트릭 산술평균(순수 함수). 상세 모달의 "평균 대비 ▲▼" 모수.
 *   - EMPTY(나무 없는 빈 대지)·totalTokens 0(사용 없는 날)은 평균에서 제외 — 빈 날을 넣으면 평균이 0 쪽으로 왜곡된다.
 *   - cellList 는 forestCellParams 결과 배열(date 오름차순). 각 원소의 raw{input,...} 와 stage 를 읽는다.
 *   - totalTokens = 토큰 4종 합(요청 수 제외) — cellInfo 의 판정과 동일 기준.
 * @param {object[]} cellList forestCellParams 결과 배열(없으면 빈 배열 취급)
 * @returns {{input:number,output:number,cacheWrite:number,cacheRead:number,requests:number,count:number}}
 *          메트릭별 평균과 모수에 든 활성일 수 count. count 0 이면 전부 0.
 */
export function metricAverages(cellList) {
  const sum = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0 };
  let count = 0;
  for (const c of cellList || []) {
    const p = (c && c.params) || c || {};
    const raw = p.raw || {};
    if (p.stage === STAGE.EMPTY) continue; // 빈 대지 제외
    const totalTokens =
      num(raw.input) + num(raw.output) + num(raw.cacheWrite) + num(raw.cacheRead);
    if (totalTokens <= 0) continue; // 사용 없는 날 제외
    sum.input += num(raw.input);
    sum.output += num(raw.output);
    sum.cacheWrite += num(raw.cacheWrite);
    sum.cacheRead += num(raw.cacheRead);
    sum.requests += num(raw.requests);
    count++;
  }
  const avg = { count };
  for (const k of METRIC_KEYS) avg[k] = count > 0 ? sum[k] / count : 0;
  return avg;
}

/**
 * 그날 값이 전체 평균보다 위/아래인지(순수 함수). 평균 모수가 비었거나 값이 같으면 "eq".
 * @param {number} value 그날 메트릭 raw 값
 * @param {number} avg metricAverages 가 준 해당 메트릭 평균
 * @returns {"up"|"down"|"eq"} value>avg → "up", value<avg → "down", 같거나 비교 불가 → "eq"
 */
export function compareToAvg(value, avg) {
  const v = num(value), a = Number.isFinite(avg) ? avg : 0;
  if (a <= 0) return "eq"; // 모수 없음(count 0 등)이면 표식 미표시
  if (v > a) return "up";
  if (v < a) return "down";
  return "eq";
}

/**
 * 평균 대비 방향 + 정도(삼각형 1~3개)를 산출(순수 함수). 상세 모달의 침엽수 뱃지가 읽는다.
 *   - 상승률 = (value - avg) / avg, 하락률 = (avg - value) / avg. 경계는 상승·하락 동일.
 *   - 33% 미만 → 1개, 66% 미만 → 2개, 66% 이상 → 3개. eq/모수없음 → level 0(뱃지 없음).
 * @param {number} value 그날 메트릭 raw 값
 * @param {number} avg metricAverages 가 준 해당 메트릭 평균
 * @returns {{dir:"up"|"down"|"eq", level:0|1|2|3}} dir=방향, level=삼각형 개수(eq 면 0)
 */
export function avgBadge(value, avg) {
  const dir = compareToAvg(value, avg);
  if (dir === "eq") return { dir, level: 0 };
  const v = num(value), a = avg; // dir!=="eq" 이면 compareToAvg 에서 a>0 보장
  const rate = (dir === "up" ? v - a : a - v) / a; // 상승률/하락률 (양수)
  const level = rate < 0.33 ? 1 : rate < 0.66 ? 2 : 3;
  return { dir, level };
}
