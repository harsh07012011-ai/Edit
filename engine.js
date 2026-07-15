/**
 * engine.js
 * 100% client-side port of the old Python backend/engine.py.
 *
 * Two parts:
 *  1. AudioAnalyzer — decodes the song with the Web Audio API and computes
 *     an onset-strength envelope, a bass-only onset envelope, a beat grid,
 *     and "major drop" timestamps, using a hand-rolled FFT (no librosa).
 *  2. Templates (VelocityGlitch / CinematicSmooth / HyperCutoutDrop) — pure
 *     functions of (t) -> draw onto a 2D canvas, mirroring engine.py's
 *     make_frame(t) design, using Canvas 2D instead of PIL/numpy.
 */

// ===========================================================================
// Tiny FFT (iterative radix-2, real input via zero imaginary part)
// ===========================================================================

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * curWr - im[i + j + len / 2] * curWi;
        const vi = re[i + j + len / 2] * curWi + im[i + j + len / 2] * curWr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const nwr = curWr * wr - curWi * wi;
        curWi = curWr * wi + curWi * wr;
        curWr = nwr;
      }
    }
  }
}

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// ===========================================================================
// Small math helpers (mirrors of the python helpers in engine.py)
// ===========================================================================

function percentile(sortedArr, p) {
  const n = sortedArr.length;
  if (n === 0) return 0;
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function findPeaks(arr, minHeight, minDistance) {
  const candidates = [];
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i] > arr[i - 1] && arr[i] >= arr[i + 1] && arr[i] >= minHeight) {
      candidates.push(i);
    }
  }
  candidates.sort((a, b) => arr[b] - arr[a]);
  const selected = [];
  for (const c of candidates) {
    if (selected.every((s) => Math.abs(s - c) >= minDistance)) selected.push(c);
  }
  selected.sort((a, b) => a - b);
  return selected;
}

function decayEnvelope(t, eventT, tau, window) {
  if (eventT === null || t < eventT || t - eventT > window) return 0.0;
  return Math.exp(-(t - eventT) / tau);
}

function easeInOutSine(x) {
  return -(Math.cos(Math.PI * x) - 1) / 2;
}

function squarePulse(t, eventT, onWidth) {
  if (eventT === null) return 0.0;
  const dt = t - eventT;
  return dt >= 0 && dt <= onWidth ? 1.0 : 0.0;
}

function lastEventBefore(t, events) {
  if (events.length === 0) return null;
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo - 1 >= 0 ? events[lo - 1] : null;
}

function argmax(arr) {
  let bi = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i;
  return bi;
}

/** Standard HSL -> RGB (0-255 each channel), used by the Neon Pulse style
 * for its slowly hue-cycling color wash. */
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ===========================================================================
// AudioAnalyzer
// ===========================================================================

