// 도트 렌더 팔레트. 색 상수만 — 의존 0의 순수 데이터.
//
// PAL = 활성(현재) 톤, PAL_PAST = 묶인 과거 톤(차분하되 잘 보이게). LEAF_* = 잎 오버레이 색 테이블.

// 밝은 팔레트.
export const PAL = {
  skyTop: "#7ec8f0",
  skyBot: "#bfe6f7",
  cloud: "#f4fbff",
  // 잔디: 체커 대비를 거의 없앰(연속 풀밭). A/B 명도차 미세.
  grassA: "#5aa83c",
  grassB: "#57a43a",
  grassC: "#5dab40", // 활성 풀밭 3톤 결(A/B/C 미세 명도·채도차 — 흙 pendDirt 3색과 같은 방식)
  grassBlade1: "#6cbd49", // 풀잎 밝은 결
  grassBlade2: "#4f9a34", // 풀잎 어두운 결
  grassSpeck: "#74c451", // 밝은 점
  dirt: "#9c6b3f",
  dirtB: "#946540",
  dirtSpeck1: "#84572f", // 흙 얼룩(어두운)
  dirtSpeck2: "#b08456", // 흙 얼룩(밝은)
  // 비활성(대기) 그리드 바닥: 진한 흙색톤(미개척 느낌, 격자 안 비치게) + 잡초.
  pendDirtA: "#8a6238", // 진한 흙 베이스 A(무작위 3종)
  pendDirtB: "#825b33", // 진한 흙 베이스 B(무작위 3종)
  pendDirtC: "#785530", // 진한 흙 베이스 C(무작위 3종)
  pendDirtSpeck1: "#6f4d2a", // 흙 얼룩(어두운)
  pendDirtSpeck2: "#9c7245", // 흙 얼룩(밝은)
  pendWeed1: "#5f7d35", // 잡초(칙칙한 녹색)
  pendWeed2: "#7a9646", // 잡초(밝은)
  // 차단 칸(닫힘) = 바위/절벽 바닥. 차가운 회청색 돌(비활성 갈색 흙과 구분).
  rockA: "#6a6e74", // 바위 베이스 A(무작위 3종)
  rockB: "#5f636a", // 바위 베이스 B
  rockC: "#73767d", // 바위 베이스 C
  rockDark: "#474a50", // 균열·그늘(어두운 돌)
  rockLight: "#8b8e95", // 모서리 하이라이트(밝은 돌)
  rockMoss: "#5a7a44", // 바위에 낀 이끼(녹색)
  // 물 웅덩이(순수 장식). 가장자리 이끼 + 물 + 반짝.
  waterDeep: "#2f6e8a", // 물 깊은 톤
  waterMid: "#3f88a8", // 물 중간 톤
  waterShine: "#bfe6f0", // 수면 반짝(하늘 반사)
  waterEdge: "#4a6a3a", // 웅덩이 가장자리 이끼/진흙
  gridBorder: "rgba(40,70,30,0.5)", // 그리드(3×3=하루) 외곽 — 또렷하되 과하지 않게
  trunk: "#7d4d28",
  trunkDark: "#54331a",
  trunkLight: "#9c6536",
  trunkBark: "#3f2614", // 세로 껍질 결(어두운 줄)
  // 수관 세로 음영 램프 (아래 어둠 → 위 밝음). 더 채도 높고 밝게.
  leafShadow: "#1f5224", // 맨 아래 그늘
  leafDark: "#2f7a2e",
  leafMid: "#46a23c",
  leafLight: "#62c24c",
  leafHi: "#86dd64", // 상단 하이라이트
  leafSpec: "#b6f58c", // 광택 점
  // 차가운 그늘(hue 청록·남보라 시프트): 단의 아랫면·수관 하단 깊은 그늘에 쓴다.
  //   단순 어두운 초록이 아니라 차가운 톤(green→teal→남색)으로 밑면을 식힌다.
  leafCool: "#1d5a4e", // 청록 그늘(단 아랫면)
  leafCoolDeep: "#163a52", // 남보라 깊은 그늘(수관 하단·몸통 접합부)
  leafTierCap: "#9be86f", // 단(티어) 윗면 밝은 캡(부채꼴 단의 밝은 윗면)
  sapCore: "#fff7b0", // 거의 흰빛 도는 밝은 금색 코어(또렷)
  sapMid: "#ffd23a", // 금색
  sapGlow: "#fff3c0", // Glow
  sapVein: "#ffcf4a", // 기둥 속 정적 금색 혈관
  sapVeinHot: "#fff2a0", // 혈관 밝은 심
};

