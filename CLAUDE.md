# agenTree — Claude Code Forest

일간 Claude Code 사용량을 절차적 도트 그래픽 숲으로 보여주는 로컬 폴링 방치형 대시보드.

## 외부 지식 베이스 — my-wiki (필수 우선 참조)

이 프로젝트의 증류된 지식은 vault `~/study/llm-wiki/my-wiki/` 에 있다. 구조는 4 카테고리 평탄화 (`concepts/`, `entities/`, `sources/`, `topics/`) — 하위 폴더 없음.

### 트리거 — 다음 유형의 작업은 **반드시 wiki 부터 Read 도구로 호출** 한 뒤 답변/구현을 시작한다

- 아키텍처 / 컴포넌트 / 플로우 / 외부 통합에 대한 질문
- 코드 리뷰 / 디버깅 / 영향도 분석
- 신규 기능 설계 또는 리팩토링
- 과거 결정의 근거 확인 ("왜 이렇게 했지?", "왜 이건 제거됐지?")
- 환경별 차이 / 함정 / 안티패턴 / 데드 코드 정리 관련
- "위험이 있나?" / "안전한가?" 같은 평가성 질문 (wiki 의 evidence-based 결론이 1 차 답)

### 면제 — wiki 우회 가능

- 단순 코드 위치 조회 ("X 함수 어디 있어?")
- 한 줄 수정, 빌드/테스트 명령 실행
- 빌드 에러 메시지 해석
- 사용자가 명시적으로 "wiki 무시" 라고 지시한 경우

### 경로 (평탄화 구조)

- 카탈로그: `~/study/llm-wiki/my-wiki/wiki/index.md`
- 카테고리: `wiki/concepts/`, `wiki/entities/`, `wiki/sources/`, `wiki/topics/` — 하위 폴더 없음
- agenTree(Claude Forest) 관련 진입점:
  - `wiki/topics/claude-code-forest.md` — 종합 허브
  - `wiki/topics/agentree-spec-harness-arc.md` — spec·하네스·아키텍처 허브
  - `wiki/topics/decision-agentree-*.md` — 결정 모음 (자동묶기·blockedSet 단일소스·grid taxonomy·노이즈 경계 통일·localStorage→server data·메트릭 식생 매핑·startDate 모달·overview LOD 등)
  - concepts: `procedural-tree-depth-layering.md`·`single-source-of-truth-grid-set.md`·`stub-canvas-headless.md`·`pixel-scan-root-cause-vs-occlusion.md`
- 전이 가능한 패턴·안티패턴·기법은 `wiki/concepts/` 에 단독 페이지로 존재. entity·topic 페이지의 `[[wikilink]]` 로 연결됨

### 작업 시작 절차 (트리거 해당 시)

1. **MUST**: `wiki/index.md` 또는 `claude-code-forest` 허브 / 관련 `decision-agentree-*` 페이지를 **Read 도구로 호출**. 답변 본문 작성 시작 전에 반드시.
2. 진입 페이지의 `[[wikilink]]` 를 타고 관련 concepts / topics / sources 로 자연 확장 (이미 서로 링크되어 있음)
3. 진입점이 모호하면 `wiki/index.md` 훑어 카테고리 직접 진입
4. wiki 에 없는 세부만 repo 원본 조회
5. **답변에 wiki 페이지 인용을 명시** — `[[wikilink]]` 또는 `wiki/<category>/<slug>.md` 경로로 표기. 인용 없는 답변은 wiki 우회로 간주
6. **새 컨텍스트로 분기되는 모든 위임 시** (서브에이전트 · 에이전트 팀 · 스킬 내부의 에이전트 spawn 등) 에는 wiki 에서 확인한 관련 페이지 핵심 요약을 **위임 prompt 에 포함**. 각 인스턴스는 자기 정의 파일과 위임 prompt 만으로 시작하므로 부모 CLAUDE.md 는 자동 전파되지 않음. 부모가 컨텍스트 bridge 역할