class AudioAnalyzer {
  static async fromFile(file, onProgress = () => {}) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuf = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuf);
    onProgress(4);
    const analyzer = new AudioAnalyzer(audioBuffer);
    onProgress(10);
    await ctx.close();
    return analyzer;
  }

  constructor(audioBuffer) {
    this.duration = audioBuffer.duration;
    this.sr = audioBuffer.sampleRate;

    // Mixdown to mono
    const chans = audioBuffer.numberOfChannels;
    let y = audioBuffer.getChannelData(0);
    if (chans > 1) {
      const mono = new Float32Array(y.length);
      for (let c = 0; c < chans; c++) {
        const d = audioBuffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / chans;
      }
      y = mono;
    }

    const N_FFT = 2048, HOP = 512;
    const window = hannWindow(N_FFT);
    const nFrames = Math.max(1, Math.floor((y.length - N_FFT) / HOP) + 1);

    const nBins = N_FFT / 2;
    const bassMax = Math.floor((150 * N_FFT) / this.sr); // bin cutoff for <=150Hz

    const onsetEnv = new Float32Array(nFrames);
    const bassEnv = new Float32Array(nFrames);
    const envTimes = new Float32Array(nFrames);

    let prevMag = new Float32Array(nBins);
    let prevBassMag = new Float32Array(bassMax + 1);
    const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);

    for (let f = 0; f < nFrames; f++) {
      const start = f * HOP;
      for (let i = 0; i < N_FFT; i++) {
        const s = start + i < y.length ? y[start + i] : 0;
        re[i] = s * window[i];
        im[i] = 0;
      }
      fftInPlace(re, im);

      let flux = 0, bassFlux = 0;
      for (let b = 0; b < nBins; b++) {
        const mag = Math.hypot(re[b], im[b]);
        const diff = mag - prevMag[b];
        if (diff > 0) flux += diff;
        if (b <= bassMax) {
          const bdiff = mag - prevBassMag[b];
          if (bdiff > 0) bassFlux += bdiff;
        }
        prevMag[b] = mag;
        if (b <= bassMax) prevBassMag[b] = mag;
      }
      onsetEnv[f] = flux;
      bassEnv[f] = bassFlux;
      envTimes[f] = start / this.sr;
    }

    // normalize both envelopes 0..1
    const norm = (arr) => {
      let mx = 0;
      for (const v of arr) if (v > mx) mx = v;
      if (mx > 0) for (let i = 0; i < arr.length; i++) arr[i] /= mx;
      return arr;
    };
    norm(onsetEnv);
    norm(bassEnv);

    this.onsetEnv = onsetEnv;
    this.envTimes = envTimes;

    // -- major drops: strong, well-spaced peaks (top quartile, >=1.2s apart)
    this.majorDropTimes = this._detectMajorDrops(onsetEnv, envTimes);

    // -- fine onsets: for jump cuts / glitch triggers
    const sortedOnset = Array.from(onsetEnv).sort((a, b) => a - b);
    const onsetThresh = percentile(sortedOnset, 55);
    const frameDt = envTimes.length > 1 ? envTimes[1] - envTimes[0] : HOP / this.sr;
    const onsetDist = Math.max(1, Math.round(0.1 / frameDt));
    let onsetPeaks = findPeaks(onsetEnv, onsetThresh, onsetDist);
    this.onsetTimes = onsetPeaks.length
      ? onsetPeaks.map((i) => envTimes[i])
      : this._fallbackBeatGrid();

    // -- bass onsets
    const sortedBass = Array.from(bassEnv).sort((a, b) => a - b);
    const bassThresh = percentile(sortedBass, 60);
    const bassDist = Math.max(1, Math.round(0.12 / frameDt));
    let bassPeaks = findPeaks(bassEnv, bassThresh, bassDist);
    this.bassTimes = bassPeaks.length
      ? bassPeaks.map((i) => envTimes[i])
      : this.majorDropTimes.slice();

    // -- beat grid via autocorrelation tempo estimate
    this.beatTimes = this._estimateBeatGrid(onsetEnv, frameDt);
  }

  _detectMajorDrops(env, envTimes, minGapSec = 1.2, pct = 75) {
    if (env.length < 2) return [0.0];
    const frameDt = envTimes[1] - envTimes[0];
    const distance = Math.max(1, Math.round(minGapSec / frameDt));
    const sorted = Array.from(env).sort((a, b) => a - b);
    const threshold = percentile(sorted, pct);
    let peaks = findPeaks(env, threshold, distance);
    const n = env.length;
    const lo = Math.floor(n * 0.05), hi = Math.floor(n * 0.95);
    peaks = peaks.filter((i) => i >= lo && i < hi);
    let times = peaks.map((i) => envTimes[i]);
    if (times.length === 0) {
      times = [envTimes[argmax(env)]];
    }
    return times.sort((a, b) => a - b);
  }

  _fallbackBeatGrid() {
    const step = 0.5;
    const out = [];
    for (let t = 0; t < Math.max(this.duration, step); t += step) out.push(t);
    return out;
  }

  _estimateBeatGrid(env, frameDt) {
    const minBpm = 60, maxBpm = 200;
    const minLag = Math.max(1, Math.round(60 / maxBpm / frameDt));
    const maxLag = Math.max(minLag + 1, Math.round(60 / minBpm / frameDt));
    let bestLag = minLag, bestScore = -Infinity;
    for (let lag = minLag; lag <= Math.min(maxLag, env.length - 1); lag++) {
      let score = 0;
      for (let i = 0; i + lag < env.length; i++) score += env[i] * env[i + lag];
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    const period = bestLag * frameDt;
    if (!(period > 0) || !isFinite(period)) return this._fallbackBeatGrid();

    // anchor the grid on the first prominent onset (falls back to 0)
    const sorted = Array.from(env).sort((a, b) => a - b);
    const anchorThresh = percentile(sorted, 70);
    let anchor = 0;
    for (let i = 0; i < env.length; i++) {
      if (env[i] >= anchorThresh) { anchor = this.envTimes[i]; break; }
    }
    const beats = [];
    for (let t = anchor; t < this.duration; t += period) beats.push(t);
    return beats.length ? beats : this._fallbackBeatGrid();
  }

  strengthAt(t) {
    if (this.envTimes.length === 0) return 0;
    let idx = 0, lo = 0, hi = this.envTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.envTimes[mid] < t) lo = mid + 1; else hi = mid;
    }
    idx = Math.min(Math.max(lo, 0), this.onsetEnv.length - 1);
    return Math.min(Math.max(this.onsetEnv[idx], 0), 1);
  }
}

// ===========================================================================
// Pixel-space transform primitives (Canvas 2D)
// ===========================================================================

const CANVAS_SIZE = [1080, 1920];
const FPS = 30;

/** Builds a "cover"-cropped offscreen canvas for a source image, matching
 * the python load_base_frame() behavior. */
function makeBaseCanvas(img) {
  const [cw, ch] = CANVAS_SIZE;
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(8,8,12)';
  ctx.fillRect(0, 0, cw, ch);
  const scale = Math.max(cw / img.width, ch / img.height);
  const nw = img.width * scale, nh = img.height * scale;
  ctx.drawImage(img, (cw - nw) / 2, (ch - nh) / 2, nw, nh);
  return c;
}

/** Draws base (a canvas) onto ctx with scale/rotation/translation, then
 * optionally applies a chromatic-aberration channel shift. */
function transformFrame(ctx, base, { scale = 1, angleDeg = 0, shiftX = 0, shiftY = 0, chromaShiftPx = 0 } = {}) {
  const [cw, ch] = CANVAS_SIZE;
  ctx.fillStyle = 'rgb(0,0,0)';
  ctx.fillRect(0, 0, cw, ch);
  ctx.save();
  ctx.translate(cw / 2 + shiftX, ch / 2 + shiftY);
  if (angleDeg) ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.drawImage(base, (-cw * scale) / 2, (-ch * scale) / 2, cw * scale, ch * scale);
  ctx.restore();

  if (chromaShiftPx > 0) applyChromaticAberration(ctx, chromaShiftPx);
}

