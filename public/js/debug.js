// 개발 모드 UI·설정 (서버 FOREST_DEBUG 가 마스터 스위치).
//
// 켜져 있을 때만 데이터 소스(실/Mock/Cold) 선택 패널과 콘솔 디버그 훅을 노출한다. 모드는
// URL 쿼리 대신 localStorage 에 저장하고, 바꾸면 새로고침으로 그 소스로 깨끗하게 재부팅한다.
// 프로덕션(스위치 꺼짐)에선 이 모듈의 어떤 것도 활성화되지 않는다.

// 데이터 소스 모드 저장 키(localStorage). "real"|"mock"|"cold".
const DEBUG_MODE_KEY = "forest.debugMode";

/**
 * 서버에 개발 모드 여부를 묻는다(GET /api/config). 꺼져 있거나 실패하면 false →
 * 데이터 소스 선택·라벨·디버그 훅 전부 비활성(프로덕션 안전 폴백).
 * @returns {Promise<boolean>} 개발 모드 활성 여부.
 */
export async function fetchDebugEnabled() {
  try {
    const r = await fetch("/api/config", { cache: "no-store" });
    if (!r.ok) return false;
    const c = await r.json();
    return !!c.debug;
  } catch {
    return false;
  }
}

/**
 * 현재 데이터 소스 모드. 개발 모드면 localStorage 값(기본 "real"), 아니면 항상 "real".
 * @param {boolean} debugEnabled 개발 모드 활성 여부.
 * @returns {"real"|"mock"|"cold"} 데이터 소스 모드.
 */
export function getDebugMode(debugEnabled) {
  return debugEnabled ? localStorage.getItem(DEBUG_MODE_KEY) || "real" : "real";
}

/**
 * 개발 모드 UI 초기화: 콘솔 디버그 훅(window.__forest) + 데이터 소스 선택 패널.
 * 개발 모드일 때만 호출한다.
 * @param {Object} renderer 렌더러(훅·cam 노출).
 * @param {Object} state 폴링 상태(훅 노출).
 * @param {string} mode 현재 모드 "real"|"mock"|"cold".
 */
export function initDebugUI(renderer, state, mode) {
  window.__forest = { renderer, state, get cam() { return renderer.cam; } };
  setupDebugPanel(mode);
}

/**
 * 데이터 소스 선택 패널을 만든다. 다른 모드 선택 시 localStorage 저장 후 새로고침.
 * @param {string} current 현재 모드 "real"|"mock"|"cold".
 */
function setupDebugPanel(current) {
  const modes = [
    { key: "real", label: "실데이터" },
    { key: "mock", label: "Mock" },
    { key: "cold", label: "Cold" },
  ];
  const panel = document.createElement("div");
  panel.id = "debug-panel";
  panel.style.cssText =
    "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;" +
    "gap:4px;align-items:center;padding:4px 8px;background:rgba(20,28,20,0.85);" +
    "border:1px solid #3a5;border-radius:6px;font:12px monospace;color:#cfe;";
  const tag = document.createElement("span");
  tag.textContent = "DEBUG";
  tag.style.cssText = "color:#7d7;font-weight:bold;margin-right:4px;";
  panel.appendChild(tag);
  for (const m of modes) {
    const btn = document.createElement("button");
    btn.textContent = m.label;
    const active = m.key === current;
    btn.style.cssText =
      `padding:2px 8px;border:1px solid ${active ? "#7d7" : "#456"};border-radius:4px;` +
      `background:${active ? "#2d5a2d" : "#1a241a"};color:${active ? "#dfd" : "#9ab"};` +
      "cursor:pointer;font:12px monospace;";
    if (!active) {
      btn.addEventListener("click", () => {
        localStorage.setItem(DEBUG_MODE_KEY, m.key);
        location.reload();
      });
    }
    panel.appendChild(btn);
  }
  document.body.appendChild(panel);
}
