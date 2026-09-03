// Claude Code 사용량 집계 모듈.
//
// ~/.claude/projects 하위 *.jsonl 을 스캔해 message.id 로 중복 제거하고,
// 로컬 시간대 기준으로 일자별 토큰 사용량을 합산한다.

import { readFile, readdir, access, stat } from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
// 수종 산식은 클라(sprites.js)와 비트 단위로 같아야 하므로 공유 모듈 1곳에서 가져온다.
import { speciesFor } from '../public/js/seed.js';

const PROJECTS_DIR = process.env.FOREST_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const WINDOW_DAYS = 90;

// statusline 이 Max5 기준으로 계산해 둔 utilization % 캐시 (실제 키: fiveHour, sevenDay).
//   테스트 격리용으로 FOREST_STATUSLINE_CACHE 로 오버라이드 가능(부재 경로 → readPct null).
function statuslineCachePath() {
  return process.env.FOREST_STATUSLINE_CACHE || path.join(os.homedir(), '.claude', 'statusline', 'usage-cache.json');
}

// ---------------------------------------------------------------------------
// 파일별 파싱 캐시 (T2) — 폴링마다 통째 재파싱(916MB·~3.6s)하던 걸, 변경된 파일만
//   재파싱하게 바꾼다. 캐시 키 = (path, mtimeMs, size). stat(수 ms)으로 불변 확인 후
//   불변이면 캐시된 파싱 결과 재사용, 바뀌면 재파싱.
//
//   캐시에 담는 것은 "cutoff 적용 전 원본 엔트리"다(함정 A). 90일 cutoff 는 매 호출
//   앞으로 이동하므로 파싱 시점에 적용하면 캐시가 stale 해져 경계일 집계가 틀어진다 →
//   cutoff 는 merge 시점에만 적용한다. 캐시 엔트리는 나이와 무관하게 전부 보관.
//
//   dedup 은 전역(파일 간)이다: 같은 message.id 가 resume/fork 로 여러 파일에 복사돼
//   존재할 수 있어(실측 234건), 파일별 dedup 은 이중 계수한다. merge 를 findJsonlFiles
//   순서 × 파일 내 라인 순서로 돌며 messageData[key]=entry(마지막 덮어씀)로 전역 dedup —
//   기존 2-pass 와 비트 동일.
// ---------------------------------------------------------------------------
// path -> { mtime:number, size:number, entries:Array<{key,dateStr,ms,input,output,cacheWrite,cacheRead}> }
const fileParseCache = new Map();
// 재파싱(캐시 미스 시 실제 read) 바이트 카운터 — 폴링 간 재파싱량 증빙·측정용.
let reparsedBytes = 0;

// 캐시 비우기(테스트의 '콜드' 재현·측정 리셋용).
export function _clearParseCache() {
  fileParseCache.clear();
  reparsedBytes = 0;
}
// 캐시 통계(테스트/측정). reparsedBytes 는 마지막 _clearParseCache 이후 실제 read 한 총 바이트.
export function _parseCacheStats() {
  return { size: fileParseCache.size, reparsedBytes };
}

/**
 * 한 파일의 유효 엔트리 배열을 돌려준다. (path,mtime,size) 불변이면 캐시 재사용(read 없음),
 * 바뀌었으면 read+parse 후 캐시 갱신. cutoff 는 적용하지 않는다(merge 에서).
 * @param {string} file 절대 경로.
 * @returns {Promise<Array<{key,dateStr,ms,input,output,cacheWrite,cacheRead}>>}
 */