function applyChromaticAberration(ctx, shiftPx) {
  const [cw, ch] = CANVAS_SIZE;
  const imgData = ctx.getImageData(0, 0, cw, ch);
  const src = imgData.data;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < ch; y++) {
    const rowOff = y * cw * 4;
    for (let x = 0; x < cw; x++) {
      const di = rowOff + x * 4;
      const rx = Math.min(cw - 1, Math.max(0, x + shiftPx));
      const bx = Math.min(cw - 1, Math.max(0, x - shiftPx));
      out[di] = src[rowOff + rx * 4];         // R shifted right by +shiftPx source (== shift left visually)
      out[di + 1] = src[di + 1];               // G unchanged
      out[di + 2] = src[rowOff + bx * 4 + 2];  // B shifted the other way
      out[di + 3] = 255;
    }
  }
  imgData.data.set(out);
  ctx.putImageData(imgData, 0, 0);
}

function blendFlash(ctx, alpha, color = [255, 255, 255]) {
  if (alpha <= 0) return;
  alpha = Math.min(alpha, 1);
  const [cw, ch] = CANVAS_SIZE;
  ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
  ctx.fillRect(0, 0, cw, ch);
}

function blendOpacity(ctx, opacity) {
  opacity = Math.min(Math.max(opacity, 0), 1);
  if (opacity >= 0.999) return;
  const [cw, ch] = CANVAS_SIZE;
  ctx.fillStyle = `rgba(0,0,0,${1 - opacity})`;
  ctx.fillRect(0, 0, cw, ch);
}

// ===========================================================================
// Base template: image-sequence segmentation shared by all styles
// ===========================================================================

class BaseTemplate {
  constructor(baseCanvases, analyzer, segmentStartsOverride = null) {
    this.baseCanvases = baseCanvases;
    this.analyzer = analyzer;
    // If the person picked their own cut timings, use those instead of
    // the AI-detected major drops. Either way, segment 0 always starts
    // at t=0.
    this.segmentStarts = segmentStartsOverride
      ? [0, ...segmentStartsOverride.filter((t) => t > 0)]
      : [0, ...analyzer.majorDropTimes];
    // The cut/flash/shake effects in each template trigger on these times —
    // same as segmentStarts minus the leading 0, so manual mode drives the
    // visual "hit" effects too, not just which image is showing.
    this.dropTimes = this.segmentStarts.slice(1);
  }

  segmentIndexAt(t) {
    const arr = this.segmentStarts;
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= t) lo = mid + 1; else hi = mid;
    }
    return Math.max(lo - 1, 0);
  }

  imageIndexAt(t) {
    return this.segmentIndexAt(t) % this.baseCanvases.length;
  }

  currentBase(t) {
    return this.baseCanvases[this.imageIndexAt(t)];
  }

  segmentBoundsAt(t) {
    const idx = this.segmentIndexAt(t);
    const start = this.segmentStarts[idx];
    const end = idx + 1 < this.segmentStarts.length ? this.segmentStarts[idx + 1] : this.analyzer.duration;
    return [start, end];
  }
}

// ===========================================================================
// Style templates
// ===========================================================================

class VelocityGlitchTemplate extends BaseTemplate {
  static ZOOM_CYCLE = [1.0, 1.18, 1.35, 1.08, 1.5, 1.22];

  drawFrame(ctx, t) {
    const base = this.currentBase(t);
    const onsets = this.analyzer.onsetTimes;

    let lo = 0, hi = onsets.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (onsets[mid] <= t) lo = mid + 1; else hi = mid; }
    const segIdx = Math.max(lo - 1, 0);

    const baseScale = VelocityGlitchTemplate.ZOOM_CYCLE[segIdx % 6];
    const onsetSegStart = onsets.length ? onsets[segIdx] : 0;
    const drift = Math.min(t - onsetSegStart, 0.5) * 0.25;
    const scale = baseScale + drift;

    const onsetT = lastEventBefore(t, onsets);
    const glitchEnv = decayEnvelope(t, onsetT, 0.05, 0.12);
    const chromaPx = Math.round(glitchEnv * 14);
    const jitterX = Math.round(glitchEnv * 18 * Math.sin(t * 90));
    const jitterY = Math.round(glitchEnv * 10 * Math.cos(t * 70));

    transformFrame(ctx, base, { scale, shiftX: jitterX, shiftY: jitterY, chromaShiftPx: chromaPx });

    const dropT = lastEventBefore(t, this.dropTimes);
    const cutEnv = decayEnvelope(t, dropT, 0.06, 0.15);
    if (cutEnv > 0) {
      transformFrame(ctx, base, { scale, chromaShiftPx: Math.round(cutEnv * 22) });
    }

    blendFlash(ctx, Math.max(glitchEnv * 0.35, cutEnv * 0.5));
  }
}

class CinematicSmoothTemplate extends BaseTemplate {
  static CROSSFADE_SEC = 0.6;

  _kenBurns(ctx, base, t, segStart, segEnd) {
    const segDuration = Math.max(segEnd - segStart, 0.5);
    const progress = Math.min(Math.max((t - segStart) / segDuration, 0), 1);
    const eased = easeInOutSine(progress);
    const scale = 1.0 + 0.22 * eased;
    const shiftX = Math.round(-40 + 80 * eased);
    const shiftY = Math.round(30 - 60 * eased);
    transformFrame(ctx, base, { scale, shiftX, shiftY });
  }

