---
name: claude-forest-orchestrator
description: Claude Code Forest(일간 Claude 사용량을 도트 숲으로 보여주는 방치형 대시보드)를 만들거나 갱신하는 전체 워크플로우를 조율한다. metrics-engineer(데이터·서버) + forest-game-builder(도트 캔버스) + integration-qa(경계면 검증) 팀을 구성·실행한다. "Claude Forest", "사용량 숲", "사용량 게임", "나무 대시보드", "agenTree" 작업 시 반드시 이 스킬을 사용. "다시 실행", "재실행", "업데이트", "수정", "보완", "집계만 다시", "렌더만 다시", "이전 결과 기반 개선" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.
---

# Claude Forest 오케스트레이터

일간 Claude 사용량을 절차적 도트 숲으로 보여주는 방치형 대시보드를 만드는 팀을 조율한다. 단일 진실 소스는 `_workspace/00_architecture.md`.

## 실행 모드

**에이전트 팀.** 데이터 계약(§1-4)이 문서로 고정돼 있어 metrics-engineer 와 forest-game-builder 가 같은 팀 안에서 계약을 축으로 협업한다. 팀 멤버 3인 모두 `model: "opus"`.

| 팀원 | agent_type | 스킬 | 산출물 |
|---|---|---|---|
| metrics-engineer | metrics-engineer | claude-usage-aggregation | 집계 모듈 + 폴링 서버 + `_workspace/10_*.md` |
| forest-game-builder | forest-game-builder | procedural-dot-forest | 캔버스 클라이언트 + 목모드 + `_workspace/20_*.md` |
| integration-qa | integration-qa | forest-integration-qa | `_workspace/30_qa_report.md` |

- 구성: `TeamCreate` 로 세 팀원을 한 번에 구성(전원 `model: "opus"`), `TaskCreate` 로 작업을 할당(의존성은 `depends_on` 으로 명시).
- 협업: 계약을 축으로 metrics ↔ builder **양방향 반복**, integration-qa 가 경계면을 교차 검증. 점진적 QA 가 이상이면 데이터 레이어부터 먼저 검증.
- 계약 변경: metrics 가 `SendMessage` 로 통지 → builder·qa 가 반영.
- 종합·정리: 리더가 팀원 산출물을 Read 로 종합한 뒤 `TeamDelete` 로 팀 정리.

## Phase 0: 컨텍스트 확인 (초기/후속 판별)

작업 시작 시 기존 산출물로 실행 모드를 결정:

- `_workspace/` 없음 → **초기 실행**: Phase 1 부터.
- `_workspace/` 있음 + 부분 수정 요청("집계만", "렌더만") → **부분 재실행**: 해당 에이전트만 재호출.
- `_workspace/` 있음 + 새 입력/전면 변경 → **새 실행**: 기존 `_workspace/` 를 `_workspace_prev/` 로 옮기고 다시.

## Phase 1: 계약 확인

`_workspace/00_architecture.md` 가 있으면 읽고, 없으면 명세서(`agenTree-develop.md`)와 데이터 소스(claude-usage-tracker)·labs 를 근거로 작성. 데이터 계약·메트릭 매핑·게임 모델·렌더 규칙을 확정한 뒤에만 구현 시작.

## Phase 2: 팀 구성·병렬 구현

1. `TeamCreate` 로 팀 구성(전원 opus):
   ```
   TeamCreate(
     team_name: "claude-forest-team",
     members: [
       { name: "metrics-engineer",    agent_type: "metrics-engineer",    model: "opus", prompt: "데이터 계약 §1-4 소유. 집계 모듈 + 폴링 서버(/api/usage + 정적 서빙) 구현. claude-usage-aggregation 스킬 사용. 산출: _workspace/10_*.md" },
       { name: "forest-game-builder", agent_type: "forest-game-builder", model: "opus", prompt: "캔버스 클라이언트(시뮬/렌더/폴링) + 목모드 구현. 계약 §1-4 에만 의존. procedural-dot-forest 스킬 사용. 산출: _workspace/20_*.md" },
       { name: "integration-qa",      agent_type: "integration-qa",      model: "opus", prompt: "두 산출물의 경계면 교차 검증. forest-integration-qa 스킬 사용. 산출: _workspace/30_qa_report.md" }
     ]
   )
   ```
