// 사내 중앙 서버 사용량 업로드 (Claude Usage Tracker 와 같은 계약).
//
// tracker(electron/claude-wrapper.js)의 uploadUsageData 와 동일:
//   POST {serverUrl}/api/claude-usage/upload
//   multipart/form-data: file(scanUsageData() {daily} JSON)·hostname·timestamp(unix초)·userEmail
//   성공 = HTTP 200/201. 인증은 userEmail 필드(별도 토큰 없음).
//
// 설정은 **GUI(설정 모달) → data/upload-config.json 영속** 을 우선으로 하고, 없으면 .env, 없으면 기본값.
//   배포 시 사용자가 .env 편집 없이 모달에서 서버 주소·이메일·주기·on/off 를 정한다.
//   우선순위: upload-config.json > env(UPLOAD_*) > 코드 기본값.
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanUsageData } from './aggregate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// store.js 와 동일: FOREST_DATA_DIR(패키징 시 메인이 userData 로 주입) 우선, 없으면 개발 경로.
//   이 처리가 없으면 패키징본에서 data/ 가 asar(읽기 전용) 안이라 설정 저장이 매번 실패한다.
const DATA_DIR = process.env.FOREST_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'upload-config.json');

// env / 코드 기본값(파일 부재 시 폴백).
const DEFAULTS = {
  serverUrl: process.env.UPLOAD_SERVER_URL || '',
  userEmail: process.env.UPLOAD_USER_EMAIL || '',
  interval: Number(process.env.UPLOAD_INTERVAL) || 600, // 초
  // 자동 전송 on/off. env 로 이메일이 주어졌으면 기본 켜짐, 아니면 꺼짐.
  enabled: process.env.UPLOAD_USER_EMAIL ? true : false,
};

let cfg = null; // 캐시(파일+기본 merge)
const state = { lastUploadTime: null, uploadCount: 0, lastError: null };
let timer = null;

// 설정 로드(파일 우선·캐시). 파일 없으면 기본값.
async function loadConfig() {
  if (cfg) return cfg;
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')); } catch { /* 파일 없음 = 기본 */ }
  cfg = {
    serverUrl: saved.serverUrl || DEFAULTS.serverUrl,
    userEmail: saved.userEmail != null ? saved.userEmail : DEFAULTS.userEmail,
    interval: saved.interval || DEFAULTS.interval,
    enabled: saved.enabled != null ? !!saved.enabled : DEFAULTS.enabled,
  };
  return cfg;
}

// 현재 설정(GUI 모달 표시용). 이메일은 그대로 노출(로컬 전용).
export async function getUploadConfig() {
  return await loadConfig();
}

/**
 * 설정 저장(모달 → POST). 부분 갱신 가능. 저장 후 타이머 재시작(주기·on/off 즉시 반영).
 * @param {object} partial 바꿀 필드만 담은 부분 설정(serverUrl·userEmail·interval·enabled).
 * @returns {Promise<object>} 병합된 현재 설정.
 */
export async function saveUploadConfig(partial) {
  const cur = await loadConfig();
  cfg = {
    serverUrl: partial.serverUrl != null ? String(partial.serverUrl).trim() : cur.serverUrl,
    userEmail: partial.userEmail != null ? String(partial.userEmail).trim() : cur.userEmail,
    interval: partial.interval != null ? Math.max(10, Number(partial.interval) || cur.interval) : cur.interval,
    enabled: partial.enabled != null ? !!partial.enabled : cur.enabled,
  };
  try {
    // 원자적 쓰기(temp+rename): 저장 중 크래시해도 upload-config.json 이 깨지지 않게.
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    const tmp = `${CONFIG_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
    await fs.rename(tmp, CONFIG_PATH);
  } catch { /* 저장 실패해도 런타임 캐시는 반영 */ }
  await restartAutoUpload(); // 주기·enabled 즉시 반영
  return cfg;
}

/**
 * 클라 HUD "마지막 전송 x분 전"·버튼·설정 표시용 상태.
 *   enabled = 자동 전송 켜짐(on/off && 이메일). configured = 이메일 있음(즉시 전송 가능).
 * @returns {Promise<object>} enabled·configured·serverUrl·lastUploadTime·lastError 등.
 */
export async function uploadStatus() {
  const c = await loadConfig();
  return {
    enabled: !!c.enabled && !!c.userEmail, // 자동 주기 전송 활성 여부
    configured: !!c.userEmail,             // 이메일 설정됨(즉시 전송 가능)
    serverUrl: c.serverUrl,
    userEmail: c.userEmail || null,
    intervalSec: c.interval,
    lastUploadTime: state.lastUploadTime, // ISO | null
    uploadCount: state.uploadCount,
    lastError: state.lastError,
  };
}

/**
 * 즉시 1회 전송. 수동 액션이므로 on/off 와 무관하게 이메일만 있으면 보낸다.
 * @returns {Promise<{ok:true, lastUploadTime, uploadCount}|{ok:false, error:string}>}
 */
export async function uploadNow() {
  const c = await loadConfig();
  if (!c.userEmail) {
    state.lastError = '이메일 미설정';
    return { ok: false, error: state.lastError };
  }
  try {
    const usage = await scanUsageData(); // { daily: [...] } — tracker 와 동일 형식
    const json = JSON.stringify(usage);
    if (json.length < 10) throw new Error('사용량 데이터가 비어있음');

    const form = new FormData();
    form.append('file', new Blob([json], { type: 'application/json' }), 'usage.json');
    form.append('hostname', os.hostname());
    form.append('timestamp', String(Math.floor(Date.now() / 1000)));
    form.append('userEmail', c.userEmail);

    const res = await fetch(`${c.serverUrl}/api/claude-usage/upload`, { method: 'POST', body: form });
    if (res.status === 200 || res.status === 201) {
      state.uploadCount += 1;
      state.lastUploadTime = new Date().toISOString();
      state.lastError = null;
      return { ok: true, lastUploadTime: state.lastUploadTime, uploadCount: state.uploadCount };
    }
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  } catch (e) {
    state.lastError = e.message;
    return { ok: false, error: e.message };
  }
}

// 자동 전송 시작(부팅·설정 저장 후). enabled && 이메일 일 때만 타이머.
export async function startAutoUpload() {
  const c = await loadConfig();
  if (timer) { clearInterval(timer); timer = null; }
  if (!c.enabled || !c.userEmail) {
    console.warn('[upload] 자동 업로드 비활성(설정 모달에서 켜거나 이메일 입력)');
    return;
  }
  uploadNow().catch(() => {}); // 시작 직후 1회
  timer = setInterval(() => { uploadNow().catch(() => {}); }, c.interval * 1000);
  console.log(`[upload] 자동 업로드 시작 — ${c.interval}초 주기, ${c.serverUrl}`);
}

async function restartAutoUpload() {
  if (timer) { clearInterval(timer); timer = null; }
  await startAutoUpload();
}

export function stopAutoUpload() {
  if (timer) { clearInterval(timer); timer = null; }
}