// 고목(과거) 나무용 — 차분하되 잘 보이게(어둡지 않게).
export const PAL_PAST = {
  trunk: "#6e4626",
  trunkDark: "#4c321b",
  trunkLight: "#8a5c33",
  trunkBark: "#3a2412",
  leafShadow: "#2a5a2c",
  leafDark: "#3a7338",
  leafMid: "#4d9145",
  leafLight: "#67ad55",
  leafHi: "#7fc169",
  leafSpec: "#9bd180",
  // 차가운 그늘(과거 톤, 조금 더 차분).
  leafCool: "#27564b",
  leafCoolDeep: "#1f3a4a",
  leafTierCap: "#86bf6e",
  // 숲 바닥 = 활성 그리드 풀밭과 같은 초록(PAST 보정: 채도·명도 약간 낮춤). 묶인 과거 달도
  //   "어두운 흙 음영 덩어리"가 아니라 명확한 초록 풀밭으로 보이게.
  grassA: "#4f9436", // 활성 grassA(#5aa83c)에서 약간 어둡게·탈채도
  grassB: "#4d9134", // PAST 풀밭 3톤(묶인 숲 바닥 일관)
  grassC: "#519639", // PAST 풀밭 3톤
  grassBlade1: "#5fa840", // 풀잎 밝은 결
  grassBlade2: "#458a30", // 풀잎 어두운 결
  grassSpeck: "#67b048", // 밝은 점
};

// 수종별 잎 오버레이 색(상수 테이블). 매 프레임 스프라이트 픽셀 샘플 금지 — 흔들 잎·낙엽·반짝임은
//   이 상수만 쓴다. species 0..4 = sprites.js (초록·연두·단풍·진청록·민트) 와 같은 순서.
//   [bright, dark] 2톤. 활성 톤 기준(과거 나무는 오버레이 대상 아님).
export const LEAF_PAL = [
  ["#62c24c", "#3c8a36"], // 0 초록
  ["#8bd859", "#5aa83c"], // 1 연두
  ["#e6a23c", "#c06a28"], // 2 단풍(주황)
  ["#3fae8e", "#247a63"], // 3 진청록
  ["#7fe0c0", "#4caa8c"], // 4 민트
];
export const LEAF_HI = "#d8ffb0"; // 햇빛 반짝 하이라이트(잎 위 밝은 점, 수종 공용·은은)
/**
 * 수종 인덱스 → [bright, dark] 잎 오버레이 색. 범위 밖은 모듈로 래핑.
 * @param {number} species 수종 인덱스
 * @returns {string[]} [bright, dark]
 */
export function leafPalFor(species) {
  const i = (species | 0) % LEAF_PAL.length;
  return LEAF_PAL[(i + LEAF_PAL.length) % LEAF_PAL.length];
}

/**
 * #rrggbb → {r,g,b}. 하늘 그라데이션·수관 음영 보간용.
 * @param {string} s "#rrggbb"
 * @returns {{r:number,g:number,b:number}}
 */
export function hexToRgb(s) {
  return {
    r: parseInt(s.slice(1, 3), 16),
    g: parseInt(s.slice(3, 5), 16),
    b: parseInt(s.slice(5, 7), 16),
  };
}

/**
 * 두 #rrggbb 를 t(0~1)로 선형 보간한 "rgb(r,g,b)" 문자열.
 * @param {string} a 시작 색 "#rrggbb"
 * @param {string} c 끝 색 "#rrggbb"
 * @param {number} t 보간 계수 0~1
 * @returns {string} "rgb(r,g,b)"
 */
export function mixHex(a, c, t) {
  const x = hexToRgb(a), y = hexToRgb(c);
  return `rgb(${(x.r + (y.r - x.r) * t) | 0},${(x.g + (y.g - x.g) * t) | 0},${(x.b + (y.b - x.b) * t) | 0})`;
}