2. `TaskCreate` 로 작업 할당(의존성은 `depends_on` 으로 명시):
   ```
   TaskCreate(tasks: [
     { title: "집계·서버 구현",   description: "message.id 중복 제거·로컬일·90일·/api/usage 계약", assignee: "metrics-engineer" },
     { title: "캔버스 클라 구현", description: "labs 이식·grid/Y-sort/픽셀퍼펙트·황금수액 40캡·목모드", assignee: "forest-game-builder" },
     { title: "경계면 통합 검증", description: "집계 정확성→JSON 계약 일치→렌더 규칙→실행", assignee: "integration-qa", depends_on: ["집계·서버 구현", "캔버스 클라 구현"] }
   ])
   ```
3. metrics-engineer 와 forest-game-builder 는 계약(§1-4)을 축으로 **양방향 반복**하며 병렬 진행. 계약 변경이 필요하면 metrics 가 `SendMessage` 로 통지하고 builder·qa 가 반영한다. 각 산출물은 실제 코드 파일 + `_workspace/10_*.md`·`_workspace/20_*.md` 리포트.

## Phase 3: 통합 검증·정리

1. integration-qa(스킬: forest-integration-qa)가 구현 작업 완료 후 경계면 교차 검증 작업을 수행: 집계 정확성(중복 제거·로컬일) → 경계면 JSON 계약 일치 → 렌더 규칙 → 실행 순으로 점검. `_workspace/30_qa_report.md` 생성.
2. 실패는 해당 팀원에게 `SendMessage` 로 통지해 1회 수정 후 재검증.
3. 리더가 세 팀원의 산출물을 Read 로 종합하고, `TeamDelete` 로 팀 정리. `_workspace/` 중간 파일은 보존(감사 추적).

## 데이터 전달 프로토콜

- **태스크 기반**(조율): `TaskCreate`/`TaskGet` 으로 작업·의존성·진행 상태 관리.
- **파일 기반**(주): 모든 산출물은 실제 코드 파일 + `_workspace/{phase}_{agent}_{artifact}.md`(10·20·30) 리포트. 중간 파일 보존(감사 추적).
- **메시지 기반**: 계약 변경 등 실시간 조율은 `SendMessage`.

## 에러 핸들링

- 팀원 실패/중지: 리더가 감지 → `SendMessage` 로 상태 확인 → 재시작. 1회 재시도 후 재실패 시 해당 결과 없이 진행하되 QA 리포트/최종 보고에 누락 명시.
- 상충 데이터(예: 집계값 vs 원본)는 삭제하지 않고 출처 병기.
- 계약 불일치는 항상 `_workspace/00_architecture.md` 기준으로 판정.

## 테스트 시나리오

- **정상 흐름**: 계약 확정 → `TeamCreate` 로 3인 팀 구성 + `TaskCreate` → 두 빌더 병렬 구현 → QA 가 `/api/usage` 호출해 §1-4 형태 확인 + 클라이언트 목모드 렌더 확인 → 통과 → `TeamDelete` → 서버 실행 안내.
- **에러 흐름**: 클라이언트가 `totalCacheWrite`(오타)로 접근 → QA 가 경계면 불일치 탐지 → `SendMessage` 로 forest-game-builder 에 통지 → 필드명 수정 → 재검증 통과.

## 산출물 체크리스트

- [ ] 폴링 서버(`/api/usage` + 정적 서빙), 표준 라이브러리만
- [ ] 집계 모듈 — message.id 중복 제거 + 로컬일 + 90일
- [ ] 캔버스 클라이언트 — labs 이식 + grid/Y-sort/픽셀퍼펙트 + 황금수액 40캡 + 목모드
- [ ] QA 리포트 — 경계면 교차 비교 통과
- [ ] 실행 방법 README
