function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOut(t) {
  // smoothstep-ish
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function randRange(a, b) {
  return a + Math.random() * (b - a);
}

const EXPRESSIONS = {
  neutral: {
    browLift: 0,
    browAsym: 0,
    gazeX: 0,
    gazeY: 0,
    mouthTension: 0.15,
  },
  concerned: {
    browLift: -0.35,
    browAsym: 0.15,
    gazeX: 0.05,
    gazeY: -0.1,
    mouthTension: 0.35,
  },
  authoritative: {
    browLift: -0.15,
    browAsym: -0.05,
    gazeX: 0,
    gazeY: 0.05,
    mouthTension: 0.45,
  },
  slight_smile: {
    browLift: 0.15,
    browAsym: 0.1,
    gazeX: 0.05,
    gazeY: 0,
    mouthTension: 0.1,
  },
};

function copyParams(p) {
  return {
    browLift: p.browLift,
    browAsym: p.browAsym,
    gazeX: p.gazeX,
    gazeY: p.gazeY,
    mouthTension: p.mouthTension,
  };
}

function lerpParams(a, b, t) {
  return {
    browLift: lerp(a.browLift, b.browLift, t),
    browAsym: lerp(a.browAsym, b.browAsym, t),
    gazeX: lerp(a.gazeX, b.gazeX, t),
    gazeY: lerp(a.gazeY, b.gazeY, t),
    mouthTension: lerp(a.mouthTension, b.mouthTension, t),
  };
}

/**
 * ExpressionController
 * - setExpression(name, transitionSecs): smooth blend
 * - update(dt): returns interpolated params (+ micro-expression overlay)
 * - micro-expression: every 8–15s, flash subtle brow movement for 0.3s
 */
export default class ExpressionController {
  constructor() {
    this._current = copyParams(EXPRESSIONS.neutral);
    this._from = copyParams(this._current);
    this._to = copyParams(this._current);

    this._transitionT = 1;
    this._transitionDur = 0;

    this._microTimer = 0;
    this._microNext = randRange(8, 15);
    this._microActive = 0;
    this._microDur = 0.3;
    this._microOffset = { browLift: 0, browAsym: 0 };
  }

  /**
   * @param {'neutral'|'concerned'|'authoritative'|'slight_smile'} name
   * @param {number} transitionSecs
   */
  setExpression(name, transitionSecs = 0.5) {
    const def = EXPRESSIONS[name] ?? EXPRESSIONS.neutral;
    this._from = copyParams(this._current);
    this._to = copyParams(def);
    this._transitionT = 0;
    this._transitionDur = Math.max(0.0001, transitionSecs || 0.0001);
  }

  /**
   * @param {number} dt seconds
   * @returns {{browLift:number,browAsym:number,gazeX:number,gazeY:number,mouthTension:number}}
   */
  update(dt) {
    const dts = Math.max(0, dt || 0);

    // Base expression transition
    if (this._transitionT < 1) {
      this._transitionT = clamp(this._transitionT + dts / this._transitionDur, 0, 1);
      const t = easeInOut(this._transitionT);
      this._current = lerpParams(this._from, this._to, t);
    }

    // Micro-expression scheduling
    this._microTimer += dts;
    if (this._microActive <= 0 && this._microTimer >= this._microNext) {
      this._microTimer = 0;
      this._microNext = randRange(8, 15);
      this._microActive = this._microDur;

      // Subtle brow-only offsets
      this._microOffset.browLift = randRange(-0.18, 0.18);
      this._microOffset.browAsym = randRange(-0.22, 0.22);
    }

    let out = this._current;

    // Apply micro-expression overlay with a short envelope
    if (this._microActive > 0) {
      this._microActive = Math.max(0, this._microActive - dts);
      const t = 1 - this._microActive / this._microDur; // 0..1
      const env = Math.sin(t * Math.PI); // 0..1..0
      out = {
        ...out,
        browLift: clamp(out.browLift + this._microOffset.browLift * env, -1, 1),
        browAsym: clamp(out.browAsym + this._microOffset.browAsym * env, -1, 1),
      };
    }

    return out;
  }
}