async function collectFileEntries(file) {
  let st;
  try {
    st = await stat(file);
  } catch {
    return []; // stat 실패한 파일은 건너뛴다(방어적).
  }
  const mtime = st.mtimeMs;
  const size = st.size;

  const cached = fileParseCache.get(file);
  if (cached && cached.mtime === mtime && cached.size === size) {
    return cached.entries; // 불변 → 재파싱 안 함(read 0).
  }

  let content;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return []; // 읽기 실패한 파일은 건너뛴다.
  }
  reparsedBytes += Buffer.byteLength(content);

  const entries = [];
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 깨진 줄은 조용히 skip (throw 금지).
    }

    if (!entry || entry.type !== 'assistant') continue;

    const timestamp = entry.timestamp;
    if (!timestamp) continue;

    const msgTime = new Date(timestamp);
    if (isNaN(msgTime.getTime())) continue; // 파싱 불가한 timestamp skip.
    // 90일 cutoff 는 여기서 적용하지 않는다(함정 A) — merge 시점에.

    const message = entry.message || {};
    const usage = message.usage;
    if (!usage || typeof usage !== 'object' || Object.keys(usage).length === 0) continue;

    entries.push({
      key: message.id || `no_id_${timestamp}`,
      dateStr: localYMD(msgTime),
      ms: msgTime.getTime(),
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    });
  }

  fileParseCache.set(file, { mtime, size, entries });
  return entries;
}
// ccusage 식 5시간 롤링 블록 길이.
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
// fiveHour % 가 이보다 작으면 분모로 쓰기 위험(역산 cap 이 폭발) → 폴백.
const MIN_PCT_FOR_INVERSE = 1;

// timestamp -> 로컬 시간대 YYYY-MM-DD. UTC 금지 ("하루"의 기준선은 사용자 로컬 자정).
function localYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 중복 제거된 메시지들(ms, totalTokens)을 ccusage 식 5시간 롤링 블록으로 묶는다.
 * 첫 메시지 시각을 블록 시작(anchor)으로, anchor+5h 안의 메시지는 같은 블록,
 * 5시간을 넘긴 다음 메시지가 새 블록의 anchor 가 된다.
 * @param {Array<{ms:number, totalTokens:number}>} messages 중복 제거된 메시지들.
 * @returns {Array<{startMs:number, totalTokens:number}>} startMs 오름차순.
 */
function buildFiveHourBlocks(messages) {
  const sorted = messages.slice().sort((a, b) => a.ms - b.ms);
  const blocks = [];
  let anchor = null;
  let cur = null;
  for (const m of sorted) {
    if (cur === null || m.ms - anchor >= FIVE_HOUR_MS) {
      anchor = m.ms;
      cur = { startMs: m.ms, totalTokens: 0 };
      blocks.push(cur);
    }
    cur.totalTokens += m.totalTokens;
  }
  return blocks;
}

/**
 * statusline 캐시에서 utilization % 를 읽는다. 파일 부재·깨짐·필드 없음 → null(throw 금지).
 * @param {string} key 캐시의 실제 키(예: fiveHour).
 * @param {string} [altKey] 변형 키(예: five_hour) 한 단계 관용 처리용.
 * @returns {Promise<number|null>}
 */
async function readPct(key, altKey) {
  let raw;
  try {
    raw = await readFile(statuslineCachePath(), 'utf8');
  } catch {
    return null; // 파일 없음/읽기 실패.
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null; // 깨진 JSON.
  }
  const v = obj && (obj[key] ?? (altKey ? obj[altKey] : undefined));
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return v;
}

// 5h 블록 totals 의 robust 상단 기준값에 쓰는 분위수·최소표본.
//   관측 '최대'(max)는 이상치 하나에 영구히 부풀어, 앤트로픽이 5h 를 리셋해 그날만 폭증하면
//   그 한 날이 분모로 박제돼 다른 날이 영영 묘목에 갇힌다('평균의 함정'의 max 판 — 극단값 지배).
//   분위수는 극단값의 '값'이 아니라 '순위'만 보므로 소수 이상치에 안 흔들린다. p85 = 본체 상단
//   (중앙값보다 위·최대보다 아래) → 센 날은 성목에 닿고 상위 ~15% 이상치는 배제, 사용량 편차가
//   나무 키로 드러난다.
const REF_PERCENTILE = 0.85;
const MIN_BLOCKS_FOR_PCTL = 8; // 표본이 적으면 분위수가 무의미 → 최대값 폴백.

/**
 * 5h 블록 totals 의 robust 상단 기준값(p85 순서통계량). 이상치(리셋 폭증)에 강하다.
 * @param {Array<{totalTokens:number}>} blocks 5시간 롤링 블록.
 * @returns {number} 기준 토큰 수(블록 없으면 0).
 */