### 셀프 체크 (답변 작성 직전)

- "방금 wiki 페이지를 Read 도구로 호출했는가?"
- "답변에 wiki 페이지를 인용하고 있는가?"

둘 중 하나라도 No 이고 위 트리거에 해당하는 작업이라면 **답변 작성을 멈추고 1·5 번부터 다시 수행**.

### Post-flight — 작업 완료 후

- 새로 발견한 wiki-worthy 지식은 사용자와 **distill 트리거로 증류**. 자동 기록 금지
- 트리거 문구: `"my-wiki 에 정리"`, `"my-wiki 에 증류"`, `"wiki 에 증류"`, `"증류해줘"` — `my-wiki-distill` 스킬이 작동
- 증류 판정 기준 (Pass 1 wiki-worthy, 4 카테고리 분류) 과 절차는 vault 의 `~/study/llm-wiki/my-wiki/CLAUDE.md` 참조

## 하네스: Claude Forest

**목표:** `~/.claude/projects/**` 의 사용량 jsonl 을 일자별로 집계해, 하루 = 나무 한 그루로 자라는 도트 숲으로 시각화한다.

**트리거:** Claude Forest / 사용량 숲 / 사용량 게임 / 나무 대시보드 / agenTree 관련 작업(생성·수정·재실행) 요청 시 `claude-forest-orchestrator` 스킬을 사용하라. 단순 질문은 직접 응답 가능.

**단일 진실 소스:** `_workspace/00_architecture.md` (데이터 계약 §1, 메트릭 매핑 §2, 게임 모델 §3, 폴링 §4, 렌더 규칙 §5). 코드 현 상태 기술은 `agenTree-spec.md`(역설계 spec). 데이터 집계 기준 구현은 `~/work/claudeCode-thirdParty/claude-usage-tracker`, 렌더 이식 출처는 `~/study/labs/tree-growth-simulation`.

**변경 이력 (요약 — 섹션별 상세는 `_workspace/00_architecture.md` §번호 본문·`20_forest_game_report.md`·git log):**
| 기간 | 범위 | 핵심 |
|------|------|------|
| 2026-06-08 | §1~§8 | 하네스 신규(계약서·agents·skills)·구현/QA(8/8)·렌더 방향 전환(labs 아이소 이식 폐기→탑다운 활엽수)·그리드(하루=9타일)·계층(타일/그리드/숲(월)/연간) 기획 |
| 2026-06-08~09 | §9~§22 | XP/단계(5시간 cap 역산)·툴팁/상세·DOM UI 전환·data 서버 영속(일/월/년·인메모리·finalized 동결)·mock 427일·콜드 첫 그리드·시작일 모달 |
| 2026-06-10 | §24~§37 | 맵 경계 클램프·오버뷰 줌·숲 군집·스프라이트 베이크+프리즈 근본수정·바닥/경계 유기화·그리드 6종·차단 단일 소스 blockedSet |
| 2026-06-11 | §38~§54 | 생태계(요청수→발치 식생)·경계 월드 노이즈 통일·메트릭→식생 매핑(refMax/species)·닫힘 그리드 활성화·마지막 활성 깃발·잎 라이브 오버레이 |
| 2026-06-11~15 | §55 | 자동 숲 묶기(지난 달 무조건 bundled)·blocked 폐기→closed 만·빛기둥·숲 생성/수동 묶기 UI 폐기 |
| 2026-06-15 | §56~§62 | UI 다수: 상세 모달 확대·ESC 우선순위·중앙 서버 업로드(하단 HUD)·업로드 설정 모달·미니맵·상세 비중 % 선형 |
| 2026-06-17 | §63 | 나무 단계 분모 교체=일일누적 역대최대(`dailyMaxTokens`)·순환 결함 수정·임계 0.3/0.6 불변·과거 동결 유지 |
| 2026-06-18 | 식생 재설계(35/35→36/36) | empty 셀 나무 제외·그늘 기반 풀/흙(`shadowRadiusFactor` 0.6)·바닥 연속화·디버그 트윅 패널(`?debug`)·골든 `ff226893`→`75c15d77`·후속 empty 군집 오버뷰 스냅샷 가드 1줄(36/36) |
| 2026-07-02 | harness 정합 | 에이전트 model tier 명시(opus/sonnet)·오케스트레이터 팀 모드 전환·팀 통신 프로토콜 정비·integration-qa 스킬 3문맥 일반화(forest-integration-qa) — 대상 claude-forest-orchestrator·metrics-engineer·forest-game-builder·forest-integration-qa, 사유 references 조정 반영 |

