import {
  Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, ALL_FORMATS, Quality,
  canEncodeAudio, canEncodeVideo, ConversionCanceledError,
} from 'mediabunny';
import { planJob, AUDIO_MODES, PRIORITIES, MB, formatBytes, formatTime, parseTime } from './planner.js';

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), source: $('source'), settings: $('settings'),
  size: $('size'), customSize: $('customSize'), customWrap: $('customWrap'),
  parts: $('parts'), priority: $('priority'), audio: $('audio'),
  start: $('trimStart'), end: $('trimEnd'),
  plan: $('plan'), convert: $('convert'), cancel: $('cancel'),
  progress: $('progress'), bar: $('bar'), progressText: $('progressText'),
  results: $('results'), list: $('resultList'), error: $('error'),
};

const MAX_RETRIES = 2;
const state = { file: null, input: null, meta: null, conversion: null, canceled: false, urls: [] };

// ---------- setup ----------

if (!('VideoEncoder' in window)) {
  showError('This browser cannot encode video. Use Safari on iOS 17 or newer, or a recent Chrome, Edge or Safari on a computer.');
}

els.file.addEventListener('change', () => els.file.files[0] && loadFile(els.file.files[0]));
for (const ev of ['dragenter', 'dragover']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('over'); });
}
els.drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]));

for (const el of [els.size, els.customSize, els.parts, els.priority, els.audio, els.start, els.end]) {
  el.addEventListener('input', refreshPlan);
}
els.size.addEventListener('change', () => { els.customWrap.hidden = els.size.value !== 'custom'; refreshPlan(); });
els.convert.addEventListener('click', runJob);
els.cancel.addEventListener('click', async () => {
  state.canceled = true;
  await state.conversion?.cancel();
});

// ---------- loading ----------

async function loadFile(file) {
  clearError();
  els.results.hidden = true;
  state.file = file;
  els.source.innerHTML = `<p class="muted">Reading ${escapeHtml(file.name)}…</p>`;
  els.source.hidden = false;
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('No video track found in this file.');
    const audio = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    const vStats = await video.computePacketStats(300);
    const aStats = audio ? await audio.computePacketStats(300) : null;
    state.input = input;
    state.meta = {
      duration,
      width: video.displayWidth,
      height: video.displayHeight,
      fps: vStats.averagePacketRate,
      videoCodec: video.codec,
      hasAudio: !!audio,
      audioCodec: audio?.codec ?? null,
      audioBitrate: aStats?.averageBitrate ?? 0,
      canDecode: await video.canDecode(),
    };
    state.meta.audioEncode = await probeAudioEncoding();
    renderSource();
    els.settings.hidden = false;
    refreshPlan();
  } catch (err) {
    els.source.hidden = true;
    els.settings.hidden = true;
    showError(`Couldn't read that file: ${err.message || err}`);
  }
}

let aacFallback = null;

async function probeAudioEncoding() {
  // Safari and Chrome on Linux lack a native AAC encoder; load a small WASM one only when needed.
  if (!(await canEncodeAudio('aac').catch(() => false))) {
    aacFallback ??= import('mediabunny-aac-encoder')
      .then((m) => m.registerAacEncoder())
      .catch((err) => console.warn('AAC encoder fallback unavailable', err));
    await aacFallback;
  }
  const out = {};
  for (const [key, mode] of Object.entries(AUDIO_MODES)) {
    if (!mode.bitrate) continue;
    out[key] = await canEncodeAudio('aac', {
      numberOfChannels: mode.channels, sampleRate: 48000, quality: new Quality({ bitrate: mode.bitrate }),
    }).catch(() => false);
  }
  return out;
}

function renderSource() {
  const m = state.meta;
  const rows = [
    ['File', escapeHtml(state.file.name)],
    ['Size', formatBytes(state.file.size)],
    ['Length', formatTime(m.duration)],
    ['Picture', `${m.width}×${m.height} at ${Math.round(m.fps)} fps (${m.videoCodec ?? 'unknown codec'})`],
    ['Audio', m.hasAudio ? `${m.audioCodec}, ${Math.round(m.audioBitrate / 1000)} kbps` : 'none'],
  ];
  els.source.innerHTML = `<h2>Your video</h2><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`
    + (m.canDecode ? '' : '<p class="warn">This browser cannot decode this video codec. Try Safari, which handles iPhone HEVC video.</p>');
}

// ---------- planning ----------

function settings() {
  const m = state.meta;
  const targetMB = els.size.value === 'custom' ? Number(els.customSize.value) : Number(els.size.value);
  const start = clamp(parseTime(els.start.value) ?? 0, 0, m.duration);
  const end = clamp(parseTime(els.end.value) ?? m.duration, 0, m.duration);
  const audio = resolveAudio(els.audio.value);
  return {
    targetBytes: Math.max(1, targetMB) * MB,
    parts: els.parts.value === 'auto' ? 'auto' : Number(els.parts.value),
    priority: els.priority.value,
    start, end, duration: end - start, audio,
  };
}

