---
name: forest-integration-qa
description: Claude Code Forest 의 서버↔클라이언트 경계면 정합성을 교차 검증하고 앱을 실제 실행해 확인하는 방법. 집계 정확성(중복 제거·로컬일), JSON 계약 일치, 필드 매칭, 렌더 파이프라인 동작을 점검한다. "통합 검증", "QA", "경계면 검증", "정합성 확인", Forest 동작 확인 작업 시 사용. 재검증/회귀 확인 후속 작업에도 사용.
---

# Forest 통합 정합성 검증

핵심은 "파일 존재 확인"이 아니라 **경계면 교차 비교**다. 서버가 내보내는 것과 클라이언트가 읽는 것을 동시에 펼쳐 shape 을 대조한다. 검증은 각 모듈 완성 직후 점진적으로(incremental) 한다.

## 1. 집계 정확성 (데이터 레이어)

`_workspace/00_architecture.md §1` 계약 기준으로:

- **중복 제거 검증**: 원본 jsonl 에서 같은 `message.id` 가 여러 줄인 날을 고른다. 집계 결과가 그 메시지를 **마지막 값 1회만** 반영했는지 확인(합산이면 부풀림 버그).
  ```sh
  # message.id 중복이 있는지 표본 확인
  grep -h '"type":"assistant"' ~/.claude/projects/*/*.jsonl | \
    python3 -c "import json,sys,collections; c=collections.Counter(json.loads(l).get('message',{}).get('id') for l in sys.stdin if l.strip()); print([k for k,v in c.items() if v>1][:5])"
  ```
- **로컬일 버킷**: 자정 근처(예: 23:30 / 00:30) 타임스탬프 메시지가 올바른 로컬 날짜로 들어갔는지. UTC 로 했으면 날짜가 어긋난다.
- **필드 매핑**: `totalCacheWriteTokens` ← `cache_creation_input_tokens`, `totalCacheReadTokens` ← `cache_read_input_tokens` 가 뒤바뀌지 않았는지.

## 2. JSON 계약 일치 (경계면)

- 서버 `/api/usage`(또는 `--once`) 응답을 받아 §1-4 형태와 정확히 대조: 필드명·타입·정렬(date 오름차순).
- 클라이언트의 필드 접근 코드(`data.daily[i].totalInputTokens` 등)를 읽어 서버 출력 필드명과 1:1 매칭. camelCase 오타·snake/camel 불일치가 가장 흔한 버그.

## 3. 견고성

- 빈 `daily: []`, 폴링 실패, 음수/NaN 값에서 클라이언트가 크래시하지 않는지(흙 타일/오프라인 표식/0 클램프).

## 4. 렌더 규칙 (코드 확인)

- 황금 알갱이 ≤ 40 하드캡.
- `imageSmoothingEnabled = false`.
- `renderObjects.sort((a,b)=>a.y-b.y)` 존재.
- 로그 스케일 매핑 적용.

## 5. 실행 검증

서버를 띄우고 `/api/usage` 실제 호출로 JSON 수신 → 클라이언트를 목모드/실모드로 띄워 나무가 그려지는지. 헤드리스가 어려우면 콘솔 로그로 폴링·렌더 루프가 도는지 확인. 막히면 무한 재시도 금지 — 막힌 지점·시도 보고 후 멈춤.

## 출력

`_workspace/30_qa_report.md`: 항목별 통과/실패. 실패는 재현 절차 + `file:line` + 계약 기준 판정(누가 고칠지). 상충 데이터는 삭제하지 않고 출처 병기. 1회 재시도 후 재실패면 누락 명시하고 진행.
