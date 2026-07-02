---
name: architecture-refactor-orchestrator
description: agenTree 코드가 각 모듈의 속성과 사용 목적에 맞게 구조화됐는지 검증하고, 안 맞으면 이 프로젝트에 알맞은 아키텍처를 제시하고 안전하게 교정하는 팀을 조율한다. architecture-reviewer(속성·목적 정합 검토) + refactor-surgeon(안전 교정) + integration-qa(동작 보존 검증)를 파이프라인으로 실행한다. "아키텍처 검증", "아키텍처 감사", "리팩토링 검증", "구조 점검", "속성·목적에 맞는지", "아키텍처 제시", "구조 개선", "모듈 분리 검증" 작업 시 반드시 이 스킬을 사용. "다시 검증", "재검증", "그 항목만 교정", "남은 교정 이어서", "회귀 확인", "이전 리뷰 기반" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.
---

# 아키텍처 감사·교정 오케스트레이터

코드가 각 모듈의 **속성**(순수데이터/순수함수/상태/IO/렌더/UI/조율)과 **사용 목적**에 맞게 자리잡았는지 검증하고, 어긋난 게 있으면 이 프로젝트에 알맞은 아키텍처를 제시하고 안전하게 교정한다.

기능을 새로 만드는 빌더 하네스(`claude-forest-orchestrator`)와 별개다. 이 하네스는 **구조를 본다.**

## 실행 모드

**에이전트 팀 + 승인 게이트.** 감사 → (사용자 승인) → 교정 → 검증의 순차 의존을 한 팀 안에서 조율한다. 팀 멤버 3인 모두 `model: "opus"`.

| 팀원 | agent_type | 스킬 | 역할 | 산출물 |
|---|---|---|---|---|
| architecture-reviewer | architecture-reviewer | architecture-audit | 속성·목적 정합 검토 | `_workspace/40_arch_review.md` |
| refactor-surgeon | refactor-surgeon | safe-refactor | 안전 교정(한 번에 하나) | `_workspace/41_refactor_log.md` |
| integration-qa | integration-qa | forest-integration-qa (3문맥 공유, 문맥 B: 아키텍처 회귀) | 동작 보존 검증 | (회귀 결과 → 41 로그 반영) |

- 구성: `TeamCreate` 로 세 팀원을 한 번에 구성(전원 `model: "opus"`).
- **승인 게이트가 핵심**: reviewer 의 교정안 중 사용자가 확인한 항목만 surgeon 에게 전달한다. 자동 일괄 교정 금지(아키텍처 결정은 사용자 몫).
- 팀 통신: reviewer→surgeon(승인된 교정 항목), surgeon→qa(교정 완료 통지), qa→reviewer/surgeon(회귀 발견 시). 모두 `SendMessage`.

## Phase 0: 컨텍스트 확인 (초기/후속 판별)

- `_workspace/40_arch_review.md` 없음 → **초기 검증**: Phase 1 부터.
- 있음 + "그 항목만"·"남은 교정 이어서" → **부분 재실행**: surgeon 만 미적용 항목으로.
- 있음 + "다시 검증"·"재검증" → **재감사**: reviewer 재호출(회귀·신규 불일치 포함).

## Phase 1: 안전망 확인 (선행 조건)

교정 전에 안전망이 있는지 먼저 본다 — 없으면 교정이 위험하다.

- `npm test` 가 통과하는지(렌더 비교 시험 기준값 + 단위 테스트). 기준값이 어떤 경로를 덮는지 파악.
- 자동 시험이 없는 영역(main·state·ui·debug)은 브라우저 스모크가 가드임을 인지.

## Phase 2: 팀 구성·감사 (architecture-reviewer)

