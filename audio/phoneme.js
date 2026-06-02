/**
 * Phase 2: frequency bands → viseme mapping.
 *
 * Viseme indices (0–11) align with the preview's placeholder VISEMES list.
 */

/**
 * @param {{low:number, mid:number, high:number, amplitude:number}} bands
 * @returns {number} viseme index 0..11
 */
export function bandsToViseme({ low, mid, high, amplitude }) {
  if (amplitude < 0.04) return 0; // silence

  // Priority rules (top-down)
  if (high > 0.35 && mid < 0.2) return 7; // F/V — sibilance dominant
  if (low > 0.5) return 1; // AH — big open jaw
  if (mid > 0.45 && low < 0.25) return 5; // EE — high mid, narrow jaw
  if (low > 0.35 && mid > 0.3) return 3; // OH — round
  if (low > 0.28 && mid < 0.2) return 4; // OO — tight round
  if (mid > 0.3) return 2; // AE — spread open
  if (high > 0.25) return 8; // TH — light sibilance
  if (amplitude < 0.12) return 9; // M/B/P — near-closed

  return 6; // IH — neutral speech
}

/**
 * Simple frame-level smoothing to prevent jitter.
 * @param {number} currentIdx
 * @param {number} targetIdx
 * @param {number} blend 0..1
 * @returns {number}
 */
export function smoothViseme(currentIdx, targetIdx, blend) {
  return blend < 0.5 ? currentIdx : targetIdx;
}

