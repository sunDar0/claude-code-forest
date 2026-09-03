// 단위4 식생 트윅 패널 + forestDensityCoef 연결 헤드리스 검증.
//
// 검증 항목(작업 명세 a~g):
//   (a) ?debug(=initVegTweaks 미호출) → 패널 display:none·슬라이더 이벤트 미배선
//   (b) debug(initVegTweaks 호출) → 표시·슬라이더 초기값 = VEG_TWEAKS(getVegTweaks)
//   (c) 슬라이더 input → renderer.setVegTweak 호출(VEG_TWEAKS 갱신)
//   (d) forestDensityCoef 곱 연결 → 군집 density 가 실제로 변함(재베이크)
//   (e) 같은 내용 폴 ×3 → 재베이크 0·무효화 0(§28)
//   (f) 드래그(setVegTweak) 시에만 무효화·재베이크
//   (g) node --check 는 npm 스크립트 밖에서 별도 수행
import { test } from "node:test";
import assert from "node:assert/strict";

import { installGlobals } from "./helpers/stub-canvas.js";
import { forestCellParams } from "../public/js/metrics.js";
import { ForestUI } from "../public/js/ui.js";

const REF_MAX = { input: 300000, output: 120000, cacheWrite: 800000, cacheRead: 5000000, requestCount: 400 };
const CAP = 5000000;

// 묶인 달(2026-04) 셀 6칸 — 군집 density 경로를 태운다. 큰 사용량(monthlyTotal)이라야
//   log10/8 가 1 미만(클램프 전)이어서 forestDensityCoef 가 density 를 실제로 바꾼다.
function bundledFixture() {
  const days = [];
  let i = 0;
  for (let gx = 5; gx <= 7; gx++) {
    for (let gy = 5; gy <= 6; gy++) {
      const date = "2026-04-" + String(++i).padStart(2, "0");
      days.push({
        date, active: true, grid: { gx, gy }, finalized: true,
        usage: { inputTokens: 40000, outputTokens: 18000, cacheWriteTokens: 60000, cacheReadTokens: 800000, requestCount: 80 },
        tree: { stage: "mature", xp: 1500000, stageProgress: 0.5, seed: date, species: 0 },
      });
    }
  }
  const placement = {};
  for (const d of days) placement[d.date] = d.grid;
  // monthly.totalTokens 를 작게 줘 log10/8 ≈ 0.5 정도(클램프 1 미만)로 — coef 효과 관찰용.
  const forests = { "2026-04": { month: "2026-04", bundled: true, monthly: { totalTokens: 50000 } } };
  return { days, placement, forests };
}

function makeRenderer(g) {
  const { days, placement, forests } = bundledFixture();
  return import("../public/js/renderer.js").then(({ ForestRenderer }) => {
    const r = new ForestRenderer(g.makeCanvas());
    r.setForests(forests);
    const cellList = days.map((d) => forestCellParams(d, CAP, REF_MAX));
    r.setData(cellList, null, placement);
    return { r, cellList, placement };
  });
}

test("(b)(d) getVegTweaks 초기값 + forestDensityCoef 곱이 군집 density 를 바꾼다", async () => {
  const g = installGlobals(101);
  try {
    const { r } = await makeRenderer(g);
    // (b) getVegTweaks 가 현재 VEG_TWEAKS 를 노출(기본값).
    const tw = r.getVegTweaks();
    assert.equal(tw.forestDensityCoef, 1.05); // VEG_TWEAKS 기본값 확정(사용자 트윅 세팅 반영)
    assert.equal(tw.shadowRadiusFactor, 0.6);

    // 묶인 달 군집이 생겼는지(density 경로 탔는지).
    assert.ok(r.forestBlobs.length >= 1, "묶인 달 군집이 있어야 함");
    const baseDensity = r.forestBlobs[0].density;
    assert.ok(baseDensity > 0.2 && baseDensity < 1, `density 가 클램프 사이여야 coef 효과 관찰 가능(실제 ${baseDensity})`);

    // (d) coef 0.5 → density 절반쪽으로(클램프 전). setVegTweak 이 _computeForestBlobs 재실행.
    r.setVegTweak("forestDensityCoef", 0.5);
    const half = r.forestBlobs[0].density;
    assert.ok(half < baseDensity - 1e-6, `coef 0.5 → density 감소해야(${baseDensity}→${half})`);

    // coef 2.0 → density 증가(또는 클램프 1).
    r.setVegTweak("forestDensityCoef", 2.0);
    const dbl = r.forestBlobs[0].density;
    assert.ok(dbl > half, `coef 2.0 → density 증가해야(${half}→${dbl})`);
  } finally {
    g.restore();
  }
});

