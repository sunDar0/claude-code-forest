// Claude Code Forest — data 레이어.
//
// data/ 디렉토리를 일/월/년 JSON 스키마로 읽고/쓰며, 메모리 작업본을 유지한다.
//   - 부팅: data/ 전체를 메모리에 로드. 없으면 forest.json 생성.
//   - 갱신: 오늘자만 jsonl 재집계 → 메모리 + 오늘 파일 1개만 기록.
//   - 동결: 과거인데 finalized:false 인 날을 finalized:true 로 한 번 박는다.
//   - 계층 집계: monthly·yearly 는 days 에서 재계산.
//   - 활성화(자리 잡기)·숲 묶기.
//
// 표준 라이브러리만 사용(http 는 index.js). 프레임워크 없음.

import { readFile, writeFile, readdir, mkdir, access, rename } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { aggregateForStore, todayLocalYMD, computeTree, REFMAX_SEED, DAILY_MAX_SEED } from './aggregate.js';
import { isPastMonth } from '../public/js/bundle-rule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.FOREST_DATA_DIR || path.join(__dirname, '..', 'data');

// 맵 경계: 100×40 고정 맵, 원점 좌상단, 음수 좌표 없음.
const MAP_GX_MIN = 0;
const MAP_GX_MAX = 99;
const MAP_GY_MIN = 0;
const MAP_GY_MAX = 39;

// ---------------------------------------------------------------------------
// 경로 헬퍼 — 일 파일은 풀네임(YYYY-MM-DD.json), 월 디렉토리 안
// ---------------------------------------------------------------------------
function ymPartsFromDate(date) {
  // date = "YYYY-MM-DD". 방어적으로 split.
  const [y, m] = String(date).split('-');
  return { year: y, month: m };
}
const forestPath = () => path.join(DATA_DIR, 'forest.json');
const yearPath = (year) => path.join(DATA_DIR, String(year), 'year.json');
const monthDirPath = (year, mm) => path.join(DATA_DIR, String(year), mm);
const monthPath = (year, mm) => path.join(monthDirPath(year, mm), 'month.json');
const dayPath = (date) => {
  const { year, month } = ymPartsFromDate(date);
  return path.join(monthDirPath(year, month), `${date}.json`);
};

async function readJson(p) {
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null; // 부재·깨짐 → null (방어적, throw 금지)
  }
}

async function writeJson(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  // 원자적 쓰기: temp 에 쓴 뒤 rename 으로 교체. 쓰는 도중 크래시해도 대상 파일은 항상
  //   온전한 직전 내용이거나 온전한 새 내용 — truncated JSON 으로 깨지지 않는다(같은 디렉토리
  //   rename 은 POSIX 원자적). forest.json(startDate·refMax) 손상 → 콜드 리셋을 막는다.
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, p);
}

// ---------------------------------------------------------------------------
// 메모리 작업본
// ---------------------------------------------------------------------------
// 구조:
//   forest = { startDate, activeYear, stages:[year] }
//   days   = Map<"YYYY-MM-DD", dayObj>
//   months = Map<"YYYY-MM", monthObj>
//   years  = Map<year, yearObj>
//   caps   = { dailyCapTokens, fiveHourPct, sevenDayPct, fiveHourCapTokens, capSource, generatedAt }
const mem = {
  forest: null,
  days: new Map(),
  months: new Map(),
  years: new Map(),
  // 메트릭별 관측 최대(단조 증가). forest.json 메타에 영속. 분모는 클라가 쓴다.
  refMax: { ...REFMAX_SEED },
  // 일일 누적 토큰(usage.totalTokens)의 역대 최대(단조 증가). forest.json 메타에 영속.
  //   computeTree 의 단계 분모 전용 — HUD cap(caps.dailyCapTokens)·식생 refMax 와 별개.
  dailyMaxTokens: DAILY_MAX_SEED,
  caps: {
    dailyCapTokens: 2,
    treeDailyDenom: 2, // 나무 단계 분모(관측 p85×2). computeTree 전용, HUD dailyCapTokens 와 별개.
    fiveHourPct: null,
    sevenDayPct: null,
    fiveHourCapTokens: 1,
    capSource: 'observed',
    generatedAt: new Date().toISOString(),
  },
};

function ym(date) {
  const { year, month } = ymPartsFromDate(date);
  return `${year}-${month}`;
}
function yearOf(date) {
  return Number(ymPartsFromDate(date).year);
}