## 하네스: 아키텍처 감사·교정

**목표:** 코드가 각 모듈의 속성(순수데이터/순수함수/상태/IO/렌더/UI/조율)과 사용 목적에 맞게 자리잡았는지 검증하고, 어긋나면 이 프로젝트에 알맞은 아키텍처를 제시·안전 교정한다. 빌더 하네스(`claude-forest-orchestrator`)와 별개 — **구조를 본다.**

**트리거:** "아키텍처 검증/감사", "리팩토링 검증", "구조 점검", "속성·목적에 맞는지", "구조 개선", "모듈 분리 검증" 요청 시 `architecture-refactor-orchestrator` 스킬을 사용하라. "다시 검증", "재검증", "그 항목만 교정", "남은 교정 이어서", "회귀 확인", "이전 리뷰 기반" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.

**안전망(SSoT):** 렌더 골든 지문(`test/render-smoke.test.js`)·`npm test`·브라우저 스모크 아래에서만 교정. 기준값·케이스 수 상세는 `safe-refactor`·`forest-integration-qa` 스킬 참조(코드가 진실 소스).

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-16 | 초기 구성 | agents(architecture-reviewer·refactor-surgeon 신규, integration-qa 재사용) + skill(architecture-refactor-orchestrator) | 속성·목적 정합 검증·교정 하네스 신규 구축 |
| 2026-07-02 | 에이전트 model tier 명시(opus/sonnet)·오케스트레이터 팀 모드 전환·팀 통신 프로토콜 정비·architecture-audit·safe-refactor 스킬 신설·integration-qa 3문맥 일반화(forest-integration-qa) | architecture-reviewer·refactor-surgeon·architecture-refactor-orchestrator·architecture-audit·safe-refactor·forest-integration-qa | references 조정 반영 |

## 하네스: Electron 데스크톱 배포

**목표:** 기존 웹 대시보드(`server/` + `public/`)를 Electron 으로 감싸 윈도우·맥 배포본을 만든다. 기능을 새로 만들지 않고 **이미 동작하는 앱을 데스크톱으로 포장**한다. 메인 프로세스가 기존 http 서버(포트 5178)를 띄우고 BrowserWindow 가 localhost 를 로드.

**트리거:** "Electron/일렉트론", "데스크톱 앱", "윈도우 앱", "맥 앱", "exe/dmg", "설치본·배포본 만들기", "앱으로 패키징" 요청 시 `electron-distribution-orchestrator` 스킬을 사용하라. "다시 빌드", "타겟 추가", "win 도 빌드" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.

**SSoT:** asar 쓰기 함정(store.js `data/`→userData·`FOREST_DATA_DIR` env·개발 폴백)·창 하한(`minWidth:780`)은 `electron-app-integration` 스킬·`agenTree-spec.md`, 패키징 전제(무서명·로컬 OS별·자동 업데이트 제외)는 `electron-packaging` 스킬 참조. 전제 변경은 사용자 재확인.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-16 | 초기 구성 | agents(electron-integrator·packaging-engineer·build-verifier 신규) + skills(electron-app-integration·electron-packaging·electron-build-verification·electron-distribution-orchestrator) | win/mac 데스크톱 배포 하네스 신규 구축. 서버 통합→패키징→구동검증 서브 에이전트 파이프라인 |
| 2026-06-16 | 1차 실행 완료(전 단계 통과) | main.js·preload.js 신설, server/{index,store}.js(startServer 추출·FOREST_DATA_DIR env), package.json(main·build·dist scripts·electron 42/electron-builder devDeps), `_workspace/5{0,1,2}_*.md` | mac 배포본 `dist/*.dmg`·`*.zip` 산출·구동·data userData 쓰기·`npm test` 31/31 통과. win 미검증 |
| 2026-07-02 | 에이전트 model tier 명시(opus/sonnet)·오케스트레이터 팀 모드 전환·팀 통신 프로토콜 정비 | electron-integrator·packaging-engineer·build-verifier·electron-distribution-orchestrator | references 조정 반영 |