function robustBlockRef(blocks) {
  const totals = blocks.map((b) => b.totalTokens).filter((t) => t > 0).sort((a, c) => a - c);
  const n = totals.length;
  if (n === 0) return 0;
  if (n < MIN_BLOCKS_FOR_PCTL) return totals[n - 1]; // 표본 적음 → 최대값 폴백.
  return totals[Math.floor(REF_PERCENTILE * (n - 1))];
}

/**
 * 5시간 한도(토큰)와 일일 최대치를 추정한다.
 *   1차(statusline): fiveHourCap = 최근 블록 totalTokens / (fiveHour%/100).
 *   폴백(observed):  fiveHourCap = 90일 블록 totals 의 p85 분위수(robustBlockRef).
 * 역산값과 robust 기준값 중 큰 값을 채택해, 가벼운 블록 하나에서 cap 이 비정상적으로
 * 작아지는 출렁임을 막는다(p85 가 하한). max 대신 분위수라 리셋 폭증 한 날이 분모를
 * 영구히 부풀리지 못한다(이상치 = 순위만 보므로 무시됨).
 * @param {Array<{startMs:number, totalTokens:number}>} blocks 5시간 롤링 블록.
 * @param {number|null} fiveHourPct statusline 캐시의 5시간 사용률 %.
 * @returns {{fiveHourCapTokens:number, dailyCapTokens:number, capSource:string}}
 */
function estimateCaps(blocks, fiveHourPct) {
  const robustRef = robustBlockRef(blocks);
  const latest = blocks.length ? blocks[blocks.length - 1] : null;

  let fiveHourCapTokens;
  let capSource;

  const canInverse =
    typeof fiveHourPct === 'number' &&
    fiveHourPct >= MIN_PCT_FOR_INVERSE &&
    latest &&
    latest.totalTokens > 0;

  if (canInverse) {
    const inverse = latest.totalTokens / (fiveHourPct / 100);
    // 역산값과 robust 기준값(p85) 중 큰 값. 역산이 너무 작으면 p85 가 하한이 된다.
    fiveHourCapTokens = Math.max(inverse, robustRef);
    capSource = 'statusline';
  } else {
    // 폴백: 블록 0개면 0 division 방지를 위해 최소 1.
    fiveHourCapTokens = robustRef > 0 ? robustRef : 1;
    capSource = 'observed';
  }

  return {
    fiveHourCapTokens: Math.round(fiveHourCapTokens),
    dailyCapTokens: Math.round(2 * fiveHourCapTokens), // 하루 ≈ 5시간 윈도우 2개.
    // 나무 단계 분모 = HUD cap 과 같은 눈금(fiveHourCapTokens×2). 나무 % 는 statusline 이
    //   보여주는 5h % 와 같은 자로 읽혀야 한다 — 관측 p85 를 쓰면 같은 사용량이 두 배로
    //   부풀어(오늘 실측 101% → 196%) HUD 와 어긋난다. statusline 부재 시엔
    //   fiveHourCapTokens 자체가 관측 p85 로 떨어지므로 폴백은 그대로 유지된다.
    treeDailyDenom: Math.round(2 * fiveHourCapTokens),
    capSource,
  };
}

/**
 * 오늘(로컬) 시작된 5시간 블록들의 사용률 % 합을 낸다 — 나무 단계 입력.
 *   블록 귀속 기준 = 블록 시작 시각(startMs)의 로컬 날짜. 어젯밤 시작해 자정을 넘긴
 *   블록은 어제 것으로 남는다("그날 출근해서 퇴근할 때까지" 를 하루로 본다).
 *   블록 1개를 refTokens 만큼 쓰면 100%. 하루 = 근무 중 리셋 한 번 = 블록 2개가 만근.
 * @param {Array<{startMs:number, totalTokens:number}>} blocks 5시간 롤링 블록.
 * @param {number} refTokens 블록 100% 기준 토큰(관측 p85).
 * @param {string} todayYMD 로컬 오늘 YYYY-MM-DD.
 * @returns {number} 사용률 % 합(블록 없음/기준 미정 → 0).
 */
