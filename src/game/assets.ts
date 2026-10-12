/**
 * 素材仓库：从 Python 宿主拉取 manifest 声明的 PNG / WAV / 音乐谱，带进度回调与容错。
 * render / audio 只通过 AssetStore 接口读取（见 src/sim/types.ts）。
 */
import type { AssetStore, Manifest, MusicIndexEntry, MusicScore } from '../sim/types';

export class Assets implements AssetStore {
  manifest: Manifest;
  musicIndex: MusicIndexEntry[];
  assetBase: string;
  readonly images = new Map<string, HTMLImageElement>();
  private buffers = new Map<string, AudioBuffer>();
  private scores = new Map<string, MusicScore>();
  private _ready = false;
  public errors: string[] = [];
  public loadedCount = 0;
  public totalCount = 0;

  constructor(manifest: Manifest, musicIndex: MusicIndexEntry[], assetBase: string) {
    this.manifest = manifest ?? emptyManifest();
    this.musicIndex = musicIndex ?? [];
    // 空串是合法值（离线单文件版把素材内联成 data URL，不需要任何前缀）；
    // 注意不能用 `''.endsWith('/') ? … : '/'` 那套，否则空串会被补成 '/' 把 data URL 拼坏。
    this.assetBase = assetBase === '' ? '' : (assetBase.endsWith('/') ? assetBase : `${assetBase}/`);
  }

  get ready(): boolean { return this._ready; }

  image(name: string): HTMLImageElement | undefined { return this.images.get(name); }
  audioBuffer(name: string): AudioBuffer | undefined { return this.buffers.get(name); }
  music(name: string): MusicScore | undefined { return this.scores.get(name); }

  audioUrl(name: string): string {
    const e = this.manifest.audio.find((a) => a.name === name);
    if (e) return this.assetBase + e.file;
    return `${this.assetBase}audio/${name}.wav`;
  }

  async load(ctx: AudioContext | null, onProgress?: (loaded: number, total: number, label: string) => void): Promise<void> {
    const art = this.manifest.art ?? [];
    const audio = this.manifest.audio ?? [];
    const music = this.manifest.music ?? [];
    this.totalCount = art.length + audio.length + music.length;
    let done = 0;
    const tick = (label: string): void => { done++; this.loadedCount = done; onProgress?.(done, this.totalCount, label); };

    // 贴图（并行，失败仅记录）
    await Promise.all(art.map((e) => new Promise<void>((res) => {
      const img = new Image();
      img.onload = () => { this.images.set(e.name, img); tick(e.name); res(); };
      img.onerror = () => { this.errors.push(`贴图缺失: ${e.name}`); tick(e.name); res(); };
      // 缓存参数只在走 HTTP 时拼：data URL 后面接 ?v= 会直接把它弄坏（离线单文件版因此丢贴图）
      const bust = this.assetBase ? `?v=${this.manifest.seed ?? 0}` : '';
      img.src = `${this.assetBase}${e.file}${bust}`;
    })));

    // 音乐谱
    await Promise.all(music.map((e) => (async () => {
      try {
        const r = await fetch(`${this.assetBase}${e.file}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as MusicScore;
        this.scores.set(e.name, j);
      } catch (err) {
        this.errors.push(`乐谱缺失: ${e.name} (${String(err)})`);
      } finally { tick(e.name); }
    })()));

    // 音频（解码需要 AudioContext；若不可用则留给音频引擎用合成音替代）
    if (ctx) {
      await Promise.all(audio.map((e) => (async () => {
        try {
          const r = await fetch(`${this.assetBase}${e.file}`);
          if (!r.ok) throw new Error(String(r.status));
          const buf = await r.arrayBuffer();
          const decoded = await ctx.decodeAudioData(buf.slice(0));
          this.buffers.set(e.name, decoded);
        } catch (err) {
          this.errors.push(`音频缺失: ${e.name} (${String(err)})`);
        } finally { tick(e.name); }
      })()));
    } else {
      for (const e of audio) tick(e.name);
    }
    this._ready = true;
  }
}

function emptyManifest(): Manifest {
  return {
    version: '0', generator: 'fallback', seed: 0, generated_at: new Date().toISOString(),
    audio: [], art: [], music: [], total_bytes: 0,
  };
}

/** 素材加载全部失败时也要能跑：生成一套纯代码的内置贴图（保证渲染不空） */
export function installFallbackSprites(assets: Assets): void {
  const mk = (name: string, size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): void => {
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const c = cv.getContext('2d');
    if (!c) return;
    draw(c, size);
    const img = new Image();
    img.src = cv.toDataURL('image/png');
    assets.images.set(name, img);
  };
  const names: [string, number][] = [
    ['glow_soft', 256], ['glow_ring', 256], ['spark', 64], ['shard', 64],
    ['vignette', 512], ['lens_gradient', 256], ['ring_dock', 256], ['grid_hex', 256],
    ['star_field', 512], ['nebula_loop1', 512], ['nebula_loop2', 512], ['nebula_loop3', 512], ['nebula_loop4', 512],
  ];
  for (const [name, size] of names) {
    if (assets.image(name)) continue;
    mk(name, size, (c, s) => {
      const id = c.createImageData(s, s);
      const h = s / 2;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const d = Math.hypot(x - h, y - h) / h;
          const i = (y * s + x) * 4;
          let a = 0;
          if (name.startsWith('glow')) a = Math.max(0, 1 - d) ** 2.2;
          else if (name === 'spark' || name === 'shard') a = Math.max(0, 1 - d) ** 1.2;
          else if (name === 'vignette') a = Math.min(1, Math.max(0, (d - 0.55) / 0.45)) ** 1.5;
          else if (name === 'ring_dock') a = Math.exp(-Math.abs(d - 0.72) * 26);
          else if (name === 'lens_gradient') a = Math.exp(-Math.abs(d - 0.85) * 12);
          else if (name.startsWith('nebula')) a = Math.max(0, 1 - d) ** 3 * 0.6;
          else a = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1 > 0.995) ? 1 : 0;
          id.data[i] = 255; id.data[i + 1] = 255; id.data[i + 2] = 255;
          id.data[i + 3] = Math.round(Math.min(1, a) * 255);
        }
      }
      c.putImageData(id, 0, 0);
    });
  }
}
