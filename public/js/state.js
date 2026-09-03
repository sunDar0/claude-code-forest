// 폴링 / 상태
//
//  - GET /api/forest 를 5초마다 fetch. 백엔드가 배치·나무 상태를 소유.
//  - 응답: { startDate, activeYear, year, days{date:{active,grid,usage,tree,finalized}},
//           forests{ym:{...}}, yearly{}, top-level dailyCapTokens/fiveHourPct/sevenDayPct/capSource }.
//  - days → cellList(forestCellParams) + placementMap(active 인 날의 grid). 나머지(forests/yearly)는
//    meta 로 그대로 넘겨 HUD·숲 계층이 직접 소비(클라 재계산 줄임).
//  - 폴링 실패: 직전 상태 유지 + offline=true (렌더 루프는 안 죽음).
//  - 데이터 소스 모드(응답 형태는 셋 다 동일):
//    · 기본(실모드)   = GET /api/forest          (백엔드 data/)
//    · mock 모드        = GET /api/forest?mock=1    (백엔드 mock/ 디렉토리 — read-only)
//    · cold 모드        = 내장 콜드 목(빈 data, startDate=null→시작일 모달)
//
// 클라이언트가 서버 응답 필드를 읽는 유일한 지점이 이 파일이다.

import { forestCellParams } from "./metrics.js";
import { ColdMockSource } from "./cold-source.js";

// 5초 → 15초. 창 최소화·유휴 시에도 setInterval 이 상수 CPU/집계를 유발하던 걸 완화한다.
//   오늘자 usage·나무 반영은 최대 15초 지연(대시보드 허용선, 나무 자람 체감은 유지).
const POLL_MS = 15000;
const API_FOREST = "/api/forest";
const API_FOREST_MOCK = "/api/forest?mock=1"; // 서버 mock/ 서빙
const API_ACTIVATE = "/api/grid/activate";
const API_START = "/api/forest/start"; // 시작일 설정

function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 서버 days{date:day} 응답을 렌더 입력으로 변환한다.
 * @param {Object} daysObj 날짜 키 → day 객체 맵.
 * @param {number} cap 일일 토큰 한도(나무 단계 역산용).
 * @param {Object|null} refMax 메트릭별 관측 최대치(정규화 분모, 없으면 상수 폴백).
 * @returns {{cellList: Object[], placementMap: Object}} cellList=모든 day 의 cellParams(date 오름차순),
 *   placementMap=active 인 날만 {date:{gx,gy}}(배치는 서버 grid 소유, 대기 날은 제외).
 */
function consumeDays(daysObj, cap, refMax) {
  const days = daysObj && typeof daysObj === "object" ? Object.values(daysObj) : [];
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const cellList = [];
  const placementMap = {};
  for (const d of days) {
    if (!d || !d.date) continue;
    const params = forestCellParams(d, cap, refMax); // refMax 정규화 분모(없으면 상수 폴백)
    cellList.push(params);
    if (d.active && d.grid && Number.isFinite(d.grid.gx) && Number.isFinite(d.grid.gy)) {
      placementMap[d.date] = { gx: d.grid.gx, gy: d.grid.gy };
    }
  }
  return { cellList, placementMap };
}

/**
 * GET /api/forest 폴링 + 사용자 액션(활성화·시작일 설정)을 담당하는 상태 컨테이너.
 * 응답을 cellList/placementMap 으로 변환해 onUpdate 콜백으로 렌더에 넘긴다.
 */
export class UsageState {
  /**
   * @param {Object} opts
   * @param {boolean} [opts.mock] mock 모드 — 서버 mock/ API(read-only, POST 안 보냄).
   * @param {boolean} [opts.cold] cold 모드 — 내장 콜드 목(빈 data, 액션 가능).
   */
  constructor({ mock = false, cold = false } = {}) {
    this.mock = mock;        // 서버 mock/ 데이터 소스
    this.cold = cold;        // 내장 콜드 스타트 목
    this.readOnly = mock;    // 서버 mock/ 는 목데이터 보존 위해 POST 안 보냄
    // 폴링 URL: 콜드 목은 코드 생성(URL 없음), mock 은 서버 mock 엔드포인트, 기본은 실 엔드포인트.
    this.fetchUrl = mock ? API_FOREST_MOCK : API_FOREST;
    this.lastSnapshot = null; // 직전 응답(diff·목 액션용)
    this.cellList = [];
    this.placementMap = {};
    this.generatedAt = null;
    this.offline = false;
    // XP/한도 표시값(top-level).
    this.dailyCapTokens = 0;
    this.fiveHourPct = null;
    this.sevenDayPct = null;
    this.capSource = null;
    this.timer = null;
    // 콜드 목 데이터 소스(cold 모드 일 때만). 서버 흉내를 한곳에 모은다. 실모드/mock 은 null.
    this.coldSource = cold ? new ColdMockSource() : null;
    // 콜백: (cellList, changedDates, meta)
    this.onUpdate = null;
  }

