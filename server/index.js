// Claude Code Forest — 라이브 폴링 서버.
//
// 한 프로세스로 두 가지를 한다:
//   1) data API:
//        GET  /api/forest          → 메모리 작업본 즉답(계층 구조 + cap)
//        POST /api/grid/activate   → 그리드 활성화(자리 잡기), body {date,gx,gy}
//        POST /api/forest/bundle   → 숲 묶기(완료된 달만), body {month}
//      호환: GET /api/usage        → 기존 daily[] 계약. 클라 마이그레이션 중 유지.
//   2) public/ 정적 서빙(기본 index.html)
//
// Node 표준 라이브러리만 사용. 프레임워크/외부 의존성 0.

import http from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanUsageData } from './aggregate.js';
import {
  boot,
  refreshToday,
  getForest,
  activateGrid,
  bundleForest,
  setStartDate,
} from './store.js';
import { getMockForest } from './mock.js';
import { startAutoUpload, uploadNow, uploadStatus, getUploadConfig, saveUploadConfig } from './upload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 5178;

// 개발 모드 마스터 스위치(.env 의 FOREST_DEBUG=1). 꺼져 있으면 mock/cold/debug 전부 무시 —
//   프로덕션에선 항상 실데이터만, 좌표 라벨·디버그 훅 없음. 클라는 GET /api/config 로 이 값을 읽는다.
const DEBUG = process.env.FOREST_DEBUG === '1' || process.env.FOREST_DEBUG === 'true';

// GET /api/forest 는 메모리 즉답이지만, 오늘자 usage·tree 는 jsonl 변동을 반영해야 한다.
// 폴링 폭주를 막으려고 오늘 재집계는 4초 TTL 로 제한한다(메모리 읽기는 항상 즉답).
// 4초 → 12초. 클라 POLL_MS(15초)보다 낮게 둬(폴당 정확히 1회 재집계) 다중 클라·버스트만
//   게이트가 막고, 정상 폴은 매번 오늘자를 갱신한다. 캐시(aggregate.js) 덕에 재집계 자체도
//   변경 파일만 읽어 싸다 — TTL 은 이제 폭주 방지용 하한.
const REFRESH_TTL_MS = 12000;
let lastRefresh = 0;
async function maybeRefreshToday() {
  const now = Date.now();
  if (now - lastRefresh < REFRESH_TTL_MS) return;
  lastRefresh = now;
  await refreshToday();
}

// 호환용 /api/usage TTL 캐시(기존 daily[] 계약 유지).
const USAGE_TTL_MS = 4000;
let usageCache = { at: 0, payload: null };
async function getUsageJson() {
  const now = Date.now();
  if (usageCache.payload && now - usageCache.at < USAGE_TTL_MS) {
    return usageCache.payload;
  }
  const result = await scanUsageData();
  const payload = JSON.stringify(result);
  usageCache = { at: now, payload };
  return payload;
}

// 정적 서빙 — .html .js .css .json 기본 처리.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', // 나무·바위 스프라이트 시트 정적 서빙
};

function safeJoin(base, target) {
  // 디렉토리 탈출(../) 방지: 정규화 후 base 밖이면 null.
  const resolved = path.normalize(path.join(base, target));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return null;
  }
  return resolved;
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath.endsWith('/')) {
    urlPath = path.join(urlPath, 'index.html');
  }

  const filePath = safeJoin(PUBLIC_DIR, urlPath);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

