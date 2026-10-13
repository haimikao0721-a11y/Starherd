/**
 * 通关片段：只留对接前大约 7 秒（墙钟）的操作，供「航线闭合」回放。
 * 更早的通关没有片段，结尾用成绩卡代替。
 */
import type { World } from '../sim/types';

/** 回放窗口（TU）。1 TU = 1.6 秒墙钟，4.4 TU ≈ 7 秒。 */
export const CLIP_WINDOW_TU = 4.4;
const KEY_EVERY_TU = 1;
const KEEP_TU = CLIP_WINDOW_TU + 1.5;

const F_ENGAGED = 1;
const F_REPEL = 2;
const F_PRECISE = 4;

export interface ClipBody {
  id: number;
  x: number; y: number; vx: number; vy: number;
  alive: 0 | 1;
  delivered: 0 | 1;
  integrity: number;
}

export interface ClipSample {
  t: number;
  tx: number; ty: number;
  mass: number;
  flags: number;
}

export interface LevelClip {
  t0: number;
  fuel: number;
  objectiveIndex: number;
  dockBody: number;
  ox: number; oy: number;
  radius: number; vMax: number;
  bodies: ClipBody[];
  wellX: number; wellY: number; wellVx: number; wellVy: number;
  samples: ClipSample[];
}

interface Keyframe { t: number; clip: Omit<LevelClip, 'samples'>; }

const q = (n: number): number => Math.round(n * 1000) / 1000;

function flagsOf(world: World): number {
  const w = world.well;
  return (w.engaged ? F_ENGAGED : 0) | (w.repel ? F_REPEL : 0) | (w.precise ? F_PRECISE : 0);
}

function capture(world: World): Omit<LevelClip, 'samples'> {
  const bodies: ClipBody[] = [];
  for (const b of world.bodies) {
    if (!b.alive && !b.delivered && b.kind !== 'pod') continue;
    bodies.push({
      id: b.id,
      x: q(b.x), y: q(b.y), vx: q(b.vx), vy: q(b.vy),
      alive: b.alive ? 1 : 0,
      delivered: b.delivered ? 1 : 0,
      integrity: q(b.integrity),
    });
  }
  return {
    t0: q(world.time),
    fuel: q(world.fuel),
    objectiveIndex: world.level.objectiveIndex ?? 0,
    dockBody: world.dock.bodyId,
    ox: q(world.dock.ox), oy: q(world.dock.oy),
    radius: world.dock.radius, vMax: world.dock.vMax,
    bodies,
    wellX: q(world.well.x), wellY: q(world.well.y),
    wellVx: q(world.well.vx), wellVy: q(world.well.vy),
  };
}

export class ClipRecorder {
  private keys: Keyframe[] = [];
  private samples: ClipSample[] = [];
  private lastKey = -1;

  reset(): void {
    this.keys = [];
    this.samples = [];
    this.lastKey = -1;
  }

  note(world: World): void {
    if (world.status !== 'running') return;
    const t = world.time;
    if (this.lastKey < 0 || t - this.lastKey >= KEY_EVERY_TU) {
      this.keys.push({ t, clip: capture(world) });
      this.lastKey = t;
    }
    this.samples.push({
      t: q(t),
      tx: q(world.well.tx), ty: q(world.well.ty),
      mass: q(world.well.targetMass),
      flags: flagsOf(world),
    });
    const cutoff = t - KEEP_TU;
    while (this.keys.length > 2 && this.keys[1].t < cutoff) this.keys.shift();
    while (this.samples.length > 1 && this.samples[0].t < cutoff) this.samples.shift();
  }

  /** 取结尾窗口。关卡太短时有多长留多长。 */
  freeze(): LevelClip | null {
    if (!this.keys.length || this.samples.length < 2) return null;
    const end = this.samples[this.samples.length - 1].t;
    const start = Math.max(this.keys[0].t, end - CLIP_WINDOW_TU);
    let key = this.keys[0];
    for (const k of this.keys) if (k.t <= start + 1e-6) key = k;
    const samples = this.samples.filter((s) => s.t >= key.t - 1e-6);
    if (samples.length < 2) return null;
    return { ...key.clip, samples };
  }
}

export function applyClip(world: World, clip: LevelClip): void {
  world.time = clip.t0;
  world.fuel = clip.fuel;
  world.status = 'running';
  world.level.objectiveIndex = clip.objectiveIndex ?? 0;
  world.dock.bodyId = clip.dockBody;
  world.dock.ox = clip.ox;
  world.dock.oy = clip.oy;
  world.dock.radius = clip.radius;
  world.dock.vMax = clip.vMax;
  const byId = new Map(clip.bodies.map((b) => [b.id, b]));
  for (const b of world.bodies) {
    const s = byId.get(b.id);
    if (!s) continue;
    b.x = s.x; b.y = s.y; b.vx = s.vx; b.vy = s.vy;
    b.px = s.x; b.py = s.y;
    b.alive = s.alive === 1;
    b.delivered = s.delivered === 1;
    b.docked = s.delivered === 1;
    b.integrity = s.integrity;
  }
  const station = world.primaries.find((p) => p.id === world.dock.bodyId);
  if (station) {
    world.dock.x = station.x + world.dock.ox;
    world.dock.y = station.y + world.dock.oy;
  }
  const w = world.well;
  w.x = clip.wellX; w.y = clip.wellY;
  w.vx = clip.wellVx; w.vy = clip.wellVy;
  w.px = w.x; w.py = w.y;
  const first = clip.samples[0];
  if (first) applySample(world, first);
}

export function applySample(world: World, s: ClipSample): void {
  const w = world.well;
  w.tx = s.tx; w.ty = s.ty;
  w.ltx = s.tx; w.lty = s.ty;
  w.tvx = 0; w.tvy = 0;
  w.targetMass = s.mass;
  w.mass = s.mass;
  w.engaged = (s.flags & F_ENGAGED) !== 0;
  w.repel = (s.flags & F_REPEL) !== 0;
  w.precise = (s.flags & F_PRECISE) !== 0;
}

export function sampleAt(clip: LevelClip, time: number): ClipSample | null {
  let hit: ClipSample | null = null;
  for (const s of clip.samples) {
    if (s.t <= time + 1e-4) hit = s;
    else break;
  }
  return hit;
}

export function routeStanding(
  levels: readonly { id: string }[],
  scores: Record<string, { grade?: string } | undefined>,
): { total: number; cleared: number; all: boolean; flawless: boolean } {
  const total = levels.length;
  let cleared = 0;
  let flawless = total > 0;
  for (const lv of levels) {
    const b = scores[lv.id];
    if (!b) { flawless = false; continue; }
    cleared++;
    if (b.grade !== 'S') flawless = false;
  }
  return { total, cleared, all: total > 0 && cleared === total, flawless: flawless && cleared === total };
}
