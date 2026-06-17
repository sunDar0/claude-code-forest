# Claude Code Forest (agenTree) — 상세 기획문서 (코드 기준)

> **작성 근거:** 현재 코드베이스 역설계(2026-06-17). 영역별 spec 조각(`_workspace/spec_chunks/1~6`)을 데이터 흐름 순으로 합성했다.
> **기존 `_workspace/00_architecture.md` 는 히스토리다.** 본문은 전부 "현재 코드가 실제로 하는 일"을 단정하고, 코드와 갈린 옛 기획·문서는 §8 미확정·후속에 모았다.
> **근거 표기:** 핵심 계약·비자명 동작에만 `파일:line` 을 단다. 경로는 저장소 루트 기준.

---

## 0. 개요 — 무엇을, 왜

**한 문단 요약.** Claude Code Forest 는 개발자 머신의 Claude Code 사용량 jsonl 을 일자별로 집계해 **"하루 = 나무 한 그루"** 로 자라는 도트 픽셀 탑다운 숲으로 보여주는 로컬 방치형 대시보드다. 단일 Node 프로세스가 `~/.claude/projects/**/*.jsonl` 을 중복 제거·로컬일 버킷으로 집계하고, 결과를 `data/` 에 일/월/년 파일로 영속하며, HTTP API + 정적 클라를 같은 포트로 서빙한다. 브라우저 클라는 5초마다 폴링해 사용량을 나무 식생(높이·잎·두께·수액·발치 식생)으로 매핑해 캔버스에 그린다. 사용자는 빈 그리드 칸을 골라 그날 나무를 "심고"(활성화), 지난 달은 자동으로 숲 군집으로 묶인다. 같은 코드를 Electron 으로 감싸 win/mac 데스크톱 배포본도 만든다.

**핵심 설계 선택.**
- **외부 프레임워크 의존 0** — 서버는 Node 표준 라이브러리만. 클라는 빌드 없는 ES 모듈.
- **서버가 진실, 클라는 렌더+입력+조율** — 배치·나무 상태·숲 묶기는 서버 소유. 클라는 표시와 액션 전달만.
- **코드가 진실, 단일 진실 소스 강조** — 데이터 계약(§2)·맵 경계 상수(grid.js)·수종 산식(seed.js)·차단 집합(activation.blockedSet)은 한 곳에서만 정의.

**세 가지 데이터 모드.**
| 모드 | 데이터 출처 | 선택 방법 | 쓰기 |
|------|-------------|-----------|------|
| real(기본) | 실제 jsonl 집계 + `data/` 영속 | 항상(비개발 강제) | 가능 |
| mock | 서버 `mock/` 디렉토리 read-only | 개발 모드 + localStorage | 불가(POST no-op) |
| cold | 클라 인메모리 흉내(`ColdMockSource`) | 개발 모드 + localStorage | 메모리만 |

> mock/cold 모드 선택은 **localStorage(`forest.debugMode`) + 새로고침**으로 한다. `?mock=1` URL 쿼리는 클라→서버 fetch 경로(`/api/forest?mock=1`)로만 살아 있다(§8 drift 1).

---

## 1. 시스템 아키텍처 — 영역 지도 + 데이터 흐름

**한 문단 요약.** 시스템은 6개 영역으로 갈린다: ①데이터·집계·서버(`server/`), ②메트릭→식생 매핑·유틸(`metrics/grid/seed/debug.js`), ③클라 상태·조율(`main/state/activation/bundle-rule/cold-source.js`), ④렌더 파이프라인(`renderer.js` + `render/*` 헬퍼), ⑤UI·DOM(`ui.js` + `index.html`), ⑥Electron 배포(`main.js`/`preload.js`/`package.json`). 데이터는 한 방향으로 흐른다: **jsonl → 집계 → data/ 영속 → GET /api/forest → state.js 소비 → forestCellParams 변환 → 렌더 입력 → 캔버스 + DOM 오버레이.** 활성화 같은 사용자 액션은 역방향으로 POST 한 줄을 타고 서버에 반영된 뒤 다음 폴로 돌아온다.

```
[~/.claude/projects/**/*.jsonl]   [~/.claude/statusline/usage-cache.json]
            │                                  │
            ▼                                  ▼
   aggregate.js (스캔·중복제거·로컬일·cap 역산)
            │
            ▼
   store.js (data/ 일·월·년 영속 + 인메모리 작업본·동결·refMax·자동묶기)
            │
   index.js (HTTP 라우팅·정적 서빙·TTL 캐시·mock 게이트·포트 폴백)
            │  GET /api/forest (§2 단일 계약)              upload.js ──▶ 사내 중앙 서버
            ▼                                              (POST /api/claude-usage/upload)
   state.js (5초 폴·offline 가드·diff)
            │  consumeDays → forestCellParams(metrics.js)
            ▼
   {cellList, placementMap} + meta(days/forests/yearly/표시값)
            │
     ┌──────┴───────────────────────────────┐
     ▼                                       ▼
 activation.js (순수 함수:               renderer.js (백버퍼 도트 렌더·베이크·
  다음 심을 날·후보칸·차단집합)            오버뷰 스냅샷·카메라·히트테스트·미니맵)
     │                                       │  getHud/cellInfo/forestInfo getter
     ▼                                       ▼
 main.js (rAF 루프·이벤트·자동/수동 심기 조율·POST activate)   ui.js (DOM 오버레이·HUD·모달)
```

**영역별 속성.**
| 영역 | 속성 | 핵심 파일 |
|------|------|-----------|
| 데이터·서버 | IO·상태·집계 | aggregate / store / index / mock / upload.js |
| 메트릭·유틸 | 순수 변환(+debug 만 IO) | metrics / grid / seed / debug.js |
| 클라 상태·조율 | 상태·조율(activation 은 순수) | main / state / activation / bundle-rule / cold-source.js |
| 렌더 | 렌더(순수 헬퍼 분리) | renderer.js + render/{camera,decor,ground,noise,palette,tree-art}.js, simulation/sprites/particles.js |
| UI·DOM | UI | ui.js + index.html |
| Electron | 패키징·수명주기 | main.js / preload.js / package.json |

---

## 2. 데이터 계약 — 집계·영속·API·클라 소비 (단일 정의)

**한 문단 요약. 이 절이 데이터 shape 의 유일한 정의처다.** 다른 절은 여기를 참조만 한다. 서버 `getForest()`(`store.js:453`, return 블록 467-485)와 mock `buildMockForest()`(`mock.js:61`, return 블록 112-130)가 같은 키를 내고, 클라는 `state.js` 한 곳에서만 이 응답 필드를 읽는다(`state.js:14`).

### 2.1 GET /api/forest 응답 (실·목 공통 계약)

