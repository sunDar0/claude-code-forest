// 시드·수종 단일 진실 소스 (서버 ↔ 클라 공유).
//
// 수종(species)은 달이 묶일 때 day.tree.species 로 동결되므로, 서버와 클라가 같은 seed 에서 비트
//   단위로 같은 수종을 내야 과거 나무가 갈리지 않는다. 그래서 hash32·SPECIES_WEIGHTS·누적분포를
//   이 한 모듈로 합쳐 양쪽이 import 한다.
//
// 환경 중립: Date·Math.imul·charCodeAt 만 쓴다(DOM/Node API 없음). 서버는 ../public/js/seed.js 로,
//   클라는 ./seed.js 로 import 한다(클라가 정적 서빙 루트라 같은 파일을 양쪽이 본다).

// 수종 가중치: 단풍(tree2)·민트(tree4)를 약간 낮춰 자연 군락 느낌. tree0..tree4.
export const SPECIES_WEIGHTS = [24, 24, 14, 24, 14];
export const SPECIES_COUNT = SPECIES_WEIGHTS.length;

// 누적 분포(시드값 0~1 → 수종 인덱스 매핑용).
const SPECIES_CUMW = (() => {
  const sum = SPECIES_WEIGHTS.reduce((a, b) => a + b, 0);
  const cum = [];
  let acc = 0;
  for (const w of SPECIES_WEIGHTS) {
    acc += w / sum;
    cum.push(acc);
  }
  return cum;
})();

/**
 * FNV-1a 32bit 해시(문자열/숫자 공통). 월드 불변 시드.
 * @param {string|number} v 해시 입력
 * @returns {number} 부호 없는 32bit 해시
 */
export function hash32(v) {
  if (typeof v === 'number') return v >>> 0;
  const s = String(v == null ? '' : v);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 수종 인덱스(0..4): 시드 결정적 해시 → 가중 누적분포. 같은 시드 = 같은 수종.
 * @param {string|number} seedVal 시드
 * @returns {number} 수종 인덱스(0..4)
 */
// 해시 마무리 섞기(fmix32, MurmurHash3 finalizer). FNV-1a 는 뒷자리 변화의 확산이 약해
//   같은 달 날짜("2026-06-DD")가 좁은 구간에 뭉쳐 한 수종으로 쏠린다. 한 번 더 섞어 흩뜨린다.
//   hash32 자체는 렌더 시드 등 다른 곳에서 쓰이므로 건드리지 않고, 수종 매핑에서만 적용한다.
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function speciesFor(seedVal) {
  const u = fmix32(hash32(seedVal)) / 4294967296; // 0~1 (마무리 섞기로 뒷자리까지 분산)
  for (let i = 0; i < SPECIES_CUMW.length; i++) {
    if (u < SPECIES_CUMW[i]) return i;
  }
  return SPECIES_COUNT - 1;
}

/**
 * 로컬 시간대 Date → "YYYY-MM-DD". UTC 금지("하루"의 기준선은 로컬 자정).
 * @param {Date} date 변환할 Date
 * @returns {string} "YYYY-MM-DD"
 */
export function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
