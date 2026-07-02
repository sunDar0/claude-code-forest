---
name: ui-design-review-orchestrator
description: Claude Code Forest 의 전반적인 UI 형태·완성도·배치가 기획 의도에 부합하는지 라이브 화면으로 점검하고, 어긋난 곳을 안전하게 교정하는 팀을 조율한다. ui-design-reviewer(라이브 캡처·기획 대조 점검) → 승인 게이트 → forest-game-builder(교정) → 재점검. "UI 점검", "UI 검토", "완성도 점검", "배치 점검", "기획 부합 점검", "디자인 검토", "화면 점검" 작업 시 반드시 이 스킬을 사용. "다시 점검", "재점검", "그 항목만 교정", "회귀 확인", "이전 리뷰 기반" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.
---

# UI 디자인·완성도 점검 오케스트레이터

UI 가 기획대로 보이고 배치됐는지 **실제 화면**으로 점검하고, 어긋난 곳을 교정한다. 코드 구조를 보는 `architecture-refactor-orchestrator` 와 별개 — 이건 **렌더된 픽셀**을 본다.

## 실행 모드

**에이전트 팀 + 승인 게이트.** 점검 → (사용자 승인) → 교정 → 재점검을 `TeamCreate` 팀으로 조율한다. 순차 의존은 `TaskCreate` 의 `depends_on` 으로, 승인된 교정 항목·재점검 요청은 `SendMessage` 로 전달. 모든 팀원 `model: "opus"`.

### 팀 구성

| 팀원 | 에이전트 타입 | model | 역할 | 스킬 |
|------|-------------|-------|------|------|
| ui-design-reviewer | ui-design-reviewer | opus | 라이브 캡처·기획 대조 점검 | ui-design-review |
| forest-game-builder | forest-game-builder | opus | 교정(렌더) | procedural-dot-forest |

```
TeamCreate(team_name: "ui-review-team", members: [
  { name: "ui-design-reviewer", agent_type: "ui-design-reviewer", model: "opus",
    prompt: "ui-design-review 스킬로 화면 상태를 라이브 캡처해 기획(00_architecture §3·§5·§7)과 대조 점검 → _workspace/60_ui_review.md" },
  { name: "forest-game-builder", agent_type: "forest-game-builder", model: "opus",
    prompt: "procedural-dot-forest 스킬로 승인된 교정 항목만 적용. 렌더 변경이면 골든 갱신·npm test 통과" }
])

TaskCreate(tasks: [
  { title: "라이브 점검", assignee: "ui-design-reviewer" },
  { title: "교정", assignee: "forest-game-builder", depends_on: ["라이브 점검"] },   // 승인 게이트 통과분만 (리더가 SendMessage 로 전달)
  { title: "재점검", assignee: "ui-design-reviewer", depends_on: ["교정"] }
])
```

- **승인 게이트가 핵심**: reviewer 의 교정 제안을 사용자가 고른 항목만 builder 가 적용한다. 디자인 결정은 사용자 몫(자동 일괄 교정 금지). 특히 "미정의" 항목은 반드시 사용자 확인.

## Phase 0: 컨텍스트 확인

- `_workspace/60_ui_review.md` 없음 → **초기 점검**: Phase 1 부터.
- 있음 + "그 항목만"·"남은 교정" → **부분 교정**: builder 만 미적용 항목으로.
- 있음 + "다시 점검"·"재점검" → **재점검**: reviewer 재호출(교정 반영·회귀·신규 사양 포함).

## Phase 1: 기획 소스 확인

`_workspace/00_architecture.md`(§3·§5·§7) + `20_forest_game_report.md`(최근 UI 사양) 가 점검 기준이다. 최근 섹션이 현재 의도(옛 사양과 충돌 시 최신 우선). 점검 전 어떤 사양이 최신인지 파악.

## Phase 2: 라이브 점검 (ui-design-reviewer)

스킬: `ui-design-review`. claude-in-chrome 으로 화면 상태 목록(일반·오버뷰·드릴다운·콜드·심는 중·HUD 접기·모달·레터박스 + 세부)을 **실제 캡처**해 기획·시각 완성도 두 축으로 평가. debug 상태는 `FOREST_DEBUG=1` 서버를 별도 포트로 띄워서. 산출 `_workspace/60_ui_review.md`(발견 목록 + 우선순위 교정). 캡처 불가는 "미확인" 명시.

## Phase 3: 승인 게이트 (사용자)

reviewer 의 발견·교정 제안을 **요약 보고**하고, 교정할 항목을 고르게 한다. 분류(기획이탈/시각결함/미완성/미정의)·심각도·교정 비용을 함께. "미정의" 는 기획 확정부터. 사용자가 고른 항목만 다음 단계로.

## Phase 4: 교정 (forest-game-builder)

스킬: `procedural-dot-forest`(렌더) 등. 사용자가 고른 항목만 교정. 렌더 변경이면 골든 갱신(의도적), `npm test` 통과. 데이터·서버 불변 원칙 유지. **교정 후 라이브 재확인은 reviewer 가**(builder 가 self-검증 후 SendMessage 로 reviewer 에 재점검 요청 — 독립 재점검).

## Phase 5: 재점검 (ui-design-reviewer)

교정 항목을 **다시 라이브 캡처**해 해소됐는지 + 회귀 없는지 확인. `_workspace/60_ui_review.md` 갱신. 통과 후 `TeamDelete` 로 팀 정리, `_workspace/` 는 보존.

## 데이터 전달 프로토콜

- **파일 기반**(주): `_workspace/60_ui_review.md` + 스크린샷 근거. 코드 교정은 실제 파일.
- **메시지 기반**(SendMessage):
  - 리더 → builder: reviewer 발견 중 사용자가 승인한 교정 항목(어느 발견·기획 기준·기대 결과).
  - builder → reviewer: 교정 완료 → 재점검 요청.
- 리더는 TaskGet 으로 진행률 확인, 팀원이 막히면 SendMessage 로 개입.

## 에러 핸들링

- claude-in-chrome 권한 거부·서버 미기동: 환경 문제로 구분. 캡처 불가 항목은 "미확인—사용자 육안" 명시(봤다고 적지 않음). 1회 재시도 후 진행.
- 기획 문서에 없는 요소(미정의): 삭제·단정 금지, 사용자 확인 거리로 병기.

## 테스트 시나리오

- **정상 흐름**: 기획 소스 확인 → reviewer 가 8개 상태 라이브 캡처·기획 대조 → `60_ui_review.md`(이탈 N·시각결함 M) → 사용자가 교정 항목 선택 → builder 교정·골든 갱신 → reviewer 재점검 통과 → 보고.
- **에러 흐름**: 콜드 모달을 5178(FOREST_DEBUG=0)에서 보려다 무시됨 → reviewer 가 debug 서버(5180) 띄워 재캡처 → 못 띄우면 "콜드 미점검" 명시하고 나머지 상태만 보고.