  drawFrame(ctx, t) {
    const segIdx = this.segmentIndexAt(t);
    const [segStart, segEnd] = this.segmentBoundsAt(t);
    const current = this.baseCanvases[segIdx % this.baseCanvases.length];
    this._kenBurns(ctx, current, t, segStart, segEnd);

    if (segIdx > 0 && t - segStart < CinematicSmoothTemplate.CROSSFADE_SEC) {
      const prev = this.baseCanvases[(segIdx - 1) % this.baseCanvases.length];
      const prevSegStart = this.segmentStarts[segIdx - 1];
      // render previous frame's end-state to an offscreen canvas, then
      // crossfade it under the current frame using canvas alpha.
      const off = document.createElement('canvas');
      off.width = CANVAS_SIZE[0]; off.height = CANVAS_SIZE[1];
      const offCtx = off.getContext('2d');
      this._kenBurns(offCtx, prev, segStart, prevSegStart, segStart);

      const alpha = (t - segStart) / CinematicSmoothTemplate.CROSSFADE_SEC;
      const snapshot = document.createElement('canvas');
      snapshot.width = CANVAS_SIZE[0]; snapshot.height = CANVAS_SIZE[1];
      snapshot.getContext('2d').drawImage(ctx.canvas, 0, 0);

      ctx.clearRect(0, 0, CANVAS_SIZE[0], CANVAS_SIZE[1]);
      ctx.globalAlpha = 1;
      ctx.drawImage(off, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.drawImage(snapshot, 0, 0);
      ctx.globalAlpha = 1;
    }

    const beatT = lastEventBefore(t, this.analyzer.beatTimes);
    const pulse = decayEnvelope(t, beatT, 0.9, 1.8) * 0.12;
    blendFlash(ctx, pulse, [255, 176, 90]);
  }
}

class HyperCutoutDropTemplate extends BaseTemplate {
  drawFrame(ctx, t) {
    const analyzer = this.analyzer;
    const base = this.currentBase(t);

    const beatT = lastEventBefore(t, analyzer.beatTimes);
    const bounce = decayEnvelope(t, beatT, 0.09, 0.25) * 0.06;
    let scale = 1.0 + bounce;

    const dropT = lastEventBefore(t, this.dropTimes);
    const dropEnv = decayEnvelope(t, dropT, 0.22, 0.6);
    scale += dropEnv * 0.2;

    const shakeEnv = decayEnvelope(t, dropT, 0.12, 0.4);
    const shiftX = Math.round(shakeEnv * 26 * Math.sin(t * 140));
    const shiftY = Math.round(shakeEnv * 26 * Math.cos(t * 160));

    transformFrame(ctx, base, { scale, shiftX, shiftY });

    const flashEnv = decayEnvelope(t, dropT, 0.07, 0.2);
    blendFlash(ctx, flashEnv);

    const bassT = lastEventBefore(t, analyzer.bassTimes);
    const cut = squarePulse(t, bassT, 0.06);
    blendOpacity(ctx, cut ? 0.35 : 1.0);
  }
}

/**
 * Cutout Drop Transition: unlike the other templates, this one needs an
 * extra array of pre-computed "cutout" canvases (one per image, subject
 * isolated on a transparent background — see makeCutoutCanvas() below).
 * That array is built asynchronously in app.js (it calls an AI
 * background-removal model), then handed to this template's constructor.
 *
 * Per frame: draw the CURRENT image full-frame as usual. Then, only
 * during the last `transitionDuration` seconds before the NEXT major
 * drop, animate the NEXT image's cutout sliding/zooming in on top of it.
 * Exactly on the drop, playback hard-cuts to the next full image (which
 * itself just becomes the new "current" image — no special handling
 * needed since segmentIndexAt() already advances there automatically).
 */
class CutoutDropTransitionTemplate extends BaseTemplate {
  /**
   * @param {HTMLCanvasElement[]} baseCanvases
   * @param {AudioAnalyzer} analyzer
   * @param {object} opts
   * @param {HTMLCanvasElement[]} opts.cutoutCanvases  one per image
   * @param {number} opts.transitionDuration           seconds, default direction
   * @param {string} opts.animationType                fallback direction
   * @param {string[]} [opts.perCutDirections]         optional per-cut direction
   * @param {number[]} [opts.segmentStartsOverride]    manual cut timings
   */
  constructor(baseCanvases, analyzer, opts = {}) {
    super(baseCanvases, analyzer, opts.segmentStartsOverride ?? null);
    this.cutoutCanvases = opts.cutoutCanvases;
    this.transitionDuration = opts.transitionDuration ?? 0.4;
    
    // THE FIX: Automatically alternate directions if no manual directions are provided
    if (opts.perCutDirections && opts.perCutDirections.length > 0) {
        this.perCutDirections = opts.perCutDirections;
    } else {
        const cycle = ['slide_right', 'slide_left', 'slide_top', 'slide_bottom'];
        // Generate an alternating array matching the number of detected cuts
        this.perCutDirections = Array.from(
            { length: this.segmentStarts.length }, 
            (_, i) => cycle[i % 4]
        );
    }
  }

