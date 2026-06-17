---
name: electron-distribution-orchestrator
description: Claude Code Forest 를 Electron 데스크톱 앱으로 만들어 윈도우·맥 배포본을 생성하는 전체 워크플로우를 조율한다. electron-integrator(서버 통합·메인 프로세스) + packaging-engineer(electron-builder·win/mac 타겟) + build-verifier(빌드·구동 검증)를 파이프라인으로 실행한다. "Electron", "일렉트론", "데스크톱 앱", "윈도우 앱", "맥 앱", "exe", "dmg", "설치본", "배포본 만들기", "앱으로 패키징" 작업 시 반드시 이 스킬을 사용. "다시 빌드", "재실행", "타겟 추가", "통합만 다시", "패키징만 다시", "win 도 빌드", "이전 결과 기반 개선" 같은 후속 요청에도 사용. 단순 질문은 직접 응답 가능.
---

# Electron 배포 오케스트레이터

기존 웹 대시보드(`server/` + `public/`)를 Electron 으로 감싸 **win/mac 배포본**을 만드는 팀을 조율한다. 기능을 새로 만들지 않는다 — 이미 동작하는 앱을 데스크톱으로 **포장**한다.

확정 전제(사용자 승인): **코드 서명 없이**(개인/사내) · **로컬에서 각 OS 직접 빌드** · **자동 업데이트 제외**. 이 전제를 바꾸려면 사용자에게 다시 확인한다.

## 실행 모드

**서브 에이전트 파이프라인.** 통합 → 패키징 → 검증의 순차 의존이라 결과만 메인에 반환하는 서브 에이전트가 맞다(팀 통신 오버헤드 불필요). 검증이 문제를 찾으면 메인이 해당 에이전트를 1회 재호출.

- 모든 `Agent` 호출에 `model: "opus"` 명시(또는 정의의 `inherit` = 메인 모델).
- 각 단계 산출물은 코드 파일 + `_workspace/5x_*.md` 리포트.

## Phase 0: 컨텍스트 확인 (초기/후속 판별)

- `main.js`·`_workspace/50_electron_integration.md` 없음 → **초기 실행**: Phase 1 부터.
- 있음 + 부분 요청("통합만", "패키징만", "win 도") → **부분 재실행**: 해당 에이전트만.
- 있음 + 전면 변경 → **새 실행**: 기존 `_workspace/5x_*.md` 를 `_workspace_prev/` 로 옮기고 다시.

## Phase 1: 사전 조사

구현 전 코드 사실을 확인한다(헛가정 방지):

- `server/index.js` 가 import 부작용으로 listen 하는지, `startServer()` 추출 여지(현재 구조).
- `server/store.js` 의 쓰기 경로(`DATA_DIR`) — userData 로 빼야 할 대상.
- `package.json` 의 `"type": "module"`(ESM) — main.js 도 ESM, electron ESM 진입 확인.
- 포트(현재 5178), 창 크기(기존 `npm run app` 1400×900).

## Phase 2: 통합 (electron-integrator)

스킬: `electron-app-integration`. 산출:
- `main.js`, `preload.js`(보안 기본: contextIsolation true, nodeIntegration false).
- 서버 최소 훅(`startServer()` export, `store.js` 의 `FOREST_DATA_DIR` env 우선 폴백).
- `_workspace/50_electron_integration.md`: 통합 방식·userData 경로 결정.

검증 게이트: `npm start`(서버 단독)·`electron .`(창 렌더) 가 도는지 정도는 integrator 가 자체 확인.

## Phase 3: 패키징 (packaging-engineer)

스킬: `electron-packaging`. 산출:
- `package.json` 의 `main`·`build` 블록·`dist` scripts, electron/electron-builder devDeps.
- `build/`(아이콘 자리), `.gitignore` 점검.
- `_workspace/51_electron_packaging.md`: 타겟·arch·asar 결정, 아이콘 상태, win 은 윈도우 머신 명시.

## Phase 4: 검증 (build-verifier)

스킬: `electron-build-verification`. `pack --dir` → 앱 실행(서버 listen + 창) → data 쓰기(userData) → `dist:mac` 산출물 → `npm test` 회귀. `_workspace/52_electron_build_qa.md` 생성. 실패는 책임 에이전트(integrator/packaging)에 통지해 1회 수정 후 재검증. **win 미검증·GUI 육안 위임은 누락으로 명시.**

## 데이터 전달 프로토콜

- **파일 기반**(주): 코드 파일 + `_workspace/5x_*.md`. 중간 파일 보존(감사 추적).
- **반환값 기반**: 서브 에이전트 완료 메시지로 결과 수집.
- 단계 간 의존 사실(files 목록·userData 경로)은 메인이 다음 에이전트 프롬프트에 실어 전달.

## 에러 핸들링

- 1회 재시도 후 재실패 시 그 결과 없이 진행하되 보고서에 누락 명시.
- mac 에서 `dist:win` 막힘은 **정상**(환경 제약) — 실패가 아니라 "윈도우 머신 필요" 로 분류.
- 빌드 로그는 원문 인용(번역 금지), 환경 문제(네트워크·디스크)와 코드 문제를 구분.

## 산출물 체크리스트

- [ ] `main.js`, `preload.js`(보안 기본).
- [ ] 서버 훅: `startServer()`, `store.js` 의 userData env 폴백(개발 무변경).
- [ ] `package.json`: `main`, `build`(mac dmg/zip identity:null, win nsis), `dist` scripts, electron devDeps.
- [ ] `build/` 아이콘 자리(+ 미제공 시 보고).
- [ ] mac 빌드·구동 검증 통과(`pack` 실행·data userData 쓰기·dist dmg).
- [ ] `npm test` 회귀 통과(렌더 스모크 골든 유지).
- [ ] win 빌드는 윈도우 머신에서 `npm run dist:win`(누락 명시).
- [ ] CLAUDE.md 변경 이력 갱신.

## 테스트 시나리오

- **정상 흐름**: 사전 조사 → integrator 가 main.js + userData 주입 → packaging 이 build 블록·dist scripts → verifier 가 `pack` 실행·서버 listen·숲 렌더·data 쓰기·`dist:mac` dmg 확인 → 통과 → "mac 배포본 dist/*.dmg, win 은 윈도우 머신에서" 안내.
- **에러 흐름**: data 경로를 userData 로 안 빼고 패키징 → verifier 가 패키징 앱 실행 시 `EROFS`(asar 쓰기 실패) 탐지 → integrator 에 통지 → `FOREST_DATA_DIR` userData 주입 + store.js env 폴백 추가 → 재검증 통과.
