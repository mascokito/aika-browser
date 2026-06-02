/**
 * Web Audio FFT analyzer used by victoria-engine.
 *
 * Works in:
 * - Browser (File from <input type="file">)
 * - Puppeteer/headless Chromium (file:// URL string passed into the page)
 *
 * Notes:
 * - AudioBufferSourceNode is one-shot; this implementation focuses on play-once.
 * - Autoplay policy is handled by wiring a "first user gesture" resume.
 */
export class AudioAnalyzer {
  /**
   * @param {object} [options]
   * @param {number} [options.fftSize=256]
   * @param {(info?: any) => void} [options.onEnded]
   * @param {number} [options.smoothingTimeConstant=0.85]
   * @param {number} [options.minDecibels=-90]
   * @param {number} [options.maxDecibels=-10]
   * @param {AudioContext} [options.audioContext] Provide your own context (optional)
   */
  constructor(options = {}) {
    this.fftSize = options.fftSize ?? 256;
    this.onEnded = typeof options.onEnded === 'function' ? options.onEnded : null;
    this.smoothingTimeConstant = options.smoothingTimeConstant ?? 0.85;
    this.minDecibels = options.minDecibels ?? -90;
    this.maxDecibels = options.maxDecibels ?? -10;
    this._externalContext = options.audioContext ?? null;

    this.audioContext = null;
    this.analyser = null;
    this._gain = null;

    this._freqData = null;
    this._timeData = null;

    this._buffer = null;
    this._source = null;
    this._startAtCtxTime = null;
    this._ended = false;
    this._unlockWired = false;
    this._unlockHandler = null;
  }

  /** True while audio is playing (best-effort). */
  get isActive() {
    if (!this.audioContext || !this._source || this._ended) return false;
    const t = this.currentTime;
    return Number.isFinite(t) && t >= 0 && t < this.duration;
  }

  /** Duration in seconds (0 if not loaded). */
  get duration() {
    return this._buffer?.duration ?? 0;
  }

