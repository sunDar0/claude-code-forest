// 부트스트랩 + requestAnimationFrame 루프
//
// 폴링(state)은 GET /api/forest 를 5초마다 받아 렌더에 넘기고, 렌더(renderer)는 rAF 로 항상
// 돌며 애니메이션을 그린다. 배치·나무 상태는 백엔드 소유 — 클라는 렌더+입력만.
// 사용자 액션(활성화)은 state.activate → POST → 재폴링. 숲 묶기는 서버 자동.

import { ForestRenderer } from "./renderer.js";
import { UsageState } from "./state.js";
import { ForestUI } from "./ui.js";
import { fetchDebugEnabled, getDebugMode, initDebugUI } from "./debug.js";
import {
  candidateSlots,
  isAcceptableSlot,
  isColdStart,
  hasPending,
  oldestPendingDate,
  blockedSet,
} from "./activation.js";
import { MAP_GX0, MAP_GX1, MAP_GY0, MAP_GY1 } from "./grid.js";

/**
 * 중앙 서버 업로드 상태 UI 를 배선한다(GET /api/forest 폴과 독립).
 *   - 30초마다 GET /api/upload-status, 1분마다 상대시간만 갱신.
 *   - 즉시 전송 버튼(POST /api/upload-now), 설정 모달(GET/POST /api/upload-config).
 * 공유 세션 상태와 무관 — ui 만 의존한다.
 * @param {ForestUI} ui DOM 오버레이.
 */
function setupUploadUI(ui) {
  async function pollUploadStatus() {
    try {
      const r = await fetch("/api/upload-status", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ui.updateUploadStatus(await r.json());
    } catch (err) {
      ui.updateUploadStatus(null); // 모름(버튼 비활성)
    }
  }
  pollUploadStatus(); // 즉시 1회
  setInterval(pollUploadStatus, 30000); // 30초 주기 갱신
  setInterval(() => ui.refreshUploadWhen(), 60000); // 1분마다 "N분 전" 상대시간만 흐르게

  // 즉시 전송 버튼: POST /api/upload-now → 성공 시 "방금 전"으로 갱신. 전송 중 비활성(연타 방지).
  ui.onUploadNow(async () => {
    ui.setUploadBusy(true);
    try {
      const r = await fetch("/api/upload-now", { method: "POST" });
      await r.json().catch(() => ({ ok: false, error: "응답 파싱 실패" }));
      ui.setUploadBusy(false);
      await pollUploadStatus(); // 성공/실패 모두 최신 상태 재폴
    } catch (err) {
      ui.setUploadBusy(false);
      await pollUploadStatus(); // 네트워크 실패도 상태 갱신(lastError 노출)
    }
  });

  // 설정 모달: 톱니 클릭 → GET /api/upload-config 로 현재값 채워 모달 열기.
  ui.onUploadCfgOpen(async () => {
    let cfg = {};
    try {
      const r = await fetch("/api/upload-config", { cache: "no-store" });
      if (r.ok) cfg = await r.json();
    } catch (err) { /* 로드 실패해도 빈 폼으로 연다 */ }
    ui.showUploadConfigModal(cfg);
  });
  // 저장 → POST /api/upload-config → 성공 시 모달 닫고 업로드 상태 즉시 재폴. 실패 시 에러 표시.
  ui.onUploadCfgSave(
    async (cfg) => {
      try {
        const r = await fetch("/api/upload-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cfg),
        });
        const res = await r.json().catch(() => ({ ok: false }));
        if (!r.ok || !res.ok) { ui.showUploadCfgError("저장 실패. 다시 시도하세요."); return; }
        ui.hideUploadConfigModal();
        await pollUploadStatus(); // 설정 반영된 상태 즉시 갱신(HUD 줄)
      } catch (err) {
        ui.showUploadCfgError("저장 실패(네트워크). 다시 시도하세요.");
      }
    },
    () => ui.hideUploadConfigModal()
  );
}

/** HUD 접기/펴기 토글 배선(#ui 에 hud-collapsed 클래스 on/off). 접으면 금색 아웃라인도 같이 숨긴다. */
function setupHudToggle(renderer) {
  const hudToggle = document.getElementById("hud-toggle");
  const uiRoot = document.getElementById("ui");
  if (!hudToggle || !uiRoot) return;
  hudToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const collapsed = uiRoot.classList.toggle("hud-collapsed");
    // §64: Auto 토글은 #ui 밖(body 직속)이라 hud-collapsed 자손 셀렉터가 안 닿는다 → 직접 전파.
    const autoToggle = document.getElementById("autoplant-toggle");
    if (autoToggle) autoToggle.classList.toggle("hud-collapsed", collapsed);
    // 대각 삼각형으로 동작 방향 암시: 펼침=우상단으로 접기(◥), 접힘=좌하단으로 펼치기(◣).
    hudToggle.textContent = collapsed ? "◣" : "◥";
    hudToggle.title = collapsed ? "HUD 펴기" : "HUD 접기";
    renderer.hudCollapsed = collapsed; // HUD 접힘 → 마지막 활성 금색 아웃라인 숨김
  });
}

