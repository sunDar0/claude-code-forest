/**
 * 카메라 상태·연산 분리 모듈. 줌(정수 배율)·팬·오버뷰·포커스 보간을 소유하고,
 * 콘텐츠/맵 범위·뷰포트·백버퍼 등 호스트(renderer) 소유분은 `this.host.` 로 역참조해 읽는다.
 *
 * 소유 상태: cam(x,y,zoom)·zoomMin·zoomMax·overview·_camAnim·_centered.
 * 호스트 소유분(역참조): _viewport·_activeBBox·_mapWorldBounds·_clampSym·_recompute·_lastActiveCell·
 *   worldOriginX/Y·worldHorizonY·bufW·bufH·_mapSnapshot·frame.
 *
 * 동작은 renderer 에서 잘라 옮긴 그대로(픽셀퍼펙트·팬 불변 유지). 골든 지문 시험이 매 프레임 검증한다.
 */

import { GRID } from "../grid.js";

// 카메라 월드 좌표 = 백버퍼 픽셀 공간. 그리드 1칸 = 3×3 타일(= GRID).
const CELL_SPAN = GRID;

export class Camera {
  /** @param {object} host renderer 인스턴스(범위·뷰포트·버퍼·_recompute 접근용) */
  constructor(host) {
    this.host = host;

    // 카메라: x,y = 월드(백버퍼) 픽셀 오프셋(보이는 영역 좌상단의 월드 좌표),
    //         zoom = 백버퍼→캔버스 정수 업스케일 배율.
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.zoomMin = 1; // 줌아웃 끝(활성 전체가 보임)
    this.zoomMax = 1; // 줌인 끝(한 칸이 꽉 참)
    this._centered = false; // 첫 데이터에서 활성 셀로 리센터했는지

    // 카메라 포커스 트랜지션 상태("마지막 활성 그리드 찾기" 버튼의 부드러운 팬+줌 보간).
    //   render() 가 _stepCamAnim 으로 매 프레임 진행. 픽셀퍼펙트 위해 줌은 정수 스텝, 위치는 ease-out.
    this._camAnim = null;

    // 오버뷰 모드: 정수 줌(zoom≥1) 하단에 추가된 "맵 전체 조망" 단계. zoom 은 1 유지하고 이 플래그로
    //   분리한다(분수 zoom 을 cam 에 넣으면 픽셀퍼펙트·커서 피벗이 흔들리므로).
    this.overview = false;
  }

  /** 줌 한계 갱신: [활성 전체 보임(줌아웃 끝)] ~ [한 칸 꽉 참(줌인 끝)]. */
  _updateZoomLimits() {
    const vp = this.host._viewport();
    // 줌인 끝: 백버퍼 ≈ CELL_SPAN 이 되는 정수 배율.
    const zMaxIn = Math.max(1, Math.floor(Math.min(vp.w, vp.h) / CELL_SPAN));
    // 줌아웃 끝: 백버퍼가 활성 bbox 를 담는 가장 작은 배율.
    const bb = this.host._activeBBox();
    const zMinOut = Math.max(1, Math.floor(Math.min(vp.w / bb.w, vp.h / bb.h)));
    this.zoomMax = zMaxIn;
    // 줌아웃 끝이 줌인 끝보다 크면(셀 적어 두 한계 겹침) 줌인 끝으로 고정.
    this.zoomMin = Math.min(zMinOut, zMaxIn);
    if (this.zoomMin > this.zoomMax) this.zoomMin = this.zoomMax;
  }

  /**
   * 휠 줌(커서 기준). 커서 아래 월드 지점이 줌 전후 화면 같은 자리에 오게 한다(재중심 안 함).
   * zoom=zoomMin 에서 추가 줌아웃하면 오버뷰(맵 전체) 진입, 오버뷰에서 줌인하면 zoomMin 으로 복귀.
   * @param {number} cx 캔버스 px x
   * @param {number} cy 캔버스 px y
   * @param {number} dir +1 줌인 / -1 줌아웃
   */
  zoomAt(cx, cy, dir) {
    if (this.overview) {
      if (dir < 0) return; // 오버뷰가 줌아웃 끝
      // 오버뷰 → zoomMin 정수 줌. 복귀 시 커서 아래 월드 지점을 커서 위치에 유지(피벗 일관).
      const snap = this.host._mapSnapshot;
      // 오버뷰 캔버스에서 맵은 하단 정렬(위는 하늘 밴드) — _renderOverview 가 mapTop=캔버스높이-snapH
      //   부터 스냅샷을 그린다. 그래서 커서 y → 스냅샷 y 역변환에 이 상단 오프셋(mapTop)을 빼야 한다.
      //   빠뜨리면 세로로 어긋나 엉뚱한(맵 하단 쪽) 지점이 피벗으로 잡힌다. 캔버스 높이는 _recompute 가
      //   바꾸기 전 오버뷰 값(= viewport 높이)으로 잡는다.
      const overviewH = Math.max(CELL_SPAN, this.host._viewport().h);
      this.overview = false;
      this.cam.zoom = this.zoomMin;
      this.host._recompute();
      if (snap) {
        const mapTop = overviewH - snap.snapH;
        const worldX = snap.offX + cx / snap.scale;
        const worldY = snap.offY + (cy - mapTop) / snap.scale;
        this.cam.x = worldX - cx / this.cam.zoom;
        this.cam.y = worldY - cy / this.cam.zoom;
      }
      this._clampPan();
      return;
    }
    const oldZoom = this.cam.zoom;
    // zoomMin 에서 추가 줌아웃 → 오버뷰 진입. 직전 완성 스냅샷이 있으면 유지(여기서 무효화 안 함).
    if (dir < 0 && oldZoom <= this.zoomMin) {
      this.overview = true;
      this.host._recompute();
      return;
    }
    const next = Math.max(this.zoomMin, Math.min(this.zoomMax, oldZoom + dir));
    if (next === oldZoom) return;
    // 줌 전 커서 아래 월드 좌표.
    const worldX = this.cam.x + cx / oldZoom;
    const worldY = this.cam.y + cy / oldZoom;
    this.cam.zoom = next;
    this.host._recompute();
    // 줌 후에도 같은 월드 좌표가 같은 캔버스 px(cx,cy)에 오도록 카메라 오프셋 재계산.
    this.cam.x = worldX - cx / next;
    this.cam.y = worldY - cy / next;
    this._clampPan();
  }