  start() {
    this._poll(); // 즉시 1회
    this.timer = setInterval(() => this._poll(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * POST /api/grid/activate {date,gx,gy}. 성공 시 재폴링(서버가 나무 식생 결정).
   * @param {string} date "YYYY-MM-DD" 심을 날짜.
   * @param {number} gx 그리드 x 좌표.
   * @param {number} gy 그리드 y 좌표.
   * @returns {Promise<boolean>} 성공 여부(read-only/실패면 false).
   */
  async activate(date, gx, gy) {
    if (this.readOnly) return false; // read-only — 서버 mock/ 데이터 보존(POST 안 보냄)
    if (this.cold) {
      // 콜드 목: 메모리에서 활성화 흉내(서버 POST 없음).
      this.lastSnapshot = this.coldSource.activate(date, gx, gy, this.lastSnapshot);
      await this._poll();
      return true;
    }
    try {
      const r = await fetch(API_ACTIVATE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, gx, gy }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._poll();
      return true;
    } catch (err) {
      console.warn("activate 실패:", err);
      return false;
    }
  }

  // 숲 묶기는 서버가 월 경계 넘으면 자동 처리(autoBundlePastMonths). 클라는 forests[ym].bundled 로 렌더만.

  /**
   * POST /api/forest/start {date}. startDate 확정(영속·불변). 성공 시 재폴링.
   * @param {string} date "YYYY-MM-DD"(과거~오늘, 클라가 1차 검증·서버가 최종).
   * @returns {Promise<boolean>} 성공 여부.
   */
  async setStartDate(date) {
    if (this.readOnly) return false; // read-only(전체 스테이지 데모, start 불가)
    if (this.cold) {
      this.coldSource.setStartDate(date); // 콜드 목: startDate 기억(영속 흉내), 다음 poll 이 재생성
      await this._poll();
      return true;
    }
    try {
      const r = await fetch(API_START, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._poll();
      return true;
    } catch (err) {
      console.warn("start 실패:", err);
      return false;
    }
  }

  async _poll() {
    let resp;
    try {
      if (this.cold) {
        // cold 모드: 내장 콜드 목. 활성화·시작일·자동 묶기 흉내는 coldSource 가 담당.
        resp = this.coldSource.poll();
      } else {
        // 실모드 또는 mock 모드(서버 mock/). 둘 다 같은 응답 형태, URL 만 다름.
        const r = await fetch(this.fetchUrl, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        resp = await r.json();
      }
    } catch (err) {
      // 실패: 직전 상태 유지 + 오프라인 표식. 렌더는 계속(에러 핸들링 계약).
      this.offline = true;
      if (this.onUpdate) {
        this.onUpdate(this.cellList, new Set(), this._meta(true));
      }
      return;
    }

    this.offline = false;
    // top-level. null 가드.
    const cap = num(resp.dailyCapTokens);
    this.dailyCapTokens = cap;
    this.fiveHourPct = Number.isFinite(resp.fiveHourPct) ? resp.fiveHourPct : null;
    this.sevenDayPct = Number.isFinite(resp.sevenDayPct) ? resp.sevenDayPct : null;
    this.capSource = resp.capSource || null;
    this.generatedAt = resp.generatedAt || new Date().toISOString();

    const prevDays = this.lastSnapshot ? this.lastSnapshot.days : null;
    const changedDates = this._diff(prevDays, resp.days);

    // top-level refMax(메트릭별 관측 최대치, 영속). 없으면 metrics.js 상수 폴백.
    const refMax = resp.refMax && typeof resp.refMax === "object" ? resp.refMax : null;
    const { cellList, placementMap } = consumeDays(resp.days, cap, refMax);
    this.cellList = cellList;
    this.placementMap = placementMap;
    this.lastSnapshot = resp;

    if (this.onUpdate) {
      this.onUpdate(this.cellList, changedDates, this._meta(false));
    }
  }

  /**
   * onUpdate 콜백에 넘길 메타 객체를 만든다(offline 분기 공용).
   * days/forests/yearly 원본을 HUD·숲 계층에 그대로 넘긴다.
   * @param {boolean} offline 폴링 실패 여부.
   * @returns {Object} 표시값 + 서버 원본 필드를 담은 meta.
   */
  _meta(offline) {
    const snap = this.lastSnapshot || {};
    return {
      offline,
      generatedAt: this.generatedAt,
      dailyCapTokens: this.dailyCapTokens,
      fiveHourPct: this.fiveHourPct,
      sevenDayPct: this.sevenDayPct,
      capSource: this.capSource,
      placementMap: this.placementMap,
      // 서버 원본(HUD·숲 계층·활성화 후보 계산용).
      startDate: snap.startDate || null,
      activeYear: snap.activeYear || null,
      year: snap.year || null,
      days: snap.days || {},
      forests: snap.forests || {},
      yearly: snap.yearly || null,
    };
  }

  /**
   * 직전 days 와 비교해 usage 가 바뀐 날짜만 골라낸다(그 셀만 재시뮬).
   * @param {Object|null} prev 직전 폴의 days.
   * @param {Object} next 이번 폴의 days.
   * @returns {Set<string>|null} 바뀐 날짜 Set. 첫 폴이면 null(전부 굽기).
   */
  _diff(prev, next) {
    if (!prev || typeof prev !== "object") return null;
    if (!next || typeof next !== "object") return new Set();
    const changed = new Set();
    for (const date in next) {
      const n = next[date];
      const p = prev[date];
      if (!n) continue;
      const nu = n.usage || {};
      const pu = p ? p.usage || {} : null;
      if (
        !p ||
        !pu ||
        (p.active !== n.active) ||
        (p.tree && n.tree && p.tree.stage !== n.tree.stage) ||
        pu.inputTokens !== nu.inputTokens ||
        pu.outputTokens !== nu.outputTokens ||
        pu.cacheWriteTokens !== nu.cacheWriteTokens ||
        pu.cacheReadTokens !== nu.cacheReadTokens ||
        pu.requestCount !== nu.requestCount
      ) {
        changed.add(date);
      }
    }
    return changed;
  }
}