test("(e) 같은 내용 폴 ×3 → 재베이크 0·무효화 0 (§28, 트윅 안 건드림)", async () => {
  const g = installGlobals(202);
  try {
    const { r, cellList, placement } = await makeRenderer(g);
    // 군집 스프라이트가 완성될 때까지 충분히 렌더(예산 분산).
    for (let i = 0; i < 30; i++) r.render();

    const bakes0 = r._forestBakes;
    const spriteBakes0 = r._spriteBakes;
    const snap0 = r._mapSnapshotStale;

    // 같은 cellList·placement 로 3회 재폴(내용 동일 → _contentSig 동일 → 조기반환).
    for (let i = 0; i < 3; i++) r.setData(cellList, null, placement);
    for (let i = 0; i < 5; i++) r.render();

    assert.equal(r._forestBakes, bakes0, "같은 내용 폴인데 군집 재베이크 발생(§28 회귀)");
    assert.equal(r._spriteBakes, spriteBakes0, "같은 내용 폴인데 셀 나무 재베이크 발생(§28 회귀)");
    // 무효화 0: 같은 내용 폴은 setData 가 조기반환 → 스냅샷 stale 표시 안 함.
    assert.equal(r._mapSnapshotStale, snap0, "같은 내용 폴인데 스냅샷 무효화 발생(§28 회귀)");
  } finally {
    g.restore();
  }
});

test("(f) 드래그(setVegTweak) 시에만 무효화/재계산", async () => {
  const g = installGlobals(303);
  try {
    const { r } = await makeRenderer(g);
    for (let i = 0; i < 30; i++) r.render();
    const density0 = r.forestBlobs[0].density;

    // F1: 덩어리 스프라이트 폐기 → forestDensityCoef 는 blob.density 파생값만 재산출(명시적 트윅).
    r.setVegTweak("forestDensityCoef", 0.4);
    for (let i = 0; i < 30; i++) r.render();
    assert.notEqual(r.forestBlobs[0].density, density0, "forestDensityCoef 드래그 후 blob density 재산출돼야 함");

    // 바닥 라이브 키(shadowGrassAtten) 드래그 → blob density 재산출은 없되 스냅샷 무효화는 표시(오버뷰 반영).
    const density1 = r.forestBlobs[0].density;
    r._mapSnapshotStale = false;
    r.setVegTweak("shadowGrassAtten", 0.7);
    assert.equal(r.getVegTweaks().shadowGrassAtten, 0.7);
    assert.equal(r.forestBlobs[0].density, density1, "shadowGrassAtten 는 바닥 라이브라 blob density 불변");
  } finally {
    g.restore();
  }
});

test("(a)(b)(c) ui.initVegTweaks: 미호출=숨김·미배선 / 호출=표시·초기값·input→setVegTweak", async () => {
  // 패널 DOM 스텁(index.html 구조 모사). querySelectorAll/parentElement/addEventListener.
  const calls = [];
  function makeSlider(key, value) {
    const valEl = { textContent: "—" };
    const listeners = {};
    const slider = {
      dataset: { key }, value: String(value),
      parentElement: { querySelector: () => valEl },
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
      _fire: (ev) => listeners[ev] && listeners[ev](),
      _listeners: listeners, _valEl: valEl,
    };
    return slider;
  }
  const sliders = [makeSlider("shadowRadiusFactor", 0), makeSlider("forestDensityCoef", 0)];
  const panel = {
    style: { display: "none" },
    querySelectorAll: () => sliders,
  };
  const origDoc = globalThis.document;
  globalThis.document = { getElementById: (id) => (id === "veg-tweaks" ? panel : null) };
  try {
    const ui = new ForestUI();

    // (a) initVegTweaks 미호출 → 패널 숨김·이벤트 미배선.
    assert.equal(panel.style.display, "none");
    assert.equal(Object.keys(sliders[0]._listeners).length, 0, "미호출인데 이벤트가 붙음");

    // (b) 호출 → 표시·슬라이더 초기값 = renderer.getVegTweaks()[key].
    const rendererStub = {
      getVegTweaks: () => ({ shadowRadiusFactor: 0.6, forestDensityCoef: 1.25 }),
      setVegTweak: (k, v) => calls.push([k, v]),
    };
    ui.initVegTweaks(rendererStub);
    assert.equal(panel.style.display, "block");
    assert.equal(sliders[0].value, "0.6", "슬라이더 초기값 = getVegTweaks");
    assert.equal(sliders[1].value, "1.25");
    assert.equal(sliders[0]._valEl.textContent, "0.60", "현재값 텍스트 동기");

    // (c) input(드래그) → setVegTweak 호출·현재값 텍스트 갱신.
    sliders[1].value = "0.85";
    sliders[1]._fire("input");
    assert.deepEqual(calls.at(-1), ["forestDensityCoef", 0.85], "input → setVegTweak(key,val)");
    assert.equal(sliders[1]._valEl.textContent, "0.85");
  } finally {
    globalThis.document = origDoc;
  }
});