  drawFrame(ctx, t) {
    const analyzer = this.analyzer;
    const segIdx = this.segmentIndexAt(t);
    const [, segEnd] = this.segmentBoundsAt(t);
    const current = this.baseCanvases[segIdx % this.baseCanvases.length];

    // Subtle beat-bounce so the base image doesn't sit completely static.
    const beatT = lastEventBefore(t, analyzer.beatTimes);
    const bounce = decayEnvelope(t, beatT, 0.09, 0.25) * 0.05;
    transformFrame(ctx, current, { scale: 1.0 + bounce });

    // Is there actually another cut coming up after this segment? (the
    // very last segment of the track has nothing to transition into)
    const hasNextCut = segIdx + 1 < this.segmentStarts.length;
    if (!hasNextCut) return;

    const timeToCut = segEnd - t;
    if (timeToCut >= 0 && timeToCut <= this.transitionDuration) {
      const nextIdx = (segIdx + 1) % this.cutoutCanvases.length;
      const progress = 1 - timeToCut / this.transitionDuration;
      // It will now pull from our generated alternating array
      const direction = this.perCutDirections[segIdx] || 'slide_right';
      this._drawAnimatedCutout(ctx, this.cutoutCanvases[nextIdx], progress, direction);
    }

    // A quick punch-flash right on the cut itself for extra impact.
    const dropT = lastEventBefore(t, this.dropTimes);
    const flashEnv = decayEnvelope(t, dropT, 0.06, 0.15);
    blendFlash(ctx, flashEnv * 0.4);
  }