```jsonc
{
  startDate,          // "YYYY-MM-DD" | null  (null 이면 클라가 시작일 모달)
  activeYear,         // number
  stages,             // number[] (연도 목록)
  year,               // = activeYear
  stageStart,         // yearObj.stageStart || startDate
  days,               // { "YYYY-MM-DD": dayObj }
  forests,            // { "YYYY-MM": monthObj }
  yearly,             // { [year]: yearObj } | null
  dailyCapTokens,     // number  (나무 단계 분모)
  fiveHourPct,        // number | null
  sevenDayPct,        // number | null
  capSource,          // "statusline" | "observed" | "mock"
  fiveHourCapTokens,  // number
  refMax,             // { input, output, cacheWrite, cacheRead, requestCount } — 메트릭별 관측 최대치
  generatedAt         // ISO string (비콘텐츠, diff 제외)
}
```

**dayObj** (`store.js:566-574`): `{ date, active:true, grid:{gx,gy}, usage:{inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,requestCount}, tree:{stage,xp,stageProgress,seed,species}, finalized:bool }`.
**monthObj** (`store.js:409-420`): `{ month:"YYYY-MM", bundled:bool, bundledAt:ISO|null, monthly:{…5메트릭, totalTokens, activeDays, treeCount} }`.
**yearObj** (`store.js:429-441`): `{ year, stageStart, yearly:{…5메트릭, totalTokens, activeDays} }`.

> usage 키와 dailyRow 키가 다르다: 집계 내부 `dailyRow`(`totalInputTokens` 등, `aggregate.js:258-266`) → store 영속 시 `byDate value`(`inputTokens` 등, `aggregate.js:299-306`)로 변환. **클라·메트릭이 보는 day.usage 는 후자(`inputTokens/outputTokens/cacheWriteTokens/cacheReadTokens/requestCount`).** tree.stage 는 **문자열**(`empty|sapling|young|mature`).

### 2.2 영속 파일 구조 (`data/`)

- 루트: `DATA_DIR = process.env.FOREST_DATA_DIR || <repo>/data`(`store.js:19`, env 우선 — Electron asar 함정 회피).
- `data/forest.json` — `{ startDate, activeYear, stages, refMax }` (메타·단일).
- `data/{YYYY}/year.json` — yearObj.
- `data/{YYYY}/{MM}/month.json` — monthObj.
- `data/{YYYY}/{MM}/{YYYY-MM-DD}.json` — dayObj.
- `data/upload-config.json` — 업로드 설정(§7.2).
- **원자적 쓰기**: 모든 쓰기는 `{p}.tmp` → `rename`(POSIX 원자, `store.js:53-61`). truncated JSON 방지.
- **days 가 진실**: 일 파일 기록마다 그 달·년을 `aggregateDays` 로 재집계·기록(`store.js:351-355,377-444`).

### 2.3 HTTP API 전체 (실제 라우트, `index.js:147-275`)

라우팅은 `urlPath = req.url.split('?')[0]` + method 의 if 체인, 미매칭은 `serveStatic`(`:270`), 미처리 예외는 500(`:271-274`). JSON 응답은 `Cache-Control: no-store`.

| method · path | 요청 body | 응답(200) | 거부 |
|---------------|-----------|-----------|------|
| GET `/api/config` | — | `{ debug:<bool> }` | 항상 200 |
| GET `/api/forest` | — | mock+DEBUG → `getMockForest()`; 아니면 `maybeRefreshToday()` 후 `getForest()` | — |
| POST `/api/grid/activate` | `{date,gx,gy}` | 실: `{ok:true, forest}`; mock: `{ok:true,mock:true,forest}`(no-op) | body 없음 → 400; store 거부 → status+`{ok:false,error}` |
| POST `/api/forest/bundle` | `{month}` | 위와 동일 패턴 | 위와 동일 |
| POST `/api/forest/start` | `{date}` | 위와 동일 패턴 | 위와 동일 |
| GET `/api/usage` | — | `scanUsageData()` 직렬화(4초 TTL 캐시·호환용) | — |
| GET `/api/upload-status` | — | `uploadStatus()` (§7.2) | — |
| POST `/api/upload-now` | (무시) | `uploadNow()`; ok 면 200, 아니면 502 | — |
| GET `/api/upload-config` | — | `getUploadConfig()`(병합 현재 설정) | — |
| POST `/api/upload-config` | partial config | `{ok:true, config:saved}` | body 없음 → 400 |

### 2.4 클라 소비 계약 (state.js → 렌더/UI)

- `consumeDays(daysObj, cap, refMax)`(`state.js:37-51`): days 를 date 오름차순 정렬 → 각 day 를 `forestCellParams(d, cap, refMax)` 로 변환해 `cellList` 에 push(모든 day). `placementMap` = `d.active && d.grid && 유한 좌표` 인 날만 `{date:{gx,gy}}`(배치는 서버 소유).
- `forests`/`yearly`/`days` 원본은 재계산 없이 `meta` 로 그대로 넘긴다(HUD·숲 계층·활성화 후보가 직접 소비).
- top-level 표시값(`dailyCapTokens`/`fiveHourPct`/`sevenDayPct`/`capSource`/`generatedAt`/`refMax`)은 null 가드 후 추출(`state.js:178-189`).

### 2.5 공유 술어·상수 (서버↔클라 비트 동일성)

- **`seed.js`** — `speciesFor(seedVal)`(수종 0..4), `hash32`, `ymd`(로컬일). 서버 aggregate 와 클라 양쪽이 같은 파일을 import 해 같은 결과 보장(`aggregate.js:11`). 산식: `fmix32(hash32(seedVal))/2^32` 의 가중 누적분포, `SPECIES_WEIGHTS=[24,24,14,24,14]`.
- **`bundle-rule.js`** — `isPastMonth(ym, currentYm) = ym < currentYm`(사전식=시간순). `currentYm` 은 공유 안 하고 계층별로 계산(서버=`todayLocalYMD().slice(0,7)`, 클라=로컬월).
- **`grid.js`** — `TILE=18`, `GRID=54`, `MAP_GX0=0/GX1=99/GY0=0/GY1=39`(100×40 맵, 월드 5400×2160px). 배치·카메라·커서 가드의 단일 소스. `gridToScreen` 은 **그리드 중심 기준**(소비자가 좌상단으로 오해하면 버그).

---

## 3. 데이터 집계·영속·동결 — 서버 코어

**한 문단 요약.** 서버는 jsonl 을 90일 윈도우로 스캔해 message.id 로 중복 제거하고(스트리밍 중복 부풀림 방지) 로컬 자정 기준 일자로 버킷한다. statusline % 로 5시간 cap 을 역산해 나무 단계 분모를 만든다. 영속은 days 를 진실로 두고 월·년을 파생한다. 과거 날짜는 부팅 시 동결(finalized)해 더는 재계산하지 않고, 지난 달은 활성화 시점에 자동으로 숲으로 묶는다.

### 3.1 jsonl 집계 (`aggregate.js`)

