/**
 * mp4-export.js
 * Converts a recorded WebM Blob into an MP4 Blob entirely in the browser,
 * using ffmpeg.wasm (a WebAssembly build of FFmpeg — no server involved).
 *
 * WHY THIS IS NEEDED: MediaRecorder (what actually captures the canvas +
 * audio) can only write WebM in Chrome/Firefox/Android — there's no
 * browser API to record MP4 directly outside Safari. This re-encodes
 * after the fact instead.
 *
 * QUALITY NOTE: this is a real re-encode (VP8/VP9 -> H.264), not just a
 * container swap, so it is not lossless. CRF 17 below is in the
 * "visually lossless" range — the difference is not perceptible in
 * normal viewing, but it isn't bit-for-bit identical either.
 *
 * Uses the single-thread ffmpeg-core build on purpose: the faster
 * multi-thread build needs special cross-origin-isolation HTTP headers
 * that a plain GitHub Pages site can't set. Single-thread is slower but
 * needs nothing special from the hosting.
 */

const FFMPEG_VERSION = '0.12.10';
const CORE_VERSION = '0.12.10';
const UTIL_VERSION = '0.12.1';

let ffmpegInstance = null;

async function getFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;

  const { FFmpeg } = await import(
    `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/index.js`
  );
  const { toBlobURL } = await import(
    `https://cdn.jsdelivr.net/npm/@ffmpeg/util@${UTIL_VERSION}/dist/esm/index.js`
  );

  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => {
    if (typeof progress === 'number' && isFinite(progress)) {
      onProgress(Math.max(0, Math.min(99, Math.round(progress * 100))));
    }
  });

  const baseURL = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

/**
 * @param {Blob} webmBlob
 * @param {(pct: number) => void} onProgress  0-99 during encode (caller sets 100 on completion)
 * @returns {Promise<Blob>} an MP4 blob
 */
export async function convertWebmToMp4(webmBlob, onProgress = () => {}) {
  const { fetchFile } = await import(
    `https://cdn.jsdelivr.net/npm/@ffmpeg/util@${UTIL_VERSION}/dist/esm/index.js`
  );

  const ffmpeg = await getFFmpeg(onProgress);

  await ffmpeg.writeFile('input.webm', await fetchFile(webmBlob));

  await ffmpeg.exec([
    '-i', 'input.webm',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '17',          // ~visually lossless; lower = higher quality/bigger file
    '-pix_fmt', 'yuv420p',  // widest device/player compatibility
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart', // lets the mp4 start playing before it's fully downloaded
    'output.mp4',
  ]);

  const data = await ffmpeg.readFile('output.mp4');
  await ffmpeg.deleteFile('input.webm');
  await ffmpeg.deleteFile('output.mp4');

  return new Blob([data.buffer], { type: 'video/mp4' });
}