  _drawAnimatedCutout(ctx, cutoutCanvas, progress, direction) {
    const eased = easeInOutSine(Math.min(Math.max(progress, 0), 1));
    const [cw, ch] = CANVAS_SIZE;

    let offsetX = 0, offsetY = 0, scale = 1;
    switch (direction) {
      case 'slide_top': offsetY = -(1 - eased) * ch * 0.5; break;
      case 'slide_bottom': offsetY = (1 - eased) * ch * 0.5; break;
      case 'slide_left': offsetX = -(1 - eased) * cw * 0.5; break;
      case 'slide_right': offsetX = (1 - eased) * cw * 0.5; break;
      case 'zoom_in': scale = 0.7 + 0.3 * eased; break;
    }

    ctx.save();
    ctx.globalAlpha = Math.min(1, eased + 0.15); // fades in alongside the slide/zoom
    ctx.translate(cw / 2 + offsetX, ch / 2 + offsetY);
    ctx.scale(scale, scale);
    ctx.translate(-cw / 2, -ch / 2);
    ctx.drawImage(cutoutCanvas, 0, 0);
    ctx.restore();
  }
       }
      
/** Direction options for the Cutout Drop Transition style — shared with
 * app.js so the UI dropdown and the renderer never fall out of sync. */
const CUTOUT_DIRECTIONS = [
  { value: 'slide_bottom', label: 'From Bottom' },
  { value: 'slide_top', label: 'From Top' },
  { value: 'slide_left', label: 'From Left' },
  { value: 'slide_right', label: 'From Right' },
  { value: 'zoom_in', label: 'Zoom In' },
];

/** Builds a "contain"-fit canvas of an AI-cutout image (transparent
 * background, subject centered) — the counterpart to makeBaseCanvas()
 * but WITHOUT filling the background, so transparency is preserved. */
function makeCutoutCanvas(cutoutImg) {
  const [cw, ch] = CANVAS_SIZE;
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  const fitScale = Math.min(cw / cutoutImg.width, ch / cutoutImg.height) * 0.85;
  const w = cutoutImg.width * fitScale, h = cutoutImg.height * fitScale;
  ctx.drawImage(cutoutImg, (cw - w) / 2, (ch - h) / 2, w, h);
  return c;
}

/**
 * Zoom Punch: the classic viral "punch in on every beat" edit. Hard,
 * fast scale spike right on each beat with a quick white flash, plus a
 * bigger shake + flash combo exactly on every image-change cut.
 */
class ZoomPunchTemplate extends BaseTemplate {
  drawFrame(ctx, t) {
    const analyzer = this.analyzer;
    const base = this.currentBase(t);

    const beatT = lastEventBefore(t, analyzer.beatTimes);
    const punch = decayEnvelope(t, beatT, 0.08, 0.35);
    const scale = 1.0 + punch * 0.12;

    const dropT = lastEventBefore(t, this.dropTimes);
    const shakeEnv = decayEnvelope(t, dropT, 0.1, 0.3);
    const shiftX = Math.round(shakeEnv * 20 * Math.sin(t * 130));
    const shiftY = Math.round(shakeEnv * 20 * Math.cos(t * 110));

    transformFrame(ctx, base, { scale, shiftX, shiftY });

    const beatFlash = decayEnvelope(t, beatT, 0.04, 0.1);
    blendFlash(ctx, beatFlash * 0.55);

    const cutFlash = decayEnvelope(t, dropT, 0.05, 0.12);
    blendFlash(ctx, cutFlash * 0.7);
  }
}

/**
 * Neon Pulse: a soft glow/bloom layer behind a sharp copy of the image,
 * with a slowly hue-cycling color wash that pulses brighter on bass
 * hits. More GPU-intensive than the other styles (uses canvas blur), so
 * expect slightly slower real-time rendering.
 */
class NeonPulseTemplate extends BaseTemplate {
  drawFrame(ctx, t) {
    const analyzer = this.analyzer;
    const base = this.currentBase(t);
    const strength = analyzer.strengthAt(t);
    const [cw, ch] = CANVAS_SIZE;

    const beatT = lastEventBefore(t, analyzer.beatTimes);
    const breathe = decayEnvelope(t, beatT, 0.3, 0.9) * 0.05;
    const scale = 1.0 + breathe;

    ctx.fillStyle = 'rgb(0,0,0)';
    ctx.fillRect(0, 0, cw, ch);

    // Blurred, brightened "glow" layer behind the sharp image.
    ctx.save();
    ctx.filter = 'blur(24px) brightness(1.3) saturate(1.6)';
    ctx.globalAlpha = 0.55 * (0.4 + strength * 0.6);
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(scale * 1.03, scale * 1.03);
    ctx.drawImage(base, -cw / 2, -ch / 2, cw, ch);
    ctx.restore();

    // Sharp layer on top.
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(scale, scale);
    ctx.drawImage(base, -cw / 2, -ch / 2, cw, ch);
    ctx.restore();

    // Slow hue-cycling color wash, brighter on bass hits.
    const bassT = lastEventBefore(t, analyzer.bassTimes);
    const bassPulse = decayEnvelope(t, bassT, 0.15, 0.4) * 0.22;
    const hue = (t * 40) % 360;
    const [r, g, b] = hslToRgb(hue / 360, 0.7, 0.55);
    blendFlash(ctx, bassPulse, [r, g, b]);

    // White flash + implicit shake on image-change cuts.
    const dropT = lastEventBefore(t, this.dropTimes);
    const flashEnv = decayEnvelope(t, dropT, 0.06, 0.18);
    blendFlash(ctx, flashEnv * 0.5, [255, 255, 255]);
  }
}

const TEMPLATE_REGISTRY = {
  velocity_glitch: VelocityGlitchTemplate,
  cinematic_smooth: CinematicSmoothTemplate,
  hyper_cutout_drop: HyperCutoutDropTemplate,
  cutout_drop_transition: CutoutDropTransitionTemplate,
  zoom_punch: ZoomPunchTemplate,
  neon_pulse: NeonPulseTemplate,
};

const STYLE_PRESETS = {
  velocity_glitch: {
    key: 'velocity_glitch', name: 'Velocity Glitch',
    description: 'Fast onset-synced jump cuts, RGB chromatic aberration flashes, and rapid zoom velocity changes. High energy, hype-trailer feel.',
    accent_color: '#ff2e63', recommended_bpm: '120-175',
  },
  cinematic_smooth: {
    key: 'cinematic_smooth', name: 'Cinematic Smooth',
    description: 'Slow elegant Ken Burns pan/zoom with eased motion and pulsing warm light-leak overlays. Moody, story-driven feel.',
    accent_color: '#f9a826', recommended_bpm: '60-110',
  },
  hyper_cutout_drop: {
    key: 'hyper_cutout_drop', name: 'Hyper Cutout Drop',
    description: "Built for transparent cutouts. Rhythmic bass-synced opacity cuts, beat-bounce scaling, and a screen-shake + explosion-zoom + flash combo timed exactly to the track's main drop.",
    accent_color: '#7c3aed', recommended_bpm: 'any',
  },
  cutout_drop_transition: {
    key: 'cutout_drop_transition', name: 'Cutout Drop Transition',
    description: "AI-cuts out each incoming image's subject and slides it in over the outgoing image right before every cut, then hard-cuts to the full next image. Needs internet on first use (downloads a small AI model once).",
    accent_color: '#22c55e', recommended_bpm: 'any', needsCutout: true,
  },
  zoom_punch: {
    key: 'zoom_punch', name: 'Zoom Punch',
    description: 'The viral "punch in on every beat" trend — a hard fast zoom spike + white flash on each beat, with a bigger shake-and-flash combo on every image cut.',
    accent_color: '#facc15', recommended_bpm: '100-160',
  },
  neon_pulse: {
    key: 'neon_pulse', name: 'Neon Pulse',
    description: 'Glowing bloom layer behind a sharp image, with a slow hue-cycling neon color wash that pulses brighter on bass hits. Moodier, club-edit feel. Slightly heavier to render.',
    accent_color: '#22d3ee', recommended_bpm: 'any',
  },
};
class SingleVideoBeatSyncTemplate {
  /**
   * @param {HTMLVideoElement} videoElement The uploaded source video
   * @param {AudioAnalyzer} analyzer The audio analyzer engine
   */
  constructor(videoElement, analyzer) {
    this.video = videoElement;
    this.analyzer = analyzer;
    this.beatTimes = analyzer.beatTimes || [];
    this.dropTimes = analyzer.dropTimes || [];
    
    // Canvas dimensions configuration
    this.cw = 1080;
    this.ch = 1920;
  }