- **스캔·윈도우**: `~/.claude/projects` 재귀로 모든 `*.jsonl`(머신 전체). `cutoffTime = now - 90일`(`WINDOW_DAYS=90`). 디렉토리 부재면 빈 폴백(같은 shape).
- **줄 필터**: 빈 줄·파싱 실패·`type!=='assistant'`·timestamp 없음/불가·cutoff 이전·`message.usage` 없음/빈객체 skip(throw 금지).
- **중복 제거 키**: `key = message.id || ("no_id_"+timestamp)`, **항상 덮어쓴다 — 마지막 엔트리 채택**(`aggregate.js:215-219`). 스트리밍 같은 message.id 여러 줄의 최종 토큰값만 취해 2~3배 부풀림 차단.
- **로컬일 버킷**: `localYMD` = `getFullYear/getMonth+1/getDate`(UTC 금지). 중복제거 값만 dateStr 별 합산.
- **메트릭 매핑**: input=`input_tokens`, output=`output_tokens`, cacheWrite=`cache_creation_input_tokens`, cacheRead=`cache_read_input_tokens`(각 `||0`). totalTokens=네 합. requestCount=중복제거 메시지 개수.

### 3.2 5시간 cap 역산 → 단계 분모 (`aggregate.js:88-117`)

- **블록 묶기**: 중복제거 메시지를 시간순 정렬, 첫 메시지 anchor 로 `anchor+5h` 안은 같은 블록(ccusage 식 롤링).
- **statusline %**: `~/.claude/statusline/usage-cache.json` 의 `fiveHour`/`sevenDay`(부재·깨짐·숫자 아님 → null).
- **robust 기준값**(`robustBlockRef`): 90일 블록 totals 의 **p85 분위수**(`REF_PERCENTILE=0.85`, 표본 `<8` 이면 max 폴백). 옛 `observedMax`(max)는 리셋 폭증 한 날이 분모로 영구 박제돼 다른 날이 영영 묘목에 갇히는 '평균의 함정'(극단값 지배)이 있어, 순서통계량인 분위수로 교체(이상치 = 순위만 보므로 무시). 본체 상단(중앙값↑·최대↓)이라 센 날은 성목에 닿고 사용량 편차가 나무 키로 드러난다.
- **역산**: `fiveHourPct≥1` && 최근 블록 존재 && `latest.totalTokens>0` 이면 `inverse = latest.totalTokens/(pct/100)`, `fiveHourCapTokens = max(inverse, robustBlockRef)`, `capSource='statusline'`. 불가하면 `robustBlockRef>0?robustBlockRef:1`, `capSource='observed'`.
- **dailyCap**: `dailyCapTokens = round(2 * fiveHourCapTokens)`(하루 ≈ 5시간 윈도우 2개).

### 3.3 나무 계산 `computeTree` (`aggregate.js:348-374`)

- **species**: `speciesFor(seed)`. store 는 보통 `date` 문자열을 seed 로 준다.
- **stage 임계**(`STAGE_PCT={young:0.3, mature:0.6}`): `totalTokens<=0`→`empty`. `pct=totalTokens/cap`. cap<=0→`sapling, progress 0`. `pct<0.30`→sapling, `0.30≤pct<0.60`→young, `0.60≤`→mature. 각 구간 progress 는 구간 내 선형. **구간 폭 비율 30:30:40 = 3:3:4** — 묘목 3·유목 3·성목 4 하위 프레임에 균등 10%씩 대응(§6.9 의 10단계 스프라이트 매핑과 정합).
- **xp = totalTokens**.

> **10단계 스프라이트는 렌더 파생.** `tree.stage` 데이터 계약은 매크로 3종(sapling/young/mature) 문자열 + `stageProgress` 그대로다(영속·동결 무변경). 사용자에게 보이는 10단계(묘목1~3·유목1~3·성목1~4)는 렌더가 `stage`+`stageProgress` 로 하위 프레임을 뽑아 만든다(§6.9). 즉 서버는 매크로 단계만 정하고, 하위 분할은 화면에서만 일어난다.

### 3.4 부팅·갱신·동결 (`store.js`)

부팅(`boot()`, `store.js:165-195`): forest.json 로드/생성 → refMax 초기화(저장값∪`REFMAX_SEED` 하한) → `loadAllFromDisk`(패턴 매칭만, 깨짐 skip) → 전체 날 refMax bump → `refreshToday()` 1회 → `freezeStaleDays(today)` → `getForest()`.

- **finalized 동결**: 부팅 시 `date<today && active && !finalized` 인 날을 그 시점 stage·xp 그대로 동결(재계산 안 함). 과거 활성화도 즉시 `finalized = date<today`. `refreshToday` 는 오늘이 `!active||finalized` 면 usage·tree 갱신 skip(caps 만).
- **refMax 단조 추적**: 5키, `REFMAX_SEED` 가 단조 하한. 그날 합이 크면 bump, 변동 시 `forest.json` 영속.

### 3.5 활성화 거부 규칙 (`activateGrid`, `store.js:497-583`)

순서대로 400 거부: 날짜 형식 불량 → gx/gy 정수 아님 → 맵 밖(`gx∈[0,99]`·`gy∈[0,39]`) → startDate null → `date<startDate` → 미래(`date>today`) → 이미 활성 → 좌표 중복 → 비인접(점유 1+일 때 8방향 인접 아님). **콜드스타트**: 점유 0개면 인접 검사 면제·맵 내 자유. 통과 시 그날 usage 로 tree 계산·refMax bump·`persistDay`·자동묶기.

### 3.6 시작일·자동 묶기·수동 묶기

- **시작일** `setStartDate`(`store.js:594-616`): 형식·실재 날짜·미래 검증 + **1회 불변**(이미 설정됐으면 거부).
- **자동 묶기** `autoBundlePastMonths`(`store.js:206-227`): **트리거는 `activateGrid` 끝(`:580`) 1곳뿐**(심는 날 기준). `isPastMonth` && `!bundled` 인 달을 **완주 무관·무조건** `bundled=true`·`bundledAt` 설정·`month.json` 기록. 이미 묶인 달은 skip(유지). → §8 drift 2(boot 경로엔 없음).
- **수동 묶기** `bundleForest`(`store.js:645-675`): API(`POST /api/forest/bundle`)는 존재하나 클라가 호출하지 않는다(클라는 자동 묶기만 사용). month 형식·`isPastMonth`·days 0개 검증 후 묶음.

### 3.7 서버 인프라 (`index.js`)

- 포트 `PORT = process.env.PORT || 5178`. 오늘 재집계 4초 TTL, `/api/usage` 4초 문자열 캐시.
- mock 게이트: `DEBUG`(=`FOREST_DEBUG==='1'|'true'`) 꺼지면 항상 false(프로덕션 mock 차단).
- 정적 서빙: `safeJoin` 디렉토리 탈출 방지(403), `/`→`index.html`, MIME `.html/.js/.css/.json/.png`. POST 바디 1MB 상한.
- 포트 폴백 `listenWithFallback`: `EADDRINUSE` 면 `startPort+1..` 최대 30회, 성공 포트로 resolve·stdout 로그.

### 3.8 mock 서빙 (`mock.js`)

`MOCK_DIR=<repo>/mock`, 실 store 와 완전 분리·read-only(POST no-op). 고정 cap(`dailyCapTokens=600M`, `fiveHourPct=42`, `sevenDayPct=31`, `capSource='mock'`). activeYear 해의 days·forests·yearly 만 조립. 지난 달·미묶음이면 **응답 객체에서만** `bundled:true` 보정(파일 미수정). 30초 TTL.

