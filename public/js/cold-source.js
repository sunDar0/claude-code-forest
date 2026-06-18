// 콜드 목 데이터 소스 (cold 모드).
//
// 서버 없이 빈 지도에서 시작해 활성화·시작일·자동 숲묶기를 메모리에서 흉내낸다.
// 서버 규칙(autoBundlePastMonths 등)을 시험용으로 클라에서 재현하므로, 서버가 바뀌면 여기도
// 맞춰야 한다(드리프트 주의). 콜드 목의 데이터 생성·런타임을 이 한 파일에 모은다.

import { isPastMonth } from "./bundle-rule.js";

const MOCK_DAILY_CAP = 14_000_000; // 콜드 목 HUD cap. 콜드 스타트는 빈 data 라 영향 적음.
// 콜드 목 단계 분모(일일누적 역대최대). 콜드 activate 는 tree.stage=empty 로만 만들어
//   단계 분모를 실질 안 쓰지만, 실서버 dailyMaxTokens 노출과 메타 일관성을 맞춘다.
const MOCK_DAILY_MAX = 494_853_000;

/**
 * 콜드 스타트 목 응답: 빈 data + startDate(미정이면 null → 시작일 모달 트리거).
 *   모달 확정 후 startDate 를 주면 그 값으로 내려보낸다(영속 흉내).
 * @param {string|null} [startDate=null] 시작일("YYYY-MM-DD") 또는 null(미정).
 * @returns {Object} forest 응답 형태의 목 객체.
 */
function mockColdResponse(startDate = null) {
  return {
    startDate, // null = 미정(모달). 모달 확정 후엔 그 날짜.
    activeYear: 2026,
    stages: [2026],
    year: 2026,
    stageStart: startDate,
    days: {}, // 콜드 스타트: 아직 심긴 날 없음
    forests: {},
    yearly: {},
    // top-level — 오늘 단계·HUD 5h/7d 표시용.
    dailyCapTokens: MOCK_DAILY_CAP,
    fiveHourPct: 62,
    sevenDayPct: 78,
    fiveHourCapTokens: MOCK_DAILY_CAP / 2,
    capSource: "observed",
    // 단계 분모(메타 일관성용). 콜드 tree 는 empty 라 단계엔 영향 없음.
    dailyMaxTokens: MOCK_DAILY_MAX,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * cold 모드 모드의 데이터 소스. UsageState 가 cold 일 때 폴링·액션을 이 객체에 위임한다.
 */
export class ColdMockSource {
  constructor() {
    this.startDate = null; // 시작일 모달 확정값(영속 흉내). null 이면 시작일 모달 표시.
    this.override = null;  // 활성화 흉내 후 다음 poll 이 쓸 스냅샷.
  }

  /**
   * 시작일 확정. 다음 poll 이 새 startDate 로 콜드 응답을 다시 만든다.
   * @param {string} date "YYYY-MM-DD".
   */
  setStartDate(date) {
    this.startDate = date;
    this.override = null;
  }

  /**
   * 활성화 흉내: 그날을 active 로 바꾸고 grid 좌표를 지정한다. 스냅샷을 제자리 수정해 돌려준다.
   * 실서버처럼 그 달 forests 엔트리(bundled:false)도 만들어, 다음 poll 의 자동 묶기 대상이 되게 한다.
   * @param {string} date "YYYY-MM-DD".
   * @param {number} gx 그리드 x.
   * @param {number} gy 그리드 y.
   * @param {Object|null} lastSnapshot 직전 응답(없으면 새 콜드 응답 생성).
   * @returns {Object} 수정된 스냅샷(호출자가 lastSnapshot 으로 설정).
   */
  activate(date, gx, gy, lastSnapshot) {
    const snap = lastSnapshot || mockColdResponse(this.startDate);
    snap.days = snap.days || {};
    const existing = snap.days[date] || {
      date,
      usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requestCount: 0 },
      tree: { stage: "empty", xp: 0, stageProgress: 0, seed: date },
      finalized: false,
    };
    existing.active = true;
    existing.grid = { gx, gy };
    snap.days[date] = existing;
    const ym = date.slice(0, 7);
    snap.forests = snap.forests || {};
    if (!snap.forests[ym]) snap.forests[ym] = { month: ym, bundled: false, bundledAt: null, monthly: null };
    this.override = snap;
    return snap;
  }

  /**
   * 폴링 1회분 콜드 응답을 만든다(자동 숲묶기 적용 후).
   * @returns {Object} 콜드 응답 스냅샷.
   */
  poll() {
    const resp = this.override || mockColdResponse(this.startDate);
    this._autoBundle(resp);
    return resp;
  }

  /**
   * 서버 autoBundlePastMonths 흉내: 현재월보다 이전이고 데이터가 있는 달을 무조건 bundled=true 로.
   * @param {Object} snap 콜드 응답 스냅샷(forests 를 제자리 수정).
   */
  _autoBundle(snap) {
    if (!snap || !snap.forests) return;
    const d = new Date();
    const curYm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    for (const ym in snap.forests) {
      const f = snap.forests[ym];
      if (!f || f.bundled) continue;
      if (isPastMonth(ym, curYm)) {
        f.bundled = true;
        f.bundledAt = f.bundledAt || new Date().toISOString();
      }
    }
  }
}