// ---------------------------------------------------------------------------
// refMax — 메트릭별 관측 최대(단조 증가). forest.json 메타에 영속.
// ---------------------------------------------------------------------------
const REFMAX_KEYS = ['input', 'output', 'cacheWrite', 'cacheRead', 'requestCount'];

// 저장값(forest.refMax) + 시드를 합쳐 모든 키가 채워진 refMax 를 만든다(부분 누락 방어).
function normalizeRefMax(stored) {
  const out = { ...REFMAX_SEED };
  if (stored && typeof stored === 'object') {
    for (const k of REFMAX_KEYS) {
      const v = stored[k];
      if (typeof v === 'number' && isFinite(v) && v > out[k]) out[k] = v;
    }
  }
  return out;
}

// 일 파일 usage 스키마 → refMax 키별 그날 합. (input/output/... 토큰 합, requestCount 는 개수)
function usageToRefMetrics(u) {
  return {
    input: u.inputTokens || 0,
    output: u.outputTokens || 0,
    cacheWrite: u.cacheWriteTokens || 0,
    cacheRead: u.cacheReadTokens || 0,
    requestCount: u.requestCount || 0,
  };
}

// 그날 합이 저장값보다 크면 갱신(단조 증가). 하나라도 갱신됐으면 true.
function bumpRefMax(metrics) {
  let changed = false;
  for (const k of REFMAX_KEYS) {
    const v = metrics[k];
    if (typeof v === 'number' && isFinite(v) && v > mem.refMax[k]) {
      mem.refMax[k] = v;
      changed = true;
    }
  }
  return changed;
}

// 메모리의 모든 날(과거+오늘)을 훑어 refMax 를 끌어올린다. 표본 전체에서 단조 최대.
// (부팅 시 1회 — 기존 일 파일들의 최대치를 refMax 에 반영.)
function bumpRefMaxFromAllDays() {
  let changed = false;
  for (const [, day] of mem.days) {
    if (day && day.usage) {
      if (bumpRefMax(usageToRefMetrics(day.usage))) changed = true;
    }
  }
  return changed;
}

// refMax 갱신을 forest.json 메타에 영속(forest 객체에 묻혀 같이 기록).
async function persistRefMax() {
  if (!mem.forest) return;
  mem.forest.refMax = { ...mem.refMax };
  await writeJson(forestPath(), mem.forest);
}

// ---------------------------------------------------------------------------
// dailyMaxTokens — 일일 누적 토큰(usage.totalTokens)의 역대 최대(단조 증가).
//   refMax 와 완전히 동일한 룰(시드 하한·단조·부팅 전체스캔·폴 bump·forest.json 영속)을
//   단일 스칼라용으로 본뜬다. computeTree 단계 분모 전용 — HUD cap·식생 refMax 와 무관.
// ---------------------------------------------------------------------------
// 저장값(forest.dailyMaxTokens) + 시드 하한을 합쳐 유효한 단조 하한을 만든다(부분 누락 방어).
function normalizeDailyMax(stored) {
  let out = DAILY_MAX_SEED;
  if (typeof stored === 'number' && isFinite(stored) && stored > out) out = stored;
  return out;
}

// 그날 누적(usage 5메트릭 합)이 저장값보다 크면 갱신(단조 증가). 갱신됐으면 true.
//   "그날 누적" = usage.totalTokens(토큰). dailyMaxTokens·treeDailyDenom 참고 노출 전용 —
//   나무 xp 는 이제 5h % 합이라 tree.xp 와 별개(오늘 활성일 한정).
function bumpDailyMax(usageSchema) {
  const total = totalOf(usageSchema);
  if (typeof total === 'number' && isFinite(total) && total > mem.dailyMaxTokens) {
    mem.dailyMaxTokens = total;
    return true;
  }
  return false;
}

// 메모리의 모든 날(과거+오늘)을 훑어 dailyMaxTokens 를 끌어올린다(부팅 1회).
function bumpDailyMaxFromAllDays() {
  let changed = false;
  for (const [, day] of mem.days) {
    if (day && day.usage) {
      if (bumpDailyMax(day.usage)) changed = true;
    }
  }
  return changed;
}

// dailyMaxTokens 갱신을 forest.json 메타에 영속(forest 객체에 묻혀 같이 기록).
async function persistDailyMax() {
  if (!mem.forest) return;
  mem.forest.dailyMaxTokens = mem.dailyMaxTokens;
  await writeJson(forestPath(), mem.forest);
}

