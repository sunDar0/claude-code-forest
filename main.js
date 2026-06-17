// Claude Code Forest — Electron 메인 프로세스.
//
// 기존 Node http 서버(server/index.js)를 그대로 안고, 메인이 띄운 뒤
// BrowserWindow 가 http://localhost:PORT 를 로드한다. 서버는 재작성하지 않는다.
//
// 핵심 3 가지:
//   1) data 쓰기 경로를 userData 로 주입 — 패키징되면 server/../data 는 asar 안이라
//      쓰기 불가. app.getPath('userData')/data 를 FOREST_DATA_DIR 로 넘긴다.
//   2) startServer(PORT) 가 listen 끝난 뒤 resolve → 그 다음 창 로드(빈 화면 방지).
//   3) contextIsolation:true / nodeIntegration:false 보안 기본값.

import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 5178;

let serverHandle = null; // http.Server — 종료 시 close.
let mainWindow = null;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // 1) data 쓰기 경로 주입 — store.js 가 이 env 를 우선 읽는다(없으면 개발 폴백).
  process.env.FOREST_DATA_DIR = path.join(app.getPath('userData'), 'data');

  // 2) 서버를 띄우고 listen 이 끝난 뒤(server ready) 창을 로드.
  try {
    const { startServer } = await import('./server/index.js');
    serverHandle = await startServer(PORT);
  } catch (err) {
    process.stderr.write(`startServer failed: ${String((err && err.message) || err)}\n`);
    // 1회 재시도 — 포트 일시 점유 등 과도기 대비.
    try {
      const { startServer } = await import('./server/index.js');
      serverHandle = await startServer(PORT);
    } catch (err2) {
      process.stderr.write(`startServer retry failed: ${String((err2 && err2.message) || err2)}\n`);
    }
  }

  // 실제 listen 된 포트(EADDRINUSE 로 fallback 됐을 수 있음)로 창 로드. 실패 시 기본 PORT.
  const addr = serverHandle && serverHandle.address && serverHandle.address();
  const actualPort = (addr && addr.port) || PORT;
  createWindow(actualPort);
});

// 단일 대시보드라 mac 의 activate-재생성 관행은 생략(과함).
app.on('window-all-closed', () => {
  if (serverHandle) {
    serverHandle.close();
    serverHandle = null;
  }
  app.quit();
});