function todayBlockPctSum(blocks, refTokens, todayYMD) {
  if (!(refTokens > 0)) return 0;
  let sum = 0;
  for (const b of blocks) {
    if (localYMD(new Date(b.startMs)) !== todayYMD) continue;
    sum += (b.totalTokens / refTokens) * 100;
  }
  return sum;
}

// ~/.claude/projects 하위를 재귀 탐색하여 모든 *.jsonl 수집 (머신 전체).
async function findJsonlFiles(dir) {
  const results = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      // 읽을 수 없는 하위 디렉토리는 조용히 건너뛴다 (방어적 파싱).
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * Claude Code 사용량을 일자별로 집계한다.
 *
 * 2-pass:
 *   Pass 1 — 중복 제거: key = message.id || ("no_id_" + timestamp), 항상 덮어쓴다(마지막 값 채택).
 *            스트리밍 응답은 같은 message.id 로 여러 엔트리가 기록되고 마지막이 최종 토큰 값이라,
 *            누적 합산하면 토큰이 2~3배 부풀려진다.
 *   Pass 2 — 일자 합산: 중복 제거된 값만 로컬일별로 더한다.
 *
 * @returns {Promise<{daily: Array<object>, generatedAt: string}>}
 */
export async function scanUsageData(projectsDir = PROJECTS_DIR) {
  const generatedAt = new Date().toISOString();

  // ~/.claude/projects 부재 시 빈 daily 폴백 (서버는 죽지 않는다).
  // 블록 0개 → dailyCapTokens 는 0 division 방지용 최소값(1×2), capSource="observed".
  try {
    await access(projectsDir);
  } catch {
    return {
      daily: [],
      dailyCapTokens: 2,
      treeDailyDenom: 2,
      fiveHourPct: null,
      sevenDayPct: null,
      fiveHourCapTokens: 1,
      capSource: 'observed',
      generatedAt,
    };
  }

  const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const files = await findJsonlFiles(projectsDir);
  const fileSet = new Set(files);

  // 캐시 프룬(함정 C·메모리 하이진): 이번 스캔 루트 하위인데 현재 파일 목록에 없는 캐시 항목
  //   제거. 병합은 아래에서 findJsonlFiles 결과만 순회하므로, 삭제/회전 파일은 프룬과 무관하게
  //   결과에서 이미 제외된다(프룬은 메모리 회수 목적). 다른 루트(테스트) 캐시는 건드리지 않음.
  const rootPrefix = projectsDir.endsWith(path.sep) ? projectsDir : projectsDir + path.sep;
  for (const p of fileParseCache.keys()) {
    if ((p === projectsDir || p.startsWith(rootPrefix)) && !fileSet.has(p)) fileParseCache.delete(p);
  }

  // Pass 1: 파일별 캐시로 엔트리 수집 → 전역 중복 제거 (key -> entry, 마지막 덮어씀).
  //   findJsonlFiles 순서 × 파일 내 라인 순서로 병합해 기존 last-write-wins 를 그대로 재현.
  //   cutoff 는 여기서만 적용(함정 A) — 캐시 엔트리는 나이 무관하게 보관돼 있다.
  const messageData = {};
  for (const file of files) {
    const entries = await collectFileEntries(file);
    for (const e of entries) {
      if (e.ms < cutoffMs) continue; // 90일 윈도우(병합 시점 적용 — 이동하는 cutoff 대응).
      messageData[e.key] = e; // 전역 dedup: 마지막 엔트리가 최종 토큰 값.
    }
  }

  // Pass 2: 일자 합산. 동시에 5시간 블록용 메시지 단위 (ms, totalTokens) 수집.
  const dailyStats = {};
  const blockMessages = []; // { ms, totalTokens } — 중복 제거된 메시지만.

  for (const e of Object.values(messageData)) {
    const d =
      dailyStats[e.dateStr] ||
      (dailyStats[e.dateStr] = {
        input: 0,
        output: 0,
        cacheWrite: 0, // cache_creation_input_tokens
        cacheRead: 0, // cache_read_input_tokens
        count: 0,
      });

    d.input += e.input;
    d.output += e.output;
    d.cacheWrite += e.cacheWrite;
    d.cacheRead += e.cacheRead;
    d.count += 1;

    blockMessages.push({ ms: e.ms, totalTokens: e.input + e.output + e.cacheWrite + e.cacheRead });
  }

  // 출력 형태. date 오름차순.
  const daily = Object.keys(dailyStats)
    .sort()
    .map((date) => {
      const s = dailyStats[date];
      const totalTokens = s.input + s.output + s.cacheWrite + s.cacheRead;
      return {
        date,
        totalInputTokens: s.input,
        totalOutputTokens: s.output,
        totalCacheWriteTokens: s.cacheWrite, // ← cache_creation_input_tokens
        totalCacheReadTokens: s.cacheRead, // ← cache_read_input_tokens
        totalTokens,
        requestCount: s.count,
      };
    });

  // 5시간 블록 추정. daily[] 출력은 위에서 확정됨 — 아래는 top-level 필드 추가만.
  const blocks = buildFiveHourBlocks(blockMessages);
  const fiveHourPct = await readPct('fiveHour', 'five_hour');
  const sevenDayPct = await readPct('sevenDay', 'seven_day');
  const { fiveHourCapTokens, dailyCapTokens, treeDailyDenom, capSource } = estimateCaps(blocks, fiveHourPct);

  return {
    daily,
    dailyCapTokens,
    treeDailyDenom, // 나무 단계 분모(관측 p85×2, 안정). 5h % 미산출 시 폴백으로 쓴다.
    // 오늘 시작된 5h 블록들의 사용률 % 합 — 나무 단계의 1차 입력(store 가 200 으로 나눈다).
    todayPctSum: todayBlockPctSum(blocks, treeDailyDenom / 2, todayLocalYMD()),
    fiveHourPct, // 캐시에서 읽은 % (없으면 null).
    sevenDayPct, // 캐시에서 읽은 7일 % (없으면 null).
    fiveHourCapTokens,
    capSource,
    generatedAt,
  };
}

/**
 * store 레이어용 어댑터. scanUsageData() 의 daily[] 배열을 date→usage 맵으로 바꿔
 * 돌려준다(store 는 특정 날짜 하나의 usage 를 빠르게 찾고 cap 정보를 같이 본다).
 * 반환 usage 키는 일 파일 스키마({inputTokens,...,requestCount})에 맞춰 변환한다.
 * @returns {Promise<{
 *   byDate: Map<string, {inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,requestCount,totalTokens}>,
 *   dailyCapTokens:number, fiveHourPct:number|null, sevenDayPct:number|null,
 *   fiveHourCapTokens:number, capSource:string, generatedAt:string }>}
 */
export async function aggregateForStore() {
  const result = await scanUsageData();
  const byDate = new Map();
  for (const d of result.daily) {
    byDate.set(d.date, {
      inputTokens: d.totalInputTokens,
      outputTokens: d.totalOutputTokens,
      cacheWriteTokens: d.totalCacheWriteTokens,
      cacheReadTokens: d.totalCacheReadTokens,
      requestCount: d.requestCount,
      totalTokens: d.totalTokens,
    });
  }
  return {
    byDate,
    dailyCapTokens: result.dailyCapTokens,
    treeDailyDenom: result.treeDailyDenom,
    todayPctSum: result.todayPctSum,
    fiveHourPct: result.fiveHourPct,
    sevenDayPct: result.sevenDayPct,
    fiveHourCapTokens: result.fiveHourCapTokens,
    capSource: result.capSource,
    generatedAt: result.generatedAt,
  };
}

// 로컬 시간대 오늘 YYYY-MM-DD. store 가 "오늘/과거" 를 가르는 기준선.
export function todayLocalYMD() {
  return localYMD(new Date());
}

// speciesFor 는 공유 모듈(public/js/seed.js)에서 import 한다 — 클라 sprites.js 와 비트 단위
//   동일성 보장. store.computeTree 가 이 speciesFor 로 수종을 정한다.
export { speciesFor };

// refMax 초기 시드값 — 실측 최대치. data/forest.json 메타 부재 시 사용한다.
//   단조 증가라 표본이 줄어도(30일 로그 삭제) 이 하한 아래로는 내려가지 않는다.
export const REFMAX_SEED = Object.freeze({
  input: 314805,
  output: 1292571,
  cacheWrite: 12574616,
  cacheRead: 399972002,
  requestCount: 1372,
});

// dailyMaxTokens 초기 시드 하한 — 일일 누적 토큰(usage.totalTokens)의 역대 최대 실측치.
//   computeTree 의 단계 분모(refMax 와 동일한 단조-증가·forest.json 영속 룰)로 쓴다.
//   refMax(메트릭별)와 별개의 단일 스칼라 — usage.totalTokens(5메트릭 합) 기준.
//   6/11 관측 일일누적 최대(≈4.95억) 수준을 보수적 하한으로 둔다. 부팅 전체 스캔이 끌어올린다.
export const DAILY_MAX_SEED = 494853000;

// 단계 임계(pct=totalTokens/분모). 구간 폭 30:30:40 = 3:3:4 — 묘목 3·유목 3·성목 4
// 하위 스프라이트 프레임에 균등 10%씩 대응(렌더가 stageProgress 로 하위 프레임 파생).
// 임계(0.3/0.6)는 절대 변경 금지 — 분모만 호출부가 갈아끼운다.
const STAGE_PCT = { young: 0.3, mature: 0.6 };
/**
 * 그날 사용량으로 나무 단계·경험치·수종을 계산한다(클라 metrics.js 와 동일 산식).
 *   pct = totalTokens / 분모. pct<0.3 묘목 / 0.3~0.6 유목 / 0.6~ 성목.
 *   사용량 0 → empty(빈 땅). 사용은 있는데 분모 미정/pct 극소면 최소 묘목.
 *   분모 = 일일 누적 토큰의 역대 최대(dailyMaxTokens). 호출부가 넘긴다 — HUD cap 과 별개.
 *   역대 최대급으로 쓴 날 = pct≈1.0 = 성목 만개.
 * @param {object} usage totalTokens 를 가진 그날 usage.
 * @param {number} denomTokens 단계 분모(일일누적 역대최대 dailyMaxTokens). 인자명은 무방.
 * @param {*} seed 수종 결정용 결정적 시드.
 * @returns {{stage:string, xp:number, stageProgress:number, seed:*, species:*}}
 */
export function computeTree(usage, denomTokens, seed) {
  const species = speciesFor(seed);
  const totalTokens = usage && usage.totalTokens > 0 ? usage.totalTokens : 0;
  if (totalTokens <= 0) {
    return { stage: 'empty', xp: 0, stageProgress: 0, seed, species };
  }
  const cap = Number.isFinite(denomTokens) && denomTokens > 0 ? denomTokens : 0;
  const pct = cap > 0 ? totalTokens / cap : 0;

  let stage;
  let stageProgress;
  if (cap <= 0 || pct <= 0) {
    // cap 미정인데 사용은 있음 → 최소 묘목, 진행 0.
    stage = 'sapling';
    stageProgress = 0;
  } else if (pct < STAGE_PCT.young) {
    stage = 'sapling';
    stageProgress = clamp01(pct / STAGE_PCT.young);
  } else if (pct < STAGE_PCT.mature) {
    stage = 'young';
    stageProgress = clamp01((pct - STAGE_PCT.young) / (STAGE_PCT.mature - STAGE_PCT.young));
  } else {
    stage = 'mature';
    stageProgress = clamp01((pct - STAGE_PCT.mature) / (1 - STAGE_PCT.mature));
  }
  return { stage, xp: totalTokens, stageProgress, seed, species };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// CLI: node server/aggregate.js --once → 집계 JSON 을 stdout 에 pretty-print(서버 없이 검증용).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain && process.argv.includes('--once')) {
  scanUsageData()
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch((err) => {
      process.stderr.write(`aggregate failed: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}