// ---------------------------------------------------------------------------
// 부팅: data/ 로드 + 없으면 생성 + 과거 동결
// ---------------------------------------------------------------------------
/**
 * data/ 전체를 메모리에 로드하고, 없으면 forest.json 을 생성하며, 과거 날짜를 동결한다.
 * 자동 숲 묶기는 여기가 아니라 활성화 시점(activateGrid)에서 한다.
 * @returns {Promise<object>} GET /api/forest 응답 형태의 forest.
 */
export async function boot() {
  const today = todayLocalYMD();

  // 1) forest.json 로드 또는 생성.
  //    startDate 는 영속·불변. 빈 data 부팅 시 "오늘"로 덮어쓰지 않고 null 로 두고,
  //    첫 활성화 시점에 그 날짜로 확정한다(activateGrid). 기존 영속값은 무조건 보존.
  let forest = await readJson(forestPath());
  if (!forest || typeof forest !== 'object') {
    const year = yearOf(today);
    // forest.json 부재 시 refMax·dailyMaxTokens 를 실측 시드로 초기화.
    forest = {
      startDate: null,
      activeYear: year,
      stages: [year],
      refMax: { ...REFMAX_SEED },
      dailyMaxTokens: DAILY_MAX_SEED,
    };
    await writeJson(forestPath(), forest);
  }
  mem.forest = forest;
  // 저장값(있으면) + 시드 합쳐 모든 키 채운 refMax 로 메모리 초기화(단조 하한 = 시드).
  mem.refMax = normalizeRefMax(forest.refMax);
  // 저장값(있으면) + 시드 하한 합쳐 dailyMaxTokens 메모리 초기화(단조 하한 = 시드).
  mem.dailyMaxTokens = normalizeDailyMax(forest.dailyMaxTokens);

  // 2) data/ 전체 스캔 → days/months/years 메모리 로드
  await loadAllFromDisk();

  // 기존 일 파일들의 그날 합으로 refMax 단조 갱신(부팅 1회). 변동 시 forest.json 영속.
  if (bumpRefMaxFromAllDays()) await persistRefMax();
  // 기존 일 파일들의 일일누적으로 dailyMaxTokens 단조 갱신(부팅 1회). 변동 시 영속.
  if (bumpDailyMaxFromAllDays()) await persistDailyMax();

  // 3) 첫 집계 1회 — caps 채우고, 오늘자 갱신(활성이면)
  await refreshToday();

  // 4) 과거 동결: today 보다 과거인데 finalized:false 인 날 → finalized:true
  await freezeStaleDays(today);

  return getForest();
}

// ---------------------------------------------------------------------------
// 자동 숲 묶기: 월 경계를 넘으면 지난 달을 무조건 bundled 로 전환·영속.
// ---------------------------------------------------------------------------
// 기준일(today)의 YYYY-MM 보다 이전이고 미묶음인 달 → bundled=true + bundledAt.
// 완주 무관(데이터 있으면 무조건). 한 번 묶이면 유지된다
// (recomputeAndPersistMonth 가 기존 monthObj 를 재사용해 bundled 가 안 풀린다).
/**
 * @param {string} today 기준일 "YYYY-MM-DD". 이 달보다 이전 달을 묶는다.
 */
async function autoBundlePastMonths(today) {
  const currentMonth = today.slice(0, 7); // YYYY-MM
  // 묶을 후보를 먼저 모은다(루프 중 mem.months 를 recompute 가 갱신하므로 분리).
  const targets = [];
  for (const [month, monthObj] of mem.months) {
    if (!isPastMonth(month, currentMonth)) continue; // 현재월·미래월은 묶지 않음
    if (!monthObj || monthObj.bundled) continue; // 이미 묶였으면 skip(영속 유지)
    targets.push(month);
  }
  for (const month of targets) {
    const [yearStr, mm] = month.split('-');
    const yearNum = Number(yearStr);
    // 묶기 전 monthly 를 days 에서 확정 재계산 — 수동 bundleForest 와 동일.
    await recomputeAndPersistMonth(yearNum, mm);
    const monthObj = mem.months.get(month);
    if (!monthObj) continue;
    monthObj.bundled = true;
    monthObj.bundledAt = new Date().toISOString();
    mem.months.set(month, monthObj);
    await writeJson(monthPath(yearNum, mm), monthObj);
  }
}

