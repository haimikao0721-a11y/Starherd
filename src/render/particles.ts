/**
 * STARHERD — 粒子与冲击波（W-render）
 *
 * 全部走预分配 typed array（SoA）与固定容量环形池：
 *  - 热循环内不 new 对象 / 不 new 数组 / 不 new canvas
 *  - 颜色用整数槽（SpriteBank.slot），粒子只存 Int16 槽位
 *  - 随机数走确定性 xorshift32（便于自动化测试复现）
 *  - 发光走预渲染精灵 + 'lighter'，绝不使用 shadowBlur / filter
 */
import type { FxEvent, Palette, Quality, ViewState, World } from '../sim/types';
import { DrawEnv, SpriteBank, blitC, clamp, mixColor, perf, rnd, rndR, tintColor, TAU } from './draw';

export const K_SPARK = 0;
export const K_SHARD = 1;
export const K_STREAK = 2;
export const K_GLOW = 3;

const RING_CAP = 72;
const SLOT_WHITE = 0;
/** 火花批量绘制时本帧允许的不同颜色槽上限（一次 fill/槽） */
const ACTIVE_SLOTS = 24;
/** 碎片数超过此值改为批量三角绘制（省 draw call） */
const SHARD_SPRITE_MAX = 96;

export class Particles {
  private cap = 0;
  private limit = 0;
  private count = 0;
  private cursor = 0;

  private px!: Float32Array;
  private py!: Float32Array;
  private vx!: Float32Array;
  private vy!: Float32Array;
  private life!: Float32Array;
  private maxLife!: Float32Array;
  private size!: Float32Array;
  private rot!: Float32Array;
  private spin!: Float32Array;
  private drag!: Float32Array;
  private slot!: Int16Array;
  private kind!: Uint8Array;
  private activeSlots = new Int16Array(ACTIVE_SLOTS);
  private shardSlots = new Int16Array(ACTIVE_SLOTS);

  /* 冲击波环池 */
  private rn = 0;
  private rCursor = 0;
  private rx = new Float32Array(RING_CAP);
  private ry = new Float32Array(RING_CAP);
  private rr = new Float32Array(RING_CAP);
  private rv = new Float32Array(RING_CAP);
  private rl = new Float32Array(RING_CAP);
  private rm = new Float32Array(RING_CAP);
  private rs = new Int16Array(RING_CAP);
  private rw = new Float32Array(RING_CAP);

  /** 最近一次 warn 事件（渲染器读给 postfx 做危险脉动） */
  warn = 0;
  /** 本帧由特效产生的屏震冲量（渲染器读取后清零） */
  impulse = 0;

  constructor(capacity: number) {
    this.alloc(Math.max(64, capacity | 0));
  }

  private alloc(n: number): void {
    this.cap = n;
    this.limit = n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.slot = new Int16Array(n);
    this.kind = new Uint8Array(n);
  }

  get live(): number {
    return this.count;
  }
  get capacity(): number {
    return this.cap;
  }

  /** 质量变更：只在需要扩容时重建 typed array（不每帧分配） */
  setCapacity(n: number): void {
    const want = Math.max(64, n | 0);
    this.limit = want;
    if (want > this.cap) {
      const old = { px: this.px, py: this.py, vx: this.vx, vy: this.vy, life: this.life, maxLife: this.maxLife, size: this.size, rot: this.rot, spin: this.spin, drag: this.drag, slot: this.slot, kind: this.kind, cap: this.cap };
      this.alloc(want);
      const keep = Math.min(old.cap, want);
      this.px.set(old.px.subarray(0, keep));
      this.py.set(old.py.subarray(0, keep));
      this.vx.set(old.vx.subarray(0, keep));
      this.vy.set(old.vy.subarray(0, keep));
      this.life.set(old.life.subarray(0, keep));
      this.maxLife.set(old.maxLife.subarray(0, keep));
      this.size.set(old.size.subarray(0, keep));
      this.rot.set(old.rot.subarray(0, keep));
      this.spin.set(old.spin.subarray(0, keep));
      this.drag.set(old.drag.subarray(0, keep));
      this.slot.set(old.slot.subarray(0, keep));
      this.kind.set(old.kind.subarray(0, keep));
      this.count = Math.min(this.count, keep);
    }
  }

  reset(): void {
    this.life.fill(0);
    this.count = 0;
    this.cursor = 0;
    this.rn = 0;
    this.rCursor = 0;
    this.warn = 0;
    this.impulse = 0;
  }

  /* ------------------------------------------------------------ 生成 */

  private slotOf(bank: SpriteBank, p: Palette, tint: number): number {
    return bank.slot(tintColor(p, tint));
  }