## 하네스: UI 디자인·완성도 점검

**목표:** UI 형태·완성도·배치가 기획 의도(`_workspace/00_architecture.md` §3·§5·§7 + `20_forest_game_report.md` 최근 사양)에 부합하는지 **라이브 화면으로** 점검하고 교정한다. 코드 구조를 보는 아키텍처 감사 하네스와 별개 — **렌더된 픽셀을 본다**(claude-in-chrome 캡처가 본질, 코드만 보면 겹침/가림을 놓침).

**트리거:** "UI 점검", "UI 검토", "완성도 점검", "배치 점검", "기획 부합 점검", "디자인 검토", "화면 점검" 요청 시 `ui-design-review-orchestrator` 스킬을 사용하라. "다시 점검", "재점검", "그 항목만 교정", "회귀 확인", "이전 리뷰 기반" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-17 | 초기 구성 | agents(ui-design-reviewer 신규) + skills(ui-design-review·ui-design-review-orchestrator), forest-game-builder 교정 재사용 | "배치하고 검토 안 하냐" 교훈 — 라이브 화면 캡처·기획 대조 점검 하네스 신규 구축 |
| 2026-07-02 | 에이전트 model tier 명시(opus/sonnet)·오케스트레이터 팀 모드 전환·팀 통신 프로토콜 정비 | ui-design-reviewer·ui-design-review·ui-design-review-orchestrator | references 조정 반영 |

## 하네스: 코드 기준 기획문서화 (역설계 spec)

**목표:** 코드가 기획문서를 앞질러 생긴 drift 를, **코드를 진실로 삼아** 상세 기획문서를 다시 길어 올려 해소한다. 영역별로 코드를 역설계해 사실 조각을 추출하고, 하나의 통합 기획문서로 합성한 뒤, 문서↔코드 정합을 교차 검증한다. 기존 `00_architecture.md`(기획 의도·계약서)는 히스토리로 보존하고, 코드 현 상태를 기술하는 새 문서(`agenTree-spec.md`)를 만든다.

**트리거:** "코드 기준 기획문서", "기획문서 작성/갱신", "코드 역설계 문서", "spec 작성", "코드와 기획 동기화", "drift 정합", "현재 코드 정리해서 문서로" 요청 시 `spec-from-code-orchestrator` 스킬을 사용하라. "다시 작성", "재실행", "그 영역만 다시", "문서 갱신", "이전 결과 기반 개선" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-17 | 초기 구성 + 1차 실행 | agents(spec-cartographer·spec-writer 신규, integration-qa 재사용) + skills(code-reverse-spec·spec-document-authoring·spec-from-code-orchestrator) / `agenTree-spec.md`(통합 기획문서) | 코드가 기획을 앞질러 drift 누적 → 역설계 기획문서화. 6영역 병렬 역설계→통합 합성→QA 교차검증. 00_architecture.md 는 히스토리 보존 |
| 2026-07-02 | 에이전트 model tier 명시(opus/sonnet)·오케스트레이터 팀 모드 전환·팀 통신 프로토콜 정비·integration-qa 3문맥 일반화(forest-integration-qa) | spec-cartographer·spec-writer·spec-from-code-orchestrator·forest-integration-qa | references 조정 반영 |
