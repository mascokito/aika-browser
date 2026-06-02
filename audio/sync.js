import { bandsToViseme, smoothViseme } from './phoneme.js';

/**
 * Phase 2: audio → viseme sync with a simple hold time.
 *
 * Hold time is used to avoid switching too rapidly (jitter).
 * Requirement: don't switch faster than every 3 frames at 30fps (~100ms).
 */
export default class AudioSync {
  /**
   * @param {import('./analyzer.js').AudioAnalyzer} analyzer
   * @param {object} [options]
   * @param {number} [options.holdMs=100]
   */
  constructor(analyzer, options = {}) {
    if (!analyzer) throw new Error('AudioSync requires an AudioAnalyzer instance');
    this.analyzer = analyzer;
    this.holdMs = options.holdMs ?? 100;

    this._current = 0;
    this._lastSwitchAt = 0; // performance.now() ms
  }

  get isActive() {
    return !!this.analyzer?.isActive;
  }

  getAmplitude() {
    return this.analyzer.getAmplitude();
  }

  /**
   * Compute current viseme based on analyzer FFT + amplitude,
   * with a minimum hold time between switches.
   * @returns {number}
   */
  getCurrentViseme() {
    const bands = this.analyzer.getBands();
    const amplitude = this.analyzer.getAmplitude();
    const target = bandsToViseme({ ...bands, amplitude });

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const since = now - this._lastSwitchAt;
    const canSwitch = since >= this.holdMs;

    if (target === this._current) return this._current;
    if (!canSwitch) return this._current;

    // When hold time is satisfied, switch immediately.
    // Blend acts as the "gate"; with 1 it always returns target.
    this._current = smoothViseme(this._current, target, 1);
    this._lastSwitchAt = now;
    return this._current;
  }
}