  private spawn(kind: number, x: number, y: number, vx: number, vy: number, life: number, size: number, slot: number, drag: number, spin: number): void {
    if (this.count >= this.limit) return;
    let i = this.cursor;
    let guard = 0;
    while (this.life[i] > 0 && guard < this.cap) {
      i++;
      if (i >= this.cap) i = 0;
      guard++;
    }
    if (guard >= this.cap) return;
    this.cursor = i + 1 >= this.cap ? 0 : i + 1;
    this.px[i] = x; this.py[i] = y;
    this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size;
    this.slot[i] = slot;
    this.kind[i] = kind;
    this.drag[i] = drag;
    this.rot[i] = rnd() * TAU;
    this.spin[i] = spin;
    this.count++;
  }

  ring(x: number, y: number, r0: number, vr: number, life: number, slot: number, width: number): void {
    const i = this.rCursor;
    this.rCursor = i + 1 >= RING_CAP ? 0 : i + 1;
    this.rx[i] = x; this.ry[i] = y;
    this.rr[i] = r0; this.rv[i] = vr;
    this.rl[i] = life; this.rm[i] = life;
    this.rs[i] = slot; this.rw[i] = width;
    if (this.rn < RING_CAP) this.rn++;
  }

  private jet(x: number, y: number, dx: number, dy: number, n: number, spread: number, sp0: number, sp1: number, life: number, size: number, slot: number, kind: number): void {
    const base = Math.atan2(dy, dx);
    for (let i = 0; i < n; i++) {
      const a = base + (rnd() * 2 - 1) * spread;
      const sp = rndR(sp0, sp1);
      this.spawn(kind, x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * rndR(0.7, 1.25), size * rndR(0.6, 1.4), slot, kind === K_SHARD ? 0.2 : 1.4, kind === K_SHARD ? (rnd() * 2 - 1) * 3 : 0);
    }
  }

  private radial(x: number, y: number, n: number, a0: number, a1: number, sp0: number, sp1: number, life: number, size: number, slot: number, kind: number, drag: number): void {
    for (let i = 0; i < n; i++) {
      const a = a0 + (a1 - a0) * rnd();
      const sp = rndR(sp0, sp1);
      this.spawn(kind, x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * rndR(0.7, 1.3), size * rndR(0.6, 1.4), slot, drag, kind === K_SHARD ? (rnd() * 2 - 1) * 3.2 : 0);
    }
  }