// POST 바디를 읽어 JSON 파싱. 1MB 상한, 깨진 JSON 은 null.
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// 목모드 판정: ?mock=1 (또는 mock=true). 단 DEBUG 꺼져 있으면 항상 실모드(목 차단).
function isMockReq(req) {
  if (!DEBUG) return false; // 프로덕션: mock 파라미터 무시
  const q = (req.url || '').split('?')[1] || '';
  const params = new URLSearchParams(q);
  const v = params.get('mock');
  return v === '1' || v === 'true';
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const urlPath = (req.url || '/').split('?')[0];
  const mock = isMockReq(req);

  try {
    // --- GET /api/config (클라 부팅 시 1회) — 개발 모드 여부만 노출 ---
    if (urlPath === '/api/config' && method === 'GET') {
      sendJson(res, 200, { debug: DEBUG });
      return;
    }

    // --- GET /api/forest ---
    if (urlPath === '/api/forest' && method === 'GET') {
      if (mock) {
        // 목모드(데모): mock/ 을 읽어 반환. 실모드 store 와 분리·read-only.
        sendJson(res, 200, await getMockForest());
        return;
      }
      await maybeRefreshToday(); // 오늘자 usage·tree 신선도(4초 TTL)
      sendJson(res, 200, getForest());
      return;
    }

    // --- POST /api/grid/activate ---
    if (urlPath === '/api/grid/activate' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      if (mock) {
        // 목모드 read-only: 목데이터를 바꾸지 않는다. 현재 목 forest 를 그대로 돌려준다(no-op).
        sendJson(res, 200, { ok: true, mock: true, forest: await getMockForest() });
        return;
      }
      const result = await activateGrid({ date: body.date, gx: body.gx, gy: body.gy });
      if (!result.ok) {
        sendJson(res, result.status || 400, { ok: false, error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, forest: getForest() });
      return;
    }

    // --- POST /api/forest/bundle ---
    if (urlPath === '/api/forest/bundle' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      if (mock) {
        // 목모드 read-only: 목데이터를 바꾸지 않는다(no-op).
        sendJson(res, 200, { ok: true, mock: true, forest: await getMockForest() });
        return;
      }
      const result = await bundleForest({ month: body.month });
      if (!result.ok) {
        sendJson(res, result.status || 400, { ok: false, error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, forest: getForest() });
      return;
    }

    // --- POST /api/forest/start (시작일 설정) ---
    if (urlPath === '/api/forest/start' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      if (mock) {
        // 목모드 read-only: 목 startDate 를 바꾸지 않는다(no-op).
        sendJson(res, 200, { ok: true, mock: true, forest: await getMockForest() });
        return;
      }
      const result = await setStartDate({ date: body.date });
      if (!result.ok) {
        sendJson(res, result.status || 400, { ok: false, error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, forest: result.forest });
      return;
    }

    // --- 호환: GET /api/usage (기존 daily[] 계약) ---
    if (urlPath === '/api/usage' && method === 'GET') {
      const payload = await getUsageJson();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(payload);
      return;
    }

    // --- 사내 중앙 서버 업로드: 상태 / 즉시 전송 / 설정 (upload.js) ---
    if (urlPath === '/api/upload-status' && method === 'GET') {
      sendJson(res, 200, await uploadStatus());
      return;
    }
    if (urlPath === '/api/upload-now' && method === 'POST') {
      const result = await uploadNow();
      sendJson(res, result.ok ? 200 : 502, result);
      return;
    }
    if (urlPath === '/api/upload-config' && method === 'GET') {
      sendJson(res, 200, await getUploadConfig());
      return;
    }
    if (urlPath === '/api/upload-config' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      const saved = await saveUploadConfig(body);
      sendJson(res, 200, { ok: true, config: saved });
      return;
    }

    await serveStatic(req, res);
  } catch (err) {
    // 집계·store 는 방어적이라 거의 throw 하지 않지만, 만약을 대비해 서버는 죽지 않게 한다.
    sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

// 부팅: data/ 로드 + forest.json 생성 + 과거 동결 → 그 다음 listen.
//
// startServer(port): boot 후 listen 이 끝나면(서버 ready) http.Server 핸들을 resolve.
// Electron 메인이 포트를 주입하고 종료 시 server.close() 할 수 있게 함수로 추출했다.
// boot 가 실패해도 빈 forest 폴백으로 서버는 띄운다(클라가 죽지 않게 — 기존 동작 보존).
export async function startServer(port = PORT) {
  try {
    await boot();
  } catch (err) {
    process.stderr.write(`boot failed (continuing with empty forest): ${String((err && err.message) || err)}\n`);
  }
  await listenWithFallback(server, Number(port) || 5178, 30);
  startAutoUpload(); // 중앙 서버 자동 업로드 시작(UPLOAD_USER_EMAIL 설정 시에만)
  return server; // 실제 포트는 server.address().port (Electron 메인이 loadURL 에 사용)
}

// 포트가 이미 점유(EADDRINUSE)면 다음 포트로 자동 재시도. Electron 앱을 여러 개 띄우거나 dev 서버가
//   같은 포트를 쓰고 있어도 빈 포트를 찾아 뜬다. 성공한 실제 포트로 resolve.
function listenWithFallback(srv, startPort, maxTries) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const onError = (err) => {
      if (err && err.code === 'EADDRINUSE' && attempt < maxTries) {
        attempt++;
        srv.listen(startPort + attempt); // 다음 포트 시도(에러 리스너 유지)
      } else {
        srv.removeListener('error', onError);
        reject(err);
      }
    };
    srv.on('error', onError);
    srv.listen(startPort, () => {
      srv.removeListener('error', onError);
      const p = srv.address().port;
      process.stdout.write(`Claude Code Forest server listening on http://localhost:${p}\n`);
      resolve(p);
    });
  });
}

// CLI 직접 실행(`node server/index.js`) 시에는 자동으로 서버를 띄운다.
// import 로 불러올 때(Electron 메인)는 부작용 없음 — 메인이 startServer() 를 호출.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