/**
 * rAF 루프 시작: 데이터와 무관하게 항상 렌더한다. 찾기 버튼 표시·미니맵도 매 프레임 갱신.
 * @param {ForestRenderer} renderer 렌더러.
 * @param {ForestUI} ui DOM 오버레이.
 * @param {{miniCanvas:HTMLCanvasElement|null, miniCtx:CanvasRenderingContext2D|null}} mini 미니맵.
 */
function startRenderLoop(renderer, ui, mini) {
  const updateMinimap = () => {
    if (!mini.miniCanvas || !mini.miniCtx) return;
    if (mini.miniCanvas.style.display !== "block") mini.miniCanvas.style.display = "block";
    renderer.drawMinimap(mini.miniCtx, mini.miniCanvas.width, mini.miniCanvas.height);
  };
  function loop() {
    renderer.render();
    ui.updateLocateButton(renderer.hasLastActive()); // 활성 셀 있을 때만 표시(콜드 숨김)
    updateMinimap();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

/**
 * 앱 부트스트랩: 렌더러·UI·폴링 상태를 만들고, 카메라/입력 핸들러와 rAF 루프를 배선한다.
 * DOMContentLoaded(또는 이미 로드됨) 시 1회 호출된다.
 */
async function boot() {
  const canvas = document.getElementById("forest");
  if (!canvas) {
    console.error("canvas #forest 를 찾을 수 없음");
    return;
  }

  const renderer = new ForestRenderer(canvas);
  const ui = new ForestUI(); // DOM 오버레이

  // 미니맵 캔버스(줌인 시 전체 위치 파악). main rAF 가 renderer.drawMinimap 으로 그림.
  const miniCanvas = document.getElementById("minimap");
  const miniCtx = miniCanvas ? miniCanvas.getContext("2d") : null;
  if (miniCtx) miniCtx.imageSmoothingEnabled = false;

  // 개발 모드(서버 FOREST_DEBUG)에서만 데이터 소스를 고를 수 있다. 모드는 디버그 패널에서 선택해
  //   localStorage 에 저장한다(URL 쿼리 안 씀). 프로덕션은 항상 실데이터·라벨 없음.
  const debugEnabled = await fetchDebugEnabled();
  const mode = getDebugMode(debugEnabled);
  const mock = mode === "mock"; // 서버 mock/ API(read-only)
  const cold = mode === "cold"; // 내장 콜드 목(액션 가능)
  const state = new UsageState({ mock, cold });
  // 디버그 모드면 그리드 좌표 라벨을 기본 ON(별도 토글 없음).
  renderer.debug = debugEnabled;

  // 개발 모드 UI: 콘솔 디버그 훅 + 데이터 소스 선택 패널 + 단위4 식생 트윅 슬라이더.
  //   식생 트윅은 debug 일 때만 패널 표시·이벤트 배선(프로덕션은 #veg-tweaks display:none 유지).
  if (debugEnabled) {
    initDebugUI(renderer, state, mode);
    ui.initVegTweaks(renderer);
  }

  // 직전 스냅샷의 배치·startDate (활성화 후보 계산용). state.onUpdate 에서 갱신.
  let lastMeta = { placementMap: {}, startDate: null, days: {} };
  // 자동 묶기 감지: 직전 폴의 forests[ym].bundled 값. 폴마다 비교해 false→true 로 바뀐 달에
  //   빛기둥을 띄운다. 첫 폴(null)은 효과 없이 스냅샷만 채운다(이미 묶인 달 폭죽 방지).
  let lastBundled = null;
  // 활성화 후보 목록. 세션 상태.
  let candidates = [];
  // 차단 집합(닫힘 칸) — 단일 진실 소스. 폴마다 refreshPlantUI 에서 1회 계산해
  //   candidateSlots·isAcceptableSlot·renderer 가 모두 이 한 집합을 참조한다(매 프레임 재계산 금지).
  let blocked = new Set();
  // 클릭한 후보 칸을 확인 팝업 동안만 잠시 보관(확인 시 사용).
  let pendingSlot = null;
  // 자동 심기 토글(클라 localStorage 영속, 기본 ON). ON 이면 미배치분을 자동 배치하고
  //   수동 UI(호버 프리뷰·확인 팝업)는 띄우지 않는다. OFF 면 기존 수동 심기 그대로.
  let autoPlant = ui.getAutoPlant();
  // 자동 배치 루프 재진입 가드: activate 는 내부에서 _poll→onUpdate 를 부르므로,
  //   루프 도중 onUpdate 가 재귀로 또 루프를 돌지 않게 막는다(중복 activate 방지).
  let autoPlanting = false;

  // 서버가 아는 날짜 키(days 키). startDate 비어도 가장 이른 날 보강용(oldestPendingDate).
  const knownDates = () => Object.keys(lastMeta.days || {});

  // 지금 심으려는 날의 달("YYYY-MM"). 닫힘 칸 허용 판정(그 달이면 허용)에 쓴다. 없으면 null.
  const pendingMonth = () => {
    const d = oldestPendingDate(lastMeta.placementMap || {}, lastMeta.startDate, knownDates());
    return d ? d.slice(0, 7) : null;
  };

  // startDate 미정 = 시작일 모달이 먼저(활성화는 start 확정 후). startDate 가 null/없음일 때.
  const startUndecided = () => lastMeta.startDate == null;

  // 활성화 가능 조건: startDate 확정 + read-only 아님 + 심을 날 남음.
  const canActivate = () =>
    !startUndecided() && !state.readOnly && hasPending(lastMeta.placementMap || {}, lastMeta.startDate, knownDates());

  /**
   * 활성화 UI 갱신.
   *   - startDate 미정: 시작일 모달 표시, 활성화 UI 비활성.
   *   - 콜드 스타트(점유 0개): 화면 빈 칸 자유 선택(사전 강조 없음).
   *   - 점유 1개 이상: 마지막 활성 그리드 8방향 후보 강조. read-only: 활성화 UI 생략.
   */
  function refreshPlantUI() {
    const map = lastMeta.placementMap || {};
    // 차단 집합 1회 계산(닫힘 칸). 펼친 달은 차단 해제(drilldown).
    //   활성화 UI 와 무관하게 항상 계산해 렌더가 바위/절벽을 그릴 수 있게 한다(단일 진실 소스).
    blocked = blockedSet(map, lastMeta.forests, renderer.isDrilldown());
    renderer.setBlocked(blocked);
    // 시작일 미정이면 모달 우선(실모드만 — read-only 목은 전체 스테이지라 해당 없음).
    const showModal = startUndecided() && !state.readOnly;
    ui.showStartModal(showModal);

    if (!showModal && canActivate() && !autoPlant) {
      // 수동 모드: 마지막 활성 그리드 8방향 후보 강조 + 안내 + 호버/확인 UI.
      //   앵커 = 마지막 활성 그리드(찾기 버튼·깃발과 동일 기준).
      candidates = candidateSlots(map, lastMeta.startDate, blocked, pendingMonth(), renderer.lastActiveGrid());
      renderer.setPlantUI(candidates, null);
      ui.showPlantPrompt(true, isColdStart(map)); // 콜드 스타트면 안내 문구 다르게
    } else {
      candidates = [];
      pendingSlot = null;
      renderer.setPlantUI([], null);
      renderer.setHoverSlot(null);
      renderer.setCursorGrid(null); // 모달 중·비활성 시 커서 하이라이트 끔
      ui.showPlantPrompt(false);
      ui.hideConfirm();
    }
  }

  // 자동 심기 카메라 추종 줌: 화면에 들어올 칸 폭. 거리 둔 줌(~10칸폭 — 심는 칸 + 주변 맥락이
  //   함께 보이게). §41 찾기 버튼의 타이트 3.5칸폭과 달리 너무 가깝지 않게(매 칸 줌 출렁임 없이 팬만).
  const AUTO_FOLLOW_CELLS = 10;

  // 점진 연출 간격: 칸당 등장 간격(ms). 대량이면 촘촘(하한 20), 소량이면 또렷(상한 150).
  //   전체 완성이 짧게 끝나게 3000/N 으로 조절(콜드 427일 ≈ 20ms×427 ≈ 8.5초로 좌르륵,
  //   일상 한둘은 150ms 로 하나씩 또렷이). activate 왕복(콜드는 메모리라 ~0)도 더해진다.
  const autoPlantInterval = (n) => Math.max(20, Math.min(150, Math.round(3000 / Math.max(1, n))));
  // 짧은 딜레이 헬퍼(점진 등장 사이 시간차). localhost activate 왕복이 너무 빨라 간격이 안 보이는 것 방지.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 후보 집합 중 무작위 택1(자동 배치 위치). 사용자가 "무작위" 확정 — Math.random 허용(매 콜드 실행
  //   다른 배치 OK, 심으면 서버 영속이라 새로고침 시 그 배치 유지). 빈 배열이면 null.
  const pickRandom = (arr) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);

  /**
   * 콜드 첫 칸(활성 0개): 시작일~오늘 자유 선택 영역 = 맵 허용 영역 중 무작위 빈칸 1개.
   *   닫힘은 콜드라 없지만 isAcceptableSlot 으로 안전 검증. 무작위 시도 후 못 찾으면 전수 폴백.
   * @param {Object} map placementMap(콜드면 빈 객체).
   * @param {string} month 심을 달.
   * @returns {{gx,gy}|null} 빈칸.
   */
  function pickRandomFreeCell(map, month) {
    const W = MAP_GX1 - MAP_GX0 + 1, H = MAP_GY1 - MAP_GY0 + 1;
    for (let t = 0; t < 200; t++) {
      const gx = MAP_GX0 + Math.floor(Math.random() * W);
      const gy = MAP_GY0 + Math.floor(Math.random() * H);
      if (isAcceptableSlot(map, [], gx, gy, blocked, month)) return { gx, gy };
    }
    // 무작위로 못 찾음(거의 불가): 전수 훑어 수용 가능 칸 중 무작위.
    const all = [];
    for (let gx = MAP_GX0; gx <= MAP_GX1; gx++)
      for (let gy = MAP_GY0; gy <= MAP_GY1; gy++)
        if (isAcceptableSlot(map, [], gx, gy, blocked, month)) all.push({ gx, gy });
    return pickRandom(all);
  }

  /**
   * 자동 심기 루프(점진 연출 + 무작위 배치 + 심는 중 차단): autoPlant ON 일 때 미배치 날짜를
   *   oldest 부터 하나씩 시간차로 배치한다. 위치 = 각 시점 candidateSlots(활성화 가능 후보 =
   *   마지막 활성 인접·비차단·닫힘 §47 통과·미점유) 집합 **중 무작위 택1**(자연스럽게 퍼짐).
   *   콜드 첫 칸은 맵 허용 영역 무작위(pickRandomFreeCell). 후보 0(둘러싸여 막힘)은 자유 폴백.
   *   각 칸마다 가벼운 빛기둥 + 칸 사이 딜레이로 "빈 맵에서 나무가 좌르륵" 연출. 시간차라 폭주 아님.
   *   시작~완료 동안 "심는 중" 인디케이터 + 전체 입력 차단(ui.setPlanting). 재진입 가드(autoPlanting)
   *   로 activate 재폴 재귀 차단(자동/수동 공유 플래그).
   */
  async function runAutoPlant() {
    if (!autoPlant) return;
    if (autoPlanting) return; // 이미 도는 중(재폴 재귀) — 중복 방지
    if (startUndecided() || state.readOnly) return; // 시작일 미정·read-only 면 자동 배치 없음
    // 심을 게 없으면 인디케이터·차단도 안 켠다(빈 폴마다 깜빡임 방지).
    if (!oldestPendingDate(lastMeta.placementMap || {}, lastMeta.startDate, knownDates())) return;
    autoPlanting = true;
    ui.setPlanting(true); // 심는 중 인디케이터 + 전체 입력 차단
    try {
      // 이번에 심을 미배치 수(간격 산출용). placementMap 기준 startDate~오늘 중 빈 날 수.
      const pendingN = countPending(lastMeta.placementMap || {}, lastMeta.startDate, knownDates());
      const interval = autoPlantInterval(pendingN);
      let guard = 0;
      let first = true;
      // 밀린 미배치분을 oldest 부터 하나씩 시간차로 자리잡게 한다(activate 마다 placementMap 갱신).
      while (guard < 800) {
        guard++;
        // 첫 칸은 즉시, 이후 칸은 등장 간격만큼 쉰다(점진 좌르륵). OFF 전환 시 즉시 중단.
        if (!first) await sleep(interval);
        first = false;
        if (!autoPlant) break; // 딜레이 중 토글 OFF 되면 멈춤
        const map = lastMeta.placementMap || {};
        const date = oldestPendingDate(map, lastMeta.startDate, knownDates());
        if (!date) break; // 더 심을 날 없음
        const month = date.slice(0, 7);
        let slot;
        if (isColdStart(map)) {
          slot = pickRandomFreeCell(map, month); // 콜드 첫 칸: 맵 허용 영역 무작위
        } else {
          const cands = candidateSlots(map, lastMeta.startDate, blocked, month, renderer.lastActiveGrid());
          // 후보 중 무작위 택1(자연스럽게 퍼지는 배치). 후보 0(둘러싸여 막힘)은 자유 폴백.
          slot = cands.length ? pickRandom(cands) : findFreeFallbackSlot(map, month);
        }
        if (!slot) break; // 심을 칸이 정말 없음(맵 가득) — 중단
        const ok = await state.activate(date, slot.gx, slot.gy); // POST → 재폴(autoPlanting 가드로 재귀 안 함)
        if (!ok) break; // 실패 시 중단(다음 폴에서 재시도)
        if (!autoPlant) break; // activate await 중 끄기 눌렀으면 즉시 중단(추가 연출 스킵)
        renderer.playPlantEffect(slot.gx, slot.gy); // 각 칸 가벼운 빛기둥(시간차라 폭주 아님)
        // 카메라 추종(§41 보간 재사용): 방금 심은 칸이 마지막 활성이 됨 → 그쪽으로 부드럽게 팬.
        //   거리 둔 줌(viewCells=10, ~10칸폭 — 심는 칸 + 주변 맥락이 함께 보임). 첫 칸에서 줌이
        //   한 번 맞춰진 뒤로는 같은 toZoom 이라 줌 출렁임 없이 위치(팬)만 따라간다. 입력 차단과 무관.
        renderer.focusLastActive(AUTO_FOLLOW_CELLS);
        // activate 가 재폴해 lastMeta 가 갱신됐다. blocked 도 새로 계산해 다음 칸 판정에 반영.
        blocked = blockedSet(lastMeta.placementMap || {}, lastMeta.forests, renderer.isDrilldown());
      }
    } finally {
      autoPlanting = false;
      ui.setPlanting(false); // 인디케이터 사라지고 입력 차단 해제
    }
    refreshPlantUI(); // 자동 배치 후 UI 정리(수동 후보 등 갱신)
  }

  /**
   * startDate~오늘 범위에서 placementMap 에 없는 날(미배치) 개수를 센다. 점진 연출 간격 산출용.
   * @param {Object} map placementMap.
   * @param {string|null} startDate 시작일.
   * @param {string[]} known 서버가 아는 날짜 키.
   * @returns {number} 미배치 날 수(>=0).
   */
  function countPending(map, startDate, known) {
    let n = 0;
    let cursor = oldestPendingDate(map, startDate, known);
    let guard = 0;
    // oldestPendingDate 는 첫 빈 날을 주므로, 그 날을 임시 채운 가정으로 다음 빈 날을 반복 카운트.
    const seen = Object.assign({}, map);
    while (cursor && guard < 800) {
      guard++;
      n++;
      seen[cursor] = { gx: 0, gy: 0 }; // 채운 셈 치고 다음 빈 날 찾기
      cursor = oldestPendingDate(seen, startDate, known);
    }
    return n;
  }

  /**
   * 후보 0(둘러싸여 막힘) 시 자유 폴백 빈칸을 찾는다. 점유칸 8방향을 넓혀가며 심을 수 있는
   *   가장 가까운 빈칸을 고른다(닫힘 §47 거름 통과 칸만). 결정적(좌표 정렬 순).
   * @param {Object} map placementMap.
   * @param {string} month 심을 달("YYYY-MM").
   * @returns {{gx,gy}|null} 빈칸, 없으면 null.
   */
  function findFreeFallbackSlot(map, month) {
    const occ = new Set();
    for (const date in map) {
      const p = map[date];
      if (p && Number.isFinite(p.gx)) occ.add(p.gx + "," + p.gy);
    }
    // 점유칸을 중심으로 반경을 넓혀가며 첫 수용 가능한 빈칸(결정적: gy,gx 정렬).
    for (let r = 1; r <= 40; r++) {
      const cands = [];
      for (const key of occ) {
        const [ox, oy] = key.split(",").map(Number);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // 둘레만
            const nx = ox + dx, ny = oy + dy;
            const k = nx + "," + ny;
            if (occ.has(k)) continue;
            if (isAcceptableSlot(map, [], nx, ny, blocked, month)) cands.push({ gx: nx, gy: ny });
          }
        }
      }
      if (cands.length) {
        cands.sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx));
        return cands[0];
      }
    }
    return null;
  }

  // 폴링 콜백: 숲(forests/drilldown) 반영 → 배치 렌더 → HUD DOM → 활성화 UI.
  state.onUpdate = (cellList, changedDates, meta) => {
    lastMeta = meta;
    // 자동 묶기 감지: 서버가 그 달을 bundled=true 로 전환한 순간 → 멤버 그리드 빛기둥.
    detectAutoBundle(meta);
    renderer.setOffline(meta.offline);
    renderer.setGeneratedAt(meta.generatedAt);
    renderer.setForests(meta.forests); // 묶인 달 → 숲 덩어리
    renderer.setData(cellList, changedDates, meta.placementMap);
    ui.updateHud(renderer, meta); // 오늘 5메트릭 + 월 누적(monthly) + 활성 수
    ui.updateDetail(renderer);
    refreshPlantUI();
    // 자동 심기 ON 이면 미배치분을 자동 배치(재진입 가드로 activate 재폴 재귀는 차단).
    runAutoPlant();
  };

  /**
   * 직전 폴 forests.bundled 와 비교해 false→true 로 바뀐 달의 멤버 그리드에 빛기둥을 띄운다.
   * 멤버 칸 = 그 ym 의 placement 좌표들. 일회성이며, 첫 폴(lastBundled==null)은
   * 효과 없이 스냅샷만 채운다(기존 묶인 달이 즉시 폭죽 터지지 않게).
   * @param {Object} meta 폴링 meta(forests·placementMap 사용).
   */
  function detectAutoBundle(meta) {
    const forests = (meta && meta.forests) || {};
    const cur = {};
    for (const ym in forests) cur[ym] = !!(forests[ym] && forests[ym].bundled);
    if (lastBundled) {
      const pmap = (meta && meta.placementMap) || {};
      for (const ym in cur) {
        if (cur[ym] && !lastBundled[ym]) {
          // 그 달 멤버 그리드 좌표 모으기.
          const cells = [];
          for (const date in pmap) {
            if (date.slice(0, 7) !== ym) continue;
            const p = pmap[date];
            if (p && Number.isFinite(p.gx)) cells.push({ gx: p.gx, gy: p.gy });
          }
          if (cells.length) renderer.playBundleEffect(cells);
          // 작업2(B): 묶임 false→true 순간 완성 토스트 1회(lastBundled 가드로 ym 당 1회 보장).
          ui.showBundleToast(ym);
        }
      }
    }
    lastBundled = cur;
  }

  // 창 크기 변경 시 백버퍼·캔버스·줌 한계 재계산.
  window.addEventListener("resize", () => renderer.resize());

  // ===================== 카메라 입력 (데스크톱 휠/드래그만) =====================
  const toCanvasPx = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / (rect.width || 1);
    const sy = canvas.height / (rect.height || 1);
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  };

  // 휠 줌: 오늘 그리드 피벗, 정수 단계. 위로(휠 업)=줌인.
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault(); // 페이지 스크롤 차단
      if (ui.isPlanting()) return; // 심는 중에는 줌 차단(오버레이가 흡수하지만 방어적으로)
      const p = toCanvasPx(e.clientX, e.clientY);
      const dir = e.deltaY < 0 ? +1 : -1;
      renderer.zoomAt(p.x, p.y, dir);
    },
    { passive: false }
  );

  // 드래그 팬 + 호버/클릭. 클릭 vs 드래그는 이동거리 임계로 구분.
  let dragging = false;
  let moved = false;
  let lastX = 0, lastY = 0;
  let downX = 0, downY = 0;
  const DRAG_THRESH = 4; // px

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    lastX = downX = e.clientX;
    lastY = downY = e.clientY;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    const p = toCanvasPx(e.clientX, e.clientY);
    if (dragging) {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / (rect.width || 1);
      const sy = canvas.height / (rect.height || 1);
      const dx = (e.clientX - lastX) * sx;
      const dy = (e.clientY - lastY) * sy;
      lastX = e.clientX;
      lastY = e.clientY;
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > DRAG_THRESH) moved = true;
      if (moved) {
        renderer.pan(dx, dy);
        renderer.setHover(null);
        renderer.setHoverForest(null); // 드래그 중 숲 떠오름 해제
        renderer.setCursorGrid(null); // 드래그 중 커서 하이라이트 숨김
        renderer.setHoverSlot(null);
        ui.hideTooltip();
      }
      return;
    }
    // 비드래그: 호버 히트테스트 → DOM 툴팁 갱신(셀 또는 묶인 숲).
    renderer.setPointer(p.x, p.y);
    const fYm = renderer.hitTestForest(p.x, p.y);
    renderer.setHover(renderer.hitTestCanvas(p.x, p.y));
    renderer.setHoverForest(fYm); // 묶인 숲 호버 떠오름
    ui.updateTooltip(renderer, e.clientX, e.clientY, fYm);
    updateCursorGrid(p.x, p.y); // 커서 그리드 하이라이트
  });

  /**
   * 활성화 가능 시 마우스 아래 그리드 칸을 표시한다. 후보 칸이면 호버 프리뷰(밝은 박스+＋),
   * 비후보 칸은 아주 옅은 커서 하이라이트. 비활성화면 둘 다 숨김.
   * @param {number} cx 커서 캔버스 X.
   * @param {number} cy 커서 캔버스 Y.
   */
  function updateCursorGrid(cx, cy) {
    const map = lastMeta.placementMap || {};
    // 자동 심기 ON 이면 수동 호버 프리뷰·커서 하이라이트 숨김(자동이 자리잡음).
    if (!canActivate() || autoPlant) {
      renderer.setCursorGrid(null);
      renderer.setHoverSlot(null);
      return;
    }
    const g = renderer.hitTestGrid(cx, cy);
    if (!g || renderer.hitTestForest(cx, cy)) {
      renderer.setCursorGrid(null);
      renderer.setHoverSlot(null);
      return;
    }
    // 유효 = 활성화 가능 칸(콜드=빈 칸 아무 데나, 점유 1+=8방향 인접, 닫힘=그 달이면 허용).
    const valid = isAcceptableSlot(map, candidates, g.gx, g.gy, blocked, pendingMonth());
    if (valid) {
      renderer.setHoverSlot({ gx: g.gx, gy: g.gy }); // 후보 → 선택 디자인 프리뷰
      renderer.setCursorGrid(null);
    } else {
      renderer.setHoverSlot(null);
      renderer.setCursorGrid({ gx: g.gx, gy: g.gy, valid: false }); // 비후보 → 옅게
    }
  }

  window.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    dragging = false;
    if (moved) return;
    const p = toCanvasPx(e.clientX, e.clientY);

    // 1) 묶인 숲 클릭 = 드릴다운 토글(펼침). 펼치면 그 달이 일 그리드로.
    const fYm = renderer.hitTestForest(p.x, p.y);
    if (fYm) {
      renderer.setDrilldown(renderer.isDrilldown() === fYm ? null : fYm);
      // 드릴다운 변경 → 마지막 스냅샷으로 즉시 재렌더(숨김/표시 갱신).
      state.onUpdate(state.cellList, null, lastMeta);
      return;
    }

    // 2) 심긴/데이터 그리드 클릭 = 상세 패널 토글.
    const cell = renderer.hitTestCanvas(p.x, p.y);
    if (cell) {
      renderer.toggleSelected(cell);
      ui.updateDetail(renderer);
      ui.updateTooltip(renderer, e.clientX, e.clientY, null);
      return;
    }

    // 3) 빈칸 클릭: 활성화 가능한 후보 칸이면 클릭 한 번에 바로 심기 확인 팝업.
    //    pendingSlot 은 확인 동안만 보관. 콜드=빈 칸 아무 데나, 점유 1+=8방향만.
    //    startDate 미정이면 모달이 먼저(canActivate=false).
    const map = lastMeta.placementMap || {};
    if (canActivate() && !autoPlant) {
      const g = renderer.hitTestGrid(p.x, p.y);
      if (g && isAcceptableSlot(map, candidates, g.gx, g.gy, blocked, pendingMonth())) {
        pendingSlot = { gx: g.gx, gy: g.gy };
        ui.showConfirm(e.clientX, e.clientY); // 바로 확인 팝업
        return;
      }
    }
    // 그 외 빈칸 클릭 → 열린 상세 닫기.
    renderer.setSelected(null);
    ui.updateDetail(renderer);
  });

  const endDrag = () => { dragging = false; };
  window.addEventListener("mouseleave", () => {
    endDrag();
    renderer.setHover(null);
    renderer.setHoverForest(null); // 커서가 캔버스 밖 → 숲 떠오름 해제
    renderer.setCursorGrid(null);
    renderer.setHoverSlot(null);
    ui.hideTooltip();
  });
  canvas.addEventListener("dragstart", (e) => e.preventDefault());

  setupHudToggle(renderer);

  // 현재 서버 포트 표시(앱이 포트 충돌로 fallback 했어도 창 origin 이 실제 포트라 그대로 반영). 웹/앱 공통.
  const portEl = document.getElementById("server-port");
  if (portEl) portEl.textContent = location.port || (location.protocol === "https:" ? "443" : "80");

  // ESC 우선순위: 위 레이어부터 닫는다. 설정 모달(딤 최상위) → 확인 팝업 → 상세 모달 → 드릴다운.
  //   상세 모달이 열려 있으면 모달만 닫고 return — 드릴다운은 다음 ESC 에서 닫힌다.
  window.addEventListener("keydown", (e) => {
    // 심는 중(연출 + 입력 차단)에는 키 입력도 막는다(전체 차단). ESC 로 모달 닫기 등 무반응.
    if (ui.isPlanting()) { e.preventDefault(); return; }
    if (e.key === "Escape") {
      // 업로드 설정 모달이 가장 위(딤 배경) — ESC 1번에 이것부터 닫는다.
      if (ui.isUploadConfigOpen()) {
        ui.hideUploadConfigModal();
        return;
      }
      if (ui.isConfirmOpen()) {
        ui.hideConfirm();
        pendingSlot = null;
        return;
      }
      // 모달(상세) > 드릴다운: 모달 열려 있으면 모달만 닫고 드릴다운은 건드리지 않는다.
      if (ui.isDetailOpen()) {
        renderer.setSelected(null);
        ui.updateDetail(renderer);
        return;
      }
      if (renderer.isDrilldown()) {
        renderer.setDrilldown(null);
        state.onUpdate(state.cellList, null, lastMeta);
        return;
      }
      return;
    }
  });

  // 상세 패널 자체 클릭으로도 닫기.
  const detailEl = document.getElementById("detail");
  if (detailEl) {
    detailEl.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      renderer.setSelected(null);
      ui.updateDetail(renderer);
    });
  }

  // 확인 팝업: 확인 → 가장 오래된 미배치 날로 POST activate(date, 선택칸) + 빛기둥, 취소 → 선택 해제.
  //   수동도 자동과 같은 "심는 중" 인디케이터 + 전체 입력 차단(즉시 표시 → activate 왕복 완료 시 해제).
  //   autoPlanting 플래그를 공유해 자동/수동 중복 심기·경쟁을 막는다.
  ui.onConfirm(
    async () => {
      const slot = pendingSlot;
      ui.hideConfirm();
      if (!slot) return;
      if (autoPlanting) return; // 이미 심는 중(자동/수동 공유 가드)
      const date = oldestPendingDate(lastMeta.placementMap || {}, lastMeta.startDate, knownDates());
      if (!date) { pendingSlot = null; refreshPlantUI(); return; }
      autoPlanting = true;
      ui.setPlanting(true, false); // 수동 심기: "심는 중…"만, '자동 끄기' 버튼 숨김(자동 이미 OFF)
      let ok = false;
      try {
        ok = await state.activate(date, slot.gx, slot.gy); // POST → 재폴링
      } finally {
        autoPlanting = false;
        ui.setPlanting(false);
      }
      pendingSlot = null;
      if (ok) renderer.playPlantEffect(slot.gx, slot.gy); // 활성화 이펙트(빛기둥)
      refreshPlantUI();
    },
    () => {
      ui.hideConfirm();
      pendingSlot = null; // 취소 시 아무 상태도 남지 않음
    }
  );

  // 마지막 활성 그리드 찾기 버튼 클릭 → 카메라를 마지막 활성 셀로 부드럽게 이동(게임 상태 불변).
  ui.onLocate(() => renderer.focusLastActive());

  // 자동 심기 토글: ON 으로 켜면 즉시 밀린 미배치분을 자동 배치, OFF 면 수동 UI 복귀.
  //   영속(localStorage)은 ui 가 처리. 확인 팝업 떠 있으면 닫는다(모드 전환 정리).
  ui.onAutoPlantToggle((on) => {
    autoPlant = on;
    if (on) {
      ui.hideConfirm();
      pendingSlot = null;
    }
    refreshPlantUI();
    runAutoPlant(); // ON 이면 미배치분 자동 배치, OFF 면 가드(autoPlant false)로 즉시 반환
  });

  // 심는 중 "자동 끄기" 버튼: 점진 연출 중에도 클릭 가능(인디케이터 z-index>오버레이).
  //   누르면 autoPlant OFF → 진행 중 루프는 다음 sleep 후 `!autoPlant` 가드로 중단,
  //   finally 의 setPlanting(false) 가 인디케이터·차단 오버레이를 해제(조작권 복귀).
  //   이미 심은 칸은 그대로(서버 영속). 체크박스·localStorage 동기화는 ui.setAutoPlant.
  ui.onPlantingStop(() => {
    autoPlant = false;
    ui.setAutoPlant(false); // 두 체크박스 + localStorage 동기화
    // 루프가 sleep 중이면 곧 멈춘다. 루프 밖(수동 등)이면 다음 폴부터 자동 안 함.
    // refreshPlantUI 는 루프 finally 후 호출되므로 여기선 생략(이중 호출 방지).
  });

  // 시작일 모달 확인: 검증 통과한 날짜로 POST /api/forest/start → 재폴링(startDate 채워짐).
  //   성공 시 모달은 onUpdate→refreshPlantUI 에서 startDate 가 null 아니게 되어 자동으로 닫힘.
  ui.onStartConfirm(async (date) => {
    const ok = await state.setStartDate(date); // POST → 재폴링
    if (!ok) {
      // 실패(서버 거부 등): 모달 유지 + 에러. refreshPlantUI 가 startDate null 이면 다시 모달.
      console.warn("startDate 설정 실패");
    }
    // 성공이면 다음 폴 meta.startDate 가 채워져 refreshPlantUI 가 모달을 닫고 활성화 시작.
  });

  // 중앙 서버 업로드 상태 UI(폴·즉시전송·설정 모달) — /api/forest 폴과 독립.
  setupUploadUI(ui);

  // rAF 루프(렌더·찾기 버튼·미니맵) 시작.
  startRenderLoop(renderer, ui, { miniCanvas, miniCtx });

  state.start();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
