---
name: electron-app-integration
description: 기존 Node http 서버 + 정적 웹 클라이언트를 Electron 데스크톱 앱으로 감싸는 방법. 메인 프로세스에서 서버를 띄우고 BrowserWindow 가 localhost 를 로드하는 통합, contextIsolation 보안 기본값, data 쓰기 경로를 userData 로 빼는 asar 함정 회피를 다룬다. "Electron 입히기", "데스크톱 앱으로", "main.js 작성", "서버를 Electron 에 통합", Claude Forest 데스크톱화 작업 시 반드시 사용. 통합 방식 재작업·preload 수정 후속 작업에도 사용.
---

# Electron 앱 통합

기존 웹 대시보드(`server/` + `public/`)를 재작성하지 않고 Electron 으로 **감싼다**. 핵심: 메인 프로세스가 기존 서버를 띄우고, 창이 그 localhost 를 로드한다.

## 통합 모델 (왜 이 구조인가)

이 앱은 이미 "로컬 서버 + 브라우저 클라" 다. Electron 은 Chromium 창 + Node 메인이다. 그래서 가장 단순한 통합은:

```
[Electron 메인 프로세스]
   ├── 기존 server/index.js 를 띄움 (포트 5178, listen)
   └── BrowserWindow → loadURL("http://localhost:5178")
        └── public/ 클라가 fetch 로 자기 서버 API 호출 (기존 그대로)
```

클라 코드(`public/`)는 한 줄도 안 바꾼다. 서버도 거의 안 바꾼다. 바꾸는 건 메인 프로세스라는 얇은 껍질뿐이다.

## 서버를 띄우는 두 방식

`server/index.js` 는 import 되는 순간 `boot()` + `server.listen()` 하는 **부작용 모듈**이다.

| 방식 | 변경량 | 트레이드오프 |
|---|---|---|
| **부작용 import** `await import('../server/index.js')` | 0 | 서버 핸들·포트를 메인이 못 잡음. 종료 제어·포트 주입 불가. |
| **`startServer()` 추출**(권장) | 작음 | `index.js` 가 부팅을 함수로 export. 메인이 포트 주입·핸들 보관·종료 시 `server.close()`. 동작 동일. |

권장은 추출이다. 종료 시 서버를 깔끔히 닫고, 포트 충돌 시 대체 포트를 줄 수 있다. 추출은 `index.js` 끝의 `boot().then(listen)` 을 `export async function startServer(port)` 로 감싸는 정도 — 기존 라우팅·핸들러는 손대지 않는다.

## data 쓰기 경로 — asar 함정 (가장 중요)

개발 중 `server/store.js` 는 `data/` 에 forest.json 등을 쓴다. 경로는 `__dirname/../data`.

패키징되면 앱 코드는 **asar 아카이브**(읽기 전용) 안에 들어간다. `data/` 가 asar 안이면 쓰기가 `EROFS`/`ENOENT` 로 실패한다. 개발에선 안 보이고 **패키징 후에만** 터진다.

해결: 런타임에 쓰기 경로를 OS 사용자 데이터 폴더로 뺀다.

```js
// main.js — 서버 띄우기 전에
process.env.FOREST_DATA_DIR = path.join(app.getPath('userData'), 'data');
```

```js
// server/store.js — 기존 DATA_DIR 정의를 env 우선으로
const DATA_DIR = process.env.FOREST_DATA_DIR
  || path.join(__dirname, '..', 'data'); // env 없으면 개발 경로(무변경)
```

env 폴백 덕분에 개발(`npm start`)은 그대로 `data/` 를 쓰고, 패키징 앱만 userData 로 간다. `mock/` 은 read-only 라 asar 안에서도 읽기 OK(쓰기 경로 문제 없음).

## main.js 골격

```js
import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer } from '../server/index.js'; // 추출 방식

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5178;
let serverHandle = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 보안 기본
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://localhost:${PORT}`);
}

app.whenReady().then(async () => {
  process.env.FOREST_DATA_DIR = path.join(app.getPath('userData'), 'data');
  serverHandle = await startServer(PORT); // listen 끝난 뒤 창
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverHandle) serverHandle.close();
  app.quit(); // 단일 대시보드라 mac 도 종료
});
```

ESM 주의: `package.json` 이 `"type": "module"` 이므로 main.js 도 ESM. `electron` 의 ESM 진입은 버전에 따라 다루기가 다르다 — `electron` 28+ 는 ESM 메인을 지원한다. 막히면 `main.cjs`(CommonJS) 로 메인만 두고 `await import()` 로 ESM 서버를 불러오는 폴백을 쓴다.

## preload.js

클라는 `fetch` 로 자기 localhost API 만 부른다 — IPC 가 거의 필요 없다. preload 는 보안 기본을 지키는 최소 형태면 된다.

```js
// preload.js — 지금은 노출할 것 없음. contextIsolation 유지용 빈 preload.
// 추후 "앱 종료", "버전 표시" 같은 네이티브 기능이 필요하면 contextBridge 로 좁게 노출.
```

노출이 정말 필요해질 때만 `contextBridge.exposeInMainWorld` 로 **좁은** API 를 더한다. 처음부터 넓게 열지 않는다(보안·단순).

## 창 설정 기준

- 크기: 기존 `npm run app` 의 1400×900 을 따른다.
- 메뉴: 대시보드라 기본 메뉴는 최소화하거나 둬도 무방. 과한 커스텀 메뉴를 새로 만들지 않는다.
- dev/prod 구분 불필요: 양쪽 다 메인이 서버를 띄우고 같은 localhost 를 로드한다.

## 검증

- `npm start` 가 여전히 그대로 동작(서버 단독 실행 회귀 — env 폴백 덕분).
- `electron .` 로 창이 뜨고 숲이 렌더(서버 listen 후 로드라 빈 화면 아님).
- 패키징 후 data 쓰기가 userData 에서 성공(packaging·verifier 단계에서 교차 확인).

## 안티패턴

- 클라(`public/`)를 Electron 용으로 포크/수정 → 금지. 웹·앱 두 벌이 갈라진다. 같은 코드를 서버가 서빙한다.
- `nodeIntegration: true` 로 열어 클라에서 직접 Node 접근 → 보안 구멍. 서버 API 로 충분하다.
- data 경로를 그대로 두고 패키징 → 개발에선 통과, 배포본만 쓰기 실패. 반드시 userData.
