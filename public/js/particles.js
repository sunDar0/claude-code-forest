// 성목 주변 부유 금색 파티클.
//
// 성목(MATURE)만 주변에 금색 파티클이 간간히 부유한다: 반짝이며 천천히 위로 떠오르다 사라짐,
// 드문드문(앰비언트). 묘목·유목은 없음. 좌표는 화면(백버퍼) px(렌더러가 setSources 로 크라운 영역 전달).

export const MAX_PARTICLES = 40; // 전체 하드캡(앰비언트라 적게)

/**
 * 성목·숲 크라운 위로 떠오르는 앰비언트 금색 파티클 풀.
 */
export class AmbientParticles {
  constructor() {
    this.particles = [];
    // 성목 발생원. [{ id, cx, cy, r }] — 화면 px(크라운 중심·반경).
    this.sources = [];
    this._ids = new Set();
  }

  /**
   * 성목 크라운 발생원 목록 설정(매 setData).
   * @param {Array<{id,cx,cy,r,rx?,weight?}>} sources 크라운 중심·반경(화면 px)
   */
  setSources(sources) {
    this.sources = sources || [];
    this._ids = new Set(this.sources.map((s) => s.id));
    if (this.sources.length === 0) this.particles.length = 0;
    else this.particles = this.particles.filter((p) => this._ids.has(p.src));
  }

  // weight 가중 발생원 선택(숲 cacheRead 강도 ∝ weight). weight 없으면 1.
  _pickSource(rng) {
    let total = 0;
    for (const s of this.sources) total += s.weight || 1;
    let r = rng() * total;
    for (const s of this.sources) {
      r -= s.weight || 1;
      if (r <= 0) return s;
    }
    return this.sources[this.sources.length - 1];
  }

  _spawn(rng) {
    if (this.sources.length === 0) return;
    const s = this._pickSource(rng);
    // 크라운 영역 안 임의 지점에서 발생(약간 위쪽 편향). rx(가로 반경) 있으면 타원으로 넓게(숲).
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng());
    const rx = s.rx || s.r;
    this.particles.push({
      src: s.id,
      x: s.cx + Math.cos(a) * rr * rx * 0.9,
      y: s.cy + Math.sin(a) * rr * s.r * 0.8,
      vy: -(0.08 + rng() * 0.18), // 천천히 위로
      vx: (rng() - 0.5) * 0.12,
      life: 1, // 1 → 0 으로 페이드
      fade: 0.004 + rng() * 0.006, // 수명 소모 속도(느림 → 드문드문 오래)
      tw: rng() * Math.PI * 2, // 반짝임 위상
      twS: 0.1 + rng() * 0.12,
    });
  }

  // 한 프레임 갱신. 앰비언트라 Math.random.
  update(rng = Math.random) {
    if (this.sources.length === 0) {
      this.particles.length = 0;
      return;
    }
    // 드문드문 스폰: 성목당 소수 + 숲당 weight 가중. 매 프레임 확률적으로 1개씩만 추가.
    //   숲은 한 줌(수십 개)을 부유시키되 전체는 항상 40캡. weight 합으로 목표를 키운다.
    let wsum = 0;
    for (const s of this.sources) wsum += (s.weight || 1) * 5;
    const target = Math.min(MAX_PARTICLES, Math.ceil(wsum));
    if (this.particles.length < target && rng() < 0.35) this._spawn(rng);

    const next = [];
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.fade;
      p.tw += p.twS;
      if (p.life > 0) next.push(p);
    }
    this.particles = next.length > MAX_PARTICLES ? next.slice(0, MAX_PARTICLES) : next;
  }
}
