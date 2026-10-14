import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planJob, planPart, parseTime, MB } from '../js/planner.js';

const iphone = { width: 1920, height: 1080, fps: 30 };

test('short clip keeps full 1080p at 30 fps', () => {
  const p = planPart({ ...iphone, duration: 30, targetBytes: 30 * MB, priority: 'balanced', audioBitrate: 48000 });
  assert.equal(p.feasible, true);
  assert.equal(p.height, 1080);
  assert.equal(p.fps, 30);
  assert.equal(p.quality, 'good');
});

test('portrait 4K source is capped at 1080 short side and keeps orientation', () => {
  const p = planPart({ width: 2160, height: 3840, fps: 60, duration: 30, targetBytes: 100 * MB, priority: 'smooth', audioBitrate: 48000 });
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  assert.equal(p.fps, 30);
});

test('sharpest-frames drops fps before resolution', () => {
  const args = { ...iphone, duration: 1800, targetBytes: 30 * MB, audioBitrate: 48000 };
  const detail = planPart({ ...args, priority: 'detail' });
  const smooth = planPart({ ...args, priority: 'smooth' });
  assert.ok(detail.fps < smooth.fps);
  assert.ok(detail.height > smooth.height);
});

test('budget never exceeds the target', () => {
  for (const duration of [10, 300, 3600]) {
    const p = planPart({ ...iphone, duration, targetBytes: 30 * MB, priority: 'detail', audioBitrate: 48000 });
    if (!p.feasible) continue;
    const bytes = ((p.videoBitrate + p.audioBitrate) * duration) / 8;
    assert.ok(bytes < 30 * MB * 0.97, `${duration}s -> ${bytes}`);
  }
});

test('impossible budgets are reported, auto split fixes them', () => {
  const args = { ...iphone, duration: 4 * 3600, targetBytes: 5 * MB, priority: 'smooth', audioBitrate: 128000 };
  assert.equal(planJob({ ...args, parts: 1 }).feasible, false);
  const auto = planJob({ ...args, parts: 'auto', maxParts: 200 });
  assert.equal(auto.feasible, true);
  assert.ok(auto.parts > 1);
});

test('auto split picks one file when one is enough', () => {
  assert.equal(planJob({ ...iphone, duration: 60, targetBytes: 30 * MB, priority: 'balanced', audioBitrate: 48000, parts: 'auto' }).parts, 1);
});

test('dimensions are even', () => {
  const p = planPart({ width: 1442, height: 1081, fps: 30, duration: 900, targetBytes: 30 * MB, priority: 'balanced', audioBitrate: 0 });
  assert.equal(p.width % 2, 0);
  assert.equal(p.height % 2, 0);
});

test('parseTime', () => {
  assert.equal(parseTime('90'), 90);
  assert.equal(parseTime('1:30'), 90);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime(''), null);
  assert.equal(parseTime('abc'), null);
});