// data/ 디렉토리를 걸어 days/months/years 를 메모리에 적재. 깨진 파일은 skip.
async function loadAllFromDisk() {
  mem.days.clear();
  mem.months.clear();
  mem.years.clear();

  let yearDirs;
  try {
    yearDirs = await readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return; // data/ 자체가 없으면(부팅에서 forest.json 만 생김) 빈 채로.
  }

  for (const yd of yearDirs) {
    if (!yd.isDirectory() || !/^\d{4}$/.test(yd.name)) continue;
    const yearStr = yd.name;
    const yearObj = await readJson(yearPath(yearStr));
    if (yearObj) mem.years.set(Number(yearStr), yearObj);

    let monthDirs;
    try {
      monthDirs = await readdir(path.join(DATA_DIR, yearStr), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const md of monthDirs) {
      if (!md.isDirectory() || !/^\d{2}$/.test(md.name)) continue;
      const mm = md.name;
      const monthObj = await readJson(monthPath(yearStr, mm));
      if (monthObj) mem.months.set(`${yearStr}-${mm}`, monthObj);

      let files;
      try {
        files = await readdir(monthDirPath(yearStr, mm));
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
        if (!m) continue; // month.json·기타 파일 skip
        const dayObj = await readJson(dayPath(m[1]));
        if (dayObj && dayObj.date) mem.days.set(dayObj.date, dayObj);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 오늘자 갱신: jsonl 재집계 → 메모리 오늘 usage·tree + 오늘 파일 1개만 기록
// ---------------------------------------------------------------------------
// 나무 단계 = 오늘 5h % 봉우리 합 ÷ 200. 5h 두 윈도우를 100% 씩 채우면 200% = 성목 만개.
const TREE_PCT_DENOM = 200; // 하루 5h 두 번 × 100% = 만근. 임계 0.3/0.6 → 60%/120% 경계.
const PCT_RESET_DROP = 30; // 이 %p 이상 떨어졌다 재상승하면 새 5h 윈도우로 보고 봉우리 확정.

/**
 * 폴링으로 관측한 fiveHourPct 시퀀스에서 "봉우리들의 합"을 누적한다.
 *   상승/유지 → 현재 봉우리(peak) 갱신. 큰 폭(PCT_RESET_DROP) 하락 후 재상승 → 직전 봉우리를
 *   sum 에 확정하고 새 봉우리 시작. 완만한 롤링 하락은 한 봉우리로 유지(오인 방지).
 *   앱이 열려 폴링하는 동안만 관측 — 서버 시작 전·앱 오프 구간은 놓친다(오늘은 부분값).
 * @param {object|undefined} track 직전 상태 { sum, peak, valley, lastPct, falling }.
 * @param {number|null} cur 이번 폴의 fiveHourPct(0~100, 캐시 없으면 null).
 * @returns {object} 갱신된 track. 오늘 도달 5h % 합 = track.sum + track.peak.
 */
function accumulatePeaks(track, cur) {
  const t = track || { sum: 0, peak: 0, valley: 0, lastPct: null, falling: false };
  if (typeof cur !== 'number' || cur < 0 || !isFinite(cur)) return t; // 캐시 없음 → 상태 유지.
  if (t.lastPct === null) {
    t.peak = cur;
    t.valley = cur;
  } else if (cur >= t.lastPct) {
    if (t.falling && t.peak - t.valley >= PCT_RESET_DROP) {
      t.sum += t.peak; // 봉우리 확정 후 새 윈도우 시작.
      t.peak = cur;
    } else {
      t.peak = Math.max(t.peak, cur); // 같은 봉우리 유지(얕은 하락 후 회복 포함).
    }
    t.falling = false;
  } else {
    if (!t.falling) t.valley = cur; // 하락 시작 → 이번 하락 구간의 최저를 초기화.
    else t.valley = Math.min(t.valley, cur);
    t.falling = true;
  }
  t.lastPct = cur;
  return t;
}

/**
 * 오늘자 나무 단계를 정한다. 5h % 봉우리 합이 관측되면(sum>0) 그 합 ÷ 200(5h 두 번 = 만근),
 *   미관측이면(statusline 캐시 없음/정지 → sum 0) 토큰 기반(treeDailyDenom)으로 폴백해
 *   빈 대지(empty) 붕괴를 막는다. 심기(activateGrid)·폴링(refreshToday)이 같은 기준을 쓰게 공유.
 * @param {object} pctTrack accumulatePeaks 상태.
 * @param {object} usage 그날 usage(토큰 폴백용).
 * @param {string} seed 수종 시드.
 */
function computeTreeForToday(pctTrack, usage, seed) {
  const sum = pctTrack.sum + pctTrack.peak;
  return sum > 0
    ? computeTree({ totalTokens: sum }, TREE_PCT_DENOM, seed)
    : computeTree(usage, mem.caps.treeDailyDenom, seed);
}

/**
 * 오늘자 usage·tree 를 jsonl 재집계로 갱신한다. 과거(finalized:true)는 건드리지 않는다.
 * 오늘이 active 일 때만 usage·tree 를 갱신하고, 미활성이면 caps 만 갱신한다.
 */
export async function refreshToday() {
  const today = todayLocalYMD();
  const agg = await aggregateForStore();
  mem.caps = {
    dailyCapTokens: agg.dailyCapTokens,
    treeDailyDenom: agg.treeDailyDenom,
    fiveHourPct: agg.fiveHourPct,
    sevenDayPct: agg.sevenDayPct,
    fiveHourCapTokens: agg.fiveHourCapTokens,
    capSource: agg.capSource,
    generatedAt: agg.generatedAt,
  };

  const day = mem.days.get(today);
  if (!day || !day.active || day.finalized) {
    // 오늘이 아직 활성화 안 됐거나(자리 미선택) 이미 동결 → usage·tree 갱신 안 함.
    return;
  }

  const usage = agg.byDate.get(today) || zeroUsage();
  day.usage = toUsageSchema(usage);
  // 나무 단계 = 오늘 5h % 봉우리 합 ÷ 200. 앱 폴링 동안 관측한 fiveHourPct 봉우리들을 누적.
  //   usage(토큰)는 툴팁·refMax 용으로 계속 저장하되, 단계는 5h % 로만 판정한다.
  day.pctTrack = accumulatePeaks(day.pctTrack, mem.caps.fiveHourPct);
  const dailyMaxChanged = bumpDailyMax(day.usage); // dailyMaxTokens·treeDailyDenom 은 참고용 노출로만 유지
  day.tree = computeTreeForToday(day.pctTrack, usage, day.tree ? day.tree.seed : today);
  day.finalized = false;
  // 오늘 그날 합이 더 크면 refMax·dailyMaxTokens 단조 갱신 → forest.json 영속.
  if (bumpRefMax(usageToRefMetrics(day.usage))) await persistRefMax();
  if (dailyMaxChanged) await persistDailyMax();
  await persistDay(day); // 오늘 파일 1개만 기록
}

// 과거인데 finalized:false 인 날을 동결. 그 시점 stage·xp 를 그대로 두고 재계산하지 않는다.
async function freezeStaleDays(today) {
  for (const [date, day] of mem.days) {
    if (date < today && day.active && !day.finalized) {
      day.finalized = true;
      await persistDay(day);
    }
  }
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    requestCount: 0,
    totalTokens: 0,
  };
}

// agg usage(totalTokens 포함) → 일 파일 usage 스키마(5메트릭).
function toUsageSchema(u) {
  return {
    inputTokens: u.inputTokens || 0,
    outputTokens: u.outputTokens || 0,
    cacheWriteTokens: u.cacheWriteTokens || 0,
    cacheReadTokens: u.cacheReadTokens || 0,
    requestCount: u.requestCount || 0,
  };
}
function totalOf(usageSchema) {
  return (
    (usageSchema.inputTokens || 0) +
    (usageSchema.outputTokens || 0) +
    (usageSchema.cacheWriteTokens || 0) +
    (usageSchema.cacheReadTokens || 0)
  );
}

// 일 파일 1개 기록 + 그 달·년 계층 집계 재계산·기록.
async function persistDay(day) {
  await writeJson(dayPath(day.date), day);
  await recomputeAndPersistMonth(yearOf(day.date), ymPartsFromDate(day.date).month);
  await recomputeAndPersistYear(yearOf(day.date));
}

// ---------------------------------------------------------------------------
// 계층 집계 — days 가 진실, monthly·yearly 는 재계산해 채운다
// ---------------------------------------------------------------------------
function daysInMonth(yearNum, mm) {
  const prefix = `${yearNum}-${mm}-`;
  const list = [];
  for (const [date, day] of mem.days) {
    if (date.startsWith(prefix)) list.push(day);
  }
  return list;
}
function daysInYear(yearNum) {
  const prefix = `${yearNum}-`;
  const list = [];
  for (const [date, day] of mem.days) {
    if (date.startsWith(prefix)) list.push(day);
  }
  return list;
}

function aggregateDays(days) {
  const acc = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    requestCount: 0,
    totalTokens: 0,
    activeDays: 0,
    treeCount: 0,
  };
  for (const d of days) {
    const u = d.usage || {};
    acc.inputTokens += u.inputTokens || 0;
    acc.outputTokens += u.outputTokens || 0;
    acc.cacheWriteTokens += u.cacheWriteTokens || 0;
    acc.cacheReadTokens += u.cacheReadTokens || 0;
    acc.requestCount += u.requestCount || 0;
    if (d.active) acc.activeDays += 1;
    if (d.tree && d.tree.stage && d.tree.stage !== 'empty') acc.treeCount += 1;
  }
  acc.totalTokens =
    acc.inputTokens + acc.outputTokens + acc.cacheWriteTokens + acc.cacheReadTokens;
  return acc;
}

async function recomputeAndPersistMonth(yearNum, mm) {
  const key = `${yearNum}-${mm}`;
  const days = daysInMonth(yearNum, mm);
  const agg = aggregateDays(days);
  let monthObj = mem.months.get(key);
  if (!monthObj) {
    monthObj = { month: key, bundled: false, bundledAt: null, monthly: null };
  }
  monthObj.monthly = {
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    cacheReadTokens: agg.cacheReadTokens,
    requestCount: agg.requestCount,
    totalTokens: agg.totalTokens,
    activeDays: agg.activeDays,
    treeCount: agg.treeCount,
  };
  mem.months.set(key, monthObj);
  await writeJson(monthPath(yearNum, mm), monthObj);
}

async function recomputeAndPersistYear(yearNum) {
  const days = daysInYear(yearNum);
  const agg = aggregateDays(days);
  let yearObj = mem.years.get(yearNum);
  if (!yearObj) {
    const stageStart = mem.forest ? mem.forest.startDate : `${yearNum}-01-01`;
    yearObj = { year: yearNum, stageStart, yearly: null };
  }
  yearObj.yearly = {
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    cacheReadTokens: agg.cacheReadTokens,
    requestCount: agg.requestCount,
    totalTokens: agg.totalTokens,
    activeDays: agg.activeDays,
  };
  mem.years.set(yearNum, yearObj);
  await writeJson(yearPath(yearNum), yearObj);
}

// ---------------------------------------------------------------------------
// GET /api/forest — 메모리에서 즉답
// ---------------------------------------------------------------------------
/**
 * 메모리 작업본을 GET /api/forest 응답 형태로 직렬화한다(활성 스테이지 기준).
 * @returns {object} startDate·days·forests·yearly·cap·refMax 등.
 */
export function getForest() {
  const f = mem.forest || { startDate: todayLocalYMD(), activeYear: yearOf(todayLocalYMD()), stages: [] };
  const year = f.activeYear;
  const yearObj = mem.years.get(year) || null;

  const days = {};
  for (const [date, d] of mem.days) days[date] = d;

  const forests = {};
  for (const [key, m] of mem.months) forests[key] = m;

  const yearly = {};
  for (const [y, yo] of mem.years) yearly[y] = yo;

  return {
    startDate: f.startDate,
    activeYear: f.activeYear,
    stages: f.stages,
    year,
    stageStart: yearObj ? yearObj.stageStart : f.startDate,
    days,
    forests,
    yearly,
    // top-level cap·utilization — 오늘 단계·HUD 계산용.
    dailyCapTokens: mem.caps.dailyCapTokens,
    fiveHourPct: mem.caps.fiveHourPct,
    sevenDayPct: mem.caps.sevenDayPct,
    capSource: mem.caps.capSource,
    fiveHourCapTokens: mem.caps.fiveHourCapTokens,
    // 메트릭별 관측 최대(단조 증가) — 클라 metrics.js 가 정규화 분모로 쓴다.
    refMax: { ...mem.refMax },
    // 일일누적 역대최대 — 참고용 노출만(나무 분모는 treeDailyDenom 으로 이관). 클라 단계 재계산엔 안 씀.
    dailyMaxTokens: mem.dailyMaxTokens,
    generatedAt: mem.caps.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// POST /api/grid/activate — 그리드 활성화(자리 잡기)
// ---------------------------------------------------------------------------
/**
 * 그날 jsonl 사용량으로 usage·tree 를 채워 그리드를 활성화한다.
 * 사용량 0 → tree.stage="empty"(빈 땅). 좌표 중복·비인접·맵 밖은 400 거부.
 * @param {{date:string, gx:number, gy:number}} args 날짜와 그리드 좌표.
 * @returns {Promise<{ok:true, day}|{ok:false, status:number, error:string}>}
 */
export async function activateGrid({ date, gx, gy }) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, status: 400, error: 'invalid date' };
  }
  if (!Number.isInteger(gx) || !Number.isInteger(gy)) {
    return { ok: false, status: 400, error: 'gx/gy must be integers' };
  }

  // 맵 경계 밖 좌표 거부. 콜드 스타트 자유 선택도 맵 범위로 한정(인접 면제는 유지).
  if (gx < MAP_GX_MIN || gx > MAP_GX_MAX || gy < MAP_GY_MIN || gy > MAP_GY_MAX) {
    return { ok: false, status: 400, error: 'grid out of map bounds' };
  }

  // startDate 미정(null)이면 활성화 거부 — 시작일을 먼저 정해야(POST /api/forest/start).
  if (!mem.forest || !mem.forest.startDate) {
    return { ok: false, status: 400, error: 'startDate not set' };
  }

  // startDate 이전 날짜는 거부(숲은 startDate 부터).
  if (date < mem.forest.startDate) {
    return { ok: false, status: 400, error: 'date before startDate' };
  }

  // 미래 날짜 거부 — 아직 오지 않은 날의 그리드는 심을 수 없다(usage 없음, refreshToday 도 안 닿음).
  // 활성화는 오늘 또는 과거(자정 경과분)만.
  if (date > todayLocalYMD()) {
    return { ok: false, status: 400, error: 'cannot activate a future date' };
  }

  const existing = mem.days.get(date);
  if (existing && existing.active) {
    return { ok: false, status: 400, error: 'date already activated' };
  }

  // 좌표 중복 거부 — 다른 날이 이미 그 (gx,gy) 점유.
  for (const [d, day] of mem.days) {
    if (d !== date && day.active && day.grid && day.grid.gx === gx && day.grid.gy === gy) {
      return { ok: false, status: 400, error: 'grid coordinate already occupied' };
    }
  }

  // 콜드 스타트 인접 면제: 점유 그리드 0개면 8방향 인접 검사를 skip 하고 아무 좌표 허용
  // (첫 그리드 자유 선택). 점유 1개 이상이면 8방향 인접 검사 유지.
  const occupied = [];
  for (const [, day] of mem.days) {
    if (day.active && day.grid) occupied.push(day.grid);
  }
  const isColdStart = occupied.length === 0;
  if (!isColdStart && !isAdjacentToAny(gx, gy, occupied)) {
    return { ok: false, status: 400, error: 'grid not adjacent to existing grids' };
  }

  // 그날 jsonl 사용량 읽기. (오늘이면 최신, 과거 날짜 활성화도 그날 집계값 사용)
  const agg = await aggregateForStore();
  mem.caps = {
    dailyCapTokens: agg.dailyCapTokens,
    treeDailyDenom: agg.treeDailyDenom,
    fiveHourPct: agg.fiveHourPct,
    sevenDayPct: agg.sevenDayPct,
    fiveHourCapTokens: agg.fiveHourCapTokens,
    capSource: agg.capSource,
    generatedAt: agg.generatedAt,
  };
  const usage = agg.byDate.get(date) || zeroUsage();
  const usageSchema = toUsageSchema(usage);
  const dailyMaxChanged = bumpDailyMax(usageSchema); // dailyMaxTokens 는 참고용 노출로만 유지
  const today = todayLocalYMD();
  // 오늘 심기: refreshToday 와 같은 5h % 기준(+토큰 폴백)으로 초기화 → 첫 폴에서 튐 없음.
  //   과거 심기: 5h % 이력이 없으니 토큰(treeDailyDenom)으로 확정 동결.
  let pctTrack = null;
  let tree;
  if (date === today) {
    pctTrack = accumulatePeaks(undefined, mem.caps.fiveHourPct);
    tree = computeTreeForToday(pctTrack, usage, date);
  } else {
    tree = computeTree(usage, mem.caps.treeDailyDenom, date); // 사용량 0 → stage:empty
  }
  // 활성화하는 날의 그날 합으로 refMax·dailyMaxTokens 단조 갱신(과거 날짜 활성화 포함).
  if (bumpRefMax(usageToRefMetrics(usageSchema))) await persistRefMax();
  if (dailyMaxChanged) await persistDailyMax();

  const day = {
    date,
    active: true,
    grid: { gx, gy },
    usage: usageSchema,
    tree,
    // 과거 날짜를 활성화하면 즉시 동결(자정 경과분). 오늘은 갱신 계속.
    finalized: date < today,
  };
  if (pctTrack) day.pctTrack = pctTrack;
  mem.days.set(date, day);
  await persistDay(day);

  // 심는 날 기준 이전 달 자동 묶기 — date 의 달보다 이전인 미묶음 달을 묶는다.
  //   진행 중 달은 안 묶임. 클라가 재폴에서 bundled false→true 를 잡아 빛기둥을 띄운다.
  await autoBundlePastMonths(date);

  return { ok: true, day };
}

// ---------------------------------------------------------------------------
// POST /api/forest/start — 시작일 설정
// ---------------------------------------------------------------------------
/**
 * startDate 가 미정(null)일 때만 1회 설정한다. 이미 정해졌으면 거부(영속·불변).
 * 미래 날짜·잘못된 형식도 거부. 성공 시 forest.json 저장 + 메모리 갱신.
 * @param {{date:string}} args 시작일 "YYYY-MM-DD".
 * @returns {Promise<{ok:true, forest}|{ok:false, status:number, error:string}>}
 */
export async function setStartDate({ date }) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, status: 400, error: 'invalid date (YYYY-MM-DD)' };
  }
  // 실재하지 않는 날짜(예: 2026-02-30) 방어.
  const parsed = new Date(`${date}T00:00:00`);
  if (isNaN(parsed.getTime()) || localDateRoundtrip(parsed) !== date) {
    return { ok: false, status: 400, error: 'invalid date (YYYY-MM-DD)' };
  }
  if (date > todayLocalYMD()) {
    return { ok: false, status: 400, error: 'startDate cannot be in the future' };
  }
  if (mem.forest && mem.forest.startDate) {
    return { ok: false, status: 400, error: 'startDate already set' };
  }
  if (!mem.forest) {
    const yr = yearOf(date);
    mem.forest = { startDate: null, activeYear: yr, stages: [yr] };
  }
  mem.forest.startDate = date;
  await writeJson(forestPath(), mem.forest);
  return { ok: true, forest: getForest() };
}

