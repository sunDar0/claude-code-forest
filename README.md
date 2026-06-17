# Claude Code Forest (agenTree)

Claude Code 의 일간 LLM 사용량을 절차적 도트 그래픽 숲으로 보여주는 **로컬 폴링 방치형 대시보드**.
**하루 = 나무 한 그루**, **한 달 = 숲 하나**.

머신의 `~/.claude/projects/**/*.jsonl` 사용량을 일자별로 집계해, 빈 그리드 칸에 그날 나무를 "심고",
사용량이 많을수록 나무가 묘목 → 유목 → 성목 10단계로 자랍니다. 지난 달은 자동으로 숲 군집이 됩니다.

---

## 빠른 시작 (웹, 설치 없음)

런타임 의존성 0 (Node 표준 라이브러리만). `npm install` 없이 바로 돕니다. **Node 20.6+** 필요.

```bash
npm start            # = node --env-file-if-exists=.env server/index.js
# 또는
node server/index.js
```

브라우저에서:

```
http://localhost:5178
```

포트 변경은 `PORT` 환경변수.

```bash
PORT=8080 node server/index.js
```

처음 켜면 시작일 모달이 뜹니다 — 날짜를 정하면 그날부터 오늘까지 빈 칸이 채워집니다(자동 심기 기본 ON).

---

## 데스크톱 앱 (Electron, win/mac)

같은 웹 대시보드를 Electron 으로 감싼 배포본입니다. 빌드 시에만 의존성이 필요합니다.

```bash
npm install          # electron · electron-builder (devDependencies)
npm run dist:mac     # mac dmg/zip → dist/
npm run dist:win     # win nsis    → dist/  (윈도우 머신에서)
npm run pack         # 패키징 검증(--dir, 설치본 없이 폴더)
```

코드 서명 없이(개인/사내) 각 OS 에서 직접 빌드하는 전제입니다. 메인 프로세스가 내부에서 서버를 띄우고
`data/` 쓰기 경로는 `userData` 로 빠지므로(asar 읽기전용 회피) 개발 동작은 그대로입니다.

---

## 화면에서 일어나는 일

- **심기**: 시작일~오늘 사이 미배치 날을 가장 오래된 순서로 심습니다. 첫 칸은 자유, 이후는 마지막 활성 칸 8방향 인접.
  자동(방치) / 수동(빈 칸 클릭 → 확인) 모두 같은 가드를 공유합니다.
- **10단계 성장**: 그날 사용량 비율(일일 cap 대비)로 묘목 1~3 · 유목 1~3 · 성목 1~4 프레임이 결정됩니다.
  같은 나무는 자랄수록 같은 수종의 프레임을 0→9 순서로 밟습니다(수종은 날짜 시드로 고정).
- **자동 숲 묶기**: 달이 지나면(현재월 이전) 그 달이 자동으로 한 숲 군집이 됩니다(완주 무관).
- **호버**: 커서가 올라간 칸·숲에 옅은 녹색 외곽선이 뜹니다.
- **상세**: 칸을 클릭하면 모달 상단에 그 칸을 확대한 도트 미리보기, 하단에 날짜·단계·수종·경험치·5메트릭이 표시됩니다.

### 사용량 → 나무 매핑 (요약)

| 사용량 | 나무 표현 |
|--------|-----------|
| 일일 총 토큰 / 일일 cap | 성장 단계(10단계) |
| `cacheReadTokens` | 성목 위 금가루 양(최대 40 스로틀) |
| `requestCount` | 발치 식생 개수 |
| input/output/cacheWrite 비중 | 발치 식생 종류 |
| 날짜 시드 | 수종(초록·연두·단풍·진청록·민트) |

> 자세한 매핑·렌더 규칙·데이터 계약은 [`agenTree-spec.md`](./agenTree-spec.md) 참조.

---

## 데이터

- **소스**: `~/.claude/projects/**/*.jsonl`(머신 전체), `type==='assistant'` + 비어있지 않은 `message.usage` 만.
- **중복 제거**: `message.id` 가 같으면 마지막 엔트리로 덮어쓴 뒤 일자 합산(스트리밍 토큰 부풀림 방지).
- **날짜**: `timestamp` 를 **로컬 시간대** `YYYY-MM-DD` 로 버킷팅(UTC 아님). 최근 **90일** 윈도우.
- **영속**: `data/` 에 일/월/년 파일로 저장(원자적 쓰기). 과거 날짜는 부팅 시 동결(finalized), 오늘만 갱신.
- **일일 cap**: statusline 5시간 사용률 역산값과 5h 블록 totals 의 **p85 분위수** 중 큰 값 × 2.
  관측 최대(max)가 아니라 분위수라, 한도 리셋 같은 이상치 한 날이 분모를 영구히 부풀리지 않습니다.

집계·계층 결과만 서버 없이 확인:

```bash
npm run usage:once     # 호환용 daily[] 집계(GET /api/usage 형태)
npm run forest:once    # 일/월/년 계층(GET /api/forest 형태). data/ 가 생성됩니다.
```

### 주요 API

- `GET /api/forest` — 전역 메타 + 일/월/년 계층 전체(렌더용). `dailyCapTokens`·`fiveHourPct`·`refMax` 등 동봉.
- `POST /api/grid/activate` `{date,gx,gy}` — 그리드 활성화(심기). 좌표 중복·비인접·미래는 거부.
- `GET /api/usage` — 호환용 `daily[]` 집계(4초 TTL 캐시).

---

## 중앙 서버 업로드 (선택)

여러 머신의 사용량을 사내 중앙 서버로 모으고 싶을 때만 설정합니다. `.env`(미추적) 에:

```bash
UPLOAD_USER_EMAIL=you@example.com      # 설정 시 자동 업로드 활성(인증 = 이메일 필드)
UPLOAD_SERVER_URL=http://server:port   # POST {url}/api/claude-usage/upload (multipart)
UPLOAD_INTERVAL=600                     # 주기(초)
FOREST_DEBUG=0                          # 1 이면 mock/cold/debug 허용(개발용)
```

설정은 GUI(하단 HUD 톱니) 또는 `data/upload-config.json` 으로도 바꿀 수 있습니다. 미설정이면 업로드는 꺼집니다.

---

## 개발·디버그 모드

데이터 모드(`real`/`mock`/`cold`) 선택은 **서버가 `FOREST_DEBUG=1` 일 때만** 가능합니다. 그 외에는 항상 실데이터.

- 개발 모드면 화면에 데이터 소스 선택 패널이 뜨고, 고르면 localStorage(`forest.debugMode`)에 저장 후 새로고침으로 그 소스로 재부팅합니다(URL 쿼리 아님).
- `mock` → 서버 `mock/` 디렉토리(read-only) 데모 데이터 / `cold` → 인메모리 콜드 목(빈 데이터, 액션 가능).
- `?debug=1` → 그리드 좌표 라벨·격자선 표시.

```bash
npm test               # node --test (집계·정규화·렌더 스모크 골든 등)
```

---

## 문서

- [`agenTree-spec.md`](./agenTree-spec.md) — **코드 기준 상세 기획문서**(역설계). 현재 코드가 실제로 하는 일의 단일 정의처.
- [`agenTree-develop.md`](./agenTree-develop.md) — 초기 기획·개발 노트(히스토리).
