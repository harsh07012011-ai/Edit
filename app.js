/**
 * app.js — 100% client-side orchestration.
 * No fetch() to any backend. Everything (audio analysis, rendering,
 * encoding) happens in this tab using engine.js.
 */

const state = {
  styleKey: null,
  imageFiles: [],
  audioFile: null,
  timingMode: 'auto', // 'auto' | 'manual'
  cutPoints: [],       // [{ time: number, direction: string }], sorted ascending
};

const el = (id) => document.getElementById(id);

function showPanel(id) {
  ['progress-panel', 'result-panel', 'error-panel'].forEach((p) => el(p).classList.add('hidden'));
  if (id) el(id).classList.remove('hidden');
}

function isCutoutStyle(key) {
  return STYLE_PRESETS[key]?.needsCutout === true;
}

function renderStyleGrid() {
  const grid = el('style-grid');
  grid.innerHTML = '';
  Object.values(STYLE_PRESETS).forEach((s) => {
    const card = document.createElement('div');
    card.className = 'style-card';
    card.style.setProperty('--card-accent', s.accent_color);
    card.innerHTML = `
      <div class="card-title"><span class="card-dot"></span>${s.name}</div>
      <div class="card-desc">${s.description}</div>
      <div class="card-bpm">Recommended BPM: ${s.recommended_bpm}</div>
    `;
    card.addEventListener('click', () => {
      document.querySelectorAll('.style-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      state.styleKey = s.key;
      const isCutout = isCutoutStyle(s.key);
      el('cutout-settings').style.display = isCutout ? 'flex' : 'none';
      el('cutout-direction-row').style.display = isCutout ? 'flex' : 'none';
      el('cutout-direction-note').style.display = isCutout && state.timingMode === 'manual' ? 'block' : 'none';
      renderCutPointList(); // per-cut direction dropdowns only make sense once a style is known
      updateGenerateButton();
    });
    grid.appendChild(card);
  });

  // Populate the direction <select> once from the shared list in engine.js,
  // so the UI and the renderer can never drift apart.
  const directionSelect = el('cutout-direction-select');
  directionSelect.innerHTML = CUTOUT_DIRECTIONS.map(
    (d) => `<option value="${d.value}">${d.label}</option>`
  ).join('');
}

function updateGenerateButton() {
  const hasBasics = state.styleKey && state.imageFiles.length && state.audioFile;
  const manualReady = state.timingMode === 'auto' || state.cutPoints.length > 0;
  el('generate-btn').disabled = !(hasBasics && manualReady);
}

function wireUploads() {
  el('image-input').addEventListener('change', (e) => {
    state.imageFiles = Array.from(e.target.files);
    const list = el('image-filelist');
    list.innerHTML = '';
    state.imageFiles.forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f.name;
      list.appendChild(li);
    });
    updateCutpointHint();
    updateGenerateButton();
  });

  el('audio-input').addEventListener('change', (e) => {
    state.audioFile = e.target.files[0] || null;
    el('audio-filename').textContent = state.audioFile ? state.audioFile.name : '';
    if (state.audioFile) {
      el('preview-audio-el').src = URL.createObjectURL(state.audioFile);
    }
    // Uploading a new song invalidates old cut-point timestamps.
    state.cutPoints = [];
    renderCutPointList();
    updateGenerateButton();
  });
}

function wireTimingControls() {
  el('timing-mode-select').addEventListener('change', (e) => {
    state.timingMode = e.target.value;
    const isManual = state.timingMode === 'manual';
    el('manual-timing-ui').classList.toggle('hidden', !isManual);
    el('cutout-direction-note').style.display =
      isManual && isCutoutStyle(state.styleKey) ? 'block' : 'none';
    updateGenerateButton();
  });

  el('add-cut-btn').addEventListener('click', () => {
    const audio = el('preview-audio-el');
    if (!audio.src) return;
    const time = Math.round(audio.currentTime * 10) / 10; // snap to 0.1s
    if (state.cutPoints.some((c) => Math.abs(c.time - time) < 0.05)) return; // avoid dupes
    state.cutPoints.push({ time, direction: 'slide_bottom' });
    state.cutPoints.sort((a, b) => a.time - b.time);
    renderCutPointList();
    updateGenerateButton();
  });
}

