// DOM UI 오버레이 갱신. 캔버스에 안 그리고 HTML 요소를 갱신한다.
// renderer 의 getter(getHud/getHover/getSelected/...)에서 데이터를 읽는다.

/**
 * 큰 수를 한글 단위로 축약한다. 한국어는 만(10⁴) 단위로 묶어 읽으므로 천·만·억·조를 쓴다.
 * 예: 12050000 → "1.2억", 15000 → "1.5만", 5000 → "5천", 800 → "800".
 * @param {number} v 0 이상 정수(토큰 수·요청 수). 유한수 아니면 0 으로 본다.
 * @returns {string} 축약 표기(소수 1자리, 정수면 소수점 생략).
 */
function abbr(v) {
  v = Number.isFinite(v) ? v : 0;
  const fmt = (n) => n.toFixed(1).replace(/\.0$/, "");
  if (v >= 1e12) return fmt(v / 1e12) + "조";
  if (v >= 1e8) return fmt(v / 1e8) + "억";
  if (v >= 1e4) return fmt(v / 1e4) + "만";
  if (v >= 1e3) return fmt(v / 1e3) + "천";
  return String(v);
}

const STAGE_NAMES = { 0: "빈 대지", 1: "묘목", 2: "유목", 3: "성목" };
const NEXT_NAME = { 1: "유목", 2: "성목" }; // 묘목→유목, 유목→성목 (성목은 다음 없음)

/**
 * 매크로 단계 → 화면 표기("성목"). 하위 칸(n/m) 숫자는 쓰지 않는다 — 매크로 이름만.
 * @param {number} stage 매크로 단계(0~3).
 * @returns {string} 표기 라벨.
 */
function stageLabel(stage) {
  return STAGE_NAMES[stage] || "";
}
// 수종 이름(sprites.js SPECIES tree0..4 = 초록·연두·단풍·진청록·민트 순서와 일치).
const SPECIES_NAMES = { 0: "초록나무", 1: "연두나무", 2: "단풍나무", 3: "진청록나무", 4: "민트나무" };
const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * "YYYY-MM-DD" 를 한글 요일로 변환한다(타임존 무관, 로컬일 자정 기준).
 * @param {string} date "YYYY-MM-DD" 날짜 문자열.
 * @returns {string} "월요일" 등. 형식 어긋나면 "".
 */
function weekdayKR(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return WEEKDAY_KR[dt.getDay()] + "요일";
}

/**
 * ISO 시각을 "마지막 업로드 N분 전" 형태의 상대 시간 문자열로 만든다.
 * @param {string|null} iso ISO 시각 문자열.
 * @returns {string} 상대 시간. null/미래/파싱 실패면 "전송 없음".
 */
function relativeTime(iso) {
  if (!iso) return "전송 없음";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "전송 없음";
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 0) return "방금 전"; // 시계 차이로 미래면 방금으로 클램프
  if (sec < 45) return "방금 전";
  const min = Math.floor(sec / 60);
  if (min < 60) return `마지막 업로드 ${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `마지막 업로드 ${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `마지막 업로드 ${day}일 전`;
}

/**
 * 경험치 바 HTML(트랙 + 채움 + 퍼센트 텍스트)을 만든다.
 * @param {number} progress 진행도 0~1(범위 밖은 클램프).
 * @returns {string} 바 HTML 문자열.
 */
function xpBar(progress) {
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const pctTxt = Math.round(p * 100) + "%";
  return (
    `<div class="xpbar"><div class="xpfill" style="width:${(p * 100).toFixed(0)}%"></div>` +
    `<span class="xptext">${pctTxt}</span></div>`
  );
}

/**
 * DOM 오버레이(HUD·툴팁·모달·활성화 UI)를 소유하고 갱신하는 클래스.
 * 데이터는 renderer getter 와 main 이 넘기는 meta 에서 읽고 HTML 요소만 갱신한다.
 */
