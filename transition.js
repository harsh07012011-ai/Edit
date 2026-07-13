/**
 * transition.js
 * Browser port of cutout_transition.py's logic:
 *   1. Grab Video B's first frame.
 *   2. Run it through an in-browser AI background-removal model
 *      (@imgly/background-removal — WASM/ONNX, runs fully client-side,
 *      same idea as rembg but ships to the browser instead of Python).
 *   3. Play Video A; during its last N seconds, draw the cutout on top
 *      with an animation.
 *   4. Hard-cut to Video B's normal playback.
 *   5. Record the whole thing in real time via canvas.captureStream()
 *      + MediaRecorder, same technique as the beat-sync tool.
 *
 * NOTE: @imgly/background-removal is AGPL-licensed. Fine for personal /
 * open-source use; check their licensing page before shipping this in a
 * closed-source product.
 */

import { removeBackground as imglyRemoveBackground } from 'https://cdn.jsdelivr.net/npm/@imgly/background-removal/+esm';

const el = (id) => document.getElementById(id);

const state = { videoAFile: null, videoBFile: null };

function showPanel(id) {
  ['progress-panel', 'result-panel', 'error-panel'].forEach((p) => el(p).classList.add('hidden'));
  if (id) el(id).classList.remove('hidden');
}

function updateGenerateButton() {
  el('generate-btn').disabled = !(state.videoAFile && state.videoBFile);
}

function wireUploads() {
  el('video-a-input').addEventListener('change', (e) => {
    state.videoAFile = e.target.files[0] || null;
    el('video-a-filename').textContent = state.videoAFile ? state.videoAFile.name : '';
    updateGenerateButton();
  });
  el('video-b-input').addEventListener('change', (e) => {
    state.videoBFile = e.target.files[0] || null;
    el('video-b-filename').textContent = state.videoBFile ? state.videoBFile.name : '';
    updateGenerateButton();
  });
}

function loadVideoMetadata(videoEl, file) {
  return new Promise((resolve, reject) => {
    videoEl.src = URL.createObjectURL(file);
    videoEl.onloadedmetadata = () => resolve();
    videoEl.onerror = () => reject(new Error(`Could not load ${file.name}`));
  });
}

function seekTo(videoEl, time) {
  return new Promise((resolve) => {
    videoEl.onseeked = () => resolve();
    videoEl.currentTime = time;
  });
}

/** Draws a video frame onto ctx using a "cover" crop (fills the canvas,
 * cropping overflow) — same behavior as engine.js's makeBaseCanvas(). */
function drawVideoCover(ctx, video, cw, ch) {
  const scale = Math.max(cw / video.videoWidth, ch / video.videoHeight);
  const nw = video.videoWidth * scale, nh = video.videoHeight * scale;
  ctx.drawImage(video, (cw - nw) / 2, (ch - nh) / 2, nw, nh);
}

/** Ease-out cubic — starts fast, settles gently. Same curve as the
 * Python version's animation easing. */
function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const c of candidates) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