/** Works out how audio will actually be produced given what the browser supports. */
function resolveAudio(choice) {
  const m = state.meta;
  if (!m.hasAudio || choice === 'none') return { mode: 'none', bitrate: 0 };
  if (m.audioEncode[choice]) return { mode: 'encode', bitrate: AUDIO_MODES[choice].bitrate, channels: AUDIO_MODES[choice].channels };
  // Browser can't encode AAC (older Safari): keep the original audio as-is and budget for it.
  if (m.audioCodec === 'aac') {
    return { mode: 'copy', bitrate: Math.ceil(m.audioBitrate * 1.05), note: 'This browser can’t re-encode audio, so the original audio is kept and the picture gets a little less room.' };
  }
  return { mode: 'none', bitrate: 0, note: 'This browser can’t encode audio for this file, so the output will be silent.' };
}

function currentPlan() {
  const m = state.meta;
  const s = settings();
  if (!(s.duration > 0.5)) return { s, plan: { feasible: false, reason: 'The trim end must be after the trim start.' } };
  const plan = planJob({
    duration: s.duration, width: m.width, height: m.height, fps: m.fps,
    targetBytes: s.targetBytes, priority: s.priority, audioBitrate: s.audio.bitrate, parts: s.parts,
  });
  return { s, plan };
}

function refreshPlan() {
  if (!state.meta) return;
  const { s, plan } = currentPlan();
  if (!plan.feasible) {
    els.plan.innerHTML = `<p class="warn">${plan.reason}</p>`;
    els.convert.disabled = true;
    return;
  }
  els.convert.disabled = !state.meta.canDecode;
  const qLabel = { good: 'Good', fair: 'Fair', low: 'Low' }[plan.quality];
  let hint = '';
  if (plan.quality !== 'good' && s.parts !== 'auto') {
    const auto = planJob({ ...planArgs(s), parts: 'auto' });
    if (auto.feasible && auto.parts > plan.parts) {
      hint = `<p class="hint">Splitting into ${auto.parts} parts would give ${auto.width}×${auto.height} at ${auto.fps} fps. Set “Split into” to Auto to do that.</p>`;
    } else if (s.priority !== 'detail') {
      hint = '<p class="hint">Choosing “Sharpest frames” trades smoothness for a clearer picture.</p>';
    }
  }
  els.plan.innerHTML = `
    <h2>Plan</h2>
    <dl>
      <dt>Output</dt><dd>${plan.parts} file${plan.parts > 1 ? 's' : ''}, each up to ${formatBytes(s.targetBytes)}${plan.parts > 1 ? `, ${formatTime(plan.partDuration)} long` : ''}</dd>
      <dt>Picture</dt><dd>${plan.width}×${plan.height} at ${plan.fps} fps, H.264</dd>
      <dt>Video bitrate</dt><dd>${Math.round(plan.videoBitrate / 1000)} kbps</dd>
      <dt>Audio</dt><dd>${describeAudio(s.audio)}</dd>
      <dt>Expected quality</dt><dd class="q-${plan.quality}">${qLabel}</dd>
    </dl>
    ${s.audio.note ? `<p class="hint">${s.audio.note}</p>` : ''}
    ${hint}`;
}

function planArgs(s) {
  const m = state.meta;
  return { duration: s.duration, width: m.width, height: m.height, fps: m.fps, targetBytes: s.targetBytes, priority: s.priority, audioBitrate: s.audio.bitrate };
}

function describeAudio(a) {
  if (a.mode === 'none') return 'none';
  if (a.mode === 'copy') return `original, ${Math.round(a.bitrate / 1000)} kbps`;
  return `AAC ${a.channels === 1 ? 'mono' : 'stereo'}, ${Math.round(a.bitrate / 1000)} kbps`;
}

// ---------- conversion ----------

async function runJob() {
  const { s, plan } = currentPlan();
  if (!plan.feasible) return;
  clearError();
  revokeUrls();
  els.list.innerHTML = '';
  els.results.hidden = false;
  setBusy(true);
  state.canceled = false;

  const wake = await navigator.wakeLock?.request('screen').catch(() => null);
  const t0 = performance.now();
  const base = state.file.name.replace(/\.[^.]+$/, '');

  try {
    for (let i = 0; i < plan.parts; i++) {
      const start = s.start + i * plan.partDuration;
      const end = i === plan.parts - 1 ? s.end : start + plan.partDuration;
      const name = plan.parts > 1 ? `${base}_part${i + 1}of${plan.parts}.mp4` : `${base}_small.mp4`;
      const result = await convertPart({ s, plan, start, end, index: i, t0 });
      addResult(name, result, start, end);
    }
    setProgress(1, `Done in ${formatTime((performance.now() - t0) / 1000)}.`);
  } catch (err) {
    if (err instanceof ConversionCanceledError || state.canceled) {
      setProgress(0, 'Canceled.');
    } else {
      console.error(err);
      showError(`Conversion failed: ${err.message || err}`);
      setProgress(0, 'Stopped.');
    }
  } finally {
    wake?.release().catch(() => {});
    state.conversion = null;
    setBusy(false);
  }
}

