// Pure encoding planner: given the source video and a size budget, picks the
// resolution, frame rate and bitrates that keep the most visual detail.
// No browser APIs here so it can be unit tested in Node.

export const MB = 1024 * 1024;

// Short-side ladder. Anything above 1080p is wasted on AI models, which
// downscale frames to roughly 1.5 megapixels before looking at them.
const SHORT_SIDES = [1080, 900, 720, 640, 540, 480, 432, 360, 288, 240, 180, 144];

// Frame rates each priority is allowed to drop to, best first.
export const PRIORITIES = {
  smooth: { fps: [30, 24], weight: 1.0, label: 'Smooth motion' },
  balanced: { fps: [30, 24, 15, 10], weight: 0.5, label: 'Balanced' },
  detail: { fps: [30, 24, 15, 10, 5, 3, 2, 1], weight: 0.35, label: 'Sharpest frames' },
};

export const AUDIO_MODES = {
  speech: { bitrate: 32_000, channels: 1, label: 'Speech (mono, 32 kbps)' },
  music: { bitrate: 128_000, channels: 2, label: 'Full (stereo, 128 kbps)' },
  none: { bitrate: 0, channels: 0, label: 'No audio' },
};

// H.264 bits per pixel per frame that still looks clean. Below the floor,
// blocking becomes obvious.
export const BPP_GOOD = 0.085;
export const BPP_FLOOR = 0.04;

const MIN_VIDEO_BITRATE = 16_000;

// Claude and most vision models resize frames to about 1.4 MP, so pixels past
// that count for little when ranking options.
const USEFUL_PIXELS = 1.4e6;
const usefulPixels = (px) => Math.min(px, USEFUL_PIXELS) + 0.1 * Math.max(0, px - USEFUL_PIXELS);

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Usable bytes after MP4 container overhead (moov index ~ 12 bytes/frame). */
export function payloadBytes(targetBytes, durationSec, fps) {
  const index = durationSec * (fps + 50) * 12; // video + audio sample tables
  return targetBytes * 0.97 - 64 * 1024 - index;
}

export function sizeFor(srcW, srcH, shortSide) {
  const srcShort = Math.min(srcW, srcH);
  const scale = Math.min(1, shortSide / srcShort);
  return { width: even(srcW * scale), height: even(srcH * scale) };
}

/**
 * @param {object} p
 * @param {number} p.duration      seconds of video in one output file
 * @param {number} p.width         source display width
 * @param {number} p.height        source display height
 * @param {number} p.fps           source frame rate
 * @param {number} p.targetBytes   maximum output file size
 * @param {keyof PRIORITIES} p.priority
 * @param {number} p.audioBitrate  bits/s spent on audio (0 for none)
 * @param {number} [p.bitrateScale] correction after an overshooting attempt
 */
export function planPart({ duration, width, height, fps, targetBytes, priority, audioBitrate, bitrateScale = 1 }) {
  const pr = PRIORITIES[priority] ?? PRIORITIES.balanced;
  const srcFps = Math.min(30, fps > 0 ? fps : 30);
  const fpsOptions = [...new Set([srcFps, ...pr.fps.filter((f) => f < srcFps)])];

  const srcShort = Math.min(width, height);
  const shorts = [...new Set([Math.min(srcShort, 1080), ...SHORT_SIDES.filter((s) => s < srcShort)])];

  const candidates = [];
  for (const f of fpsOptions) {
    const total = (payloadBytes(targetBytes, duration, f) * 8) / duration;
    const videoBitrate = Math.floor((total - audioBitrate) * bitrateScale);
    for (const s of shorts) {
      const { width: w, height: h } = sizeFor(width, height, s);
      const bpp = videoBitrate / (w * h * f);
      candidates.push({ width: w, height: h, fps: f, videoBitrate, bpp, score: usefulPixels(w * h) * Math.pow(f, pr.weight) });
    }
  }

  const ok = candidates.filter((c) => c.videoBitrate >= MIN_VIDEO_BITRATE);
  if (!ok.length) {
    return { feasible: false, reason: 'The size limit is too small for this much video. Split it into more parts or trim it.' };
  }
  const good = ok.filter((c) => c.bpp >= BPP_GOOD);
  const pool = good.length ? good : ok.filter((c) => c.bpp >= BPP_FLOOR);
  const pick = pool.length
    ? pool.reduce((a, b) => (b.score > a.score ? b : a))
    : ok.reduce((a, b) => (b.bpp > a.bpp ? b : a));

  const quality = pick.bpp >= BPP_GOOD ? 'good' : pick.bpp >= BPP_FLOOR ? 'fair' : 'low';
  return { feasible: true, quality, ...pick, audioBitrate };
}

/**
 * Plans the whole job, splitting into `parts` equal pieces (or the fewest that
 * reach good quality at a useful resolution when parts === 'auto').
 */
export function planJob({ duration, width, height, fps, targetBytes, priority, audioBitrate, parts, maxParts = 20 }) {
  const make = (n) => {
    const partDuration = duration / n;
    return { parts: n, partDuration, ...planPart({ duration: partDuration, width, height, fps, targetBytes, priority, audioBitrate }) };
  };
  if (parts !== 'auto') return make(Math.max(1, Math.floor(parts)));

  const wantShort = Math.min(720, Math.min(width, height));
  for (let n = 1; n <= maxParts; n++) {
    const plan = make(n);
    if (plan.feasible && plan.quality === 'good' && Math.min(plan.width, plan.height) >= wantShort) return plan;
  }
  return make(maxParts);
}

/** Smallest number of parts that would give good quality, for a hint in the UI. */
export function suggestParts(args) {
  const plan = planJob({ ...args, parts: 'auto' });
  return plan.parts;
}

export function formatBytes(b) {
  if (b >= 1024 * MB) return (b / (1024 * MB)).toFixed(2) + ' GB';
  if (b >= MB) return (b / MB).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}

export function formatTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Parses "90", "1:30" or "1:02:03" into seconds. Returns null when blank or invalid. */
export function parseTime(str) {
  const t = String(str ?? '').trim();
  if (!t) return null;
  const bits = t.split(':').map(Number);
  if (bits.some((n) => !Number.isFinite(n) || n < 0) || bits.length > 3) return null;
  return bits.reduce((acc, n) => acc * 60 + n, 0);
}
