---
name: spec-from-code-orchestrator
description: agenTree 코드를 역설계해 코드 기준 상세 기획문서를 만들고 유지하는 워크플로우를 조율한다. spec-cartographer(영역별 역설계 분석, 병렬 팬아웃) → spec-writer(통합 기획문서 합성) → integration-qa(문서↔코드 정합 검증)를 파이프라인으로 실행한다. "코드 기준 기획문서", "기획문서 작성/갱신", "코드 역설계 문서", "spec 작성", "코드와 기획 동기화", "drift 정합", "현재 코드 정리해서 문서로" 작업 시 반드시 이 스킬을 사용. "다시 작성", "재실행", "그 영역만 다시", "문서 갱신", "이전 결과 기반 개선" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.
---

# spec-from-code 오케스트레이터

코드가 기획문서를 앞질러 생긴 drift 를, **코드를 진실로 삼아** 상세 기획문서를 다시 길어 올려 해소한다.

**실행 모드:** 하이브리드 — 영역별 역설계는 서브 에이전트 병렬 팬아웃(독립 분석, 통신 불필요), 합성·검증은 단일 서브 에이전트 순차. 모든 Agent 호출은 `model: "opus"`.

**데이터 전달:** 파일 기반. cartographer → `_workspace/spec_chunks/{area}.md`, writer → `agenTree-spec.md`(프로젝트 루트, 또는 사용자 지정). 중간 조각은 `_workspace/` 에 보존.

## Phase 0: 컨텍스트 확인

1. `_workspace/spec_chunks/` 와 통합 문서(`agenTree-spec.md`) 존재 여부 확인.
2. 분기:
   - **초기 실행**: 둘 다 없음 → Phase 1 부터 전체.
   - **부분 재실행**: 존재 + 사용자가 특정 영역/절 수정 요청 → 해당 cartographer 만 재호출 → writer 가 그 절만 갱신 → QA.
   - **전면 갱신**: 존재 + 코드가 크게 바뀜 → 기존 조각을 `spec_chunks_prev/` 로 옮기고 재분석.
3. 산출물 경로를 사용자에게 확인(기본 `agenTree-spec.md`, 프로젝트 루트).

## Phase 1: 영역 분할

코드베이스를 독립 분석 가능한 영역으로 나눈다. agenTree 현재 기준 6 영역:

| # | 영역 | 파일 |
|---|------|------|
| 1 | 데이터·집계·서버 | `server/{aggregate,store,index,mock,upload}.js` |
| 2 | 클라 상태·활성화·조율 | `public/js/{main,state,activation,bundle-rule,cold-source}.js` |
| 3 | 렌더 파이프라인 | `public/js/{renderer,simulation,sprites,particles}.js`, `public/js/render/*` |
| 4 | 메트릭→식생 매핑·유틸 | `public/js/{metrics,grid,seed,debug}.js` |
| 5 | UI·DOM | `public/js/ui.js`, `public/index.html` |
| 6 | Electron 배포 | `main.js`, `preload.js`, `package.json`(build), `server/index.js`(startServer) |

코드 구조가 바뀌면 영역을 재산정한다(파일 목록을 먼저 `ls`/`wc` 로 확인).

## Phase 2: 역설계 (팬아웃)

`spec-cartographer` 6 명을 **한 메시지에서 병렬 스폰**(서브 에이전트, `run_in_background` 불필요 — 동시 호출). 각자 한 영역 + 출력 경로를 받는다. 각 cartographer 는 `code-reverse-spec` 스킬을 따라 조각을 Write 한다.

대기 후 6 조각이 다 생겼는지 확인. 빠진 영역은 1 회 재시도, 재실패면 "조각 부재"로 기록하고 진행(누락 명시).

## Phase 3: 합성

`spec-writer` 1 명을 스폰. `spec_chunks/*` + (참고) `00_architecture.md` 를 읽어 `spec-document-authoring` 스킬대로 통합 문서를 Write. 데이터 계약 단일 출처·데이터 흐름 순 배치·drift 명시.

## Phase 4: 검증 (생성-검증)

`integration-qa` 1 명을 스폰. **문서 주장 ↔ 코드 정합**을 교차 검증:
- 문서가 단정한 데이터 계약·함수 시그니처·API shape 이 실제 코드와 맞는가(샘플 교차 비교).
- "추정"이 사실처럼 단정되지 않았는가.
- 데이터 계약이 두 절에 갈라져 적히지 않았는가.

QA 가 불일치를 보고하면 writer 를 재호출해 **해당 절만** 고친다(전면 재작성 금지). 1 회 수정 후에도 남는 불일치는 문서 §미확정에 명시.

## Phase 5: 보고

사용자에게: 산출 문서 경로, 영역별 커버리지, 발견한 drift 목록(기존 문서와 코드가 갈린 지점), 미확정·후속 항목. CLAUDE.md 변경 이력에 이번 실행을 기록한다.

## 에러 핸들링

- cartographer 실패: 1 회 재시도 → 실패 시 그 영역 "조각 부재", 나머지로 합성 진행.
- 조각 간 충돌: 삭제 금지, writer 가 양쪽 병기 → QA 판정 → 코드 근거 있는 쪽 채택.
- QA 가 문서 다수 절을 반려: 반려 절 목록만 writer 에 전달해 부분 수정.

## 테스트 시나리오

- **정상 흐름:** "현재 코드 기준 상세 기획문서 작성" → 6 영역 병렬 역설계 → 통합 문서 합성 → QA 정합 통과 → `agenTree-spec.md` 산출 + drift 보고.
- **에러 흐름:** 렌더 영역 cartographer 가 대형 파일로 일부만 분석 → 조각 §7 에 누락 범위 명시 → writer 가 렌더 절에 "부분 커버"로 표기 → QA 가 누락 지적 → 렌더 영역만 재분석.
- **후속 흐름:** "자동 심기 부분만 문서 갱신" → 영역 2·5 cartographer 만 재호출 → writer 가 해당 절만 갱신 → QA.
