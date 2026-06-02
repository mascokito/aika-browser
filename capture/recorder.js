/**
 * CanvasRecorder
 * Records a canvas captureStream() output using MediaRecorder.
 */

export default class CanvasRecorder {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   * @param {number} [options.fps=30]
   * @param {number} [options.videoBitsPerSecond=8000000]
   * @param {string|null} [options.mimeType=null]
   */
  constructor(canvas, options = {}) {
    if (!canvas) throw new Error('CanvasRecorder requires a canvas');
    this.canvas = canvas;

    this.fps = options.fps ?? 30;
    this.videoBitsPerSecond = options.videoBitsPerSecond ?? 8_000_000;

    this.mimeType = options.mimeType ?? null;
    this._recorder = null;
    this._chunks = [];
    this._startMs = 0;
    this.isRecording = false;

    if (!this.mimeType) {
      this.mimeType = CanvasRecorder._pickBestMimeType();
    }
  }

  static _pickBestMimeType() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    if (typeof MediaRecorder === 'undefined') return null;
    if (typeof MediaRecorder.isTypeSupported !== 'function') return candidates[2];
    for (const t of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t;
      } catch {
        // ignore and continue
      }
    }
    return candidates[2];
  }

  start() {
    if (this.isRecording) return;
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder is not available in this environment.');
    }

    const stream = this.canvas.captureStream(this.fps);
    const opts = {
      videoBitsPerSecond: this.videoBitsPerSecond,
    };
    if (this.mimeType) opts.mimeType = this.mimeType;

    this._chunks = [];
    this._startMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this._recorder = new MediaRecorder(stream, opts);
    this._recorder.ondataavailable = (e) => {
      if (e?.data && e.data.size > 0) this._chunks.push(e.data);
    };

    this._recorder.start(200); // timeslice (ms)
    this.isRecording = true;
  }

  /**
   * @returns {Promise<Blob>}
   */
  stop() {
    if (!this._recorder || !this.isRecording) {
      return Promise.resolve(new Blob([], { type: this.mimeType || 'video/webm' }));
    }

    const rec = this._recorder;
    this.isRecording = false;

    return new Promise((resolve, reject) => {
      rec.onstop = () => {
        try {
          const blob = new Blob(this._chunks, { type: this.mimeType || 'video/webm' });
          resolve(blob);
        } catch (e) {
          reject(e);
        } finally {
          this._recorder = null;
        }
      };
      rec.onerror = (e) => reject(e?.error || e);
      try {
        rec.stop();
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * @returns {number} elapsed seconds since start()
   */
  getElapsed() {
    if (!this._startMs) return 0;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return Math.max(0, (now - this._startMs) / 1000);
  }

  /**
   * @param {Blob} blob
   * @param {string} filename
   */
  static downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'recording.webm';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 250);
  }
}