function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function renderCutPointList() {
  const list = el('cutpoint-list');
  list.innerHTML = '';
  const showDirection = isCutoutStyle(state.styleKey);

  state.cutPoints.forEach((cp, i) => {
    const row = document.createElement('li');
    row.className = 'cutpoint-row';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'cutpoint-time';
    timeSpan.textContent = `#${i + 1}  ${formatTime(cp.time)}`;
    row.appendChild(timeSpan);

    if (showDirection) {
      const select = document.createElement('select');
      select.innerHTML = CUTOUT_DIRECTIONS.map(
        (d) => `<option value="${d.value}" ${d.value === cp.direction ? 'selected' : ''}>${d.label}</option>`
      ).join('');
      select.addEventListener('change', (e) => { cp.direction = e.target.value; });
      row.appendChild(select);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'cutpoint-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      state.cutPoints.splice(i, 1);
      renderCutPointList();
      updateGenerateButton();
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  });

  updateCutpointHint();
}

function updateCutpointHint() {
  const hint = el('cutpoint-hint');
  const suggested = Math.max(state.imageFiles.length - 1, 0);
  hint.textContent = state.imageFiles.length
    ? `${state.cutPoints.length} cut point(s) added — ${suggested} suggested for ${state.imageFiles.length} images (images repeat if you add more cuts than images).`
    : 'Add your images first to see how many cut points are suggested.';
}

async function loadImage(fileOrBlob) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/** Downscales an image file before handing it to the AI background-removal
 * model. The model works on a fixed internal resolution anyway, so feeding
 * it a huge original phone photo just wastes time re-encoding/decoding —
 * this is the single biggest speed win available without changing models. */
async function downscaleForCutout(file, maxDim = 1024) {
  const img = await loadImage(file);
  if (Math.max(img.width, img.height) <= maxDim) return file;
  const scale = maxDim / Math.max(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
}

// 1. THIS IS THE NEW MODEL LOADER (Caches in the browser)
let bgRemover = null;

async function loadWebGPUModel() {
    if (!bgRemover) {
        // Dynamically import Transformers.js so it doesn't break your HTML script tags
        const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0');
        env.allowLocalModels = false;
        
        console.log("Downloading AI model (First time only, ~176MB)...");
        // Initialize the RMBG-1.4 pipeline with WebGPU acceleration if available
        bgRemover = await pipeline('background-removal', 'briaai/RMBG-1.4', { 
            device: navigator.gpu ? 'webgpu' : 'wasm' 
        });
    }
    return bgRemover;
}

// 2. THIS REPLACES YOUR EXISTING buildCutoutCanvases FUNCTION
async function buildCutoutCanvases(imageFiles, onProgress) {
  const cutoutCanvases = new Array(imageFiles.length);
  let completed = 0;
  
  // Load the AI model once before starting the loop so it doesn't stall per image
  const remover = await loadWebGPUModel();

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    
    // Scale down the image first to speed up the AI (using your existing downscale function)
    const smallBlob = await downscaleForCutout(file);
    const imgUrl = URL.createObjectURL(smallBlob);
    
    try {
      // Process the image client-side via Transformers.js
      const resultImage = await remover(imgUrl);
      
      // Convert the AI's RawImage output into a Blob
      const transparentBlob = await resultImage.toBlob();
      
      // Turn the Blob into a canvas for your video renderer
      const cutoutImg = await loadImage(transparentBlob);
      cutoutCanvases[i] = makeCutoutCanvas(cutoutImg);
      
    } catch (error) {
      console.error(`Transformers.js failed for image ${i}:`, error);
      // Fallback: use the original image if AI fails so the video rendering continues
      const fallbackImg = await loadImage(file);
      cutoutCanvases[i] = makeCutoutCanvas(fallbackImg);
    } finally {
      URL.revokeObjectURL(imgUrl); // Clean up browser memory
    }
    
    completed++;
    onProgress(completed, imageFiles.length);
  }
  
  return cutoutCanvases;
}

          
async function generateVideo() {
  showPanel('progress-panel');
  el('progress-fill').style.width = '0%';
  el('progress-label').textContent = 'Analyzing audio…';

  try {
    // 1. Analyze audio (still runs even in manual mode — beatTimes/bassTimes
    // drive the "life" effects like bounce/shake/glow on every style).
    const analyzer = await AudioAnalyzer.fromFile(state.audioFile, (pct) => {
      el('progress-fill').style.width = `${pct}%`;
    });

    // Manual mode overrides WHEN images change; auto mode uses the AI-detected drops.
    const segmentStartsOverride =
      state.timingMode === 'manual' ? state.cutPoints.map((c) => c.time) : null;

    // 2. Load + cover-crop images
    el('progress-label').textContent = 'Preparing images…';
    const imgs = await Promise.all(state.imageFiles.map(loadImage));
    const baseCanvases = imgs.map(makeBaseCanvas);
    el('progress-fill').style.width = '14%';

    // 3. Build the chosen template
    const TemplateCls = TEMPLATE_REGISTRY[state.styleKey];
    let template;
    if (isCutoutStyle(state.styleKey)) {
      el('progress-label').textContent = 'Cutting out subjects (AI)…';
      const cutoutCanvases = await buildCutoutCanvases(state.imageFiles, (done, total) => {
        const pct = 14 + Math.round((done / total) * 10); // 14-24% reserved for AI cutouts
        el('progress-fill').style.width = `${pct}%`;
        el('progress-label').textContent = `Cutting out subjects (${done}/${total})…`;
      });
      template = new TemplateCls(baseCanvases, analyzer, {
        cutoutCanvases,
        transitionDuration: parseFloat(el('cutout-duration-input').value) || 0.4,
        animationType: el('cutout-direction-select').value,
        perCutDirections: state.timingMode === 'manual' ? state.cutPoints.map((c) => c.direction) : null,
        segmentStartsOverride,
      });
    } else {
      template = new TemplateCls(baseCanvases, analyzer, segmentStartsOverride);
    }

    // 4. Set up render canvas + capture stream
    const canvas = el('render-canvas');
    canvas.width = CANVAS_SIZE[0];
    canvas.height = CANVAS_SIZE[1];
    const ctx = canvas.getContext('2d');
    const videoStream = canvas.captureStream(FPS);

    // 5. Set up audio graph: decode into an <audio> element and pipe it
    // through Web Audio into a MediaStreamAudioDestination so it can be
    // combined with the video track for MediaRecorder.
    const audioEl = el('audio-el');
    const audioUrl = URL.createObjectURL(state.audioFile);
    audioEl.src = audioUrl;
    audioEl.currentTime = 0;
    audioEl.muted = false;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const sourceNode = audioCtx.createMediaElementSource(audioEl);
    const destNode = audioCtx.createMediaStreamDestination();
    sourceNode.connect(destNode);
    sourceNode.connect(audioCtx.destination); // also let the user hear it

    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...destNode.stream.getAudioTracks(),
    ]);

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(combined, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const recordingDone = new Promise((resolve) => { recorder.onstop = resolve; });

    el('progress-label').textContent = 'Rendering (playing song in real time)…';

    let rafId = null;
    const drawLoop = () => {
      const t = audioEl.currentTime;
      template.drawFrame(ctx, t);
      const pct = Math.min(89, 24 + Math.round((t / analyzer.duration) * 65));
      el('progress-fill').style.width = `${pct}%`;
      if (!audioEl.ended && !audioEl.paused) {
        rafId = requestAnimationFrame(drawLoop);
      }
    };

    audioEl.onended = () => {
      if (rafId) cancelAnimationFrame(rafId);
      recorder.stop();
    };

    recorder.start(250);
    await audioEl.play();
    rafId = requestAnimationFrame(drawLoop);

    await recordingDone;

    el('progress-fill').style.width = '90%';
    el('progress-label').textContent = 'Converting to MP4…';

    const webmBlob = new Blob(chunks, { type: mimeType || 'video/webm' });
    let outputBlob = webmBlob;
    let outputExt = 'webm';

    try {
      const { convertWebmToMp4 } = await import('./mp4-export.js');
      outputBlob = await convertWebmToMp4(webmBlob, (pct) => {
        el('progress-fill').style.width = `${90 + Math.round(pct * 0.09)}%`;
      });
      outputExt = 'mp4';
    } catch (convertErr) {
      // MP4 conversion is a bonus step — if it fails (offline on first use,
      // low memory, etc.) still hand back the WebM rather than losing the render.
      console.error('MP4 conversion failed, falling back to WebM:', convertErr);
    }

    el('progress-fill').style.width = '100%';
    el('progress-label').textContent = 'Done!';

    const outUrl = URL.createObjectURL(outputBlob);

    el('result-video').src = outUrl;
    el('download-link').href = outUrl;
    el('download-link').download = `apex-edit-${state.styleKey}.${outputExt}`;
    el('format-result-note').textContent =
      outputExt === 'mp4'
        ? 'Exported as MP4 (H.264, CRF 17 — visually lossless).'
        : 'MP4 conversion failed, so this is the raw WebM recording instead — still plays fine, just re-import it elsewhere if you specifically need .mp4.';

    await audioCtx.close();
    URL.revokeObjectURL(audioUrl);

    showPanel('result-panel');
  } catch (err) {
    console.error(err);
    el('error-message').textContent = err.message || String(err);
    showPanel('error-panel');
  }
}

function resetToStart() {
  state.styleKey = null;
  state.imageFiles = [];
  state.audioFile = null;
  state.timingMode = 'auto';
  state.cutPoints = [];
  el('image-input').value = '';
  el('audio-input').value = '';
  el('image-filelist').innerHTML = '';
  el('audio-filename').textContent = '';
  el('preview-audio-el').removeAttribute('src');
  el('timing-mode-select').value = 'auto';
  el('manual-timing-ui').classList.add('hidden');
  el('cutout-direction-note').style.display = 'none';
  renderCutPointList();
  document.querySelectorAll('.style-card').forEach((c) => c.classList.remove('selected'));
  el('cutout-settings').style.display = 'none';
  el('cutout-direction-row').style.display = 'none';
  updateGenerateButton();
  showPanel(null);
}

window.addEventListener('DOMContentLoaded', () => {
  renderStyleGrid();
  wireUploads();
  wireTimingControls();
  el('generate-btn').addEventListener('click', generateVideo);
  el('restart-btn').addEventListener('click', resetToStart);
  el('error-restart-btn').addEventListener('click', resetToStart);
});
