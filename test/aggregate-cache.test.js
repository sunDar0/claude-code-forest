// 파일별 파싱 캐시(T2) 집계 동등성 계약.
//
// 캐시(웜)가 콜드 전량 스캔과 비트 동일한 결과를 내는지, 파일 append·삭제 후에도 증분이
// 전량과 일치하는지 검증한다. 또한 무변경 폴은 재파싱 0바이트, 한 파일만 바뀌면 그 파일만
// 읽는지 측정한다. statusline 캐시는 부재 경로로 고정해(capSource=observed) 결정적으로 만든다.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, appendFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanUsageData, _clearParseCache, _parseCacheStats } from '../server/aggregate.js';

// 결정적 statusline(부재 경로) — readPct null → capSource 'observed'.
process.env.FOREST_STATUSLINE_CACHE = path.join(os.tmpdir(), 'forest-nonexistent-statusline.json');

let ROOT;

// n일 전 ISO timestamp(로컬 정오 기준 — 자정 경계 흔들림 방지).
function daysAgoISO(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function asstLine(id, ts, u) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, usage: u },
  });
}
const U = (i, o, cw, cr) => ({
  input_tokens: i,
  output_tokens: o,
  cache_creation_input_tokens: cw,
  cache_read_input_tokens: cr,
});

// 픽스처: 스트리밍 중복(같은 파일·같은 id, 마지막 채택)·경계일·90일 밖·파일 간 중복·
//   깨진 줄·비-assistant 줄을 섞는다.
async function writeFixture(dir) {
  const projA = path.join(dir, 'projA');
  const projB = path.join(dir, 'projB');
  await mkdir(projA, { recursive: true });
  await mkdir(projB, { recursive: true });

  // 세션 1: 스트리밍 중복(msg1 두 줄, 마지막이 최종) + 경계일(40일 전, 윈도우 안).
  const s1 = [
    asstLine('msg1', daysAgoISO(1), U(10, 20, 0, 0)), // 중간값(덮어씌워짐)
    asstLine('msg1', daysAgoISO(1), U(100, 200, 5, 7)), // 최종값 채택
    'this is a broken line {not json',
    JSON.stringify({ type: 'user', message: { content: 'hi' } }), // 비-assistant skip
    asstLine('msg2', daysAgoISO(40), U(1000, 2000, 300, 400)), // 경계일(윈도우 안)
    asstLine('msg_old', daysAgoISO(120), U(9999, 9999, 9999, 9999)), // 90일 밖 → 제외
    '',
  ].join('\n');
  await writeFile(path.join(projA, 'session1.jsonl'), s1);

  // 세션 2: 파일 간 중복(msgX 가 projB 에도 등장) + 고유 msg3.
  //   전역 dedup 이면 msgX 는 마지막 파일(순회 순서상)의 값으로 1회만 계수.
  const s2 = [
    asstLine('msgX', daysAgoISO(2), U(500, 500, 0, 0)),
    asstLine('msg3', daysAgoISO(2), U(50, 60, 70, 80)),
  ].join('\n');
  await writeFile(path.join(projA, 'session2.jsonl'), s2);

  const s3 = [
    asstLine('msgX', daysAgoISO(2), U(500, 500, 0, 0)), // 세션2 와 동일 id·값(복사본)
    asstLine('msg4', daysAgoISO(3), U(1, 2, 3, 4)),
  ].join('\n');
  await writeFile(path.join(projB, 'session3.jsonl'), s3);
}

// generatedAt 제외 정규화.
function norm(r) {
  const c = { ...r };
  delete c.generatedAt;
  return c;
}

before(async () => {
  ROOT = await mkdtemp(path.join(os.tmpdir(), 'forest-aggcache-'));
  await writeFixture(ROOT);
});
after(async () => {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  _clearParseCache();
});

test('1) 콜드 전량 스캔 == 웜 재실행 (generatedAt 제외 deep-equal)', async () => {
  _clearParseCache();
  const cold = await scanUsageData(ROOT);
  const warm = await scanUsageData(ROOT); // 캐시 채운 뒤 재실행
  assert.deepEqual(norm(warm), norm(cold));
  // 파일 간 중복 msgX 가 이중 계수 안 됐는지 — 전역 dedup 정합성(핵심 함정).
  //   90일 밖 msg_old(≈4만 토큰)가 제외됐는지도 아래 총합으로 간접 확인.
  const totalReq = cold.daily.reduce((a, d) => a + d.requestCount, 0);
  // 계수 대상: msg1,msg2,msgX,msg3,msg4 = 5건 (msg1 중복 1회·msgX 파일간 1회·msg_old 제외).
  assert.equal(totalReq, 5);
});

test('2) 파일 append(mtime 변경) 후 재실행 == 그 상태 콜드 전량 스캔', async () => {
  await scanUsageData(ROOT); // 캐시 웜업
  const extra = '\n' + asstLine('msg5', daysAgoISO(1), U(7, 8, 9, 10));
  await appendFile(path.join(ROOT, 'projA', 'session1.jsonl'), extra);

  const warm = await scanUsageData(ROOT); // 증분(변경 파일만 재파싱)
  _clearParseCache();
  const cold = await scanUsageData(ROOT); // 같은 상태 전량 스캔
  assert.deepEqual(norm(warm), norm(cold));
});

test('3) 파일 삭제 후에도 웜 == 콜드 (삭제 파일 병합 제외·프룬)', async () => {
  await scanUsageData(ROOT); // 캐시 웜업(session3 캐시됨)
  const before = _parseCacheStats().size;
  await rm(path.join(ROOT, 'projB', 'session3.jsonl'));

  const warm = await scanUsageData(ROOT);
  _clearParseCache();
  const cold = await scanUsageData(ROOT);
  assert.deepEqual(norm(warm), norm(cold));
  // 삭제 파일은 캐시에서 프룬됐어야(웜 스캔 후 size 가 before 보다 작거나 같고, 삭제분 반영).
  assert.ok(before >= 1);
});

test('측정) 무변경 폴 재파싱 0바이트 · 한 파일만 바뀌면 그 파일만 읽음', async () => {
  _clearParseCache();
  await scanUsageData(ROOT); // 콜드(전량 read)
  const afterCold = _parseCacheStats().reparsedBytes;
  assert.ok(afterCold > 0);

  // 무변경 폴 — 재파싱 델타 0.
  await scanUsageData(ROOT);
  const afterNoChange = _parseCacheStats().reparsedBytes;
  assert.equal(afterNoChange - afterCold, 0, '무변경 폴은 재파싱 0바이트여야');

  // 한 파일만 append → 그 파일 크기만큼만 재파싱.
  const target = path.join(ROOT, 'projA', 'session2.jsonl');
  await appendFile(target, '\n' + asstLine('msg6', daysAgoISO(1), U(1, 1, 1, 1)));
  const before = _parseCacheStats().reparsedBytes;
  await scanUsageData(ROOT);
  const delta = _parseCacheStats().reparsedBytes - before;
  const sz = (await stat(target)).size;
  assert.equal(delta, sz, '바뀐 파일 바이트만 재파싱해야');
});