---

## 4. 메트릭 → 식생 매핑 — 어떤 사용량이 어떤 나무가 되는가

**한 문단 요약.** 클라는 서버 tree 확정값(stage·xp·species)을 재계산하지 않고 그대로 받되, 5메트릭은 두 갈래로 정규화한다: **logNorm(나무 변조용·렌더가 씀)** 과 **linPct(상세 패널 표시 전용·선형)**. `forestCellParams`(`metrics.js:77-158`)가 이 변환의 핵심 공개 계약이다. 각 메트릭은 정해진 나무 속성 하나씩에 매핑된다.

### 4.1 5메트릭 → 나무 속성 매핑 (`metrics.js`)

**핵심 주의 — 스프라이트 전환(§30) 이후 매핑의 절반이 화면에 안 보인다.** `metrics.js` 의 `forestCellParams` 는 아래 식을 모두 계산하지만, §30 에서 나무 그림이 **사용자 제작 스프라이트 시트 blit** 으로 바뀌면서 화면 나무 모양을 정하는 입력은 `species`·`stage`(+`stageProgress`)뿐이다. `sim.*` 절차 파라미터(높이·두께·잎·분기량·분포)는 `buildTree`(`simulation.js:263-265`) **폴백 경로**에서만 읽힌다 — 스프라이트가 로드된 정상 경로에선 계산만 되고 그려지지 않는다. 그래서 매핑을 **정상 경로 반영 / 절차 폴백 전용** 으로 나눈다.

#### 표 A — 정상(스프라이트) 경로에서 실제 렌더에 반영

| 메트릭 | 효과 | 경로·근거 |
|--------|------|-----------|
| `cacheReadTokens` | 성목 **금가루(수액) weight** | `cell.params.norms.cacheReadN`(`renderer.js:868`, 40캡). ⚠ `metrics.js` 의 `sap.density` 가 아니라 norms 를 직접 읽는다 — `sap.density` 는 소비처 0건(죽은 필드) |
| `requestCount` | **발치 식생 개수** | `ground.density`(`renderer.js:1536`) |
| input/output/cacheWrite 비중 | 발치 식생 **종류** | §45 매핑(`renderer.js:1536` 근방) |
| `species` | **수종** 스프라이트 | 메트릭 아님 — `tree.species`(서버 영속), 없으면 `speciesFor(seed)` 폴백(`renderer.js:1173`) |
| `stage`/`stageProgress` | **성장 단계** 스프라이트 프레임 | 메트릭 아님 — XP 누적 기반(`renderer.js:1174-1175`) |

#### 표 B — 절차 폴백 전용 (스프라이트 미준비/로드 실패 시에만 그려짐)

| 메트릭 | logNorm | 절차 속성 | 식 (metrics.js) |
|--------|---------|-----------|-----------------|
| `inputTokens` | inputN | 기둥 높이 maxHeight | `22 + inputN*42` (:138) |
| `inputTokens` | inputN | 분기량 resourceCount | `round(8 + inputN*34)` (:139) |
| `outputTokens` | outputN | 잎 크기 leafSize | `0.8 + outputN*2.0` (:141) |
| `outputTokens` | outputN | 잎 개수 leafCount | `round(2 + outputN*4)` (:142) |
| `outputTokens` | outputN | 빛 민감도 lightSensitivity | `0.35 + outputN*0.25` (:147) |
| `cacheWriteTokens` | cacheWriteN | 기둥 두께 baseThickness | `0.6 + cacheWriteN*1.8` (:144) |
| (5메트릭 비율) | — | 분포 타입 distribution | `pickDistribution(u)` (:145) |

> ⚠ 잎 라이브 오버레이(§53 `_drawLeafOverlay`)도 `leafCount` 를 **무시**하고 잎 개수를 stage 로 하드코딩한다(MATURE 6 / 그 외 3, `renderer.js:511`). 즉 `output` 의 잎 표현은 정상 경로에서 메트릭과 무관하다.
>
> **요약(정상 경로 기준):** 화면 나무를 정하는 건 **수종(species) + 단계(stage)** 이고, 사용량 메트릭이 직접 보이는 건 **금가루=cacheRead, 발치 식생=requestCount** 뿐이다. `input`·`output`·`cacheWrite` 의 나무 변조(높이·잎·두께)는 스프라이트 전환 후 폴백에서만 살아 있다.

### 4.2 정규화 두 갈래

- **logNorm**(`metrics.js:23-28`): `log10(1+v)/log10(1+ref)` 클램프 0~1. 5메트릭을 `norms{inputN,…,requestN}` 으로. **렌더·식생 매핑이 이걸 쓴다.**
- **linPct**(선형, `metrics.js:89-96`): `clamp01(raw/ref)`. 상세 패널에만 표시(log 가 큰 값을 80~95%로 몰아 오해 주던 것을 선형으로 풀어줌). **렌더에 안 쓴다.**
- **분모 `refFor`**(`metrics.js:62-65`): `refMax[key]` 유한+양수면 그 값(영속 관측 최대치), 아니면 `REF[key]` 상수 폴백. **메트릭 키별 독립** 결정.

### 4.3 단계·분포 보조 규칙

- **STAGE enum**(`metrics.js:31-36`): `{EMPTY:0, SAPLING:1, YOUNG:2, MATURE:3}`. tree.stage 문자열은 `STAGE_FROM_STR` 로 숫자화, 모르는 값은 EMPTY.
- **species 결정**: `tree.species` 유한이면 그 값(0~4 동결), 아니면 null → 렌더러 `speciesFor(seed)` 폴백. seed = `tree.seed || day.date`.
- **`pickDistribution`**(`metrics.js:167-178`): `readRatio>12`→weeping, `outRatio>0.6`→spreading, `outRatio<0.25`→upward, else uniform.
- **species 산식의 fmix32**: FNV-1a 는 같은 달 날짜를 한 수종으로 쏠리게 해서, 수종 매핑에서만 한 번 더 MurmurHash3 finalizer 로 섞는다(`seed.js:47-57`).

### 4.4 배치 변환 (`grid.js`)

- `layoutByPlacements(cellParamsList, placementMap)`(`grid.js:40-59`): placementMap 에 있는 날만 `{gx, gy(서버값), params, isActive: 가장 늦은 배치날, dayIndexFromNewest:0}` 로 감싸 반환. `dayIndexFromNewest` 는 항상 0(§8 drift 6).
- `gridToScreen`: `round(originX+gx*GRID)`, 중심 기준 선형 매핑(대각 변환 없음).

---

## 5. 클라 상태·조율 — 폴링·활성화·심기