export class ForestUI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      // 하단(오늘 5메트릭)
      bInput: $("b-input"), bOutput: $("b-output"), bCwrite: $("b-cwrite"),
      bCread: $("b-cread"), bReq: $("b-req"),
      // 우상단: 5h/7d + 이번달 활성수 + 월 누적 5메트릭
      fiveHour: $("m-fivehour"), sevenDay: $("m-sevenday"),
      mCount: $("m-count"),
      tInput: $("t-input"), tOutput: $("t-output"), tCwrite: $("t-cwrite"),
      tCread: $("t-cread"), tReq: $("t-req"),
      tooltip: $("tooltip"), detail: $("detail"),
      offline: $("offline"), emptyNote: $("empty-note"),
      // 활성화 UI
      plantPrompt: $("plant-prompt"), confirmBox: $("plant-confirm"),
      confirmYes: $("confirm-yes"), confirmNo: $("confirm-no"),
      // 시작일 모달
      startModal: $("start-modal"), startInput: $("start-date-input"),
      startConfirm: $("start-confirm"), startError: $("start-error"),
      // 마지막 활성 그리드 찾기 버튼
      locateBtn: $("locate-btn"),
      // 자동 심기 토글(우상단 HUD + 시작일 모달, 같은 localStorage 상태 공유)
      autoPlant: $("auto-plant"), startAutoPlant: $("start-auto-plant"),
      // 심는 중 입력 차단 오버레이 + 인디케이터 + 끄기 버튼
      plantingOverlay: $("planting-overlay"), plantingIndicator: $("planting-indicator"),
      plantingStop: $("planting-stop"),
      // 중앙 서버 업로드 상태(하단 HUD 한 줄)
      uploadRow: $("upload-row"), upWhen: $("up-when"), uploadNowBtn: $("upload-now"),
      // 업로드 설정 모달
      uploadCfgBtn: $("upload-cfg"), cfgModal: $("upload-config-modal"),
      cfgUrl: $("ucfg-url"), cfgEmail: $("ucfg-email"), cfgInterval: $("ucfg-interval"),
      cfgEnabled: $("ucfg-enabled"), cfgError: $("ucfg-error"), cfgHint: $("ucfg-hint"),
      cfgSave: $("ucfg-save"), cfgCancel: $("ucfg-cancel"),
    };
    // 마지막 업로드 상태 보관(1분 타이머로 상대시간 재계산용). null=아직 모름.
    this._uploadStatus = null;
  }

  /**
   * "마지막 활성 그리드 찾기" 버튼 표시/숨김.
   * @param {boolean} show 활성 셀이 있을 때만 true(콜드 스타트면 숨김).
   */
  updateLocateButton(show) {
    const el = this.el.locateBtn;
    if (!el) return;
    el.style.display = show ? "block" : "none";
  }
  /**
   * 찾기 버튼 클릭 콜백 배선(1회). 캔버스 mousedown 으로 전파 안 되게 stopPropagation.
   * @param {Function} cb 클릭 시 호출할 콜백.
   */
  onLocate(cb) {
    if (this.el.locateBtn)
      this.el.locateBtn.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        cb();
      });
  }

  /**
   * 단위4 식생 트윅 슬라이더 패널 초기화(디버그 전용). main 이 debug 모드일 때만 호출한다 —
   * 안 부르면 패널은 display:none 으로 숨고 어떤 이벤트도 안 붙는다(프로덕션 무영향).
   *   - 각 슬라이더 초기값 = renderer.getVegTweaks()[key], 현재값 텍스트도 동기.
   *   - input(드래그) → renderer.setVegTweak(key, val) 로 식생만 재반영(§28: 슬라이더 조작 시에만
   *     무효화, 일반 폴은 무영향). main 의 rAF 루프가 항상 돌아 다음 프레임에 화면 반영되므로
   *     별도 render() 호출 불필요.
   * @param {Object} renderer setVegTweak/getVegTweaks 를 가진 렌더러.
   */
  initVegTweaks(renderer) {
    const panel = document.getElementById("veg-tweaks");
    if (!panel) return;
    const cur = renderer.getVegTweaks ? renderer.getVegTweaks() : {};
    const sliders = panel.querySelectorAll('input[type="range"][data-key]');
    sliders.forEach((slider) => {
      const key = slider.dataset.key;
      const valEl = slider.parentElement.querySelector(".vt-val");
      const init = Number.isFinite(cur[key]) ? cur[key] : Number(slider.value);
      slider.value = String(init);
      if (valEl) valEl.textContent = init.toFixed(2);
      slider.addEventListener("input", () => {
        const v = Number(slider.value);
        if (valEl) valEl.textContent = v.toFixed(2);
        renderer.setVegTweak(key, v);
      });
    });
    panel.style.display = "block";
  }

  /**
   * 로컬 오늘 날짜를 "YYYY-MM-DD" 로 반환한다(모달 입력 max·검증용).
   * @returns {string} 오늘 날짜.
   */
  _todayYMD() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /**
   * 폴링 갱신 시 HUD 를 다시 그린다. meta.days/forests 를 직접 사용한다.
   *   - 하단: 오늘자(가장 최근 날) day.usage 5메트릭.
   *   - 우상단: 이번달 활성 수 + 월 누적 5메트릭(forests[ym].monthly, 없으면 days 합산 폴백).
   *   - 5h/7d: top-level utilization(null 가드).
   * @param {Object} renderer 오프라인/빈 상태 판정을 읽을 렌더러.
   * @param {Object} meta state.onUpdate 가 넘기는 meta(days·forests·표시값 포함).
   */
  updateHud(renderer, meta) {
    const set = (el, txt) => { if (el) el.textContent = txt; };
    const daysObj = meta && meta.days && typeof meta.days === "object" ? meta.days : {};
    const days = Object.values(daysObj);
    const forests = meta && meta.forests ? meta.forests : {};

    // --- 오늘자(가장 최근 날) 5메트릭(하단). usage 5필드. ---
    let today = null;
    for (const d of days) if (d && d.date && (!today || d.date > today.date)) today = d;
    const u = (today && today.usage) || {};
    const tk = (k) => u[k] || 0;
    set(this.el.bInput, abbr(tk("inputTokens")));
    set(this.el.bOutput, abbr(tk("outputTokens")));
    set(this.el.bCwrite, abbr(tk("cacheWriteTokens")));
    set(this.el.bCread, abbr(tk("cacheReadTokens")));
    set(this.el.bReq, abbr(tk("requestCount")));

    // --- 이번달: forests[ym].monthly 직접 사용. 없으면 days 에서 폴백 계산. ---
    const refDate = today ? today.date : (days.length ? days.map((d) => d.date).sort().pop() : null);
    const month = refDate ? refDate.slice(0, 7) : null; // "YYYY-MM"
    let m = month && forests[month] && forests[month].monthly ? forests[month].monthly : null;
    if (!m && month) {
      // 폴백: 그 달 days 합산(서버가 forests 안 줄 때 견고).
      m = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requestCount: 0, activeDays: 0 };
      for (const d of days) {
        if (!d.date || d.date.slice(0, 7) !== month) continue;
        const du = d.usage || {};
        m.inputTokens += du.inputTokens || 0;
        m.outputTokens += du.outputTokens || 0;
        m.cacheWriteTokens += du.cacheWriteTokens || 0;
        m.cacheReadTokens += du.cacheReadTokens || 0;
        m.requestCount += du.requestCount || 0;
        if (d.active) m.activeDays++;
      }
    }
    m = m || { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requestCount: 0, activeDays: 0 };
    const daysInMonth = month ? new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate() : 0;
    set(this.el.mCount, month ? `${m.activeDays || 0}/${daysInMonth}` : "—");
    set(this.el.tInput, abbr(m.inputTokens));
    set(this.el.tOutput, abbr(m.outputTokens));
    set(this.el.tCwrite, abbr(m.cacheWriteTokens));
    set(this.el.tCread, abbr(m.cacheReadTokens));
    set(this.el.tReq, abbr(m.requestCount));

    // --- 5h / 7d utilization (top-level, null 가드) ---
    const fh = meta ? meta.fiveHourPct : null;
    const sd = meta ? meta.sevenDayPct : null;
    set(this.el.fiveHour, fh == null ? "5h: —" : "5h: " + Math.round(fh) + "%");
    set(this.el.sevenDay, sd == null ? "7d: —" : "7d: " + Math.round(sd) + "%");

    this.el.offline.style.display = renderer.isOffline() ? "block" : "none";
    this.el.emptyNote.style.display = renderer.isEmpty() ? "block" : "none";
  }

  /**
   * 호버 툴팁 갱신(매 mousemove). 단계 라벨 + 경험치 바 포함.
   * @param {Object} renderer 호버·선택 상태를 읽을 렌더러.
   * @param {number} clientX 커서 client X(툴팁 위치).
   * @param {number} clientY 커서 client Y.
   * @param {string|null} fYm 묶인 달 ym(있으면 숲 요약 툴팁).
   */
  updateTooltip(renderer, clientX, clientY, fYm) {
    const tip = this.el.tooltip;
    if (renderer.getSelected()) {
      tip.style.display = "none";
      return;
    }
    let html;
    if (fYm) {
      // 묶인 달 숲 요약(monthly 직접 사용).
      const f = renderer.forestInfo(fYm);
      if (!f) { tip.style.display = "none"; return; }
      html =
        `<div class="title">${f.month} · 숲 (펼치려면 클릭)</div>` +
        f.rows.map(([k, v]) => `${k}: ${v}`).join("<br>");
    } else {
      const hover = renderer.getHover();
      if (!hover) { tip.style.display = "none"; return; }
      const info = hover.info;
      if (info.empty) {
        html = `<div class="title">${info.date || ""}</div>빈 대지(데이터 없음)`;
      } else {
        const stage = stageLabel(info.stage);
        html =
          `<div class="title">${info.date} · ${stage}</div>` +
          xpBar(info.stageProgress) +
          info.rows.map(([k, v]) => `${k}: ${v}`).join("<br>");
      }
    }
    tip.innerHTML = html;
    tip.style.display = "block";
    // 커서 우하단. 화면 밖이면 반대쪽으로.
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = clientX + pad, y = clientY + pad;
    if (x + r.width > window.innerWidth) x = clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 4;
    tip.style.left = Math.max(4, x) + "px";
    tip.style.top = Math.max(4, y) + "px";
  }

  hideTooltip() {
    this.el.tooltip.style.display = "none";
  }

  /**
   * 클릭 상세 패널 갱신. 날짜+요일·단계 한글·수종·경험치 바·다음 단계·5메트릭 실측값+비중.
   * 데이터는 renderer.getSelected() 가 주는 cell.params 파생값(species·linPct·rows).
   * @param {Object} renderer 선택 셀 정보를 읽을 렌더러.
   */
  updateDetail(renderer) {
    const d = this.el.detail;
    const info = renderer.getSelected();
    if (!info) {
      d.style.display = "none";
      return;
    }
    const wd = weekdayKR(info.date);
    let body;
    if (info.empty) {
      // 빈 대지: 날짜+요일만(데이터 없음).
      body =
        `<div class="title">${info.date || ""}</div>` +
        (wd ? `<div class="subtitle">${wd}</div>` : "") +
        `<div class="drow"><span>빈 대지(데이터 없음)</span></div>`;
    } else {
      const stage = STAGE_NAMES[info.stage] || "";
      const stageFull = stageLabel(info.stage);
      const species = SPECIES_NAMES[info.species] != null ? SPECIES_NAMES[info.species] : "";
      const next = NEXT_NAME[info.stage];
      // 다음 단계까지: 묘목/유목은 (1 - 진행)% 남음, 성목은 max 안내.
      const nextLine = next
        ? `<div class="drow"><span class="k">다음 단계 (${next})</span><span class="v">${Math.round((1 - info.stageProgress) * 100)}% 남음</span></div>`
        : info.stageProgress >= 0.999
        ? `<div class="drow"><span class="k">성목</span><span class="v">MAX 달성</span></div>`
        : `<div class="drow"><span class="k">성목</span><span class="v">최고 단계</span></div>`;
      // 부제 = 요일 · 수종.
      const subParts = [wd, species].filter(Boolean);
      // 5메트릭 실측값(rows) + 선형 비중(linPct = 역대 최대 대비). rows 순서 동일.
      //   norms(logNorm)는 나무 렌더용 — 상세 % 는 직관적 선형 linPct 를 쓴다.
      const lp = info.linPct || {};
      const pctMap = {
        Requests: lp.requestN, "Input Tokens": lp.inputN, "Output Tokens": lp.outputN,
        "Cache Creation": lp.cacheWriteN, "Cache Read": lp.cacheReadN,
      };
      const metricRows = info.rows
        .map(([k, v]) => {
          const nv = pctMap[k];
          const nrm = Number.isFinite(nv) ? `<span class="nrm">(${Math.round(nv * 100)}%)</span>` : "";
          return `<div class="drow"><span class="k">${k}</span><span class="v">${v}${nrm}</span></div>`;
        })
        .join("");
      body =
        `<div class="title">${info.date} · ${stageFull}</div>` +
        (subParts.length ? `<div class="subtitle">${subParts.join(" · ")}</div>` : "") +
        `<div class="xplabel">경험치 (${stage} 진행)</div>` +
        xpBar(info.stageProgress) +
        nextLine +
        `<div class="section">사용량 — 실측값 · 역대 최대 대비 %</div>` +
        metricRows +
        `<div class="pct-note">% 는 관측된 역대 최대 사용량 대비 비율 (최대치는 사용할수록 갱신됨)</div>`;
    }
    // 모달 상단: 선택 칸 확대 프리뷰(있으면). 그 아래 기존 상세.
    const previewUrl = renderer.selectedCellPreview ? renderer.selectedCellPreview(128) : null;
    const preview = previewUrl ? `<div class="detail-preview"><img src="${previewUrl}" alt=""></div>` : "";
    d.innerHTML = preview + body + `<div class="hint">클릭 / ESC 로 닫기</div>`;
    d.style.display = "block";
  }

  /**
   * 상세 모달 열림 판정(ESC 우선순위용).
   * @returns {boolean} display:block 일 때만 true.
   */
  isDetailOpen() {
    return !!this.el.detail && this.el.detail.style.display === "block";
  }

  // ===================== 중앙 서버 업로드 상태 =====================
  /**
   * GET /api/upload-status 응답으로 하단 HUD 한 줄 갱신.
   *   - enabled=false(UPLOAD_USER_EMAIL 미설정): "업로드 꺼짐" 옅게 + 버튼 비활성.
   *   - enabled=true: lastUploadTime 상대시간 + 즉시 전송 버튼. lastError 있으면 빨갛게.
   * status 는 보관해 refreshUploadWhen 1분 타이머가 상대시간만 재계산한다.
   * @param {Object|null} status 업로드 상태 응답(null=모름→버튼 비활성).
   */
  updateUploadStatus(status) {
    this._uploadStatus = status || null;
    const row = this.el.uploadRow, when = this.el.upWhen, btn = this.el.uploadNowBtn;
    if (!row || !when) return;
    if (!status) {
      // 상태 폴 실패 등: 영역 유지하되 모름 표시(버튼 비활성).
      row.className = "up-off";
      when.textContent = "—";
      if (btn) btn.disabled = true;
      return;
    }
    if (!status.enabled) {
      row.className = "up-off";
      when.textContent = "업로드 꺼짐";
      if (btn) { btn.disabled = true; btn.title = "UPLOAD_USER_EMAIL 미설정 — 업로드 비활성"; }
      return;
    }
    // 활성: 상대시간 + (에러 시) 빨강. 버튼은 전송 중이 아니면 활성.
    row.className = status.lastError ? "up-err" : "";
    when.textContent = status.lastError ? "전송 실패" : relativeTime(status.lastUploadTime);
    if (btn && !btn.dataset.busy) {
      btn.disabled = false;
      btn.title = status.lastError ? `최근 오류: ${status.lastError}` : "지금 중앙 서버로 전송";
    }
  }

  // 1분 타이머용: 보관된 status 의 상대시간만 다시 그린다(폴 없이 "N분 전" 흐르게).
  refreshUploadWhen() {
    const s = this._uploadStatus, when = this.el.upWhen;
    if (!s || !s.enabled || s.lastError || !when) return;
    when.textContent = relativeTime(s.lastUploadTime);
  }

  /**
   * 즉시 전송 버튼 배선(1회).
   * @param {Function} cb 클릭 시 호출(async). 연타 방지는 setUploadBusy.
   */
  onUploadNow(cb) {
    if (this.el.uploadNowBtn)
      this.el.uploadNowBtn.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
  }
  /**
   * 전송 중 버튼 비활성(연타 방지).
   * @param {boolean} busy true 면 disabled + "전송 중…", false 면 복구.
   */
  setUploadBusy(busy) {
    const btn = this.el.uploadNowBtn;
    if (!btn) return;
    if (busy) { btn.dataset.busy = "1"; btn.disabled = true; btn.textContent = "전송 중…"; }
    else { delete btn.dataset.busy; btn.disabled = false; btn.textContent = "지금 전송"; }
  }

  // ===================== 업로드 설정 모달 =====================
  /**
   * 톱니 클릭 배선(1회).
   * @param {Function} cb 모달 열기 콜백(main 이 GET /api/upload-config 로 채움).
   */
  onUploadCfgOpen(cb) {
    if (this.el.uploadCfgBtn)
      this.el.uploadCfgBtn.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
  }
  /**
   * 설정값으로 입력 필드 채우고 모달 표시. 첫 실행(이메일 빔)이면 안내 한 줄.
   * @param {Object} config {serverUrl,userEmail,interval,enabled}.
   */
  showUploadConfigModal(config) {
    const m = this.el.cfgModal;
    if (!m) return;
    const c = config || {};
    if (this.el.cfgUrl) this.el.cfgUrl.value = c.serverUrl || "";
    if (this.el.cfgEmail) this.el.cfgEmail.value = c.userEmail || "";
    if (this.el.cfgInterval) this.el.cfgInterval.value = Number.isFinite(c.interval) ? c.interval : 600;
    if (this.el.cfgEnabled) this.el.cfgEnabled.checked = !!c.enabled;
    if (this.el.cfgError) this.el.cfgError.style.display = "none";
    if (this.el.cfgHint)
      this.el.cfgHint.textContent = c.userEmail
        ? "중앙 서버 전송 설정 (.env 없이 여기서 설정)."
        : "처음이라면 이메일을 입력하고 자동 전송을 켜세요.";
    m.style.display = "flex";
  }
  hideUploadConfigModal() {
    if (this.el.cfgModal) this.el.cfgModal.style.display = "none";
  }
  isUploadConfigOpen() {
    return !!this.el.cfgModal && this.el.cfgModal.style.display === "flex";
  }
  /**
   * 설정 입력값을 검증한다. 자동 전송 켜짐인데 이메일 비면 거부.
   * 이메일 형식은 값이 있을 때만 가볍게 검증(빈 값 허용=꺼짐).
   * @returns {Object|null} 통과 시 {serverUrl,userEmail,interval,enabled}, 실패 시 null(+에러 표시).
   */
  _readUploadConfig() {
    const err = (msg) => {
      if (this.el.cfgError) { this.el.cfgError.textContent = msg; this.el.cfgError.style.display = "block"; }
      return null;
    };
    const serverUrl = (this.el.cfgUrl ? this.el.cfgUrl.value : "").trim();
    const userEmail = (this.el.cfgEmail ? this.el.cfgEmail.value : "").trim();
    const interval = Math.max(10, Number(this.el.cfgInterval ? this.el.cfgInterval.value : 600) || 600);
    const enabled = !!(this.el.cfgEnabled && this.el.cfgEnabled.checked);
    // 이메일 가벼운 검증(있을 때만). 아주 단순한 형식만(로컬@도메인.tld).
    if (userEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail))
      return err("이메일 형식이 올바르지 않습니다.");
    if (enabled && !userEmail) return err("자동 전송을 켜려면 이메일이 필요합니다.");
    return { serverUrl, userEmail, interval, enabled };
  }
  /**
   * 저장/취소 버튼 배선(1회).
   * @param {Function} saveCb 검증 통과한 config 로 호출.
   * @param {Function} cancelCb 취소 시 호출.
   */
  onUploadCfgSave(saveCb, cancelCb) {
    if (this.el.cfgSave)
      this.el.cfgSave.addEventListener("click", (e) => {
        e.stopPropagation();
        const cfg = this._readUploadConfig();
        if (cfg) saveCb(cfg);
      });
    if (this.el.cfgCancel)
      this.el.cfgCancel.addEventListener("click", (e) => { e.stopPropagation(); cancelCb(); });
  }
  // 저장 에러(서버 거부 등) 표시.
  showUploadCfgError(msg) {
    if (this.el.cfgError) { this.el.cfgError.textContent = msg; this.el.cfgError.style.display = "block"; }
  }

  // ===================== 활성화 UI =====================
  /**
   * 심을 자리 안내 표시(pending 일 때만).
   * @param {boolean} show 표시 여부.
   * @param {boolean} [coldStart] 콜드 스타트면 첫 그리드 자유 선택 문구로.
   */
  showPlantPrompt(show, coldStart = false) {
    const el = this.el.plantPrompt;
    if (!el) return;
    if (show) {
      el.textContent = coldStart
        ? "🌱 첫 나무 심을 자리를 자유롭게 고르세요"
        : "🌱 나무 심을 자리를 고르세요";
    }
    el.style.display = show ? "block" : "none";
  }
  /**
   * 심기 확인 팝업을 커서 근처에 표시(화면 밖이면 반대쪽으로).
   * @param {number} clientX 커서 client X.
   * @param {number} clientY 커서 client Y.
   */
  showConfirm(clientX, clientY) {
    const c = this.el.confirmBox;
    if (!c) return;
    c.style.display = "block";
    const r = c.getBoundingClientRect();
    let x = clientX + 12, y = clientY + 12;
    if (x + r.width > window.innerWidth) x = clientX - r.width - 12;
    if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 6;
    c.style.left = Math.max(6, x) + "px";
    c.style.top = Math.max(6, y) + "px";
  }
  hideConfirm() {
    if (this.el.confirmBox) this.el.confirmBox.style.display = "none";
  }
  isConfirmOpen() {
    return !!this.el.confirmBox && this.el.confirmBox.style.display === "block";
  }
  /**
   * 확인/취소 버튼 콜백 배선(1회).
   * @param {Function} yesCb 확인 시 호출.
   * @param {Function} noCb 취소 시 호출.
   */
  onConfirm(yesCb, noCb) {
    if (this.el.confirmYes) this.el.confirmYes.addEventListener("mousedown", (e) => { e.stopPropagation(); yesCb(); });
    if (this.el.confirmNo) this.el.confirmNo.addEventListener("mousedown", (e) => { e.stopPropagation(); noCb(); });
  }

  // ===================== 자동 심기 토글 =====================
  // 자동 심기 = 미배치 날짜를 사용자 개입 없이 마지막 활성 그리드 옆에 자동 배치(클라 영속).
  //   ON 이면 수동 UI(호버 프리뷰·확인 팝업)는 뜨지 않는다(자동이 자리잡으므로 충돌 방지).
  //   영속은 localStorage 만(서버 무관). 기본 true(방치해도 숲이 자람).

  /** 두 자동 심기 체크박스(HUD + 시작일 모달)를 같은 값으로 맞춘다(상태 공유 동기화). */
  _setAutoPlantChecks(on) {
    if (this.el.autoPlant) this.el.autoPlant.checked = on;
    if (this.el.startAutoPlant) this.el.startAutoPlant.checked = on;
  }
  /**
   * 자동 심기 상태를 코드에서 설정한다(영속 + 두 체크박스 동기화). "자동 끄기" 버튼처럼
   *   UI change 이벤트 없이 끌 때 쓴다. main 의 autoPlant 변수는 호출자가 별도로 맞춘다.
   * @param {boolean} on 새 상태.
   */
  setAutoPlant(on) {
    this._setAutoPlantChecks(on);
    try { localStorage.setItem("forest.autoPlant", on ? "1" : "0"); } catch (err) { /* 무시 */ }
  }
  /**
   * localStorage 에서 자동 심기 상태를 읽는다(기본 true). 두 체크박스 초기값도 맞춘다.
   * @returns {boolean} 자동 심기 ON 여부.
   */
  getAutoPlant() {
    let on = true; // 기본 ON
    try {
      const v = localStorage.getItem("forest.autoPlant");
      if (v === "0") on = false;
    } catch (e) { /* localStorage 불가(시크릿 등): 기본 ON */ }
    this._setAutoPlantChecks(on);
    return on;
  }
  /**
   * "심는 중" 입력 차단 오버레이 + 인디케이터 토글. 자동 점진 연출·수동 activate 왕복 공통.
   *   ON 이면 전체를 덮어 줌/팬/클릭을 흡수(오버레이 pointer-events) + 배지 표시.
   * @param {boolean} on 심는 중이면 true.
   * @param {boolean} [showStop=true] "자동 끄기" 버튼 표시. 수동 심기(자동 이미 OFF)면 false 로 숨김.
   */
  setPlanting(on, showStop = true) {
    if (this.el.plantingOverlay) this.el.plantingOverlay.style.display = on ? "block" : "none";
    if (this.el.plantingIndicator) this.el.plantingIndicator.style.display = on ? "flex" : "none";
    // "자동 끄기" 버튼: 자동 심기(showStop=true)일 때만. 수동 심기 땐 "심는 중…"만 두고 버튼 숨김.
    if (this.el.plantingStop) this.el.plantingStop.style.display = (on && showStop) ? "" : "none";
  }
  /** 심는 중(입력 차단) 여부. main keydown 가드용. */
  isPlanting() {
    return !!this.el.plantingOverlay && this.el.plantingOverlay.style.display === "block";
  }
  /**
   * 심는 중 "자동 끄기" 버튼 배선(1회). 점진 연출 중에도 클릭 가능(인디케이터 z-index>오버레이).
   * @param {Function} cb 클릭 시 호출(main 이 autoPlant OFF + 루프 중단).
   */
  onPlantingStop(cb) {
    const btn = this.el.plantingStop;
    if (btn) btn.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
  }

  /**
   * 자동 심기 토글 변경 배선(1회). HUD·시작일 모달 두 체크박스 모두에 건다 — 어느 쪽이 바뀌든
   *   둘 다 동기화(상태 공유) + localStorage 영속 + 콜백 1회.
   * @param {Function} cb 새 on/off 값(boolean)으로 호출.
   */
  onAutoPlantToggle(cb) {
    const handler = (srcEl) => (e) => {
      e.stopPropagation();
      const on = !!srcEl.checked;
      this._setAutoPlantChecks(on); // 다른 쪽 체크박스도 같은 값으로
      try { localStorage.setItem("forest.autoPlant", on ? "1" : "0"); } catch (err) { /* 무시 */ }
      cb(on);
    };
    if (this.el.autoPlant) this.el.autoPlant.addEventListener("change", handler(this.el.autoPlant));
    if (this.el.startAutoPlant) this.el.startAutoPlant.addEventListener("change", handler(this.el.startAutoPlant));
  }

  // ===================== 시작일 모달 =====================
  /**
   * 시작일 모달 표시/숨김. startDate=null(미정) 일 때 표시한다.
   * @param {boolean} show 표시 여부. true 면 날짜 입력 max=오늘(미래 차단).
   */
  showStartModal(show) {
    const m = this.el.startModal;
    if (!m) return;
    if (show) {
      // 이미 열려 있으면(display=flex) input·display 를 다시 건드리지 않는다.
      // (5초 폴링마다 showStartModal(true) 가 불려 max 재설정·display 재적용으로
      //  date input 의 입력 중 값이 리셋되던 버그 방지)
      // 첫 호출 시 인라인 display 는 ""(CSS none)이므로 "flex" 비교라야 정상 표시.
      if (m.style.display === "flex") return;
      // 미래 입력 차단: date input max=오늘.
      if (this.el.startInput) this.el.startInput.max = this._todayYMD();
      if (this.el.startError) this.el.startError.style.display = "none";
      m.style.display = "flex";
    } else {
      m.style.display = "none";
    }
  }
  hideStartModal() { this.showStartModal(false); }
  isStartModalOpen() {
    return !!this.el.startModal && this.el.startModal.style.display === "flex";
  }
  /**
   * 시작일 입력 검증: "YYYY-MM-DD" 형식 + 과거~오늘 + 실재 날짜.
   * @param {string} v 입력값.
   * @returns {string|null} 유효하면 그 값, 아니면 null(+에러 표시).
   */
  _validateStart(v) {
    const err = (msg) => {
      if (this.el.startError) { this.el.startError.textContent = msg; this.el.startError.style.display = "block"; }
      return null;
    };
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return err("날짜를 YYYY-MM-DD 형식으로 입력하세요.");
    const today = this._todayYMD();
    if (v > today) return err("미래 날짜는 선택할 수 없습니다.");
    // 실재 날짜인지(예: 2025-02-30 차단).
    const [y, mo, d] = v.split("-").map(Number);
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return err("존재하지 않는 날짜입니다.");
    return v;
  }
  /**
   * 시작일 확인 버튼·Enter 배선(1회).
   * @param {Function} cb 검증 통과한 "YYYY-MM-DD" 만 인자로 호출.
   */
  onStartConfirm(cb) {
    const submit = () => {
      const v = this._validateStart(this.el.startInput ? this.el.startInput.value : "");
      if (v) cb(v);
    };
    if (this.el.startConfirm) this.el.startConfirm.addEventListener("click", (e) => { e.stopPropagation(); submit(); });
    if (this.el.startInput) this.el.startInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
  }
}