async function generateTransition() {
  showPanel('progress-panel');
  el('progress-fill').style.width = '0%';
  el('progress-label').textContent = 'Loading clips…';

  const videoA = el('video-a-el');
  const videoB = el('video-b-el');
  const canvas = el('render-canvas');
  const ctx = canvas.getContext('2d');

  try {
    await Promise.all([
      loadVideoMetadata(videoA, state.videoAFile),
      loadVideoMetadata(videoB, state.videoBFile),
    ]);

    const transitionDuration = parseFloat(el('duration-input').value) || 0.5;
    const animationType = el('animation-select').value;

    if (transitionDuration >= videoA.duration) {
      throw new Error(
        `Transition length (${transitionDuration}s) must be shorter than Video A (${videoA.duration.toFixed(2)}s).`
      );
    }

    canvas.width = videoA.videoWidth;
    canvas.height = videoA.videoHeight;
    const cw = canvas.width, ch = canvas.height;

    // --- Step 1+2: grab Video B's first frame, run AI background removal
    el('progress-label').textContent = 'Cutting out Video B\'s subject (AI)…';
    await seekTo(videoB, 0);
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = videoB.videoWidth;
    frameCanvas.height = videoB.videoHeight;
    frameCanvas.getContext('2d').drawImage(videoB, 0, 0);
    const frameBlob = await new Promise((resolve) => frameCanvas.toBlob(resolve, 'image/png'));

    const cutoutBlob = await imglyRemoveBackground(frameBlob, {
      model: 'small',
      progress: (key, current, total) => {
        const pct = total ? Math.round((current / total) * 10) : 0; // reserve 0-10% for model download/inference
        el('progress-fill').style.width = `${pct}%`;
      },
    });
    const cutoutImg = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(cutoutBlob);
    });
    el('progress-fill').style.width = '12%';

    // Fit the cutout inside the canvas like CSS "object-fit: contain",
    // scaled to 90% so it doesn't touch the edges.
    const fitScale = Math.min(cw / cutoutImg.width, ch / cutoutImg.height) * 0.9;
    const cutoutW = cutoutImg.width * fitScale, cutoutH = cutoutImg.height * fitScale;

    function drawAnimatedCutout(progress) {
      const eased = easeOutCubic(Math.min(Math.max(progress, 0), 1));
      let scale = 1, offsetY = 0;
      if (animationType === 'zoom_in') {
        scale = 0.9 + 0.1 * eased;
      } else if (animationType === 'slide_up') {
        offsetY = (1 - eased) * 60;
      }
      const w = cutoutW * scale, h = cutoutH * scale;
      const x = (cw - w) / 2;
      const y = (ch - h) / 2 + offsetY;
      ctx.drawImage(cutoutImg, x, y, w, h);
    }

    // --- Audio graph: Video A's audio, then Video B's audio, both routed
    // into one recordable destination. Only one clip plays at a time, so
    // there's no overlap — this just lets the recorder hear whichever is
    // currently playing.
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const destNode = audioCtx.createMediaStreamDestination();
    const sourceA = audioCtx.createMediaElementSource(videoA);
    const sourceB = audioCtx.createMediaElementSource(videoB);
    sourceA.connect(destNode);
    sourceA.connect(audioCtx.destination);
    sourceB.connect(destNode);
    sourceB.connect(audioCtx.destination);

    const videoStream = canvas.captureStream(30);
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...destNode.stream.getAudioTracks(),
    ]);
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(combined, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const recordingDone = new Promise((resolve) => { recorder.onstop = resolve; });

    // --- Step 3+4+5: play A (overlaying the cutout near the end), hard
    // cut to B, record continuously throughout.
    el('progress-label').textContent = 'Rendering (playing clips in real time)…';
    const splitPoint = videoA.duration - transitionDuration;
    const totalDuration = videoA.duration + videoB.duration;
    let phase = 'A';
    let rafId = null;

    const drawLoop = () => {
      if (phase === 'A') {
        drawVideoCover(ctx, videoA, cw, ch);
        if (videoA.currentTime >= splitPoint) {
          drawAnimatedCutout((videoA.currentTime - splitPoint) / transitionDuration);
        }
        const pct = 12 + Math.round((videoA.currentTime / totalDuration) * 77);
        el('progress-fill').style.width = `${Math.min(pct, 89)}%`;
      } else {
        drawVideoCover(ctx, videoB, cw, ch);
        const pct = 12 + Math.round(((videoA.duration + videoB.currentTime) / totalDuration) * 77);
        el('progress-fill').style.width = `${Math.min(pct, 89)}%`;
      }
      rafId = requestAnimationFrame(drawLoop);
    };

    videoA.onended = async () => {
      phase = 'B';
      await videoB.play();
    };
    videoB.onended = () => {
      if (rafId) cancelAnimationFrame(rafId);
      recorder.stop();
    };

    recorder.start(250);
    await videoA.play();
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
      console.error('MP4 conversion failed, falling back to WebM:', convertErr);
    }

    el('progress-fill').style.width = '100%';
    el('progress-label').textContent = 'Done!';

    const outUrl = URL.createObjectURL(outputBlob);
    el('result-video').src = outUrl;
    el('download-link').href = outUrl;
    el('download-link').download = `cutout-transition.${outputExt}`;

    await audioCtx.close();
    showPanel('result-panel');
  } catch (err) {
    console.error(err);
    el('error-message').textContent = err.message || String(err);
    showPanel('error-panel');
  }
}

function resetToStart() {
  state.videoAFile = null;
  state.videoBFile = null;
  el('video-a-input').value = '';
  el('video-b-input').value = '';
  el('video-a-filename').textContent = '';
  el('video-b-filename').textContent = '';
  updateGenerateButton();
  showPanel(null);
}

window.addEventListener('DOMContentLoaded', () => {
  wireUploads();
  el('generate-btn').addEventListener('click', generateTransition);
  el('restart-btn').addEventListener('click', resetToStart);
  el('error-restart-btn').addEventListener('click', resetToStart);
});