1. `TeamCreate` 로 팀 구성(전원 opus):
   ```
   TeamCreate(
     team_name: "arch-refactor-team",
     members: [
       { name: "architecture-reviewer", agent_type: "architecture-reviewer", model: "opus", prompt: "속성·목적 정합 감사. architecture-audit 스킬 사용. 산출: _workspace/40_arch_review.md (모듈 속성 표/의존 그래프/불일치 목록(심각도)/목표 아키텍처/우선순위 교정안)." },
       { name: "refactor-surgeon",      agent_type: "refactor-surgeon",      model: "opus", prompt: "승인된 교정을 한 번에 하나씩 안전 적용. safe-refactor 스킬 사용. 산출: _workspace/41_refactor_log.md." },
       { name: "integration-qa",        agent_type: "integration-qa",        model: "opus", prompt: "교정 후 동작 보존 회귀 검증. forest-integration-qa 스킬(문맥 B: 아키텍처 회귀) 사용." }
     ]
   )
   ```
2. `TaskCreate` 로 감사 작업을 architecture-reviewer 에 할당. reviewer 가 속성·목적 정합을 검증해 `_workspace/40_arch_review.md` 생성:
   모듈 속성 표 / 의존 그래프 / 불일치 목록(심각도) / 목표 아키텍처 / 우선순위 교정안.

## Phase 3: 승인 게이트 (사용자)

reviewer 의 교정안을 사용자에게 **요약 보고**하고, 적용할 항목을 고르게 한다. 영향도·비용·안전망 유무를 함께 제시. 사용자가 고른 항목만 다음 단계로.

## Phase 4: 교정 (refactor-surgeon → integration-qa, 항목당 반복)

승인된 교정을 **한 번에 하나씩** (팀원 간 `SendMessage` 로 조율):

1. 리더/reviewer 가 승인된 교정 항목을 `SendMessage` 로 refactor-surgeon 에 전달.
2. `refactor-surgeon` 가 한 교정 적용(가드 없으면 가드부터 신설, safe-refactor 스킬). 완료를 `SendMessage` 로 integration-qa 에 통지.
3. `integration-qa` 가 동작 보존 검증(렌더 기준값 유지·테스트·스모크, forest-integration-qa 문맥 B).
4. 통과 → 다음 항목. 실패 → integration-qa 가 `SendMessage` 로 surgeon/reviewer 에 회귀 통지 → surgeon 이 되돌리거나 고친 뒤 재검증.

산출: `_workspace/41_refactor_log.md`(교정별 가드 결과).

## Phase 5: 종합 보고·정리

1. 적용된 교정·줄 수 변화·기준값 유지 여부·보류(과교정·가드 부재) 항목을 리더가 종합. 사용자에게 다음 후보를 제시하되 결정은 넘긴다.
2. `TeamDelete` 로 팀 정리. `_workspace/40·41` 중간 산출은 보존.

## 데이터 전달 프로토콜

- **태스크 기반**(조율): `TaskCreate`/`TaskGet` 으로 감사·교정·검증 작업과 상태 관리.
- **메시지 기반**: 승인 항목 전달·교정 완료·회귀 통지는 `SendMessage`.
- **파일 기반**: `_workspace/40·41` 리포트 + 최종 코드 변경은 작업트리에 직접. 중간 산출은 `_workspace/` 보존.

## 에러 핸들링

- 팀원 실패/중지: 리더가 감지 → `SendMessage` 로 상태 확인 → 재시작 또는 재할당.
- 교정 가드(렌더 기준값) 실패 = 동작 변경. surgeon 이 되돌림. 기준값 우회 갱신 금지.
- 가드 없는 교정은 보류하고 "가드 신설 필요"로 보고(누락 명시).
- reviewer 가 불확정이면 "확인 필요"로 남기고 그 항목 교정 안 함.
- 1회 재시도 후 재실패 시 해당 결과 없이 진행, 보고서에 누락 명시.

## 테스트 시나리오

- **정상 흐름**: `TeamCreate` 로 3인 팀 → reviewer 감사 → 불일치 3건 발견 → 사용자가 2건 승인 → surgeon 가 1건씩 적용(`SendMessage` 로 qa 통지), 매번 기준값 `7c022c6` 유지·26 테스트 통과 → 종합 보고·`TeamDelete`. 보류 1건은 사유 기재.
- **에러 흐름**: 한 교정 후 렌더 기준값이 바뀜 → integration-qa 가 회귀 감지 → `SendMessage` 로 surgeon 에 통지 → surgeon 가 본문 원복 → 기준값 복구 확인 → 그 교정 "동작 변경 위험"으로 보류 처리하고 다음 항목.
