// 나무·바위 스프라이트 에셋 파이프라인.
//
// 사용자가 제작한 스프라이트 시트를 비동기 로드해, 수종 5종 × 단계 10프레임(sprite_{species}_{0..9})을
// frame 조회로 제공한다. 렌더-데이터 분리: 이 모듈은 이미지·좌표만 안다(게임 상태·카메라 무관).
//   - 로드 전: ready=false → 렌더러가 절차 아트 폴백.
//   - 로드 완료: onReady 콜백 1회 → 렌더러가 스프라이트 캐시 전체 무효화 후 시트로 전환.
//   - 로드 실패: ready 영원히 false → 절차 아트 유지(폴백 전용).
//
// 10프레임 = 사용자에게 보이는 10단계(묘목1~3·유목1~3·성목1~4). 단, 데이터 계약은 매크로 3종
//   (sapling/young/mature)+stageProgress 그대로다 — 10단계는 렌더가 stage+stageProgress 로 하위
//   프레임을 파생해 만든다(frameNameForStage). 좌표 json 의 image 필드는 무시하고 렌더러가 넘기는
//   png 경로를 쓴다.

// 수종 산식(speciesFor·가중치)은 서버와 공유하는 단일 소스. import 로만 쓴다.
import { speciesFor as speciesForSeed, SPECIES_COUNT } from "./seed.js";

const STAGE_FRAMES = 10; // sprite_S_0..9 (절대 프레임)

/**
 * 나무 스프라이트 시트 로더. 수종 5종 × 10프레임(sprite_{species}_{0..9})을 비동기 로드·조회한다.
 */
export class SpriteSheet {
  constructor() {
    this.ready = false; // 이미지+좌표 모두 로드되면 true
    this.failed = false; // 로드 실패(폴백 전용 고정)
    this.image = null; // HTMLImageElement
    this.frames = new Map(); // "sprite_{species}_{0..9}" → {x,y,w,h}
    this._onReady = []; // 로드 완료 콜백(렌더러 캐시 무효화)
  }

  /**
   * 시트 로드 시작. 이미지+좌표 둘 다 받아야 ready. 실패 시 failed=true(폴백). 멱등(중복 호출 무시).
   * @param {string} imgUrl png 경로
   * @param {string} coordsUrl 좌표 json 경로
   */
  load(imgUrl, coordsUrl) {
    if (this._loading || this.ready) return;
    this._loading = true;
    let coordsOk = false;
    let imgOk = false;
    const finish = () => {
      if (coordsOk && imgOk) {
        this.ready = true;
        const cbs = this._onReady.slice();
        this._onReady.length = 0;
        for (const cb of cbs) {
          try { cb(); } catch (_) { /* 콜백 오류가 로드를 깨지 않게 */ }
        }
      }
    };
    // 좌표 JSON.
    fetch(coordsUrl)
      .then((r) => r.json())
      .then((j) => {
        for (const f of j.frames || []) {
          this.frames.set(f.name, { x: f.x, y: f.y, w: f.w, h: f.h });
        }
        coordsOk = true;
        finish();
      })
      .catch(() => { this.failed = true; });
    // 이미지.
    const img = new Image();
    img.onload = () => { this.image = img; imgOk = true; finish(); };
    img.onerror = () => { this.failed = true; };
    img.src = imgUrl;
  }

  // 로드 완료 콜백 등록. 이미 ready 면 즉시 호출.
  onReady(cb) {
    if (this.ready) cb();
    else this._onReady.push(cb);
  }

  // 수종 인덱스(0..4). 공유 모듈(seed.js)에 위임 — 서버와 동일 결과 보장.
  speciesFor(seedVal) {
    return speciesForSeed(seedVal);
  }

  /**
   * 매크로 stage + stageProgress → 절대 프레임 이름(sprite_{species}_{0..9}).
   *   SAPLING(1) → 0/1/2, YOUNG(2) → 3/4/5, MATURE(3) → 6/7/8/9.
   *   하위 프레임은 stageProgress 를 균등 분할(묘목·유목 3등분, 성목 4등분)로 파생한다.
   *   데이터 계약(매크로 3종+stageProgress)은 불변 — 10단계는 여기서만 만들어진다.
   * @param {number} species 수종 인덱스(0..4)
   * @param {number} stageEnum 내부 STAGE(1=SAPLING,2=YOUNG,3=MATURE)
   * @param {number} stageProgress 단계 진행(0~1)
   * @returns {string} 프레임 이름("sprite_{species}_{0..9}")
   */
  frameNameForStage(species, stageEnum, stageProgress) {
    const p = Number.isFinite(stageProgress) ? Math.max(0, Math.min(1, stageProgress)) : 0;
    let frameIdx;
    if (stageEnum === 1) frameIdx = 0 + Math.max(0, Math.min(2, Math.floor(p * 3))); // SAPLING → 0/1/2
    else if (stageEnum === 2) frameIdx = 3 + Math.max(0, Math.min(2, Math.floor(p * 3))); // YOUNG → 3/4/5
    else if (stageEnum === 3) frameIdx = 6 + Math.max(0, Math.min(3, Math.floor(p * 4))); // MATURE → 6/7/8/9
    else frameIdx = 0; // EMPTY 등(호출 안 되지만 방어)
    return "sprite_" + species + "_" + frameIdx;
  }