**한 문단 요약.** `state.js` 가 5초 폴로 응답을 `cellList`/`placementMap` 으로 바꾸고, 실패하면 직전 상태를 유지한 채 offline 플래그만 세워 렌더 루프를 죽이지 않는다. `activation.js` 는 순수 함수로 "다음에 심을 가장 오래된 미배치 날"과 "심을 수 있는 빈칸 후보"와 "닫힘(closed) 차단 집합"을 계산한다. `main.js` 가 rAF 루프·이벤트·자동/수동 심기를 조율하며, 심기는 단일 `autoPlanting` 가드 + 전체 입력 차단 오버레이로 경쟁을 막는다.

### 5.1 폴링 루프 (`state.js:86-198`)

`start()` → 즉시 `_poll()` + 5초 `setInterval`(`POLL_MS=5000`). cold 면 `coldSource.poll()`(동기 메모리), 아니면 `fetch(fetchUrl, {cache:"no-store"})`. **실패 시 `offline=true` 로 두고 `onUpdate(cellList, new Set(), meta(true))` 후 return — 직전 상태 유지, 렌더 안 죽음.** 성공 시 `_diff` 로 `changedDates` 산출 → `consumeDays` → `onUpdate`.

### 5.2 폴링 콜백 순서 (`main.js:378-391`)

매 폴: `lastMeta=meta` → `detectAutoBundle(meta)`(자동묶기 빛기둥) → `renderer.setOffline/setGeneratedAt/setForests/setData` → `ui.updateHud/updateDetail` → `refreshPlantUI()`(차단집합 1회 계산·후보/모달 갱신) → `runAutoPlant()`(재진입 가드).

### 5.3 활성화 후보·차단 (`activation.js`, 순수 함수)

- **차단 집합** `blockedSet`(`activation.js:98-164`): **닫힘(closed)만 담는다.** 숲 바깥 인접 빈칸은 차단 안 함(바로 옆 심기 허용). 점유칸 4방향 빈칸을 BFS 시드로 영역을 모으고, 맵 가장자리/밖에 닿으면 트인 땅(open). 안 트인 영역만 `"closed:대표달,…"` 로 막고, 그 달에만 심기 허용(`canPlantMonthAt`). 결과는 `Map<"gx,gy","closed:…">`.
- **다음 심을 날** `oldestPendingDate`(`activation.js:174-196`): startDate~오늘 사이 placementMap 에 없는 가장 오래된 날.
- **후보 슬롯** `candidateSlots`(`activation.js:214-239`): 점유 0개(콜드)면 `[]`(자유). 점유 1+면 **앵커(=마지막 활성 그리드)의 8방향** ∩ 맵 ∩ 미점유·미중복·그 달 허용. 앵커 없으면 `latestPlacement` 폴백.
- **수용 판정** `isAcceptableSlot`(`activation.js:265-277`): 맵 밖·점유칸·달 불일치면 false; 콜드/후보 빈 경우 자유 폴백 true; 그 외 후보 멤버십.

### 5.4 자동 심기 (`runAutoPlant`, `main.js:267-317`)

진입 가드(`!autoPlant`·`autoPlanting`·`startUndecided||readOnly`·미배치 0 → return). `autoPlanting=true`+`ui.setPlanting(true)`(전체 입력 차단). 간격 = `clamp(round(3000/N), 20, 150)`ms. 루프: 다음 날 = `oldestPendingDate` → 콜드 첫 칸은 `pickRandomFreeCell`, 아니면 후보 무작위 택1(후보 0이면 `findFreeFallbackSlot`) → `state.activate(date, slot)`(POST→재폴) → `playPlantEffect` + `focusLastActive(AUTO_FOLLOW_CELLS=10)`. `finally` 로 차단 해제.

### 5.5 수동 심기 (`main.js:520-559, 621-646`)

`mouseup`(드래그 아닐 때): 묶인 숲 클릭→드릴다운 토글; 데이터 셀 클릭→상세 토글; 빈칸 클릭 + `isAcceptableSlot` 통과면 `pendingSlot` 저장 + `ui.showConfirm()`. 확인→`state.activate`. **자동/수동이 같은 `autoPlanting` 플래그 + `ui.setPlanting` 인디케이터를 공유**해 중복 심기·경쟁 차단.

### 5.6 시작일 모달·ESC 우선순위

- 시작일 모달: `startDate=null && !readOnly` 면 표시. 확인 → `state.setStartDate(date)`(POST→다음 폴이 startDate 채우면 모달 자동 닫힘).
- **ESC 닫기 순서**(`main.js:579-606`, 심는 중이면 전부 무반응): ①업로드 설정 모달 → ②확인 팝업 → ③상세 모달 → ④드릴다운. 한 번에 한 레이어.

### 5.7 콜드 모드 (`cold-source.js`)

`ColdMockSource`(인메모리). `poll()` 동기 → 시작일 null 이면 모달 → `setStartDate` → `activate` 가 스냅샷 제자리 수정(days+forests 엔트리 신설) → 다음 poll 이 `_autoBundle` 적용. 자동심기 ON 이면 콜드 첫 칸 무작위로 좌르륵 배치(왕복 ~0ms).

---

## 6. 렌더 파이프라인 — 베이크·스냅샷·카메라·도트 숲

**한 문단 요약.** `ForestRenderer`(`renderer.js`, god-class) 하나가 백버퍼에 하늘·바닥·나무·묶인 달 숲 군집·장식·파티클·UI 강조를 그리고 정수배 nearest 업스케일로 화면에 표시한다. 비용 큰 정지 형상(나무 본체·수관 음영·뿌리·군집·맵 스냅샷)은 오프스크린 캔버스에 **베이크**해 `drawImage` 1콜로 재사용하고, 잎·금가루·나비·풀결·깃발·구름·UI 강조만 매 프레임 라이브로 덧그린다. 내용 시그니처가 같으면 setData 가 조기 반환해 재베이크 0. 절차 데이터·스프라이트·카메라·바닥 분류·노이즈·색은 `render/*` 헬퍼로 분리됐다.

### 6.1 setData + 내용 시그니처 무효화 (`renderer.js:647-728`)

`_contentSignature` = drilldown + 정렬 배치 + bundled 달 + 각 날짜 `date|stage|subFrame|seed|5메트릭`(generatedAt 제외). **시그니처 같고 cells>0 이면 조기 반환**(재배치·재베이크·스냅샷 무효화 0). 변경 시: `layoutByPlacements` 재레이아웃 → cellByKey·placement 재구성 → 베이크 필요 판정 → 숲 군집 계산 → 카메라 클램프(첫 데이터 1회 `_centerOnContent`) → HUD 재구성 → `_invalidateSnapshot`(실변경 시만).

### 6.2 베이크 인프라

