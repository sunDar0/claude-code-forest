// Claude Code Forest — 목모드 데이터 서빙(read-only).
//
// GET /api/forest?mock=1 일 때 data/ 가 아니라 mock/ 을 읽어 forest 응답을 만든다.
//   - 실모드(data/) store 와 완전히 분리된 경로. 실모드 인메모리 상태를 오염시키지 않는다.
//   - mock/ 파일에 절대 쓰지 않는다(read-only). POST 는 목데이터 보존을 위해 no-op.
//   - 활성 스테이지(mock/forest.json activeYear)만 반환 — 그 해의 days·forests·yearly.
//
// 표준 라이브러리만(fs/promises·path). 짧은 TTL 캐시로 디스크 반복 읽기를 줄인다.

import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { REFMAX_SEED, todayLocalYMD } from './aggregate.js';
import { isPastMonth } from '../public/js/bundle-rule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = path.join(__dirname, '..', 'mock');

// 목업 고정 CAP — 실서버처럼 statusline 역산을 하지 않고 데모용 상수로 둔다(목데이터 자기완결).
// 클라 HUD 가 dailyCapTokens·fiveHourPct·sevenDayPct·capSource 를 그대로 쓸 수 있게.
const MOCK_DAILY_CAP_TOKENS = 600_000_000;
// 목 단계 분모(일일누적 역대최대). mock day 파일은 tree 가 이미 박혀 있어 computeTree 를 안
//   거치므로 단계엔 영향 없지만, 메타 일관성(실서버 dailyMaxTokens 노출)을 위해 둔다.
const MOCK_DAILY_MAX_TOKENS = 700_000_000;
const MOCK_FIVE_HOUR_PCT = 42;
const MOCK_SEVEN_DAY_PCT = 31;
const MOCK_CAP_SOURCE = 'mock';

// 목 응답 캐시(디스크 반복 읽기 방지). mock/ 은 변하지 않으니 길게 잡아도 무방.
const MOCK_TTL_MS = 30_000;
let cache = { at: 0, payload: null };

async function readJson(p) {
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null; // 부재·깨짐 → null (방어적, throw 금지)
  }
}

// mock/{year}/{MM}/ 의 일 파일들을 읽어 date→dayObj 로 모은다. 깨진/비매칭 파일 skip.
async function readMonthDays(yearStr, mm) {
  const dirPath = path.join(MOCK_DIR, yearStr, mm);
  let files;
  try {
    files = await readdir(dirPath);
  } catch {
    return [];
  }
  const days = [];
  for (const f of files) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue; // month.json 등 skip
    const dayObj = await readJson(path.join(dirPath, f));
    if (dayObj && dayObj.date) days.push(dayObj);
  }
  return days;
}

/**
 * 활성 스테이지(activeYear) 기준 forest 응답을 mock/ 에서 조립한다.
 * @returns {Promise<object>} GET /api/forest 응답 형태.
 */