  // 프레임 rect 조회. 없으면 null(폴백).
  frame(name) {
    return this.frames.get(name) || null;
  }
  frameFor(species, stageEnum, stageProgress) {
    return this.frame(this.frameNameForStage(species, stageEnum, stageProgress));
  }
}

// 바위 프레임 가중치(낮은 번호 = 작은 돌 흔함, 높은 번호 = 큰 세로 바위 희귀).
//   sprite_0_0(작은 돌) 42% → sprite_0_4(큰 바위) 4% 단조 감소.
const ROCK_WEIGHTS = [42, 27, 17, 10, 4];

/**
 * 바위 스프라이트 시트 로더(놓인 바위 장식). SpriteSheet 와 같은 비동기 로드·폴백 패턴.
 *   5프레임 sprite_0_0..sprite_0_4(작은 돌→큰 세로 바위). 수종·단계 매핑 없이 인덱스(0..4)로 조회.
 */
export class RockSheet {
  constructor() {
    this.ready = false;
    this.failed = false;
    this.image = null;
    this.frames = []; // [{x,y,w,h}] (sprite_0_0..4 순서)
    this._onReady = [];
    // 누적 분포(가중 프레임 선택용).
    const sum = ROCK_WEIGHTS.reduce((a, b) => a + b, 0);
    this._cumW = [];
    let acc = 0;
    for (const w of ROCK_WEIGHTS) { acc += w / sum; this._cumW.push(acc); }
  }
  load(imgUrl, coordsUrl) {
    if (this._loading || this.ready) return;
    this._loading = true;
    let coordsOk = false, imgOk = false;
    const finish = () => {
      if (coordsOk && imgOk) {
        this.ready = true;
        const cbs = this._onReady.slice();
        this._onReady.length = 0;
        for (const cb of cbs) { try { cb(); } catch (_) { /* 콜백 오류 격리 */ } }
      }
    };
    fetch(coordsUrl)
      .then((r) => r.json())
      .then((j) => {
        // sprite_0_{i} 순서대로 인덱스 배열에 담는다(coords 순서 의존 안 함).
        const map = new Map();
        for (const f of j.frames || []) map.set(f.name, { x: f.x, y: f.y, w: f.w, h: f.h });
        for (let i = 0; i < 5; i++) {
          const fr = map.get("sprite_0_" + i);
          if (fr) this.frames[i] = fr;
        }
        coordsOk = this.frames.length > 0;
        if (coordsOk) finish(); else this.failed = true;
      })
      .catch(() => { this.failed = true; });
    const img = new Image();
    img.onload = () => { this.image = img; imgOk = true; finish(); };
    img.onerror = () => { this.failed = true; };
    img.src = imgUrl;
  }
  onReady(cb) { if (this.ready) cb(); else this._onReady.push(cb); }
  count() { return this.frames.length; }
  // 인덱스(0..4) → 프레임 rect. 범위 밖이면 null.
  frameByIndex(i) {
    const n = this.frames.length;
    if (n === 0) return null;
    return this.frames[((i % n) + n) % n] || null;
  }
  /**
   * 가중 프레임 인덱스(0..4): 누적분포로 낮은 번호 많고 높은 번호 적게. 결정적.
   * @param {number} u 시드값 ∈[0,1)
   * @returns {number} 프레임 인덱스
   */
  weightedIndex(u) {
    for (let i = 0; i < this._cumW.length; i++) {
      if (u < this._cumW[i]) return i;
    }
    return this._cumW.length - 1;
  }
}

// 싱글턴(앱 전역 1장). 렌더러가 import 후 load() 호출.
export const sheet = new SpriteSheet();
// 바위 시트 싱글턴(앱 전역 1장).
export const rockSheet = new RockSheet();
export { SPECIES_COUNT, STAGE_FRAMES };
