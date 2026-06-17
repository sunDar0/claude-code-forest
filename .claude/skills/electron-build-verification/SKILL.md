---
name: electron-build-verification
description: 패키징된 Electron 앱이 실제로 빌드되고 구동되는지 검증하는 방법. node --check, npm run pack(--dir) 으로 빠른 앱 빌드 후 실행해 서버 listen + 창 렌더 확인, data 쓰기가 userData 에서 동작하는지(asar 함정 회귀), dist 산출물 확인, win 미검증 누락 명시를 다룬다. "빌드 검증", "Electron 앱 구동 확인", "패키징 테스트", "dmg 동작 확인", 배포본 검증 작업 시 반드시 사용. 재검증·회귀 확인 후속 작업에도 사용.
---

# Electron 빌드·구동 검증

패키징 설정이 "그럴듯한지" 가 아니라, 빌드를 돌리고 앱을 실행해 **실제로 뜨는지** 본다. 설정만 읽고 통과 판정하지 않는다 — Electron asar/경로 문제는 패키징 후에만 드러나기 때문이다.

## 검증 순서 (싼 것 먼저)

```
1. node --check main.js preload.js        → 문법
2. npm run pack (--dir)                    → 서명·압축 없이 빠른 앱 빌드
3. 패키징 앱 실행 → 메인 콘솔 로그 확인     → 서버 listen + 창 로드
4. data 쓰기 동작(userData)                → asar 함정 회귀
5. npm run dist:mac → dist/*.dmg, *.zip     → 무거운 실제 산출물
6. npm test                                → 서버·클라 동작 회귀
```

무거운 `dist:mac` 을 1번에 돌리지 않는다. `pack --dir` 로 먼저 막힌 데를 찾는다.

## 구동 검증의 핵심 4가지

### 1. 서버 listen + 창 렌더 (빈 화면 아님)

메인이 서버를 띄우고 창이 `localhost:PORT` 를 로드해야 한다. GUI 가 헤드리스에서 안 뜰 수 있으므로 **메인 프로세스 콘솔 로그**로 확인한다:

- `server listening on http://localhost:5178` 가 찍히는가.
- 창의 렌더러 콘솔(또는 `did-finish-load` 이벤트)이 도는가.

패키징 앱을 콘솔 로그가 보이게 실행:
```
./dist/mac-arm64/Claude\ Code\ Forest.app/Contents/MacOS/Claude\ Code\ Forest
# 또는 pack 산출 디렉토리의 실행 파일을 터미널에서 직접 실행해 stdout 확인
```

GUI 창의 숲 렌더 육안 확인이 헤드리스에서 불가하면, "서버 listen + window load 까지 확인, 창 육안은 사용자 위임" 으로 **명시**한다(안 본 걸 봤다고 하지 않는다).

### 2. data 쓰기 경로 (asar 함정 회귀 — 가장 잘 터지는 곳)

패키징 앱에서 그리드 활성화 등 쓰기 동작이 `userData` 하위에서 성공하는가. 확인법:

- 앱 실행 후 `~/Library/Application Support/<productName>/data/` 에 forest.json 등이 생기는가(mac).
- asar 안 `data/` 에 쓰려다 `EROFS`/`ENOENT` 가 나면 → integrator 의 `FOREST_DATA_DIR` userData 주입이 안 된 것. 통지.

### 3. 런타임 읽기 자원 (mock/스프라이트)

`mock/`·`public/**/*.png` 등이 패키징본에서 읽히는가. 읽기 실패(asar 경로)면 `asarUnpack` 이 필요했던 것 → packaging 에 통지.

### 4. dist 산출물

`npm run dist:mac` 후 `dist/` 에 `*.dmg`·`*.zip` 이 생기고, dmg 가 마운트/열리는가.

## win 은 누락 명시

이 mac 에서 win 빌드는 검증 대상이 **아니다**(확정: 로컬 각 OS). 보고서에 반드시:

> win 미검증 — 윈도우 머신에서 `npm run dist:win` 로 nsis 설치본 생성·실행 필요.

검증 안 된 것을 통과로 적지 않는다.

## 회귀

Electron 통합이 기존 동작을 깼는지:

- `npm test` (렌더 스모크 골든 `b28d5c2f` 포함) 통과.
- `npm start`(서버 단독) 가 여전히 동작 — `FOREST_DATA_DIR` env 폴백 덕분에 개발 경로 무변경.

## 출력

`_workspace/52_electron_build_qa.md`:
- 항목별 통과/실패(위 6단계 + 4핵심).
- 실패는 재현 절차 + **로그 원문 인용**(번역 금지) + 책임 에이전트(integrator/packaging).
- win 미검증 명시. GUI 육안 위임 명시.

## 안티패턴

- 설정 파일만 읽고 "맞다" 판정 → asar/경로 문제는 실행해야 드러난다. 반드시 빌드·실행.
- 첫 시도에 `dist:mac`(수 분) → `pack --dir` 로 먼저 빠르게 막힌 데를 찾는다.
- 빌드 실패 로그를 요약/번역 → 원문 첫 에러를 그대로 인용해야 원인을 짚는다.