  /**
   * Calculates the speed-ramped video time mapping from current audio time
   */
  getVideoTimeMapping(t) {
    if (this.beatTimes.length === 0) return t;

    // Find what beat segment we are currently inside
    let beatIdx = 0;
    while (beatIdx < this.beatTimes.length && this.beatTimes[beatIdx] <= t) {
      beatIdx++;
    }

    const startBeat = beatIdx === 0 ? 0 : this.beatTimes[beatIdx - 1];
    const endBeat = beatIdx >= this.beatTimes.length ? this.analyzer.duration : this.beatTimes[beatIdx];
    const beatDuration = endBeat - startBeat;
    
    if (beatDuration <= 0) return t;

    // Normalized progress between these two beats (0.0 to 1.0)
    const progress = (t - startBeat) / beatDuration;

    // CapCut Velocity Curve: Stays slow for 70% of the beat, then accelerates rapidly
    let rampedProgress;
    if (progress < 0.7) {
      // Slow-motion segment
      rampedProgress = (progress / 0.7) * 0.4;
    } else {
      // Fast catch-up snap right on the beat landing
      rampedProgress = 0.4 + ((progress - 0.7) / 0.3) * 0.6;
    }

    // Map back to global video timeline coordinates
    return startBeat + (rampedProgress * beatDuration);
  }

  drawFrame(ctx, t) {
    // 1. Sync the video timeline to our custom velocity curve mapping
    const targetsVideoTime = this.getVideoTimeMapping(t);
    if (Math.abs(this.video.currentTime - targetsVideoTime) > 0.1) {
      this.video.currentTime = targetsVideoTime;
    }

    ctx.save();

    // 2. Calculate decay envelopes from the beat grid
    let lastBeat = 0;
    for (let b of this.beatTimes) { if (b <= t) lastBeat = b; else break; }
    const beatAge = t - lastBeat;
    
    let lastDrop = 0;
    for (let d of this.dropTimes) { if (d <= t) lastDrop = d; else break; }
    const dropAge = t - lastDrop;

    // Decaying effect factors
    const beatEnv = Math.max(0, 1 - (beatAge / 0.3)); // 300ms beat window
    const dropEnv = Math.max(0, 1 - (dropAge / 0.4)); // 400ms drop window

    // 3. Dynamic Camera Work (Zoom & Rotation)
    const baseScale = 1.0;
    const zoomImpact = dropEnv * 0.12; // 12% extra pop zoom on drops
    const currentScale = baseScale + zoomImpact;
    
    const rotationImpact = beatEnv * 0.03 * (this.beatTimes.indexOf(lastBeat) % 2 === 0 ? 1 : -1);

    // Center canvas coordinate pivots
    ctx.translate(this.cw / 2, this.ch / 2);
    ctx.scale(currentScale, currentScale);
    ctx.rotate(rotationImpact);

    // 4. Bass-Drop Camera Shake Impact
    if (dropAge < 0.15) {
      const shakePower = dropEnv * 15; // Up to 15px shifting displacement
      const offsetX = (Math.random() - 0.5) * shakePower;
      const offsetY = (Math.random() - 0.5) * shakePower;
      ctx.translate(offsetX, offsetY);
    }
    ctx.translate(-this.cw / 2, -this.ch / 2);

    // Helper to draw video centered using cover cropping
    const drawVideoCover = (targetCtx, vid, w, h) => {
      const scale = Math.max(w / vid.videoWidth, h / vid.videoHeight);
      const nw = vid.videoWidth * scale;
      const nh = vid.videoHeight * scale;
      targetCtx.drawImage(vid, (w - nw) / 2, (h - nh) / 2, nw, nh);
    };

    // 5. The Ghost Echo / Clone Split Effect
    if (beatAge < 0.25) {
      const ghostProgress = beatAge / 0.25; // 0.0 to 1.0
      const ghostOffset = ghostProgress * 90; // Slides out up to 90 pixels
      
      ctx.save();
      ctx.globalAlpha = (1 - ghostProgress) * 0.4; // Fade out as they slide
      ctx.globalCompositeOperation = "screen";

      // Left Echo Clone
      ctx.save();
      ctx.translate(-ghostOffset, 0);
      drawVideoCover(ctx, this.video, this.cw, this.ch);
      ctx.restore();

      // Right Echo Clone
      ctx.save();
      ctx.translate(ghostOffset, 0);
      drawVideoCover(ctx, this.video, this.cw, this.ch);
      ctx.restore();

      ctx.restore();
    }

    // 6. RGB Glitch / Split Effect
    if (beatAge < 0.08) { // Ultra quick glitch burst
      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      // Red Channel Offset Shift
      ctx.save();
      ctx.translate(8, 0);
      drawVideoCover(ctx, this.video, this.cw, this.ch);
      ctx.restore();

      // Cyan Channel Offset Shift
      ctx.save();
      ctx.translate(-8, 0);
      drawVideoCover(ctx, this.video, this.cw, this.ch);
      ctx.restore();
      
      ctx.restore();
    } else {
      // Regular base layer draw
      drawVideoCover(ctx, this.video, this.cw, this.ch);
    }

    ctx.restore(); // Restore baseline configurations

    // 7. Strobe Flash Impact Overlay
    if (dropAge < 0.2) {
      ctx.save();
      ctx.fillStyle = `rgba(255, 255, 255, ${dropEnv * 0.35})`; // Soft white flash overlay
      ctx.fillRect(0, 0, this.cw, this.ch);
      ctx.restore();
    }
  }
}

// Attach to global window scope so app.js can discover it
window.SingleVideoBeatSyncTemplate = SingleVideoBeatSyncTemplate;
  
// ===========================================================================
// SINGLE VIDEO BEAT-SYNC ENGINE (CAPCUT STYLE)
// ===========================================================================

class SingleVideoBeatSyncTemplate {
  constructor(videoElement, analyzer) {
    this.video = videoElement;
    this.analyzer = analyzer;
    this.beatTimes = analyzer.beatTimes || [];
    this.dropTimes = analyzer.dropTimes || [];
    this.cw = 1080;
    this.ch = 1920;
  }