/** Encodes one part, re-encoding at a lower bitrate if the encoder overshoots the size cap. */
async function convertPart({ s, plan, start, end, index, t0 }) {
  let videoBitrate = plan.videoBitrate;
  let bitrateMode = 'variable';
  for (let attempt = 0; ; attempt++) {
    const label = plan.parts > 1 ? `Part ${index + 1} of ${plan.parts}` : 'Converting';
    const retry = attempt ? ` (pass ${attempt + 1}, tightening to fit)` : '';
    const buffer = await encode({ s, plan, start, end, videoBitrate, bitrateMode }, (p) => {
      const overall = (index + p) / plan.parts;
      const elapsed = (performance.now() - t0) / 1000;
      const eta = overall > 0.02 ? ` · about ${formatTime(elapsed / overall - elapsed)} left` : '';
      setProgress(overall, `${label}${retry}: ${Math.round(p * 100)}%${eta}`);
    });
    if (buffer.byteLength <= s.targetBytes || attempt >= MAX_RETRIES) {
      return { buffer, overLimit: buffer.byteLength > s.targetBytes, videoBitrate };
    }
    // Scale the video share of the file down by how much we overshot, plus a margin.
    const audioBytes = (s.audio.bitrate / 8) * (end - start);
    const ratio = (s.targetBytes - audioBytes) / Math.max(1, buffer.byteLength - audioBytes);
    videoBitrate = Math.floor(videoBitrate * Math.min(0.95, ratio * 0.95));
    bitrateMode = 'constant';
  }
}

async function encode({ s, plan, start, end, videoBitrate, bitrateMode }, onProgress) {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const videoQuality = new Quality({ bitrate: videoBitrate, bitrateMode });
  const codec = (await canEncodeVideo('avc', { width: plan.width, height: plan.height, quality: videoQuality })) ? 'avc' : undefined;

  const audio = s.audio.mode === 'none'
    ? { discard: true }
    : s.audio.mode === 'copy'
      ? {}
      : { codec: 'aac', numberOfChannels: s.audio.channels, sampleRate: 48000, quality: new Quality({ bitrate: s.audio.bitrate }), forceTranscode: true };

  const conversion = await Conversion.init({
    input: state.input,
    output,
    tracks: 'primary',
    trim: { start, end },
    video: {
      width: plan.width,
      height: plan.height,
      fit: 'cover',
      frameRate: plan.fps,
      codec,
      quality: videoQuality,
      // Long GOPs save bits; 4 s still keeps seeking reasonable.
      keyFrameInterval: plan.fps <= 5 ? 10 : 4,
      forceTranscode: true,
    },
    audio,
  });
  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason.replaceAll('_', ' ')}`).join('; ');
    throw new Error(`this browser can't convert this video (${reasons})`);
  }
  state.conversion = conversion;
  if (state.canceled) await conversion.cancel();
  conversion.onProgress = onProgress;
  await conversion.execute();
  return target.buffer;
}

// ---------- results ----------

function addResult(name, { buffer, overLimit }, start, end) {
  const blob = new Blob([buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  state.urls.push(url);
  const li = document.createElement('li');
  li.innerHTML = `
    <video src="${url}" controls playsinline preload="metadata"></video>
    <div class="meta">
      <strong>${escapeHtml(name)}</strong>
      <span>${formatBytes(blob.size)} · ${formatTime(start)}–${formatTime(end)}</span>
      ${overLimit ? '<span class="warn">Still a little over the limit. Try a lower size setting.</span>' : ''}
      <span class="buttons">
        <button type="button" class="share secondary" hidden>Share</button>
        <a class="button" href="${url}" download="${escapeHtml(name)}">Save</a>
      </span>
    </div>`;
  // On iPhone the share sheet can save straight to Photos or send to the Claude app.
  const file = new File([blob], name, { type: 'video/mp4' });
  const share = li.querySelector('.share');
  if (navigator.canShare?.({ files: [file] })) {
    share.hidden = false;
    share.addEventListener('click', () => navigator.share({ files: [file] }).catch(() => {}));
  }
  els.list.append(li);
}

// ---------- helpers ----------

function setBusy(busy) {
  els.convert.hidden = busy;
  els.cancel.hidden = !busy;
  els.progress.hidden = false;
  for (const el of els.settings.querySelectorAll('select, input')) el.disabled = busy;
  els.file.disabled = busy;
  if (!busy) refreshPlan();
}

function setProgress(fraction, text) {
  els.bar.value = fraction;
  els.progressText.textContent = text;
}

function revokeUrls() {
  state.urls.forEach((u) => URL.revokeObjectURL(u));
  state.urls = [];
}

function showError(msg) { els.error.textContent = msg; els.error.hidden = false; }
function clearError() { els.error.hidden = true; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }

// Lets the page open offline once it has been loaded, like an installed app.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for automated tests.
window.__converter = { state, loadFile, runJob, currentPlan, PRIORITIES };