  /** Current playback time in seconds (0 if not started). */
  get currentTime() {
    if (!this.audioContext || this._startAtCtxTime == null) return 0;
    const t = this.audioContext.currentTime - this._startAtCtxTime;
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Math.min(this.duration || Infinity, t));
  }

  /**
   * Load and start playback.
   * @param {File|string} input File object OR URL string (including file://)
   * @param {object} [options]
   * @param {boolean} [options.autoplay=true] Attempt to start immediately
   * @param {number} [options.volume=1.0]
   */
  async play(input, options = {}) {
    const autoplay = options.autoplay ?? true;
    const volume = options.volume ?? 1.0;

    await this._ensureAudioGraph();
    await this._loadBuffer(input);

    // Reset any prior playback
    this.stop();
    this._ended = false;

    this._gain.gain.value = volume;

    // Try to satisfy autoplay policy; if suspended, we’ll resume on gesture.
    if (autoplay) await this.resume().catch(() => {});
    this._wireAutoplayUnlock();

    this._source = this.audioContext.createBufferSource();
    this._source.buffer = this._buffer;
    this._source.onended = () => {
      // onended fires for stop() too; differentiate best-effort by time.
      this._ended = true;
      this._source = null;
      this._startAtCtxTime = null;
      if (this.onEnded) {
        try {
          this.onEnded();
        } catch {
          // swallow
        }
      }
    };

    // Connect: source -> analyser -> gain -> destination
    this._source.connect(this.analyser);
    this.analyser.connect(this._gain);
    this._gain.connect(this.audioContext.destination);

    this._startAtCtxTime = this.audioContext.currentTime;
    this._source.start(0);
  }

  /**
   * Stop playback immediately (safe if not playing).
   */
  stop() {
    if (this._source) {
      try {
        this._source.onended = null;
        this._source.stop(0);
      } catch {
        // ignore
      }
      try {
        this._source.disconnect();
      } catch {
        // ignore
      }
    }
    this._source = null;
    this._startAtCtxTime = null;
    this._ended = true;
  }

  /**
   * Resume AudioContext if suspended (required by autoplay policy).
   */
  async resume() {
    await this._ensureAudioGraph();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  /**
   * Get raw FFT bins (0..255).
   * @returns {Uint8Array}
   */
  getFrequencyData() {
    if (!this.analyser) return new Uint8Array(0);
    if (!this._freqData || this._freqData.length !== this.analyser.frequencyBinCount) {
      this._freqData = new Uint8Array(this.analyser.frequencyBinCount);
    }
    this.analyser.getByteFrequencyData(this._freqData);
    return this._freqData;
  }

  /**
   * Returns low/mid/high band energy, normalized 0..1.
   * - low:  bins 0–3
   * - mid:  bins 4–11
   * - high: bins 12–23
   */
  getBands() {
    const bins = this.getFrequencyData();
    const to01 = (v) => Math.max(0, Math.min(1, v));
    const avg = (from, to) => {
      if (!bins.length) return 0;
      const start = Math.max(0, from);
      const end = Math.min(bins.length - 1, to);
      if (end < start) return 0;
      let sum = 0;
      let n = 0;
      for (let i = start; i <= end; i++) {
        sum += bins[i];
        n++;
      }
      return n ? sum / (n * 255) : 0;
    };

    return {
      low: to01(avg(0, 3)),
      mid: to01(avg(4, 11)),
      high: to01(avg(12, 23)),
    };
  }

  /**
   * Overall RMS loudness from time-domain samples, normalized 0..1.
   * @returns {number}
   */
  getAmplitude() {
    if (!this.analyser) return 0;
    if (!this._timeData || this._timeData.length !== this.analyser.fftSize) {
      this._timeData = new Uint8Array(this.analyser.fftSize);
    }
    this.analyser.getByteTimeDomainData(this._timeData);

    // Convert 0..255 to -1..1 then RMS.
    let sumSq = 0;
    for (let i = 0; i < this._timeData.length; i++) {
      const x = (this._timeData[i] - 128) / 128;
      sumSq += x * x;
    }
    const rms = Math.sqrt(sumSq / (this._timeData.length || 1));
    return Math.max(0, Math.min(1, rms));
  }

  /**
   * Free resources (does not close externally provided AudioContext).
   */
  async dispose() {
    this.stop();
    this._unwireAutoplayUnlock();
    this._buffer = null;
    this._freqData = null;
    this._timeData = null;

    if (this.audioContext && !this._externalContext) {
      try {
        await this.audioContext.close();
      } catch {
        // ignore
      }
    }
    this.audioContext = null;
    this.analyser = null;
    this._gain = null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────────

  async _ensureAudioGraph() {
    if (this.audioContext && this.analyser && this._gain) return;

    const Ctx =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : typeof webkitAudioContext !== 'undefined'
          ? webkitAudioContext
          : null;
    if (!Ctx) {
      throw new Error('Web Audio API is not available in this environment.');
    }

    this.audioContext = this._externalContext ?? new Ctx();

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = this.smoothingTimeConstant;
    this.analyser.minDecibels = this.minDecibels;
    this.analyser.maxDecibels = this.maxDecibels;

    this._gain = this.audioContext.createGain();
    this._gain.gain.value = 1.0;
  }

  async _loadBuffer(input) {
    const arrayBuffer = await this._toArrayBuffer(input);
    // decodeAudioData is Promise-based in modern browsers, callback-based in some.
    const decode = () =>
      new Promise((resolve, reject) => {
        const p = this.audioContext.decodeAudioData(arrayBuffer, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve).catch(reject);
      });
    this._buffer = await decode();
  }

  async _toArrayBuffer(input) {
    // File object
    if (typeof File !== 'undefined' && input instanceof File) {
      return await input.arrayBuffer();
    }

    if (typeof input === 'string') {
      // Prefer fetch; fall back to XHR for file:// in some contexts.
      try {
        const res = await fetch(input);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.arrayBuffer();
      } catch (e) {
        return await this._xhrArrayBuffer(input, e);
      }
    }

    throw new Error('AudioAnalyzer.play(input): input must be a File or URL string.');
  }

  _xhrArrayBuffer(url, originalError) {
    // XHR works with file:// in Chromium when file access is allowed.
    return new Promise((resolve, reject) => {
      if (typeof XMLHttpRequest === 'undefined') {
        reject(originalError ?? new Error('fetch failed and XMLHttpRequest is unavailable'));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
          resolve(xhr.response);
        } else {
          reject(originalError ?? new Error(`XHR failed with status ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(originalError ?? new Error('XHR network error'));
      xhr.send();
    });
  }

  _wireAutoplayUnlock() {
    if (this._unlockWired) return;
    this._unlockWired = true;

    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return;

    this._unlockHandler = async () => {
      try {
        await this.resume();
      } finally {
        this._unwireAutoplayUnlock();
      }
    };

    // Capture phase so we trigger even if app stops propagation.
    doc.addEventListener('pointerdown', this._unlockHandler, { capture: true, passive: true });
    doc.addEventListener('touchstart', this._unlockHandler, { capture: true, passive: true });
    doc.addEventListener('keydown', this._unlockHandler, { capture: true });
  }

  _unwireAutoplayUnlock() {
    if (!this._unlockWired) return;
    this._unlockWired = false;

    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !this._unlockHandler) return;

    doc.removeEventListener('pointerdown', this._unlockHandler, { capture: true });
    doc.removeEventListener('touchstart', this._unlockHandler, { capture: true });
    doc.removeEventListener('keydown', this._unlockHandler, { capture: true });
    this._unlockHandler = null;
  }
}

export default AudioAnalyzer;