  /**
   * 드래그 팬. 월드 오프셋 = 이동량/zoom.
   * @param {number} dx 화면 px 이동량 x
   * @param {number} dy 화면 px 이동량 y
   */
  pan(dx, dy) {
    this.cam.x -= dx / this.cam.zoom;
    this.cam.y -= dy / this.cam.zoom;
    this._clampPan();
  }

  /**
   * 주어진 월드 좌표를 화면(뷰포트) 중앙에 두도록 카메라를 옮긴다. 미니맵 클릭/드래그 내비게이션용.
   * 팬과 같은 맵 경계 클램프를 적용한다. 줌은 건드리지 않는다.
   * @param {number} wx 월드 x
   * @param {number} wy 월드 y
   */
  centerOnWorld(wx, wy) {
    this.cam.x = wx - this.host.bufW / 2;
    this.cam.y = wy - this.host.bufH / 2;
    this._clampPan();
  }

  /**
   * 팬 클램프: 보이는 월드 범위가 맵 bbox 밖으로 못 나가게 묶는다(맵 기준 — 1그루여도 맵 안 자유 이동).
   * 정수 줌에서 맵(5400×2160)은 항상 뷰포트보다 크므로 [lo,hi] 역전 없이 정확 클램프.
   * 북쪽만 하늘(지평선 위 SKY_VIEW)까지 올라갈 수 있게 예외(남쪽은 맵 끝).
   */
  _clampPan() {
    const c = this.host._mapWorldBounds();
    // 가로: cam.x ∈ [x0, x1 - bufW]. (맵 폭 ≥ bufW 전제 — 정수 줌에서 성립.)
    const camXMin = c.x0;
    const camXMax = c.x1 - this.host.bufW;
    this.cam.x = this.host._clampSym(this.cam.x, camXMin, camXMax, (c.x0 + c.x1) / 2 - this.host.bufW / 2);
    // 세로: 아래 끝 = 맵 남단(cam.y + bufH ≤ y1). 위 끝 = 지평선 위 하늘 SKY_VIEW 까지 허용.
    const SKY_VIEW = GRID * 2; // 지평선 위로 보일 수 있는 하늘(확대)
    const camYMin = Math.min(this.host.worldHorizonY - SKY_VIEW, c.y0);
    const camYMax = c.y1 - this.host.bufH;
    this.cam.y = this.host._clampSym(this.cam.y, camYMin, camYMax, (c.y0 + c.y1) / 2 - this.host.bufH / 2);
  }

  /**
   * 첫 데이터 초기 카메라 = 마지막 활성 그리드를 화면 중앙에 둔다.
   * 중앙 계산 후 맵 경계로 클램프한다 — 가장자리 셀을 중앙에 두려다 카메라가 맵 밖으로 나가
   * 뷰포트 한쪽에 빈(검은) 띠가 생기는 것을 막는다. 맵은 뷰포트보다 항상 커서(정수 줌) 클램프가
   * 맵 안 정상 중심은 흩뜨리지 않고, 경계 밖 음수 오프셋만 맵 끝으로 묶는다.
   */
  _centerOnContent() {
    const cell = this.host._lastActiveCell();
    const wx = cell ? this.host.worldOriginX + cell.gx * GRID : this.host.worldOriginX;
    const wy = cell ? this.host.worldOriginY + cell.gy * GRID : this.host.worldOriginY;
    this.cam.x = Math.round(wx - this.host.bufW / 2);
    this.cam.y = Math.round(wy - this.host.bufH / 2);
    this._clampPan();
  }

