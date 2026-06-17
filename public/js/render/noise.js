// 월드 좌표 값 노이즈. 정수 격자 해시 → smoothstep 보간 → 2옥타브 fbm.
//   입력이 월드 좌표라 팬에 불변(카메라 무관)·결정적. 순수 함수 — 캔버스·상태 무관.
//   나무 시드 해시(FNV-1a)는 seed.js hash32 를 쓴다(중복 제거).

/**
 * 정수 격자점(ix,iy) → 0~1 의사난수. 월드 좌표 기반(팬 불변).
 * @param {number} ix
 * @param {number} iy
 * @returns {number} 0~1 의사난수
 */
export function vhash(ix, iy) {
  let h = ((ix | 0) * 374761393) ^ ((iy | 0) * 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * 값 노이즈: 정수 격자 해시 + smoothstep 보간. 입력 = 월드 좌표(float).
 * @param {number} x 월드 x
 * @param {number} y 월드 y
 * @returns {number} 0~1
 */
export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); // smoothstep
  fy = fy * fy * (3 - 2 * fy);
  const a = vhash(ix, iy), b2 = vhash(ix + 1, iy);
  const c = vhash(ix, iy + 1), d = vhash(ix + 1, iy + 1);
  const top = a + (b2 - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy; // 0~1
}

/**
 * fbm(2옥타브, 가벼움). seedOff 로 x/y 노이즈를 탈상관(도메인 워프 2축).
 * @param {number} x 월드 x
 * @param {number} y 월드 y
 * @param {number} [seedOff] 탈상관 오프셋
 * @returns {number} 0~1 근사
 */
export function fbm(x, y, seedOff) {
  const s = seedOff || 0;
  let v = vnoise(x + s, y - s) * 0.6;
  v += vnoise(x * 2.13 - s, y * 2.13 + s) * 0.4;
  return v; // ~0~1
}
