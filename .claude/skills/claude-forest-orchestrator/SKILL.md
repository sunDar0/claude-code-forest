---
name: claude-forest-orchestrator
description: Claude Code Forest(일간 Claude 사용량을 도트 숲으로 보여주는 방치형 대시보드)를 만들거나 갱신하는 전체 워크플로우를 조율한다. metrics-engineer(데이터·서버) + forest-game-builder(도트 캔버스) + integration-qa(경계면 검증) 팀을 구성·실행한다. "Claude Forest", "사용량 숲", "사용량 게임", "나무 대시보드", "agenTree" 작업 시 반드시 이 스킬을 사용. "다시 실행", "재실행", "업데이트", "수정", "보완", "집계만 다시", "렌더만 다시", "이전 결과 기반 개선" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.
---

# Claude Forest 오케스트레이터

일간 Claude 사용량을 절차적 도트 숲으로 보여주는 방치형 대시보드를 만드는 팀을 조율한다. 단일 진실 소스는 `_workspace/00_architecture.md`.

## 실행 모드

**하이브리드.** 데이터 계약(§1-4)이 문서로 고정돼 있어 두 빌더가 협상 없이 병렬로 일할 수 있다.

- 구현 단계: metrics-engineer 와 forest-game-builder 를 **병렬**로 호출(서로 계약으로만 결합). 모든 Agent 호출에 `model: "opus"` 명시.
- 검증 단계: integration-qa 가 두 산출물의 **경계면을 교차 검증**. 점진적 QA 가 이상이면 데이터 레이어부터 먼저 검증.
- 실시간 협상이 필요해지면(계약 변경) 그때만 팀 메시지(SendMessage)로 전환.

## Phase 0: 컨텍스트 확인 (초기/후속 판별)

작업 시작 시 기존 산출물로 실행 모드를 결정:

- `_workspace/` 없음 → **초기 실행**: Phase 1 부터.
- `_workspace/` 있음 + 부분 수정 요청("집계만", "렌더만") → **부분 재실행**: 해당 에이전트만 재호출.
- `_workspace/` 있음 + 새 입력/전면 변경 → **새 실행**: 기존 `_workspace/` 를 `_workspace_prev/` 로 옮기고 다시.

## Phase 1: 계약 확인

`_workspace/00_architecture.md` 가 있으면 읽고, 없으면 명세서(`agenTree-develop.md`)와 데이터 소스(claude-usage-tracker)·labs 를 근거로 작성. 데이터 계약·메트릭 매핑·게임 모델·렌더 규칙을 확정한 뒤에만 구현 시작.

## Phase 2: 병렬 구현

| 에이전트 | 스킬 | 산출물 |
|---|---|---|
| metrics-engineer | claude-usage-aggregation | 집계 모듈 + 폴링 서버(`/api/usage` + 정적 서빙) + `_workspace/10_*.md` |
| forest-game-builder | procedural-dot-forest | 캔버스 클라이언트(시뮬/렌더/폴링) + 목모드 + `_workspace/20_*.md` |

두 에이전트를 `run_in_background: true` 로 병렬 호출. 각자 계약(§1-4)에만 의존.

## Phase 3: 통합 검증

integration-qa(스킬: forest-integration-qa) 호출. 집계 정확성(중복 제거·로컬일) → 경계면 JSON 계약 일치 → 렌더 규칙 → 실행 순으로 점검. `_workspace/30_qa_report.md` 생성. 실패는 해당 에이전트에 통지해 1회 수정.

## 데이터 전달 프로토콜

- **파일 기반**(주): 모든 산출물은 실제 코드 파일 + `_workspace/{phase}_{agent}_{artifact}.md` 리포트. 중간 파일 보존(감사 추적).
- **반환값 기반**: 백그라운드 에이전트 완료 메시지로 결과 수집.
- 계약 변경 시에만 **메시지 기반**(SendMessage).

## 에러 핸들링

- 1회 재시도 후 재실패 시 해당 결과 없이 진행하되 QA 리포트/최종 보고에 누락 명시.
- 상충 데이터(예: 집계값 vs 원본)는 삭제하지 않고 출처 병기.
- 계약 불일치는 항상 `_workspace/00_architecture.md` 기준으로 판정.

## 테스트 시나리오

- **정상 흐름**: 계약 확정 → 두 빌더 병렬 구현 → QA 가 `/api/usage` 호출해 §1-4 형태 확인 + 클라이언트 목모드 렌더 확인 → 통과 → 서버 실행 안내.
- **에러 흐름**: 클라이언트가 `totalCacheWrite`(오타)로 접근 → QA 가 경계면 불일치 탐지 → forest-game-builder 에 통지 → 필드명 수정 → 재검증 통과.

## 산출물 체크리스트

- [ ] 폴링 서버(`/api/usage` + 정적 서빙), 표준 라이브러리만
- [ ] 집계 모듈 — message.id 중복 제거 + 로컬일 + 90일
- [ ] 캔버스 클라이언트 — labs 이식 + grid/Y-sort/픽셀퍼펙트 + 황금수액 40캡 + 목모드
- [ ] QA 리포트 — 경계면 교차 비교 통과
- [ ] 실행 방법 README