  getVideoTimeMapping(t) {
    if (this.beatTimes.length === 0) return t;
    let beatIdx = 0;
    while (beatIdx < this.beatTimes.length && this.beatTimes[beatIdx] <= t) {
      beatIdx++;
    }
    const startBeat = beatIdx === 0 ? 0 : this.beatTimes[beatIdx - 1];
    const endBeat = beatIdx >= this.beatTimes.length ? this.analyzer.duration : this.beatTimes[beatIdx];
    const beatDuration = endBeat - startBeat;
    
    if (beatDuration <= 0) return t;
    const progress = (t - startBeat) / beatDuration;
    
    let rampedProgress;
    if (progress < 0.7) {
      rampedProgress = (progress / 0.7) * 0.4;
    } else {
      rampedProgress = 0.4 + ((progress - 0.7) / 0.3) * 0.6;
    }
    return startBeat + (rampedProgress * beatDuration);
  }

  drawFrame(ctx, t) {
    const targetsVideoTime = this.getVideoTimeMapping(t);
    if (Math.abs(this.video.currentTime - targetsVideoTime) > 0.1) {
      this.video.currentTime = targetsVideoTime;
    }

    ctx.save();
    let lastBeat = 0;
    for (let b of this.beatTimes) { if (b <= t) lastBeat = b; else break; }
    const beatAge = t - lastBeat;
    
    let lastDrop = 0;
    for (let d of this.dropTimes) { if (d <= t) lastDrop = d; else break; }
    const dropAge = t - lastDrop;

    const beatEnv = Math.max(0, 1 - (beatAge / 0.3));
    const dropEnv = Math.max(0, 1 - (dropAge / 0.4));

    const baseScale = 1.0;
    const zoomImpact = dropEnv * 0.12;
    const currentScale = baseScale + zoomImpact;
    const rotationImpact = beatEnv * 0.03 * (this.beatTimes.indexOf(lastBeat) % 2 === 0 ? 1 : -1);

    ctx.translate(this.cw / 2, this.ch / 2);
    ctx.scale(currentScale, currentScale);
    ctx.rotate(rotationImpact);

    if (dropAge < 0.15) {
      const shakePower = dropEnv * 15;
      const offsetX = (Math.random() - 0.5) * shakePower;
      const offsetY = (Math.random() - 0.5) * shakePower;
      ctx.translate(offsetX, offsetY);
    }
    ctx.translate(-this.cw / 2, -this.ch / 2);

    const drawVideoCover = (targetCtx, vid, w, h) => {
      const scale = Math.max(w / vid.videoWidth, h / vid.videoHeight);
      const nw = vid.videoWidth * scale;
      const nh = vid.videoHeight * scale;
      targetCtx.drawImage(vid, (w - nw) / 2, (h - nh) / 2, nw, nh);
    };

    if (beatAge < 0.25) {
      const ghostProgress = beatAge / 0.25;
      const ghostOffset = ghostProgress * 90;
      
      ctx.save();
      ctx.globalAlpha = (1 - ghostProgress) * 0.4;
      ctx.globalCompositeOperation = "screen";

      ctx.save();
      ctx.translate(-ghostOffset, 0);
      drawVideoCover(ctx, this.video, this.cw, this.ch);
      ctx.restore();

      ctx.save();
      ctx.translate(ghostOffset, 0);
      drawVideoCover(ctx, this.video, this.cw, this.ch);
      ctx.restore();
      ctx.restore();
    }

    if (beatAge < 0.08) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.save();
      ctx.translate(8, 0);
      drawVideoCover(ctx, this.video, this.cw, this.ch);
      ctx.restore();
      ctx.save();
      ctx.translate(-8, 0);
      drawVideoCover(ctx, this.video, this.cw, this.ch);
      ctx.restore();
      ctx.restore();
    } else {
      drawVideoCover(ctx, this.video, this.cw, this.ch);
    }

    ctx.restore();

    if (dropAge < 0.2) {
      ctx.save();
      ctx.fillStyle = `rgba(255, 255, 255, ${dropEnv * 0.35})`;
      ctx.fillRect(0, 0, this.cw, this.ch);
      ctx.restore();
    }
  }
}

// Attach the class to the global window so app.js can use it
window.SingleVideoBeatSyncTemplate = SingleVideoBeatSyncTemplate;

// Automatically inject the card into the UI menus
window.addEventListener('DOMContentLoaded', () => {
  if (typeof STYLE_PRESETS !== 'undefined') {
    STYLE_PRESETS['single_video_sync'] = {
      key: 'single_video_sync',
      name: 'CapCut Auto-Sync',
      description: 'Upload ONE video + audio track. Automatically generates velocity ramping, ghost echo splits, RGB glitches, and heavy camera shakes on the beat.',
      recommended_bpm: '120-160',
      accent_color: '#ff007f',
      needsCutout: false
    };
  }
  
  if (typeof TEMPLATE_REGISTRY !== 'undefined') {
    TEMPLATE_REGISTRY['single_video_sync'] = SingleVideoBeatSyncTemplate;
  }
  
  // Re-render the grid so the new card shows up immediately
  if (typeof renderStyleGrid === 'function') {
    renderStyleGrid();
  }
});
    