  /** 마지막 활성 그리드가 있나(버튼 표시/비활성 판정). 콜드 스타트(활성 0)면 false. @returns {boolean} */
  hasLastActive() {
    return this.host._lastActiveCell() != null;
  }

  /** 마지막 활성 그리드 좌표. 후보 앵커·포커스·깃발의 단일 기준. @returns {{gx,gy}|null} */
  lastActiveGrid() {
    const c = this.host._lastActiveCell();
    return c ? { gx: c.gx, gy: c.gy } : null;
  }

  /**
   * "마지막 활성 그리드 찾기"(지도 앱 "내 위치"): 마지막 활성 셀을 화면 중앙으로 + 줌.
   * 부드러운 팬+줌 보간(ease-out)으로 이동(오버뷰면 해제 후 복귀). 게임 상태 불변 — 카메라만 움직인다.
   *   viewCells = 화면에 들어올 칸 폭(작을수록 타이트 줌인). 기본 3.5(§41 찾기 버튼: 타이트).
   *   자동 심기 추종은 8~12칸폭(거리 둔 줌 — 심는 칸 + 주변 맥락이 함께 보이게). 보간·클램프는 공통 재사용.
   * @param {number} [viewCells=3.5] 화면에 들어올 칸 폭(줌 거리)
   * @returns {boolean} 대상이 있어 보간을 시작했으면 true, 콜드 스타트면 false
   */
  focusLastActive(viewCells = 3.5) {
    const cell = this.host._lastActiveCell();
    if (!cell) return false; // 콜드 스타트 — 대상 없음
    // 목표 월드 중심 = 그 그리드 중심.
    const toWx = this.host.worldOriginX + cell.gx * GRID;
    const toWy = this.host.worldOriginY + cell.gy * GRID;
    // 목표 줌: 화면에 viewCells 칸 폭이 들어오는 배율. 작을수록 타이트(§41=3.5), 클수록 거리 둠(자동=10).
    //   zoomMin~zoomMax 안으로 클램프.
    const vp = this.host._viewport();
    let toZoom = Math.round(Math.min(vp.w, vp.h) / (viewCells * GRID));
    toZoom = Math.max(this.zoomMin, Math.min(this.zoomMax, toZoom));
    // 오버뷰면 즉시 해제(정수 줌 체계로 복귀) — 보간은 정수 줌 위에서.
    if (this.overview) {
      this.overview = false;
      this.cam.zoom = this.zoomMin;
      this.host._recompute();
      this._clampPan();
    }
    const startZoom = this.cam.zoom;
    const dur = 26; // ~0.4s @ 60fps. ease-out.
    const dz = Math.abs(toZoom - startZoom);
    this._camAnim = {
      toWx, toWy, toZoom, startZoom,
      // 시작 카메라 오프셋(보간 시작점). 위치는 월드 중심 기준이라 줌 바뀌어도 중심 일관.
      fromCx: this.cam.x + this.host.bufW / 2, // 현재 화면 중심 월드 x
      fromCy: this.cam.y + this.host.bufH / 2,
      frame0: this.host.frame,
      dur,
      // 줌 정수 스텝: dur 동안 dz 스텝을 균등 분배(픽셀퍼펙트 유지 — 항상 정수 줌).
      zoomStepEvery: dz > 0 ? Math.max(1, Math.floor(dur / dz)) : 0,
    };
    return true;
  }

  /** 카메라 포커스 보간 1프레임 진행(render() 첫머리). ease-out 위치 + 정수 줌 스텝(픽셀퍼펙트). */
  _stepCamAnim() {
    const a = this._camAnim;
    if (!a) return;
    const t0 = (this.host.frame - a.frame0) / a.dur;
    const t = Math.max(0, Math.min(1, t0));
    const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
    // 줌 정수 스텝: 진행도에 비례해 startZoom→toZoom 정수로 이동(중간도 정수).
    let zoom = a.startZoom;
    if (a.toZoom !== a.startZoom) {
      const dz = a.toZoom - a.startZoom;
      zoom = Math.round(a.startZoom + dz * ease);
      zoom = Math.max(this.zoomMin, Math.min(this.zoomMax, zoom));
    }
    if (zoom !== this.cam.zoom) {
      this.cam.zoom = zoom;
      this.host._recompute();
    }
    // 위치: 현재 화면 중심(월드)을 from→to 로 ease 보간 → 카메라 오프셋 = 중심 - 버퍼/2.
    const cwx = a.fromCx + (a.toWx - a.fromCx) * ease;
    const cwy = a.fromCy + (a.toWy - a.fromCy) * ease;
    this.cam.x = Math.round(cwx - this.host.bufW / 2);
    this.cam.y = Math.round(cwy - this.host.bufH / 2);
    this._clampPan();
    if (t0 >= 1) this._camAnim = null; // 완료
  }

  /** 오버뷰(맵 전체 조망) 모드인가. @returns {boolean} */
  isOverview() { return !!this.overview; }
}