async function buildMockForest() {
  const forestMeta = await readJson(path.join(MOCK_DIR, 'forest.json'));
  // mock/forest.json 부재 시 빈 폴백(서버 안 죽게). 실모드와 동일 톤.
  if (!forestMeta || typeof forestMeta !== 'object') {
    return emptyMockPayload(null);
  }

  const activeYear = forestMeta.activeYear;
  const yearStr = String(activeYear);

  // 활성 스테이지의 월 디렉토리 나열.
  let monthDirs;
  try {
    monthDirs = await readdir(path.join(MOCK_DIR, yearStr), { withFileTypes: true });
  } catch {
    return emptyMockPayload(forestMeta);
  }

  const currentMonth = todayLocalYMD().slice(0, 7); // YYYY-MM (실서버와 동일 로컬월)
  const days = {};
  const forests = {};
  for (const md of monthDirs) {
    if (!md.isDirectory() || !/^\d{2}$/.test(md.name)) continue;
    const mm = md.name;

    // 월 묶음 상태 + 월 집계 (month.json 그대로 노출)
    const monthObj = await readJson(path.join(MOCK_DIR, yearStr, mm, 'month.json'));
    if (monthObj && monthObj.month) {
      // 자동 묶기: 지난 달(데이터 있음·미묶음)이면 런타임 보정해 bundled 노출.
      //   mock/ 은 read-only — 파일에 쓰지 않고 응답 객체만 보정한다.
      if (isPastMonth(monthObj.month, currentMonth) && !monthObj.bundled) {
        forests[monthObj.month] = {
          ...monthObj,
          bundled: true,
          bundledAt: monthObj.bundledAt || new Date().toISOString(),
        };
      } else {
        forests[monthObj.month] = monthObj;
      }
    }

    // 일 상세
    const dayList = await readMonthDays(yearStr, mm);
    for (const d of dayList) days[d.date] = d;
  }

  // 연 집계(year.json 그대로). 활성 스테이지만 yearly 에 싣는다(이전 년 뷰 미구현).
  const yearObj = await readJson(path.join(MOCK_DIR, yearStr, 'year.json'));
  const yearly = {};
  if (yearObj) yearly[activeYear] = yearObj;

  return {
    startDate: forestMeta.startDate,
    activeYear,
    stages: forestMeta.stages,
    year: activeYear,
    stageStart: yearObj ? yearObj.stageStart : forestMeta.startDate,
    days,
    forests,
    yearly,
    // top-level cap·utilization — 목 고정값. 클라 HUD 동작용.
    dailyCapTokens: MOCK_DAILY_CAP_TOKENS,
    fiveHourPct: MOCK_FIVE_HOUR_PCT,
    sevenDayPct: MOCK_SEVEN_DAY_PCT,
    capSource: MOCK_CAP_SOURCE,
    fiveHourCapTokens: Math.round(MOCK_DAILY_CAP_TOKENS / 2),
    // 목 refMax — 실서버처럼 관측 추적은 안 하고 실측 시드(REFMAX_SEED) 상수.
    refMax: { ...REFMAX_SEED },
    // 목 단계 분모(메타 일관성용). mock day tree 는 정적이라 단계엔 영향 없음.
    dailyMaxTokens: MOCK_DAILY_MAX_TOKENS,
    generatedAt: new Date().toISOString(),
  };
}

function emptyMockPayload(forestMeta) {
  const startDate = forestMeta ? forestMeta.startDate : null;
  const activeYear = forestMeta ? forestMeta.activeYear : null;
  return {
    startDate,
    activeYear,
    stages: forestMeta ? forestMeta.stages : [],
    year: activeYear,
    stageStart: startDate,
    days: {},
    forests: {},
    yearly: {},
    dailyCapTokens: MOCK_DAILY_CAP_TOKENS,
    fiveHourPct: MOCK_FIVE_HOUR_PCT,
    sevenDayPct: MOCK_SEVEN_DAY_PCT,
    capSource: MOCK_CAP_SOURCE,
    fiveHourCapTokens: Math.round(MOCK_DAILY_CAP_TOKENS / 2),
    // 목 refMax — 실측 시드(REFMAX_SEED) 상수.
    refMax: { ...REFMAX_SEED },
    // 목 단계 분모(메타 일관성용).
    dailyMaxTokens: MOCK_DAILY_MAX_TOKENS,
    generatedAt: new Date().toISOString(),
  };
}

// GET /api/forest?mock=1 응답. TTL 캐시(mock/ 은 불변).
export async function getMockForest() {
  const now = Date.now();
  if (cache.payload && now - cache.at < MOCK_TTL_MS) {
    // generatedAt 만 최신으로 갱신(폴링 diff 가 동작하도록은 클라 몫이지만, 캐시여도 새 시각).
    return { ...cache.payload, generatedAt: new Date().toISOString() };
  }
  const payload = await buildMockForest();
  cache = { at: now, payload };
  return payload;
}

// CLI: node server/mock.js --forest → 목 응답을 stdout 에 pretty-print (서버 없이 검증).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain && process.argv.includes('--forest')) {
  getMockForest()
    .then((f) => {
      process.stdout.write(JSON.stringify(f, null, 2) + '\n');
    })
    .catch((err) => {
      process.stderr.write(`mock build failed: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}