- **나무 스프라이트**(`_treeSprite`): 키 `d|{date}|{L|P}|{stage}|s{sub}`, LRU 256. `sub` = 하위 프레임 인덱스(`_subFrame`: 묘목·유목 0~2, 성목 0~3 — 옛 `_matureSub` 의 성목 전용에서 전 단계로 일반화). 시트 준비 시 시트 프레임 nearest 다운스케일(PAST 톤 source-atop 멀티플라이), 아니면 절차 `paintTreeBody`. `_drawTree` 가 정수 좌표 drawImage(스케일 변환 없음, baseY=sy+5).
- **군집=달 1장 점진 베이크**(`_forestSprite`): 키 = ym, 캔버스 = `cluster.drawBBox`. 프레임당 `_instBakeBudget(10)` 그루씩 누적. **스프라이트 수 = 달 수**(그루당 1장이면 LRU 스래시 → 프리즈, 그래서 달 1장).
- **프레임당 예산**: `_frameBakeBudget=2`, `_instBakeBudget=10`(단일 프레임 < 100ms 목표). 화면 밖은 컬링(작업집합 = 보이는 칸뿐).

### 6.3 오버뷰 스냅샷 이중 버퍼 (`renderer.js:1054-1146`)

오버뷰(최대 줌아웃)는 맵 전체를 한 장으로 베이크한다. `_invalidateSnapshot` 은 완성본이 있으면 **null 로 비우지 않고 stale 표시**(원자 교체 대기) — 드릴다운 등 내용 변경 시 직전 완성본을 계속 그려 **초록 임시본 플래시 제거**. `_advanceMapSnapshot` 2단계: ①워밍업(가시 스프라이트 점진 베이크) ②합성(풀해상 1회 그려 다운스케일 → 원자 교체). 콜드 전용 저해상 임시본(`_buildProvisionalSnapshot`).

### 6.4 카메라 (`render/camera.js`)

cam.x/y = 보이는 영역 좌상단 월드 px, zoom = 정수 업스케일 배율. `zoomMax` = 한 칸 꽉 참, `zoomMin` = 활성 bbox 담는 최소. `zoomAt` 은 커서 아래 지점을 줌 전후 같은 자리에 유지하고, zoomMin 에서 더 줌아웃하면 overview 진입. `pan` 후 `_clampPan` 으로 맵 bbox(아래=남단, 위=지평선 위 SKY_VIEW) 밖으로 못 나감. `focusLastActive(viewCells)` 는 마지막 활성 셀 중앙 정렬 + `_camAnim` ease-out 보간(찾기 버튼=3.5칸, 자동심기 추종=10칸).

### 6.5 뷰포트·업스케일

- `_viewport`: 창에 **16:9 contain**(레터박스), 남는 영역 body 검정.
- `_layoutCanvas`: 가로 중앙, **세로 하단 고정**(땅이 창 바닥에 붙음).
- `_recompute`: zoom=정수, 백버퍼 = `max(GRID, ceil(vp/zoom))`, `imageSmoothingEnabled=false`.

### 6.6 바닥 경계 노이즈 전이대 (`render/ground.js` + renderer)

- 바닥 종류 `groundKindCell`: 활성=grass, blocked Map 에 있으면 closed, bundled 셀이면 forest, 나머지 dirt. **활성불가 "rock" 종류는 폐기**(§8 drift 3).
- 경계 타일만 전이대: `warpedGroundKind`(도메인 워프 fbm) + `ditheredGroundKind`(블록별 지터 → 경계 50:50 도트 디더). 월드 좌표라 팬 불변. 비경계는 종류별 3톤 solid.
- 결 텍스처(LOD 시 생략): 경계=`drawTransitionDetail`, 활성=풀잎, 닫힘=`drawClosedGround`, 흙=`drawPendingGround`. 빈 대지=`drawEmptyDirtPatch`.

### 6.7 라이브 vs 베이크 경계

- **베이크(정지)**: 나무 본체·수관 통합 음영·뿌리·군집·시트 blit·맵 스냅샷.
- **라이브(매 프레임)**: 잎 오버레이(`_drawLeafOverlay` — 활성 YOUNG·MATURE 만, LEAF_PAL 상수색, 흔들림·햇빛 반짝·낙엽), 금가루 파티클, 숲 나비, 풀결 굽이침, 깃발 펄럭, UI 강조, 구름, 마지막 활성 금색 아웃라인, 호버 외곽선.
- **마지막 활성 깃발**(`_drawLastActiveFlag`): 칸 우하단 안쪽 5px 고정·사선 깃대 + 붉은 천 펄럭, Y-sort 큐 편입(칸 bbox = `gridToScreen` 중심 ± GRID/2).
- **호버 외곽선**(`_drawHoverHighlight`): 커서가 올라간 칸(`hoverCell`, 빈 대지 포함·비묶음) footprint 와 묶인 숲(`hoverForestYm`) bbox 외곽에 옅은 녹색 strokeRect(`rgba(170,225,150,~0.4)`·1px·정수·펄스 없음·금색보다 은은). 정상 위치(이동 없음)·라이브 전용(overview/스냅샷 합성 제외). 호버 대상 = 나무 칸은 `_treeAtCanvas`(커서가 나무 스프라이트 그릴 사각에 들면 그 밑동 셀 — 큰 성목 수관 호버도 잡음), 폴백은 그리드 칸 조회. **(연혁: 호버 시 칸을 들어 올리는 "떠오름" 연출을 만들었다가 사용자 판단으로 폐기 — 지금은 외곽선만.)**

### 6.8 render() 순서 (`renderer.js:966-1009`)

`frame++`·예산 리셋·`_stepCamAnim` → (overview 면 `_renderOverview` return) → 하늘 → 바닥 베이스→결→빈땅→격자/강조 → objs Y-sort(decor/rock/pool/tree/forest/flag) → 파티클 → 나비·잎 오버레이 → (debug 좌표) → nearest 업스케일.

### 6.9 절차 데이터·스프라이트 (`simulation.js`/`sprites.js`)

- `gridPlacement(date,stage)`: 날짜 시드로 9칸 중 씨앗 1칸. SAPLING=1칸, YOUNG=2×2, MATURE=9칸. footprint/offsetTiles/corner 반환 형태 불변 계약.
- `buildTree`: 절차 나무 형상(메트릭 매핑: input→높이, output→수관, cacheWrite→두께). **시트 로드되면 crown 블롭은 폴백 전용**(footprint·skeleton·placement 는 항상 사용).
- `buildForest`: 숲 군집 셀좌표 배치(월드 px 절대값, 셀당 1~2그루, minGap 리젝션, 경계 오버행).
- `sprites.js`: 나무/바위 스프라이트 시트 비동기 로더. **나무 프레임 = `sprite_{species}_{0..9}`(수종 5 × 단계 10)**. 단계 매핑은 `stage`+`stageProgress` → 절대 프레임 0~9: 묘목(SAPLING)=`0 + floor(p·3)` clamp 0~2, 유목(YOUNG)=`3 + floor(p·3)` clamp 3~5, 성목(MATURE)=`6 + floor(p·4)` clamp 6~9. 즉 묘목1~3·유목1~3·성목1~4. 로드 실패 시 절차 폴백. 경로 `/sprite/tree_sprite_10_packed.png`·`/sprite/tree_sprite_10_coords.json`(바위는 `/sprite/rock_sprite_packed.png` 그대로). 시트 좌표의 `image` 필드(`atlas.png`)는 무시하고 로더가 받은 png 경로를 쓴다.
  - **단조 크기 성장**: 10프레임은 시트에서 w·h 가 단조 증가한다. 렌더는 프레임마다 다시 매크로 footprint 폭으로 정규화하지 않고, 절대 프레임 크기에 비례해 다운스케일해 10단계가 화면에서 점점 커지게 한다(§6.2 베이크).

