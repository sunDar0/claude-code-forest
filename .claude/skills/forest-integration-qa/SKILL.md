---
name: forest-integration-qa
description: 두 면이 계약대로 맞물리는지 경계면을 교차 비교해 검증하는 방법. integration-qa 가 세 하네스에서 공유해 쓴다 — (A) Forest 서버↔클라이언트 데이터 계약(집계 정확성·/api/usage·렌더 규칙), (B) 아키텍처 교정 후 동작 보존 회귀(골든 지문·npm test·스모크), (C) spec 문서↔코드 정합. "통합 검증", "QA", "경계면 검증", "정합성 확인", "동작 보존 확인", "문서↔코드 대조" 작업 시 사용. "재검증", "회귀 확인", "그 항목만 다시", "이전 QA 리포트 기반" 같은 후속에도 사용.
---

# 통합·정합 검증 (integration-qa 공유 스킬)

핵심은 "파일 존재 확인"이 아니라 **경계면 교차 비교**다. 서로 맞물려야 하는 두 면을 동시에 펼쳐놓고 shape·값·주장을 대조한다. 어느 문맥이든 원리는 같고, 대조 대상만 다르다.

> 스킬 이름은 이력상 `forest-integration-qa` 지만 스코프는 세 하네스 공통이다(Forest·아키텍처 감사·spec 문서화). Forest 검증은 문맥 A.

## 왜 이렇게 하는가

경계면 버그는 한쪽만 보면 안 보인다. 서버가 `totalCacheWriteTokens` 를 내보내는데 클라가 `cacheWrite` 로 읽으면 각 파일은 멀쩡해 보여도 화면은 비어 있다. 그래서 **양쪽을 같이** 읽어 필드·타입·null 처리를 1:1 로 맞춘다. 검증은 전체 완성 후 1회가 아니라 각 모듈 완성 직후 점진적으로 한다 — 늦게 잡을수록 원인 범위가 넓어진다.

## 공통 원칙 (세 문맥 공통)

- **교차 비교**: 생산 측(서버 출력·리팩토링 전 동작·코드 사실)과 소비 측(클라 접근 코드·리팩토링 후 동작·문서 주장)을 둘 다 읽어 대조. 한쪽만 보고 판정하지 않는다.
- **실측·재현**: 판정은 실행 결과·수치·file:line 근거로. 상충하는 데이터는 삭제하지 말고 출처를 병기한다.
- **판정 귀속**: 실패는 재현 절차 + `file:line` + 계약 기준으로 누가 고칠지 명시. 코드가 계약과 다르면 코드가 틀린 것(계약을 바꿔야 하면 소유자가 문서부터 고침).
- **막히면 멈춘다**: 실행 불가(포트·의존성)는 환경 문제인지 코드 문제인지 구분해 보고. 1회 재시도 후 재실패면 누락 명시하고 진행. 무한 재시도 금지.

## 문맥 A — Forest 데이터 계약 (claude-forest-orchestrator)

`_workspace/00_architecture.md §1` 계약 기준으로 서버↔클라 경계면을 본다.

- **중복 제거**: 같은 `message.id` 가 여러 줄인 날을 골라, 집계가 **마지막 값 1회만** 반영했는지 확인(합산이면 부풀림 버그).
  ```sh
  grep -h '"type":"assistant"' ~/.claude/projects/*/*.jsonl | \
    python3 -c "import json,sys,collections; c=collections.Counter(json.loads(l).get('message',{}).get('id') for l in sys.stdin if l.strip()); print([k for k,v in c.items() if v>1][:5])"
  ```
- **로컬일 버킷**: 자정 근처(23:30 / 00:30) 타임스탬프가 올바른 로컬 날짜로 들어갔는지(UTC 면 어긋난다).
- **필드 매핑**: `totalCacheWriteTokens` ← `cache_creation_input_tokens`, `totalCacheReadTokens` ← `cache_read_input_tokens` 가 뒤바뀌지 않았는지. 클라의 필드 접근 코드(`data.daily[i].totalInputTokens` 등)와 서버 출력 필드명을 1:1 매칭(camelCase 오타·snake/camel 불일치가 가장 흔함).
- **JSON 계약**: `/api/usage`(또는 `--once`) 응답을 §1-4 형태와 대조(필드명·타입·정렬 date 오름차순).
- **견고성**: 빈 `daily: []`, 폴링 실패, 음수/NaN 에서 클라가 크래시하지 않는지(흙 타일·오프라인 표식·0 클램프).
- **렌더 규칙(코드 확인)**: 황금 알갱이 ≤ 40 하드캡, `imageSmoothingEnabled = false`, `renderObjects.sort((a,b)=>a.y-b.y)` 존재, 로그 스케일 매핑.
- **실행 검증**: 서버를 띄워 `/api/usage` 실호출 → 클라를 목/실모드로 띄워 나무가 그려지는지(헤드리스가 어려우면 콘솔 로그로 폴링·렌더 루프 확인).

출력 `_workspace/30_qa_report.md`: 항목별 통과/실패.

## 문맥 B — 아키텍처 교정 동작 보존 (architecture-refactor-orchestrator)

리팩토링은 코드를 옮길 뿐 동작을 바꾸지 않아야 한다. refactor-surgeon 이 교정 한 건을 적용한 직후, 그 교정이 동작을 보존했는지 회귀로 확인한다.

- **골든 지문 유지**: `npm test` 의 렌더 지문이 기준값(`test/render-smoke.test.js` 의 `GOLDEN` 상수)과 동일한지. 바뀌었으면 동작이 바뀐 것 — surgeon 에게 본문 원복을 통지한다. **기준값 우회 갱신은 금지**(목표가 무변경이므로).
- **단위 테스트·적재**: `npm test`(node --test) 전 케이스 통과, `node --check`/동적 `import()` 로 적재 확인.
- **스모크**: 자동 시험이 없는 영역(main·state·ui·debug·묶은 숲·오버뷰 스냅샷·카메라)은 `?debug` 모드 육안·스크린샷으로. 백그라운드 탭 rAF throttle 같은 측정 한계인지 실제 결함인지 구분.
- 회귀를 잡으면 architecture-reviewer 의 불일치 목록에 반영되도록 결과를 넘긴다. 통과 후 다음 교정으로.

출력은 `_workspace/41_refactor_log.md` 의 교정별 가드 결과와 연동(회귀 발견 시 그 항목에 기록).

## 문맥 C — spec 문서↔코드 정합 (spec-from-code-orchestrator)

spec-writer 가 합성한 문서의 주장이 실제 코드와 맞는지 교차 검증한다.

- **계약·시그니처 대조**: 문서가 단정한 데이터 계약·함수 시그니처·API shape 을 실제 코드와 샘플 교차 비교.
- **추정 단정 여부**: 코드로 확정 못 하는 것이 사실처럼 단정되지 않았는가("추정"으로 분리됐는지).
- **단일 출처**: 데이터 계약이 두 절에 갈라져 적히지 않았는가.
- 불일치를 보고하면 writer 를 재호출해 **해당 절만** 고친다(전면 재작성 금지). 남는 불일치는 문서 §미확정에 명시.

## 재호출 시

이전 리포트(`_workspace/30_qa_report.md` 등)가 있으면 이전 실패 항목부터 재검증하고, 회귀(이전 통과가 깨졌는지)도 함께 본다.
