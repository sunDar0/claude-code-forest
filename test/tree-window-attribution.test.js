// 나무 단계 입력(todayPctSum)의 블록 귀속 계약.
//
// 5h 블록은 "시작 시각(startMs)의 로컬 날짜" 에 귀속된다 — 어젯밤 시작해 자정을 넘긴 블록은
// 어제 것으로 남는다("그날 출근해서 퇴근할 때까지" 를 하루로 본다). 이전 구현은 폴링으로 관측한
// fiveHourPct 봉우리를 누적해, 자정 직후 첫 관측(전날 잔여 %)이 오늘 봉우리로 계상되면서
// 출근 전부터 만근 절반을 깔고 시작하는 결함이 있었다.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanUsageData, _clearParseCache } from '../server/aggregate.js';

// 결정적 statusline(부재 경로) — readPct null → capSource 'observed', treeDailyDenom = p85×2.
process.env.FOREST_STATUSLINE_CACHE = path.join(os.tmpdir(), 'forest-nonexistent-statusline.json');

let ROOT;

// 오늘/어제의 특정 로컬 시각 ISO. 시험이 도는 시각과 무관하게 블록 경계를 고정한다.
function localAtISO(dayOffset, hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d.toISOString();
}

function asstLine(id, ts, totalTokens) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      usage: {
        input_tokens: totalTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

before(async () => {
  ROOT = await mkdtemp(path.join(os.tmpdir(), 'forest-window-attr-'));
  const proj = path.join(ROOT, 'projA');
  await mkdir(proj, { recursive: true });

  // 블록 3개(각각 5시간 이상 벌어져 anchor 가 새로 잡힌다):
  //   어제 20:00 시작 1000 토큰 — 자정을 넘겨 오늘 01:00 까지 이어지는 블록. 어제 귀속.
  //   오늘 02:00 시작  400 토큰
  //   오늘 09:00 시작  600 토큰
  await writeFile(
    path.join(proj, 'session1.jsonl'),
    [
      asstLine('y1', localAtISO(-1, 20), 1000),
      asstLine('t1', localAtISO(0, 2), 400),
      asstLine('t2', localAtISO(0, 9), 600),
    ].join('\n')
  );
  _clearParseCache();
});

after(async () => {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  _clearParseCache();
});

test('자정 넘긴 어제 블록은 오늘 % 합에서 빠진다', async () => {
  const r = await scanUsageData(ROOT);
  // 표본 3개(<8) → robustRef = 블록 최대 1000 → treeDailyDenom = 2000.
  assert.equal(r.treeDailyDenom, 2000);
  // 오늘 시작 블록만: (400 + 600) / 1000 × 100 = 100.
  //   어제 20:00 블록까지 세면 200 이 되어 만근(성목 만개)으로 튄다 — 그게 이전 결함이었다.
  assert.equal(Math.round(r.todayPctSum), 100);
});

test('오늘 시작 블록이 없으면 % 합은 0 (토큰 폴백 경로)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'forest-window-attr2-'));
  const proj = path.join(dir, 'projA');
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, 'session1.jsonl'), asstLine('y1', localAtISO(-1, 20), 1000));
  _clearParseCache();

  const r = await scanUsageData(dir);
  assert.equal(r.todayPctSum, 0);

  _clearParseCache();
  await rm(dir, { recursive: true, force: true });
});