### 6.10 DOM 노출 getter (렌더러 → ui.js)

- `cellInfo(cell)`: 빈땅이면 `{date,empty:true,stage:0,rows:[]}`, 아니면 `{date,empty:false,stage,stageProgress,pct,isActive,species,norms,linPct,rows:[5메트릭]}`.
- `forestInfo(ym)`: `{month,bundled,rows:[["나무","N 그루(활성 N일)"],…5메트릭]}`.
- `selectedCellPreview(size=128)`: 선택 칸을 오프스크린에 확대 렌더한 dataURL(PNG, 없거나 묶인 셀이면 null). 고정폭 흙 슬래브(풀/흙 윗면 + 세로 음영 흙벽·오버행 립·측면 슬리버·접지 그림자 = 2.5D 두께) 위에 그 칸 베이크 나무를 가로중앙·하단 앵커·정수배 nearest 로 얹는다. 바닥색은 `_isActiveGridCell`(배치 칸=풀·아니면 흙). 식생 없음. 같은 키 캐시(폴마다 재생성 0). 상세 모달 상단 미리보기에 쓴다.
- `getHud`/`isOffline`/`isEmpty`/`getHover`/`getSelected`/`hasLastActive`·플래그 `debug`(좌표 라벨·격자선, ?debug=1)·`hudCollapsed`.

---

## 7. UI / DOM·배포

### 7.1 UI 오버레이 (`ui.js` + `index.html`)

**한 문단 요약.** `ForestUI` 는 캔버스에 한 픽셀도 안 그리고 `index.html` 의 DOM 요소(HUD·툴팁·상세 모달·확인 팝업·시작일 모달·업로드 설정 모달·자동 심기 토글·미니맵·찾기 버튼)를 갱신·표시한다. 데이터는 renderer getter 와 main 이 넘기는 `meta` 에서 읽고, 자기 상태는 마지막 업로드 상태와 localStorage 자동 심기 플래그뿐이다.

- **HUD**: 우상단(`#hud-tr` — 포트·5h/7d·월 활성수·월 누적 5메트릭) + 하단(`#hud-bottom` — 상단 전용 바 `#upload-row` + 최근 날 5메트릭, 각 `(Height)/(Foliage)/(Structure)/(Energy Flow)/(Vibrancy)` 서브라벨). HUD 접기는 main 이 `#ui.hud-collapsed` 토글.
- **모달**: 시작일(재진입 가드 — 5초 폴마다 호출돼도 입력 리셋 안 함), 상세(**맨 위 `.detail-preview` 에 `selectedCellPreview(128)` 확대 그리드 이미지** + 빈 대지=날짜+요일만 / 나무=단계 "묘목/유목/성목 N/M"·수종·경험치 바·5메트릭 raw + 선형 비중%), 심기 확인 팝업(커서 근처), 업로드 설정(서버주소·이메일·주기·자동전송, 이메일 형식 검증).
- **자동 심기 토글**: 두 체크박스(`#auto-plant`·`#start-auto-plant`)가 같은 localStorage `forest.autoPlant`(기본 ON) 공유.
- **심는 중**: `#planting-overlay`(전체 입력 차단, z45) + `#planting-indicator`(끄기 버튼, z46) + 토글(z47, 차단 위라 끌 수 있음). `setPlanting(on, showStop=true)` — **수동 심기는 `showStop=false`** 로 '자동 끄기' 버튼을 숨긴다("심는 중…" 표시는 유지, 자동 심기 OFF 상태에 무의미한 버튼 제거). 자동 루프만 버튼 노출.
- **미니맵·찾기 버튼**: ui.js 는 안 만짐(main 이 매 프레임 `drawMinimap`·`updateLocateButton`). 미니맵 좌상단 150×100·줌 무관 항상 표시.

### 7.2 중앙 서버 업로드 (`server/upload.js`)

- **계약**: `scanUsageData()` 의 `{daily:…}` JSON 을 `POST {serverUrl}/api/claude-usage/upload`, `multipart/form-data`(필드 `file`·`hostname`·`timestamp`·`userEmail`). 성공 = HTTP 200/201. 인증은 userEmail 필드(별도 토큰 없음).
- **설정 우선순위**: `data/upload-config.json` > env(`UPLOAD_SERVER_URL`/`UPLOAD_USER_EMAIL`/`UPLOAD_INTERVAL`) > 코드 기본(interval 600초, enabled = email 있으면 true).
- **상태/UI**: `uploadStatus()` → `{enabled, configured, serverUrl, userEmail, intervalSec, lastUploadTime, uploadCount, lastError}`. 클라 main 이 30초 폴 + 1분 상대시간 타이머로 하단 바 갱신(`/api/forest` 폴과 독립). `startAutoUpload` 는 enabled&&email 일 때만 listen 직후 즉시1회+타이머.

### 7.3 Electron 데스크톱 배포 (`main.js`/`preload.js`/`package.json`)

**한 문단 요약.** 이미 동작하는 웹 대시보드를 새 기능 없이 Electron 으로 감싼다. 메인 프로세스가 기존 http 서버를 인프로세스로 띄우고 BrowserWindow 가 `http://localhost:실제포트` 를 로드한다. 핵심은 패키징 시 asar 읽기전용 함정을 피하려 data 쓰기 경로를 `userData` 로 주입하는 것.

- **준비 시퀀스**(`main.js:41-64`): `app.whenReady` → `process.env.FOREST_DATA_DIR = userData/data` 설정(store import 전) → 동적 `import('./server/index.js')` → `startServer(PORT)`(실패 시 1회 재시도, 그래도 실패하면 stderr 만·throw 없음) → `serverHandle.address().port` 로 실제 포트 추출 → `createWindow(actualPort)`.
- **창 보안 기본값**: `contextIsolation:true`, `nodeIntegration:false`, 빈 preload(노출 API 없음 — 렌더러는 일반 브라우저처럼 localhost API fetch).
- **종료**: `window-all-closed` → `serverHandle.close()` → `app.quit()`.
- **data 경로 분기**: `DATA_DIR = env || <repo>/data`. 개발 무변경, 배포본만 userData. `asar:true` 이나 data 가 userData 로 빠져 unpack 불필요.
- **electron-builder**: appId `com.claudeforest.app`, mac `dmg/zip`(identity:null 서명 없음), win `nsis`, files = main/preload/server/public/mock/package.json. scripts: `pack`(--dir 검증), `dist`/`dist:mac`/`dist:win`.

---

## 8. 미확정·후속 — drift·죽은 코드·검증 한계

코드로 확정하지 못했거나, 기존 문서·주석과 코드가 갈린 지점. **본문은 전부 현재 코드 기준으로 단정**했고, 여기 그 갈림만 모은다. QA(integration-qa)가 판정한다.