  /**
   * 把一条特效并入粒子系统。返回屏震冲量（0..2）。
   * world 用于取主恒星位置（星风）与场景尺度。
   */
  emit(ev: FxEvent, world: World, pal: Palette, view: ViewState, bank: SpriteBank): number {
    const x = ev.x || 0, y = ev.y || 0;
    let dx = ev.nx || 0, dy = ev.ny || 0;
    let mag = ev.mag;
    if (!(mag > 0)) mag = 1;
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) { dx = 1; dy = 0; } else { dx /= dl; dy /= dl; }
    const q = view.quality;
    const rich = clamp((q && q.maxParticles > 0 ? q.maxParticles : 2200) / 2200, 0.25, 1);
    const slotTint = this.slotOf(bank, pal, ev.tint);
    const sDanger = bank.slot(pal.danger);
    const sPod = bank.slot(pal.pod);
    const sStation = bank.slot(pal.station);
    const sWell = bank.slot(pal.well);
    const sOrbit = bank.slot(pal.orbit);
    let imp = 0;
    switch (ev.kind) {
      case 'impact': {
        const n = Math.round(16 * rich);
        this.jet(x, y, dx, dy, n, 0.55, 0.05, 0.42 * (0.6 + mag), 0.55, 0.016, slotTint, K_SPARK);
        this.jet(x, y, dx, dy, Math.round(4 * rich), 1.1, 0.03, 0.14, 0.9, 0.014, slotTint, K_SHARD);
        this.ring(x, y, 0.01, 0.28 + mag * 0.1, 0.34, slotTint, 2.4);
        imp = clamp(mag * 0.5, 0.08, 0.7);
        break;
      }
      case 'dock': {
        this.ring(x, y, 0.02, 0.55, 0.75, sStation, 5);
        this.ring(x, y, 0.01, 0.28, 0.5, bank.slot('#ffffff'), 2.5);
        const n = Math.round(26 * rich);
        for (let i = 0; i < n; i++) {
          const a = rnd() * TAU, r = rndR(0.01, 0.06);
          this.spawn(K_GLOW, x + Math.cos(a) * r, y + Math.sin(a) * r, Math.cos(a) * rndR(0.02, 0.1), Math.sin(a) * rndR(0.02, 0.1) - 0.06, rndR(0.5, 1.3), 0.02, sStation, 0.5, 0);
        }
        break;
      }
      case 'lost': {
        this.radial(x, y, Math.round(34 * rich), 0, TAU, 0.06, 0.5, 1.0, 0.02, sDanger, K_SHARD, 0.22);
        this.radial(x, y, Math.round(24 * rich), 0, TAU, 0.1, 0.8, 0.5, 0.02, sDanger, K_SPARK, 1.6);
        this.radial(x, y, Math.round(10 * rich), 0, TAU, 0.05, 0.4, 0.35, 0.03, bank.slot('#ffffff'), K_SPARK, 2.0);
        this.ring(x, y, 0.02, 0.9, 0.85, sDanger, 7);
        this.ring(x, y, 0.01, 0.45, 0.55, bank.slot('#ffffff'), 3);
        imp = 1.5;
        break;
      }
      case 'fragment':
      case 'tear': {
        const big = ev.kind === 'tear';
        this.radial(x, y, Math.round((big ? 26 : 14) * rich), 0, TAU, 0.05, big ? 0.6 : 0.35, big ? 1.3 : 0.9, 0.017, sPod, K_SHARD, 0.2);
        this.jet(x, y, dx, dy, Math.round((big ? 22 : 12) * rich), 0.9, 0.08, 0.45, 0.7, 0.022, sOrbit, K_STREAK);
        this.ring(x, y, 0.015, big ? 0.6 : 0.35, 0.6, sOrbit, 3.4);
        imp = big ? 0.8 : 0.35;
        break;
      }
      case 'wind': {
        // 星风：从恒星向外的高速条纹
        const n = Math.round(52 * rich);
        for (let i = 0; i < n; i++) {
          const a = rnd() * TAU;
          const sp = rndR(0.5, 1.5);
          const r0 = rndR(0, 0.05);
          this.spawn(K_STREAK, x + Math.cos(a) * r0, y + Math.sin(a) * r0, Math.cos(a) * sp, Math.sin(a) * sp, rndR(0.7, 1.5), 0.02, slotTint, 0.06, 0);
        }
        break;
      }
      case 'pulse': {
        this.ring(x, y, 0.03, 1.25, 0.7, sWell, 6);
        this.ring(x, y, 0.02, 0.7, 0.45, bank.slot('#ffffff'), 3);
        this.radial(x, y, Math.round(14 * rich), 0, TAU, 0.06, 0.4, 0.6, 0.016, sWell, K_SPARK, 1.5);
        imp = 0.2;
        break;
      }
      case 'ignite': {
        this.jet(x, y, -dx, -dy, Math.round(20 * rich), 0.4, 0.1, 0.5, 0.45, 0.018, sPod, K_SPARK);
        this.jet(x, y, -dx, -dy, Math.round(6 * rich), 0.3, 0.05, 0.2, 0.8, 0.02, bank.slot('#ffffff'), K_GLOW);
        this.ring(x, y, 0.008, 0.3, 0.3, sPod, 2);
        imp = 0.25;
        break;
      }
      case 'thruster': {
        this.jet(x, y, -dx, -dy, 3, 0.28, 0.06, 0.24, 0.28, 0.013, sPod, K_SPARK);
        break;
      }
      case 'warn': {
        this.warn = 1;
        this.ring(x, y, 0.02, 0.5, 0.9, sDanger, 4);
        break;
      }
      case 'win': {
        this.ring(x, y, 0.03, 0.8, 1.1, sStation, 6);
        this.ring(x, y, 0.02, 0.45, 0.8, bank.slot('#ffffff'), 3);
        const n = Math.round(46 * rich);
        for (let i = 0; i < n; i++) {
          const a = rnd() * TAU, r = rndR(0.01, 0.18);
          this.spawn(K_GLOW, x + Math.cos(a) * r, y + Math.sin(a) * r, Math.cos(a) * rndR(0.01, 0.06), -rndR(0.05, 0.22), rndR(0.8, 2.0), 0.02, sStation, 0.35, 0);
        }
        break;
      }
      case 'fail': {
        this.radial(x, y, Math.round(30 * rich), 0, TAU, 0.05, 0.45, 1.2, 0.02, sDanger, K_SHARD, 0.25);
        this.ring(x, y, 0.02, 0.6, 1.0, sDanger, 5);
        imp = 0.9;
        break;
      }
      case 'soi':
      case 'enter': {
        this.ring(x, y, 0.02, 0.5, 0.8, sOrbit, 4);
        this.radial(x, y, Math.round(18 * rich), 0, TAU, 0.03, 0.22, 0.9, 0.018, sOrbit, K_GLOW, 0.4);
        break;
      }
      case 'countdown': {
        this.ring(x, y, 0.01, 0.25, 0.4, sOrbit, 2.5);
        break;
      }
      default: {
        this.radial(x, y, Math.round(10 * rich), 0, TAU, 0.04, 0.3, 0.6, 0.016, slotTint, K_SPARK, 1.2);
        break;
      }
    }
    this.impulse += imp;
    return imp;
  }

  /* ------------------------------------------------------------ 更新 */

  update(dt: number, world: World | null): void {
    if (dt <= 0) return;
    const n = this.cap;
    let live = 0;
    for (let i = 0; i < n; i++) {
      const l = this.life[i];
      if (l <= 0) continue;
      const nl = l - dt;
      if (nl <= 0) {
        this.life[i] = 0;
        continue;
      }
      this.life[i] = nl;
      live++;
      const d = this.drag[i];
      if (d > 0) {
        const f = 1 - d * dt;
        const k = f < 0 ? 0 : f;
        this.vx[i] *= k;
        this.vy[i] *= k;
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      if (this.spin[i] !== 0) this.rot[i] += this.spin[i] * dt;
    }
    this.count = live;
    // 冲击波环
    let rn = 0;
    for (let i = 0; i < RING_CAP; i++) {
      const l = this.rl[i];
      if (l <= 0) continue;
      const nl = l - dt;
      if (nl <= 0) { this.rl[i] = 0; continue; }
      this.rl[i] = nl;
      this.rr[i] += this.rv[i] * dt;
      rn++;
    }
    this.rn = rn;
  }

  /* ------------------------------------------------------------ 绘制 */

  draw(env: DrawEnv): void {
    const g = env.g;
    const bank = env.bank;
    const n = this.cap;
    const st = this.stat;
    st.sparks = 0; st.shards = 0; st.streaks = 0; st.glows = 0; st.rings = 0; st.spriteShards = 0;
    if (this.count > 0) {
      g.globalCompositeOperation = 'lighter';
      // 统计 + 收集本帧火花用到的颜色槽（单遍，零分配）
      let slots = 0;
      let shardCount = 0;
      for (let i = 0; i < n; i++) {
        const l = this.life[i];
        if (l <= 0) continue;
        const k = this.kind[i];
        if (k === K_SPARK) {
          st.sparks++;
          const s = this.slot[i];
          let seen = false;
          for (let q = 0; q < slots; q++) {
            if (this.activeSlots[q] === s) { seen = true; break; }
          }
          if (!seen && slots < ACTIVE_SLOTS) this.activeSlots[slots++] = s;
        } else if (k === K_SHARD) shardCount++;
        else if (k === K_STREAK) st.streaks++;
        else st.glows++;
      }
      st.shards = shardCount;
      // 1) 火花：按颜色槽批量填充（每槽一次 fill，而不是每粒子一次 drawImage）
      //    半径随寿命连续收缩 ⇒ 不加 per-particle alpha 也能读出衰减
      for (let k = 0; k < slots; k++) {
        const s = this.activeSlots[k];
        g.fillStyle = bank.colorOf(s);
        g.globalAlpha = 0.85;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          if (this.life[i] <= 0 || this.kind[i] !== K_SPARK || this.slot[i] !== s) continue;
          const f = this.life[i] / this.maxLife[i];
          const r = this.size[i] * (0.35 + f * 0.85) * 1.9;
          if (r <= 0.02) continue;
          g.moveTo(this.px[i] + r, this.py[i]);
          g.arc(this.px[i], this.py[i], r, 0, TAU);
        }
        g.fill();
        perf.draws++;
      }
      // 2) 碎片：数量少 → 旋转精灵（好看）；数量多 → 按槽批量三角（省 draw call）
      if (shardCount <= SHARD_SPRITE_MAX) {
        st.spriteShards = shardCount;
        for (let i = 0; i < n; i++) {
          if (this.life[i] <= 0 || this.kind[i] !== K_SHARD) continue;
          const f = this.life[i] / this.maxLife[i];
          const sz = this.size[i] * (0.7 + f * 0.6) * 2.6;
          g.save();
          g.translate(this.px[i], this.py[i]);
          g.rotate(this.rot[i]);
          blitC(g, bank.bySlot('shard', this.slot[i], 0), 0, 0, sz, sz, Math.pow(f, 0.55) * 0.95);
          g.restore();
        }
      } else {
        for (let band = 0; band < 2; band++) {
          const lo = band === 0 ? 0 : 0.5;
          const hi = band === 0 ? 0.5 : 1.01;
          const a = band === 0 ? 0.42 : 0.95;
          let sCount = 0;
          for (let k = 0; k < ACTIVE_SLOTS; k++) this.shardSlots[k] = -1;
          for (let i = 0; i < n; i++) {
            if (this.life[i] <= 0 || this.kind[i] !== K_SHARD) continue;
            const f = this.life[i] / this.maxLife[i];
            if (f < lo || f >= hi) continue;
            const s = this.slot[i];
            let seen = false;
            for (let q = 0; q < sCount; q++) {
              if (this.shardSlots[q] === s) { seen = true; break; }
            }
            if (!seen && sCount < ACTIVE_SLOTS) this.shardSlots[sCount++] = s;
          }
          for (let q = 0; q < sCount; q++) {
            const s = this.shardSlots[q];
            g.fillStyle = bank.colorOf(s);
            g.globalAlpha = a;
            g.beginPath();
            for (let i = 0; i < n; i++) {
              if (this.life[i] <= 0 || this.kind[i] !== K_SHARD || this.slot[i] !== s) continue;
              const f = this.life[i] / this.maxLife[i];
              if (f < lo || f >= hi) continue;
              const r = this.size[i] * (0.7 + f * 0.6) * 1.35;
              const ca = Math.cos(this.rot[i]) * r, sa = Math.sin(this.rot[i]) * r;
              const x = this.px[i], y = this.py[i];
              g.moveTo(x + (-0.85 * ca - -0.25 * sa), y + (-0.85 * sa + -0.25 * ca));
              g.lineTo(x + (0.9 * ca - -0.6 * sa), y + (0.9 * sa + -0.6 * ca));
              g.lineTo(x + (0.35 * ca - 0.75 * sa), y + (0.35 * sa + 0.75 * ca));
              g.closePath();
            }
            g.fill();
            perf.draws++;
          }
        }
      }
      // 3) 条纹（星风/潮汐拉伸）：逐条 stroke（数量受控）
      g.lineCap = 'round';
      g.lineWidth = 1.5 * env.inv;
      for (let i = 0; i < n; i++) {
        if (this.life[i] <= 0 || this.kind[i] !== K_STREAK) continue;
        const f = this.life[i] / this.maxLife[i];
        const L = Math.min(0.09, Math.hypot(this.vx[i], this.vy[i]) * 0.12);
        g.strokeStyle = bank.colorOf(this.slot[i]);
        g.globalAlpha = Math.pow(f, 0.6) * 0.75;
        g.beginPath();
        g.moveTo(this.px[i], this.py[i]);
        g.lineTo(this.px[i] - this.vx[i] * L, this.py[i] - this.vy[i] * L);
        g.stroke();
        perf.draws++;
      }
      // 4) 柔光点（上升粒子）
      for (let i = 0; i < n; i++) {
        if (this.life[i] <= 0 || this.kind[i] !== K_GLOW) continue;
        const f = this.life[i] / this.maxLife[i];
        const sz = this.size[i] * (2.2 + (1 - f) * 2.2);
        blitC(g, bank.bySlot('glow_soft', this.slot[i], 0), this.px[i], this.py[i], sz, sz, Math.pow(f, 0.8) * 0.75 * env.gs);
      }
    }
    // 冲击波环
    if (this.rn > 0) {
      g.globalCompositeOperation = 'lighter';
      const cap = 320 * env.inv;
      for (let i = 0; i < RING_CAP; i++) {
        const l = this.rl[i];
        if (l <= 0) continue;
        const f = l / this.rm[i];
        const fw = (1 - f) * (1 - f);
        let d = this.rr[i] * 2;
        if (d > cap) d = cap;
        blitC(g, bank.bySlot('glow_ring', this.rs[i], 0), this.rx[i], this.ry[i], d, d, (0.25 + 0.75 * f) * 0.85);
        let d2 = d * 1.5;
        if (d2 > cap) d2 = cap;
        blitC(g, bank.bySlot('glow_soft', this.rs[i], 0), this.rx[i], this.ry[i], d2, d2, fw * 0.28 * env.gs);
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  /** 危险脉动：把调色板 danger 颜色交给 postfx（无分配） */
  dangerColor(pal: Palette): string {
    return this.warn > 0 ? pal.danger : mixColor(pal.bg, pal.bg2, 0.5);
  }

  /** 上一帧各类粒子的实际绘制数量（诊断/自动化用） */
  readonly stat = { sparks: 0, shards: 0, streaks: 0, glows: 0, rings: 0, spriteShards: 0 };
}

export type { Quality };
