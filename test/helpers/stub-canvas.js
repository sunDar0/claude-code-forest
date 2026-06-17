// 헤드리스 렌더 스모크용 스텁 캔버스.
//
// 브라우저 없이 ForestRenderer 를 구동하기 위한 가짜 Canvas/2D 컨텍스트다. 모든 그리기 호출
// (clearRect·fillRect·fillText·drawImage·gradient)과 속성 설정을 **순서대로** 공유 ops 로그에
// 기록한다. 그 로그의 해시가 "그리기 명령 지문" — 고정 입력에 대해 결정적이라, 렌더 코드를
// 리팩토링해도 지문이 같으면 그리기 동작이 보존됐음을 증명한다(의존성 0).
//
// 비결정성은 ambient 파티클의 Math.random 뿐이라, installGlobals 가 Math.random 을 시드 고정한다.

/** 공유 ops 로그. 모든 컨텍스트(메인·백버퍼·오프스크린 베이크)가 한 배열에 시간순으로 쌓는다. */
const ops = [];

/** 숫자를 안정 문자열로(부동소수 잡음 제거). 정수는 그대로, 소수는 3자리. */
function n(v) {
  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return "NaN";
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

/** 그리기 인자를 압축 표기. 캔버스는 W×H, 그라데이션은 grad, 나머지는 숫자/문자열. */
function arg(a) {
  if (a && a.__stubCanvas) return `cv(${a.width}x${a.height})`;
  if (a && a.__stubGradient) return "grad";
  return n(a);
}

/** 기록 컨텍스트. 호출/속성설정을 ops 에 push. 그리는 화면은 없다. */
class RecordingContext {
  constructor(tag) {
    this._tag = tag;
    // 속성 — 설정 시 기록(렌더가 실제로 쓰는 것만; 나머지는 단순 보관).
    const props = [
      "fillStyle", "strokeStyle", "font", "textAlign", "textBaseline",
      "globalAlpha", "lineWidth", "imageSmoothingEnabled", "globalCompositeOperation",
    ];
    for (const p of props) {
      let val;
      Object.defineProperty(this, p, {
        get: () => val,
        set: (v) => { val = v; ops.push(`${this._tag} ${p}=${arg(v)}`); },
      });
    }
  }
  // 그리기 메서드 — 인자 압축해 기록.
  clearRect(...a) { ops.push(`${this._tag} clearRect ${a.map(arg).join(",")}`); }
  fillRect(...a) { ops.push(`${this._tag} fillRect ${a.map(arg).join(",")}`); }
  strokeRect(...a) { ops.push(`${this._tag} strokeRect ${a.map(arg).join(",")}`); }
  fillText(...a) { ops.push(`${this._tag} fillText ${a.map(arg).join(",")}`); }
  drawImage(...a) { ops.push(`${this._tag} drawImage ${a.map(arg).join(",")}`); }
  // 경로 계열(렌더가 거의 안 쓰지만 안전하게 기록).
  beginPath() { ops.push(`${this._tag} beginPath`); }
  closePath() { ops.push(`${this._tag} closePath`); }
  rect(...a) { ops.push(`${this._tag} rect ${a.map(arg).join(",")}`); }
  clip(...a) { ops.push(`${this._tag} clip ${a.map(arg).join(",")}`); }
  moveTo(...a) { ops.push(`${this._tag} moveTo ${a.map(arg).join(",")}`); }
  lineTo(...a) { ops.push(`${this._tag} lineTo ${a.map(arg).join(",")}`); }
  arc(...a) { ops.push(`${this._tag} arc ${a.map(arg).join(",")}`); }
  fill() { ops.push(`${this._tag} fill`); }
  stroke() { ops.push(`${this._tag} stroke`); }
  save() { ops.push(`${this._tag} save`); }
  restore() { ops.push(`${this._tag} restore`); }
  translate(...a) { ops.push(`${this._tag} translate ${a.map(arg).join(",")}`); }
  scale(...a) { ops.push(`${this._tag} scale ${a.map(arg).join(",")}`); }
  setTransform(...a) { ops.push(`${this._tag} setTransform ${a.map(arg).join(",")}`); }
  // 그라데이션 — addColorStop 을 기록하는 스텁 반환.
  createLinearGradient(...a) {
    ops.push(`${this._tag} linGrad ${a.map(arg).join(",")}`);
    return { __stubGradient: true, addColorStop: (o, c) => ops.push(`grad stop ${n(o)},${c}`) };
  }
  createRadialGradient(...a) {
    ops.push(`${this._tag} radGrad ${a.map(arg).join(",")}`);
    return { __stubGradient: true, addColorStop: (o, c) => ops.push(`grad stop ${n(o)},${c}`) };
  }
}

let _cvSeq = 0;
/** 가짜 캔버스. width/height 설정 가능, getContext('2d') → 기록 컨텍스트(캔버스당 1개). */
class StubCanvas {
  constructor() {
    this.__stubCanvas = true;
    this.width = 0;
    this.height = 0;
    this._ctx = new RecordingContext("c" + (_cvSeq++));
  }
  getContext() { return this._ctx; }
  // 프리뷰 dataURL 용 스텁(헤드리스에선 실제 PNG 인코딩 없음 — 형식만 맞춘 고정 문자열).
  toDataURL() { return "data:image/png;base64,STUBPNG"; }
}

/** 시드 PRNG(mulberry32). Math.random 고정용. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 헤드리스 렌더에 필요한 브라우저 전역(document/window)을 깔고 Math.random 을 시드 고정한다.
 * @param {number} [seed] Math.random PRNG 시드.
 * @returns {{ restore: Function, makeCanvas: Function }} restore 로 원복.
 */
function installGlobals(seed = 12345) {
  const origRandom = Math.random;
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  _cvSeq = 0; // 캔버스 태그를 실행마다 0 부터 — 지문이 실행 순서에 불변(결정성).
  Math.random = mulberry32(seed);
  globalThis.document = {
    createElement: (tag) => (tag === "canvas" ? new StubCanvas() : {}),
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 800 };
  return {
    makeCanvas: () => new StubCanvas(),
    restore: () => {
      Math.random = origRandom;
      globalThis.document = origDoc;
      globalThis.window = origWin;
    },
  };
}

/** ops 로그 비우기(렌더 직전 호출). */
function resetOps() { ops.length = 0; }
/** 현재 ops 로그(배열 참조). */
function getOps() { return ops; }
/** ops 로그를 FNV-1a 32bit 해시로(지문). */
function fingerprint() {
  let h = 2166136261 >>> 0;
  const s = ops.join("\n");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

export { installGlobals, resetOps, getOps, fingerprint, StubCanvas };
