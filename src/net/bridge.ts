/**
 * 与 Python 任务控制中心的 WebSocket 桥。
 * 连接 → 发 hello → 收 welcome（含关卡、素材清单、配乐索引、存档）→ 之后按协议双向通信。
 */
import type { VerdictMsg, WelcomeMsg } from '../sim/types';

type Handler = (msg: unknown) => void;

export class Bridge {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private pending: ((w: WelcomeMsg) => void) | null = null;
  private pendingErr: ((e: Error) => void) | null = null;
  private url = '';
  private _connected = false;
  private queue: string[] = [];
  public lastPing = 0;
  public version = '1.0.0';

  get connected(): boolean { return this._connected; }

  connect(url: string, hello: { mode: string; version: string }, timeoutMs = 12000): Promise<WelcomeMsg> {
    this.url = url;
    return new Promise<WelcomeMsg>((resolve, reject) => {
      this.pending = resolve;
      this.pendingErr = reject;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('连接任务控制中心超时'));
      }, timeoutMs);
      const finish = (w: WelcomeMsg): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(w);
      };
      this.pending = finish;

      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => {
          this._connected = true;
          this.send({ t: 'hello', version: hello.version, mode: hello.mode, ua: navigator.userAgent });
          for (const q of this.queue) ws.send(q);
          this.queue.length = 0;
        };
        ws.onmessage = (ev: MessageEvent) => {
          let msg: { t?: string } | null = null;
          try { msg = JSON.parse(String(ev.data)); } catch { return; }
          if (!msg || typeof msg.t !== 'string') return;
          if (msg.t === 'welcome') { this.pending?.(msg as unknown as WelcomeMsg); this.pending = null; }
          if (msg.t === 'ping') { this.send({ t: 'pong', client_time: Date.now() / 1000 }); return; }
          const hs = this.handlers.get(msg.t);
          if (hs) for (const h of hs) h(msg);
        };
        ws.onerror = () => {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error('WebSocket 连接失败')); }
        };
        ws.onclose = () => {
          this._connected = false;
          this.emit('close', {});
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error('连接在握手前关闭')); }
        };
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  on(t: string, fn: Handler): void {
    const arr = this.handlers.get(t) ?? [];
    arr.push(fn);
    this.handlers.set(t, arr);
  }

  private emit(t: string, msg: unknown): void {
    const hs = this.handlers.get(t);
    if (hs) for (const h of hs) h(msg);
  }

  send(msg: Record<string, unknown>): void {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (this.queue.length < 64) this.queue.push(s);
  }

  requestVerdict(result: Record<string, unknown>): Promise<VerdictMsg> {
    // 离线/未连接：立刻用与 python/physics_ref.py 同一套阈值在本地评级，不要让玩家等超时
    if (!this._connected) return Promise.resolve(this.localVerdict(result));
    return new Promise((resolve) => {
      const to = setTimeout(() => resolve(this.localVerdict(result)), 2500);
      const once = (m: unknown): void => {
        clearTimeout(to);
        resolve(m as VerdictMsg);
      };
      this.on('verdict', once);
      this.send({ t: 'result', ...result });
    });
  }

  /** 本地保真度评级：阈值与 DESIGN §2 / physics_ref.grade_fidelity 完全一致 */
  private localVerdict(result: Record<string, unknown>): VerdictMsg {
    const dE = Math.abs(Number(result.energy_drift ?? 0));
    const dL = Math.abs(Number(result.angular_drift ?? 0));
    const d = Math.max(dE, dL);
    const grade = d < 1e-5 ? 'S' : d < 1e-4 ? 'A' : d < 1e-3 ? 'B' : 'C';
    const fidelity = grade === 'S' ? 1 : grade === 'A' ? 0.85 : grade === 'B' ? 0.7 : 0.5;
    return {
      t: 'verdict',
      level_id: String(result.level_id ?? ''),
      grade,
      energy_drift: dE,
      angular_drift: dL,
      fidelity,
      par_ok: true,
      note: `本地评级（无任务控制中心）：ΔE/E=${dE.toExponential(2)}，ΔL/L=${dL.toExponential(2)}；`
        + '阈值 S<1e-5 / A<1e-4 / B<1e-3，与 python/physics_ref.py 同一套标准',
      score_bonus: 0,
    };
  }

  save(state: unknown): void { this.send({ t: 'save', state }); }
  telemetry(payload: Record<string, unknown>): void { this.send({ t: 'telemetry', ...payload }); }
  log(level: string, msg: string, data?: unknown): void { this.send({ t: 'log', level, msg, data }); }

  close(): void {
    try { this.send({ t: 'bye' }); this.ws?.close(); } catch { /* 忽略 */ }
    this.ws = null;
    this._connected = false;
  }
}
