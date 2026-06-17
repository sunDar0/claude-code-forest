---
name: claude-usage-aggregation
description: Claude Code 사용량 jsonl 을 일자별로 집계하고 폴링 서버를 만드는 방법. ~/.claude/projects 의 jsonl 스캔, message.id 중복 제거, 로컬일 버킷, GET /api/usage 계약을 다룬다. "사용량 집계", "토큰 집계", "daily usage", "jsonl 파싱", "폴링 서버", "/api/usage", Claude 메트릭 데이터 레이어 작업 시 반드시 이 스킬을 사용할 것. 사용량을 다시 집계/수정/재스캔하는 후속 작업에도 사용.
---

# Claude 사용량 일간 집계

Claude Code 의 실제 사용량은 `~/.claude/projects/<프로젝트>/<세션>.jsonl` 의 각 assistant 메시지 `usage` 필드에 들어있다. 이를 일자별로 집계해 게임 데이터로 쓴다.

기준 구현: `~/work/claudeCode-thirdParty/claude-usage-tracker/electron/claude-wrapper.js` 의 `scanUsageData()`. 새로 짜기 전에 그 코드를 읽고 규칙을 그대로 따른다.

## 왜 단순 합산이 아닌가 (가장 중요)

스트리밍 응답은 **같은 `message.id` 로 여러 jsonl 엔트리**가 기록되고, 마지막 엔트리만 최종 토큰 값을 가진다. 모든 엔트리를 더하면 토큰이 2~3배 부풀려진다. 그래서 2-pass 로 집계한다:

1. **Pass 1 — 중복 제거**: `key = message.id || ("no_id_" + timestamp)` 로 맵에 저장하되 **항상 덮어쓴다**(마지막 값 채택).
2. **Pass 2 — 일자 합산**: 중복 제거된 값만 날짜별로 더한다.

```js
// Pass 1
const messageData = {};
for (const line of lines) {
  const e = JSON.parse(line);
  if (e.type !== 'assistant') continue;
  const u = e.message?.usage;
  if (!u || Object.keys(u).length === 0) continue;
  const t = new Date(e.timestamp);
  if (t < cutoff) continue;                    // 90일 윈도우
  const dateStr = localYMD(t);                 // 로컬일! UTC 아님
  const key = e.message?.id || `no_id_${e.timestamp}`;
  messageData[key] = { dateStr, usage: u };    // 덮어쓰기
}
// Pass 2
const daily = {};
for (const { dateStr, usage } of Object.values(messageData)) {
  const d = (daily[dateStr] ??= { input:0, output:0, cw:0, cr:0, count:0 });
  d.input  += usage.input_tokens || 0;
  d.output += usage.output_tokens || 0;
  d.cw     += usage.cache_creation_input_tokens || 0;
  d.cr     += usage.cache_read_input_tokens || 0;
  d.count  += 1;
}
```

## 날짜는 로컬 캘린더 기준

```js
function localYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;   // getUTC* 쓰지 말 것 — "하루"는 사용자 로컬 자정 기준
}
```

## 출력 계약 (GET /api/usage)

`_workspace/00_architecture.md §1-4` 와 동일. 필드명을 바꾸지 않는다.

```json
{ "daily": [ { "date","totalInputTokens","totalOutputTokens",
  "totalCacheWriteTokens","totalCacheReadTokens","totalTokens","requestCount" } ],
  "generatedAt": "<ISO8601>" }
```

`daily` 는 date 오름차순. `totalTokens` 는 4개 합. `requestCount` 는 중복 제거 후 메시지 수.

## 폴링 서버 (단순 우선)

- Node 표준 라이브러리만: `http`, `fs/promises`, `path`, `os`. 프레임워크 금지.
- 한 프로세스가 `/api/usage`(집계 JSON) + 정적 클라이언트 서빙을 모두 담당.
- 짧은 TTL 캐시(3~5초)로 폴링 폭주 방지. 90일 스캔은 단일 머신 기준 가벼움.
- `--once` CLI 경로로 집계 결과를 stdout 에 찍어 서버 없이 검증 가능하게.

## 방어적 파싱

깨진 줄, 빈 usage, 없는 필드는 조용히 skip(throw 금지). `~/.claude/projects` 부재 시 빈 `daily: []` 폴백(클라이언트가 죽지 않게).

## 흔한 함정

- ❌ 모든 assistant 엔트리 합산 → 중복으로 토큰 부풀림. ✅ message.id 덮어쓰기 먼저.
- ❌ UTC 날짜 → 자정 근처 사용량이 엉뚱한 날로. ✅ 로컬일.
- ❌ `cache_creation_input_tokens` 를 `totalCacheReadTokens` 에 매핑(역) → 계약 위반. 이름 정확히 매핑.
