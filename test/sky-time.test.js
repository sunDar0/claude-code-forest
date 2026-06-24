// 시간대 하늘(작업 3) — skyColorsAt 순수성·결정성·정오 골든·보간 연속성 검증.
//
// render-smoke 의 골든 픽스처는 카메라가 지평선 위로 올라가 하늘이 안 그려진다(hY<=0 return).
// 그래서 골든 지문은 하늘 변경을 못 잡는다 → 시간대 하늘 회귀는 이 단위 테스트가 가드한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { skyColorsAt, hexToRgb, PAL } from "../public/js/render/palette.js";

const eqRgb = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b;

test("skyColorsAt: 순수·결정적(같은 hour → 같은 색)", () => {
  for (const h of [0, 3.25, 6, 9.9, 12, 15.5, 18, 21.7, 23.99]) {
    assert.deepEqual(skyColorsAt(h), skyColorsAt(h), `h=${h} 비결정`);
  }
});

test("skyColorsAt: 정오(12) = 기존 PAL.skyTop/skyBot (정오 골든 보존)", () => {
  const noon = skyColorsAt(12);
  assert.ok(eqRgb(noon.skyTop, hexToRgb(PAL.skyTop)), "정오 skyTop 이 PAL.skyTop 과 달라짐");
  assert.ok(eqRgb(noon.skyBot, hexToRgb(PAL.skyBot)), "정오 skyBot 이 PAL.skyBot 과 달라짐");
});

test("skyColorsAt: 24시=0시 wrap 으로 하루가 닫힘", () => {
  assert.deepEqual(skyColorsAt(24), skyColorsAt(0));
  // 23.99 시는 0시에 거의 도달(연속).
  const near = skyColorsAt(23.99), zero = skyColorsAt(0);
  const d = Math.abs(near.skyTop.r - zero.skyTop.r) + Math.abs(near.skyBot.r - zero.skyBot.r);
  assert.ok(d <= 2, `23.99→0 단차 큼(${d})`);
});

test("skyColorsAt: 범위 밖 hour 는 24 모듈로 래핑", () => {
  assert.deepEqual(skyColorsAt(25), skyColorsAt(1));
  assert.deepEqual(skyColorsAt(-2), skyColorsAt(22));
});

test("skyColorsAt: 인접 시각 색 연속(키프레임 경계 포함 점프 작음)", () => {
  // 0~24 를 3분(0.05h) 간격으로 스윕, 채널합 점프가 임계 이하.
  let prev = skyColorsAt(0), maxJump = 0;
  for (let h = 0.05; h <= 24.0001; h += 0.05) {
    const c = skyColorsAt(h);
    const j = Math.abs(c.skyTop.r - prev.skyTop.r) + Math.abs(c.skyTop.g - prev.skyTop.g) + Math.abs(c.skyTop.b - prev.skyTop.b)
            + Math.abs(c.skyBot.r - prev.skyBot.r) + Math.abs(c.skyBot.g - prev.skyBot.g) + Math.abs(c.skyBot.b - prev.skyBot.b);
    if (j > maxJump) maxJump = j;
    prev = c;
  }
  // 가장 짧은 키프레임 구간(18→22, 4h)에서도 0.05h 당 채널합 점프는 한 자릿수여야 함.
  assert.ok(maxJump <= 12, `시각 보간 단차 큼(maxJump=${maxJump}) — 매끄럽지 않음`);
});

test("skyColorsAt: 야간(0시)이 검정이 아님(콘텐츠 대비 유지)", () => {
  // 야간 남색이 너무 어두우면 금가루·붉은 깃발·나무가 묻힌다. skyTop 합 > 일정 하한.
  const night = skyColorsAt(0);
  const sum = night.skyTop.r + night.skyTop.g + night.skyTop.b;
  assert.ok(sum >= 100, `야간 skyTop 이 너무 어두움(rgb 합 ${sum}) — 콘텐츠 묻힘 위험`);
});
