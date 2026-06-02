function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * BlinkController
 * State machine: OPEN → CLOSING → CLOSED → OPENING → OPEN
 *
 * - Intervals are pulled from a shuffled bag so timing feels natural.
 * - Occasionally triggers a double blink (8% chance) with 120ms spacing.
 */
export default class BlinkController {
  /**
   * @param {object} [options]
   * @param {number} [options.minInterval=2.0]
   * @param {number} [options.maxInterval=6.0]
   * @param {number} [options.closeSpeed=0.06] seconds to close
   * @param {number} [options.openSpeed=0.10] seconds to open
   */
  constructor(options = {}) {
    this.minInterval = options.minInterval ?? 2.0;
    this.maxInterval = options.maxInterval ?? 6.0;
    this.closeSpeed = options.closeSpeed ?? 0.06;
    this.openSpeed = options.openSpeed ?? 0.10;

    this._state = 'OPEN';
    this._blinkValue = 1.0;

    this._timeToNext = 0;
    this._closedHold = 0;

    this._bag = [];
    this._bagIdx = 0;

    this._doublePending = false;
    this._doubleDelay = 0;

    this._scheduleNext();
  }

  /**
   * @param {number} dt seconds
   * @returns {number} blinkValue (1=open, 0=closed)
   */
  update(dt) {
    const dts = Math.max(0, dt || 0);

    // If we’re open and a double-blink is pending, count down to it.
    if (this._state === 'OPEN' && this._doublePending) {
      this._doubleDelay -= dts;
      if (this._doubleDelay <= 0) {
        this._doublePending = false;
        this._doubleDelay = 0;
        this._state = 'CLOSING';
      }
    }

    if (this._state === 'OPEN') {
      this._timeToNext -= dts;
      if (this._timeToNext <= 0) {
        this._state = 'CLOSING';
      }
    }

    if (this._state === 'CLOSING') {
      const denom = Math.max(1e-4, this.closeSpeed);
      this._blinkValue = clamp01(this._blinkValue - dts / denom);
      if (this._blinkValue <= 0) {
        this._blinkValue = 0;
        this._state = 'CLOSED';
        this._closedHold = 0.04;
      }
    } else if (this._state === 'CLOSED') {
      this._closedHold -= dts;
      if (this._closedHold <= 0) {
        this._state = 'OPENING';
      }
    } else if (this._state === 'OPENING') {
      const denom = Math.max(1e-4, this.openSpeed);
      this._blinkValue = clamp01(this._blinkValue + dts / denom);
      if (this._blinkValue >= 1) {
        this._blinkValue = 1;
        this._state = 'OPEN';

        // Decide on double blink (8% chance), else schedule next normal blink.
        if (Math.random() < 0.08) {
          this._doublePending = true;
          this._doubleDelay = 0.12;
        } else {
          this._scheduleNext();
        }
      }
    }

    return this._blinkValue;
  }

  _refillBag() {
    const n = 10; // bag size: enough to avoid obvious repetition
    const min = Math.max(0.05, this.minInterval);
    const max = Math.max(min + 0.01, this.maxInterval);

    const bag = [];
    for (let i = 0; i < n; i++) {
      const t = min + Math.random() * (max - min);
      bag.push(t);
    }
    shuffleInPlace(bag);
    this._bag = bag;
    this._bagIdx = 0;
  }

  _nextInterval() {
    if (!this._bag.length || this._bagIdx >= this._bag.length) {
      this._refillBag();
    }
    return this._bag[this._bagIdx++];
  }

  _scheduleNext() {
    this._timeToNext = this._nextInterval();
  }
}

