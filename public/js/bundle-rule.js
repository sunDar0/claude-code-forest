// 자동 숲묶기 규칙 — 단일 비교 술어.
//
// "묶기 대상 = 현재월 이전 달" 규칙을 한 곳에 고정한다. 서버·목·콜드 세 계층이
// 같은 규칙을 복제하던 것을 이 술어로 통일한다(동작 비트 동일: 셋 다 `X < 현재월`).
//
// 현재월(currentYm) 계산은 **공유하지 않는다** — 계층마다 입력이 다르기 때문이다.
//   - 서버:   todayLocalYMD().slice(0,7)
//   - 클라:   new Date() 로컬월
// 비교 술어(이 함수)만 공유하고, 현재월은 각 계층이 자기 방식으로 구해 넘긴다.

/**
 * 그 달이 묶기 대상(현재월 이전)인지 판정한다.
 *   YYYY-MM 문자열은 사전식 비교가 시간순과 일치하므로 `<` 가 곧 "이전 달".
 * @param {string} ym 검사할 달 "YYYY-MM".
 * @param {string} currentYm 현재월 "YYYY-MM"(계층별로 계산해 전달).
 * @returns {boolean} ym 이 currentYm 보다 이전이면 true(묶기 대상).
 */
export function isPastMonth(ym, currentYm) {
  return ym < currentYm;
}
