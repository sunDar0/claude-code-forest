# Claude Code Forest

Claude Code의 일간 LLM 사용량을 절차적 도트 그래픽 숲으로 치환해 보여주는 로컬 폴링 대시보드. **하루 = 나무 한 그루.**

## 실행 (설치 없음, 의존성 0)

Node 18+ 만 있으면 됩니다. 외부 패키지를 받지 않으므로 `npm install` 이 필요 없습니다.

```bash
npm start
# 또는
node server/index.js
```

그 다음 브라우저에서:

```
http://localhost:5178
```

포트를 바꾸려면 `PORT` 환경변수를 줍니다.

```bash
PORT=8080 node server/index.js
```

## 동작

서버 한 프로세스가 data 영속 + API + 정적 서빙을 합니다. 부팅 시 `data/` 를 메모리에 로드하고, 없으면 `data/forest.json` 을 시작일 미정(`startDate:null`)으로 생성합니다. 첫 실행 때 클라이언트가 시작일 모달로 날짜를 입력받아 영속합니다(§21).

### §18 data API (주 계약)

- `GET /api/forest` — 전역 메타 + 일/월/년 계층 전체(렌더용)를 메모리에서 즉답. top-level 에 `dailyCapTokens`·`fiveHourPct`·`sevenDayPct`·`capSource` 동봉.
- `POST /api/grid/activate` body `{date,gx,gy}` — 그리드 활성화(자리 잡기). 그날 사용량으로 나무 식생 결정, 사용량 0이면 빈 땅. 좌표 중복·비인접·미래는 400 거부.
- 숲 묶기는 **자동**입니다(§55). 서버가 부팅·폴마다 지난 달을 완주 여부와 무관하게 숲으로 묶습니다(`autoBundlePastMonths`). 별도 수동 묶기 API/버튼은 폐기됐습니다.

`data/` 는 서버가 소유합니다(오늘 하루치는 jsonl 변동을 반영해 갱신, 과거는 동결). 갱신 시 오늘 파일 1개만 기록합니다.

### 호환 + 정적

- `GET /api/usage` — 기존 §1-4 `daily[]` 집계(호환 유지). 90일 재귀 스캔, 4초 TTL 캐시.
- `public/` 정적 서빙 — 기본 `index.html` (클라이언트 Canvas 렌더러).

## 화면에서 일어나는 일 (게임 플레이)

매일 그리드 한 칸을 활성화해 그날 사용량을 나무로 심고, 달이 지나면 그 달이 자동으로 숲으로 묶입니다.

### 그리드 활성화 (하루 = 나무 한 그루)

- 시작일을 정하면 시작일~오늘 사이 미배치 날을 가장 오래된 순서로 심습니다.
- 첫 칸은 빈 땅 아무 데나 자유 선택. 이후엔 어제 칸 8방향 인접에 심습니다.
- 그날 사용량으로 식생이 갈립니다 — 미사용은 빈 땅, 많이 쓸수록 새싹 → 어린 나무 → 고목.

### 그리드 5종

1. **활성화 대상** — 지금 심을 수 있는 후보 칸(강조 표식).
2. **활성화됨** — 나무가 자라거나 빈 잔디(풀밭).
3. **비활성** — 아직 안 심은 흙 땅(잡초·돌).
4. **닫힘** — 다른 달에 4방향으로 둘러싸인 빈칸. 그 달 땅(옅은 그 달 톤)이라 다른 달은 못 심습니다.
5. **묶인 숲 바닥** — 자동으로 묶인 달의 숲(초록 풀밭 + 나무 군집).

### 숲 묶기 (월 단위·자동)

- 달이 지나면(현재월 이전) 그 달이 완주 여부와 무관하게 **자동으로** 한 숲 군집이 됩니다(§55).
- 숲 바로 옆에도 심을 수 있습니다(활성 불가 테두리 폐기). 다만 다른 달에 4방향으로 완전히 갇힌 빈칸은 닫힘(그 달 땅)이 됩니다.
- 인접 후보가 전부 막히면(예: 숲에 둘러싸여 갇힘) 빈 땅 아무 데나 자유 선택으로 새 숲을 시작합니다.

### 숲 연출

- 캐시 읽기 총량이 많은 달일수록 숲 위로 금가루가 더 많이 날립니다(최대 40개로 스로틀).
- 숲마다 나비가 떠돌고, 바닥은 얼룩 그늘·낙엽·이끼 돌로 입체감을 줍니다.

## 집계·계층 결과만 확인 (서버 없이)

```bash
# 기존 §1-4 daily[] 집계
npm run usage:once          # = node server/aggregate.js --once

# §18 계층 구조 (boot 수행 → GET /api/forest 응답). data/ 가 실제로 생성됩니다.
npm run forest:once         # = node server/store.js --forest
```

`usage:once` 는 `{ "daily": [ ... ], "generatedAt": "<ISO8601>" }`, `forest:once` 는 `{ startDate, activeYear, stages, days, forests, yearly, dailyCapTokens, ... }` 를 stdout 에 pretty-print 합니다.

## 데이터 계약

출력 JSON 의 필드명과 집계 규칙은 `_workspace/00_architecture.md §1` 이 단일 진실 소스입니다. 핵심:

- 소스: `~/.claude/projects/**/*.jsonl` (머신 전체), `type==='assistant'` + 비어있지 않은 `message.usage` 만.
- 중복 제거(2-pass): `message.id` 같으면 마지막 엔트리로 덮어쓴 뒤 일자 합산. 누적 합산 금지(토큰 부풀림).
- 날짜: `timestamp` 를 **로컬 시간대** `YYYY-MM-DD` 로 버킷팅. UTC 아님.
- 윈도우: 최근 90일.

```json
{
  "daily": [
    {
      "date": "2026-06-08",
      "totalInputTokens": 0,
      "totalOutputTokens": 0,
      "totalCacheWriteTokens": 0,
      "totalCacheReadTokens": 0,
      "totalTokens": 0,
      "requestCount": 0
    }
  ],
  "generatedAt": "<ISO8601>"
}
```

`~/.claude/projects` 가 없으면 빈 `daily: []` 로 폴백하며 서버는 죽지 않습니다.

## 기준값 (정규화 상한, 2026-06-09 기준)

나무 생장·식생 결정 시 일자별 사용량을 0~1 로 정규화하는 분모로 쓰는 항목별 상한입니다. 측정일(2026-06-09) 기준, 로컬에 남아있는 로그(5/8~6/9, 약 30일치)에서 일자 합산 후 뽑은 하루 최대치입니다.

| 항목 | JSON 필드 | 최대값 | 발생일 |
|---|---|--:|---|
| 요청수 | `requestCount` | 1,372 | 2026-06-09 |
| 입력 토큰 | `totalInputTokens` | 314,805 | 2026-06-01 |
| 출력 토큰 | `totalOutputTokens` | 1,292,571 | 2026-06-04 |
| 캐시 생성 | `totalCacheWriteTokens` | 12,574,616 | 2026-06-08 |
| 캐시 읽기 | `totalCacheReadTokens` | 399,972,002 | 2026-06-08 |

- `requestCount` 의 발생일이 측정일(2026-06-09)과 같습니다 — 그날이 아직 진행 중이라 하루가 끝나면 더 커질 수 있는 잠정값입니다.
- Claude Code 가 30일보다 오래된 세션 로그를 자동 삭제(`cleanupPeriodDays` 기본 30)하므로, 위 상한은 전체 이력이 아닌 최근 약 30일 표본에서 나온 값입니다. 보존 기간을 늘리거나 표본이 바뀌면 재측정이 필요합니다.