### 8.1 문서·코드 drift (현재 코드 기준으로 본문 단정함)

1. **데이터 모드 선택 = localStorage(URL 쿼리 아님).** 프롬프트·일부 주석은 `?mock=1`/`?cold=1` URL 로 설명하나, 실제 모드 선택은 `main.js:143-146` 가 `getDebugMode` 로 **localStorage(`forest.debugMode`) + 새로고침**으로 한다(`debug.js:31-33`). `?mock=1` 은 클라→서버 fetch 경로(`/api/forest?mock=1`)로만 살아 있다. cold 는 인메모리 `ColdMockSource`(URL 없음).

2. **자동 묶기 트리거는 `activateGrid` 1곳뿐.** CLAUDE.md §55 이력은 "boot+폴마다 지난 달 무조건 bundled" 라 적지만, 코드상 `autoBundlePastMonths` 호출은 `activateGrid` 끝(`store.js:580`)뿐이다. boot·refreshToday 경로엔 없음 → **활성화가 한 번도 안 일어난 채 월이 바뀌면 실모드 자동묶기가 안 도는 것으로 보인다.** mock 은 응답 시점 런타임 보정이라 무관. (코드 = 진실, 문서가 drift. 의도 vs 버그 판정 필요.)

3. **활성불가 "rock" 바닥 종류·`_drawRockTile` 폐기.** §55 에서 blocked(활성불가)가 폐기돼 차단 집합은 **닫힘(closed)만** 담는다(`ground.js:64-75`, `activation.js:86-87`). `_drawRockTile` 호출은 코드에 없고 decor 엔 `paintProceduralRock`·`drawClosedGround` 만 존재 — 옛 문서의 일부 함수명이 현재 코드와 불일치.

4. **`getHud` getter 주석 잔존.** `ui.js:2` 주석은 `getHud` 의존을 언급하나 ui.js 본문은 호출하지 않는다(HUD 는 `meta` 에서 직접 읽음, `ui.js:155-203`). 실제 의존은 `getSelected/getHover/forestInfo/isOffline/isEmpty`. renderer 는 `getHud()` 를 노출하긴 함(`renderer.js:2411`) — 현재 소비처가 없는 죽은 getter.

5. **`sim` 절차 나무 파라미터 정상 경로에서 죽음(실측 확정).** §30 "절차 나무→스프라이트 시트", §45 "나무 변조 폐기→발치 식생 분산" 후 `metrics.js` 의 `sim{maxHeight,resourceCount,leafSize,leafCount,baseThickness,distribution,lightSensitivity}` 는 절차 나무 시절 모델 그대로 계산·반환하지만, **스프라이트가 로드된 정상 경로에서 그려지지 않는다**(실측 완료 — §4.1 표 B 참조). 소비처는 `buildTree`(`simulation.js:263-265`) 폴백뿐이고, 잎 라이브 오버레이도 `leafCount` 대신 stage 하드코딩(`renderer.js:511`). 정상 경로에서 메트릭이 나무에 직접 보이는 건 `cacheRead`(금가루, `norms.cacheReadN`)·`requestCount`(발치 식생)뿐. `metrics.js` 의 `sap.density` 필드는 소비처 0건(`norms.cacheReadN` 으로 대체됨). **후속 판단거리:** 폴백을 유지할지(스프라이트 로드 실패 대비) 아니면 sim 계산을 들어낼지는 제품 결정 사항.

6. **`dayIndexFromNewest` 항상 0.** `layoutByPlacements`(`grid.js:55`)가 이 필드를 늘 0 으로 채운다. 이름상 "최신부터의 일 인덱스"를 의도한 듯하나 계산 로직 없음 — 미사용 죽은 필드로 추정(소비처 확인 필요).

7. **`#empty-note` 텍스트 불일치(무해).** 마크업은 "빈 대지 — 사용량 데이터 없음"(`index.html:797`)인데 `showPlantPrompt` 가 항상 다른 문구로 덮음 — 초기 마크업 잔존.

8. **호환용 미사용 인자.** `blockedSet` 의 2·3번째 인자(`forestsMap`/`drilldownMonth`)·`candidateSlots` 의 `startDate` 인자는 시그니처에만 있고 본문 미사용(`activation.js:94-95,208`). main 은 여전히 전달(동작 영향 없음).

9. **`stopAutoUpload` export 미사용.** `upload.js:149-151` 에 export 됐으나 `index.js` 가 import 안 함. Electron 종료 시 호출 가능성(이 영역 밖, 정적 확인 불가).

### 8.2 코드만으로 확정 못 한 것 (런타임 검증 필요)

- **win 빌드 미검증**: `win.target:["nsis"]` 설정은 있으나 실제 nsis 산출/구동은 윈도우 머신에서 `npm run dist:win` 필요(문서 근거 있음). mac 은 검증됨.
- **Electron 재시도 시 boot 중복**: `startServer` 1차 실패 후 재시도가 같은 모듈의 `boot`/`listenWithFallback`/`startAutoUpload` 를 다시 실행 — 이미 listen 중 server 재listen 동작은 코드로 확정 불가.
- **`startServer` 반환값 vs `listenWithFallback` resolve 불일치(정상 동작)**: listenWithFallback 은 포트 number 로 resolve 하나 startServer 는 그 값을 버리고 server 객체 반환, main 은 `server.address().port` 로 다시 읽음(주석상 의도적 설계).
- **자동/수동 심기 동시성 잔존 레이스**: `autoPlanting` + `ui.setPlanting` 단일 가드로 막으나 비동기 인터리빙 전 경로는 정적 분석 한계 — 런타임 확인 필요.
- **species 산식 서버↔클라 동일성**: 같은 `seed.js` 를 import 한다는 사실은 양 영역 조각에서 확인됐으나, 비트 동일 결과는 통합 검증 권장.
- **`countPending` O(N²) 비용**: 콜드 427일 같은 대량에서 guard 800 으로 상한은 있으나 실측 비용 미확인.
- **LOD 임계·FPS·프리즈**: `buffer 면적 > 1_500_000` LOD, 프레임당 베이크 예산은 코드 사실이나 실모드 FPS·프리즈 해소는 헤드리스+실측 영역.

### 8.3 일치 확인된 항목(과거 우려 해소)

- 숲 생성 버튼(`#bundle-btn`)·수동 묶기 UI: §55 에서 폐기 — 마크업·CSS·ui.js 메서드 모두 제거됨(코드·문서 일치).
- 클라 숲 묶기 API 없음: 서버 자동 묶기만 사용, 클라는 `forests[ym].bundled` 로 렌더만(설계대로).

---

## 부록 — 영역별 spec 조각 출처

| 절 | spec 조각 |
|----|-----------|
| §2·§3·§7.2 | `spec_chunks/1_data_server.md` |
| §5 | `spec_chunks/2_client_state.md` |
| §6 | `spec_chunks/3_render.md` |
| §4·§2.5 | `spec_chunks/4_metrics_util.md` |
| §7.1 | `spec_chunks/5_ui_dom.md` |
| §7.3 | `spec_chunks/6_electron.md` |