// 로컬 시간대로 Date → YYYY-MM-DD (실재 날짜 검증용 라운드트립).
function localDateRoundtrip(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 8방향 인접 판정(그리드 단위).
function isAdjacentToAny(gx, gy, occupied) {
  for (const g of occupied) {
    const dx = Math.abs(g.gx - gx);
    const dy = Math.abs(g.gy - gy);
    if (dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// POST /api/forest/bundle — 숲 묶기(완료된 달만)
// ---------------------------------------------------------------------------
/**
 * 완료된 달(month < 현재월)을 숲으로 묶는다(달 중간 묶기 금지).
 * month.json 에 bundled=true·bundledAt·monthly 를 확정 저장한다.
 * @param {{month:string}} args 달 "YYYY-MM".
 * @returns {Promise<{ok:true, month}|{ok:false, status:number, error:string}>}
 */
export async function bundleForest({ month }) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, status: 400, error: 'invalid month (YYYY-MM)' };
  }
  const today = todayLocalYMD();
  const currentMonth = today.slice(0, 7); // YYYY-MM
  if (!isPastMonth(month, currentMonth)) {
    return { ok: false, status: 400, error: 'only completed months can be bundled' };
  }

  const [yearStr, mm] = month.split('-');
  const yearNum = Number(yearStr);

  // 데이터(심긴 그리드) 없는 달은 묶을 게 없다 — 거부. (빈 달 bundled 방지)
  if (daysInMonth(yearNum, mm).length === 0) {
    return { ok: false, status: 400, error: 'month has no data' };
  }

  // 그 달 monthly 를 days 에서 확정 재계산 후 bundled 표기.
  await recomputeAndPersistMonth(yearNum, mm);
  const monthObj = mem.months.get(month);
  if (!monthObj) {
    return { ok: false, status: 400, error: 'month has no data' };
  }
  monthObj.bundled = true;
  monthObj.bundledAt = new Date().toISOString();
  mem.months.set(month, monthObj);
  await writeJson(monthPath(yearNum, mm), monthObj);

  return { ok: true, month: monthObj };
}

// 테스트/검증용: 메모리 상태 스냅샷.
export function _debugSnapshot() {
  return {
    forest: mem.forest,
    dayCount: mem.days.size,
    monthCount: mem.months.size,
    yearCount: mem.years.size,
    caps: mem.caps,
    refMax: { ...mem.refMax },
    dailyMaxTokens: mem.dailyMaxTokens,
  };
}

// CLI: node server/store.js --forest → boot 후 GET /api/forest 응답을 stdout 에 pretty-print.
// (서버 없이 계층 구조 검증용. data/ 가 실제로 생성된다.)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain && process.argv.includes('--forest')) {
  boot()
    .then((forest) => {
      process.stdout.write(JSON.stringify(forest, null, 2) + '\n');
    })
    .catch((err) => {
      process.stderr.write(`store boot failed: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}
