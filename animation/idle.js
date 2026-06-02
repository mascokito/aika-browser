function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function randRange(a, b) {
  return a + Math.random() * (b - a);
}

/**
 * IdleController
 * 1) Slow sway (4–6s): ±3px X, ±2px Y
 * 2) Breathing (~3.5s): 0px X, ±1.5px Y + subtle scale (0.998–1.002)
 * 3) Micro-jitter: ±0.4px, updates at 12Hz (not every frame)
 */
export default class IdleController {
  constructor() {
    this._t = 0;

    this._swayPeriod = randRange(4.0, 6.0);
    this._swayPhaseX = Math.random() * Math.PI * 2;
    this._swayPhaseY = Math.random() * Math.PI * 2;

    this._breathePeriod = 3.5;
    this._breathePhase = Math.random() * Math.PI * 2;

    this._jitterTimer = 0;
    this._jitterHz = 12;
    this._jitter = { x: 0, y: 0 };
    this._jitterTarget = { x: 0, y: 0 };
  }

  /**
   * @param {number} dt seconds
   * @returns {{x:number,y:number,scale:number}}
   */
  update(dt) {
    const dts = Math.max(0, dt || 0);
    this._t += dts;

    // Slow sway
    const swayW = (Math.PI * 2) / this._swayPeriod;
    const swayX = Math.sin(this._t * swayW + this._swayPhaseX) * 3.0;
    const swayY = Math.cos(this._t * swayW + this._swayPhaseY) * 2.0;

    // Breathing (vertical + scale)
    const bw = (Math.PI * 2) / this._breathePeriod;
    const breathe = Math.sin(this._t * bw + this._breathePhase); // -1..1
    const breatheY = breathe * 1.5;
    const scale = 1.0 + breathe * 0.002; // 0.998..1.002

    // Micro-jitter at 12Hz with gentle smoothing
    this._jitterTimer += dts;
    const step = 1 / this._jitterHz;
    if (this._jitterTimer >= step) {
      this._jitterTimer -= step;
      this._jitterTarget.x = randRange(-0.4, 0.4);
      this._jitterTarget.y = randRange(-0.4, 0.4);
    }
    const follow = clamp(dts * 10, 0, 1);
    this._jitter.x = lerp(this._jitter.x, this._jitterTarget.x, follow);
    this._jitter.y = lerp(this._jitter.y, this._jitterTarget.y, follow);

    return {
      x: swayX + this._jitter.x,
      y: swayY + breatheY + this._jitter.y,
      scale,
    };
  }
}

