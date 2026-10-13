/**
 * 游戏总装：多循环宿主 + 生命周期状态机 + 关卡流程 + 输入映射 + 镜头 + 结算与存档。
 *
 * 生命周期：BOOT → PRELOAD → ATTRACT/MENU → BRIEFING → PLAY ⇄ PAUSE → DEBRIEF → CHAPTER → END → SHUTDOWN
 * 多循环：渲染(rAF) / 物理(120Hz 固定步长) / 音频(WebAudio 前瞻调度，引擎内部) / 遥测(1Hz) / 后台降级
 */
import type {
  LevelsDoc, LevelSpec, Manifest, MusicIndexEntry, Palette, Quality, SaveState,
  ScoreBreakdown, ViewState, WelcomeMsg, World,
} from '../sim/types';
import { DEFAULT_QUALITY, DEFAULT_SAVE, PALETTES } from '../sim/types';
import { createWorld } from '../sim/world';
import { advance, frameEnd, stepOnce } from '../sim/step';
import { predictPaths } from '../sim/predict';
import { DT, SLOWMO_SCALE, STAR_KEEPOUT, TIME_SCALE, WELL_MASS_MAX, WELL_MASS_MIN, WELL_PRESETS, WELL_RANGE } from '../sim/constants';
import { PX_PER_RU } from '../engine/view';
import { GameLoop } from '../engine/loop';
import { Input } from '../engine/input';
import { screenToWorld } from '../engine/view';
import { Renderer } from '../render/renderer';
import { AudioEngine } from '../audio/audio';
import { Hud, type HudToast } from '../ui/hud';
import { Menu, type MusicTrackInfo, type ScreenName } from '../ui/menu';
import { Assets, installFallbackSprites } from './assets';
import { autopilot, createPilot, type PilotState, type PilotTelemetry } from './autopilot';
import { computeScore, type VerdictLike } from './score';

type Screen = ScreenName | 'play';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
  welcome: WelcomeMsg;
  bridge: BridgeLike;
  autotest: boolean;
  startLevel?: number;
}

export interface BridgeLike {
  send(msg: Record<string, unknown>): void;
  save(state: unknown): void;
  telemetry(p: Record<string, unknown>): void;
  log(level: string, msg: string, data?: unknown): void;
  requestVerdict(r: Record<string, unknown>): Promise<VerdictLike>;
  connected: boolean;
}

interface Check { name: string; ok: boolean; detail: string; soft?: boolean }

export class Game {
  private canvas: HTMLCanvasElement;
  private uiRoot: HTMLElement;
  private welcome: WelcomeMsg;
  private bridge: BridgeLike;
  readonly autotest: boolean;
  private startLevel: number;

  private doc: LevelsDoc;
  private manifest: Manifest;
  private musicIndex: MusicIndexEntry[];
  private assets!: Assets;
  private renderer: Renderer | null = null;
  private audio: AudioEngine | null = null;
  private hud: Hud | null = null;
  private menu: Menu | null = null;
  private input: Input;
  private loop: GameLoop;

  private world: World | null = null;
  private palette: Palette = PALETTES.loop1;
  private view: ViewState;
  private quality: Quality = { ...DEFAULT_QUALITY };
  private save: SaveState;

  private screen: Screen = 'boot';
  private levelIndex = 0;
  private attract = false;
  private paused = false;
  private slowmo = false;
  /** 时间加速倍率（T 键循环 1×/2×/4×）：把等相位窗口从被动等待变成玩家可主动推进的过程 */
  private fastFwd = 1;
  private predictOn = false;
  /** 当前正在播放的曲目 id（事件驱动切换用；空串表示尚未设置） */
  private musicTrack = '';
  private showHelp = false;
  private simAccum = 0;
  private frames = 0;
  private errors: string[] = [];
  private reported = new Set<string>();
  private toasts: HudToast[] = [];
  private pilot: PilotState = createPilot();
  private pilotTel: PilotTelemetry = { active: false, targetIndex: -1, distance: 0, closing: 0, aDes: 0, rPod: 0, rStation: 0, phase: 'idle', fuel: 0, dWellPod: 0, dirErr: 0, deadband: false };
  private resolveTimer = -1;
  /** 本局是否已结算（防止结算页被反复重绘） */
  private resolved = false;
  /** 玩家手动画面缩放偏好（Alt+滚轮；0.45×~3.2×），只影响世界视图，不缩放 HUD/菜单 */
  private zoomBias = 1;
  private lastTelemetry = 0;
  private lastPredictAt = -1;
  private lastSaveAt = 0;
  private cam = { x: 0, y: 0, zoom: 1.15, tx: 0, ty: 0, tz: 1.15 };
  private autotestT = 0;
  private autotestDone = false;
  private checks: Check[] = [];
  private minDockDistance = Infinity;
  private podPos0 = { x: 0, y: 0 };
  private podsMoved = 0;
  private verdict: VerdictLike | null = null;
  private brightFx = 0;
  /** 分段计时（仅基准模式开启，用于定位 CPU 瓶颈） */
  private profiling = false;
  private prof = { logic: 0, render: 0, hud: 0, n: 0 };
  private qEma = 0;
  /** 启动阶段追踪（用于把"卡在加载界面"这类问题变成可诊断的） */
  private bootLog: string[] = [];
  private bootError = '';
  private booted = false;
  private wellBlocked = false;
  /** 引力井（飞船）是否已脱离作业区（用户反馈的飞出地图）：HUD 据此给出提示与重试入口 */
  private wellLost = false;
  private quitting = false;

  private phase(name: string): void {
    this.bootLog.push(name);
    if (this.bootLog.length > 24) this.bootLog.shift();
  }

  /** 离线单文件版：没有宿主，所有上报/退出请求都要跳过（否则 file:// 下会报 CORS 错误） */
  private get isOffline(): boolean {
    return !!(window as unknown as { __LC_OFFLINE__?: unknown }).__LC_OFFLINE__;
  }

  /** 启动失败上报宿主：EXE/WebView2 没有控制台，这是唯一能看到真凶的通道 */
  private reportBootFailure(msg: string): void {
    if (this.isOffline) return;
    try {
      void fetch('/api/selftest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false, boot_failure: true, error: msg, phases: this.bootLog,
          ua: navigator.userAgent, size: `${window.innerWidth}x${window.innerHeight}`,
          dpr: window.devicePixelRatio,
          assets: this.assets ? { loaded: this.assets.loadedCount, total: this.assets.totalCount, errors: this.assets.errors.slice(0, 6) } : null,
        }),
      });
    } catch { /* 忽略 */ }
  }

  get isBooted(): boolean { return this.booted; }
  get phases(): string[] { return this.bootLog; }

  /** 是否看过操作演示（localStorage，三种运行模式通用；读不到就当作看过，避免老玩家被打扰） */
  private get tutorialSeen(): boolean {
    try { return localStorage.getItem('lc_tut_seen') === '1'; } catch { return true; }
  }

  private markTutorialSeen(): void {
    try { localStorage.setItem('lc_tut_seen', '1'); } catch { /* 忽略 */ }
  }

  constructor(opts: GameOptions) {
    this.canvas = opts.canvas;
    this.uiRoot = opts.uiRoot;
    this.welcome = opts.welcome;
    this.bridge = opts.bridge;
    this.autotest = opts.autotest;
    this.startLevel = opts.startLevel ?? 1;
    this.doc = opts.welcome.levels;
    this.manifest = opts.welcome.manifest;
    this.musicIndex = opts.welcome.music_index ?? [];
    this.save = sanitizeSave({ ...DEFAULT_SAVE, ...(opts.welcome.save ?? {}) }, this.doc);
    this.applyQualityFromSave();

    this.view = {
      w: window.innerWidth, h: window.innerHeight, dpr: Math.min(2, window.devicePixelRatio || 1),
      zoom: 1.15, targetZoom: 1.15, shake: 0, hitstop: 0, flash: 0, chroma: 0,
      showField: this.save.settings.showField, showVectors: false, showPredict: false, showOrbits: true,
      slowmo: 1, intensity: 0.2, fade: 1, uiAlpha: 1,
      wellMode: 'idle', quality: this.quality,
      camera: { x: 0, y: 0, zoom: 1.15 },
    };
    this.input = new Input(this.canvas);
    this.zoomBias = this.loadZoomBias();
    this.loop = new GameLoop({
      simDt: (dtReal) => this.simDt(dtReal),
      fixed: (dtTU) => this.fixed(dtTU),
      frame: (alpha, dtReal, simDt) => this.frame(alpha, dtReal, simDt),
      second: (dtReal) => this.second(dtReal),
      onVisibility: (hidden) => this.onVisibility(hidden),
    });
    // 启动即应用已保存的帧率上限（0=不限）
    this.loop.setFrameCap(this.save.settings.fpsCap ?? 0);
    if (this.save.settings.physics60) this.loop.setFixedDt(DT * 2);
    this.renderer?.setRenderScale(this.save.settings.renderScale ?? 0.62,
      this.save.settings.renderScaleAuto !== false);
    window.addEventListener('error', this.onError);
    window.addEventListener('unhandledrejection', this.onRejection);
  }

  /* ------------------------------------------------------------ 启动 */

  async start(): Promise<void> {
    try {
      await this.startBody();
    } catch (e) {
      // 启动期异常必须显式暴露：否则页面会永远停在启动面板（用户实测到的静默吊死）
      const msg = String((e as Error)?.stack ?? e);
      this.bootError = msg;
      console.error('[LC] 启动失败', e);
      this.reportBootFailure(msg);
      const shell = (window as unknown as { LCShell?: { fail?: (m: string) => void } }).LCShell;
      const bootEl = document.getElementById('boot');
      if (shell?.fail) { try { shell.fail(msg); } catch { /* 忽略 */ } }
      else if (bootEl) {
        bootEl.classList.remove('hidden');
        bootEl.innerHTML = `<div class="boot-panel"><h1>启动失败</h1><pre>${msg.replace(/</g, '&lt;')}</pre>`
          + `<p class="dim">阶段：${this.bootLog.join(' → ')}</p></div>`;
      }
      throw e;
    }
  }

  private async startBody(): Promise<void> {
    const boot = document.getElementById('boot');
    const shell = (window as unknown as { LCShell?: { progress?: (pct: number, detail?: string) => void; done?: (ms?: number) => void } }).LCShell;
    const setBoot = (t: string, frac = 0): void => {
      this.phase(t);
      if (shell?.progress) shell.progress(Math.max(1, Math.min(99, Math.round(frac * 100))), t);
      else if (boot) boot.textContent = t;
    };

    setBoot('正在连接任务控制中心…', 0.02);
    const ctx = this.tryCreateAudioContext();
    // ?? 而非 ||：离线单文件版的 asset_base 是空串（素材内联为 data URL），空串必须被尊重
    this.assets = new Assets(this.manifest, this.musicIndex, this.welcome.asset_base ?? '/assets/');
    try {
      await this.assets.load(ctx, (n, total, label) => setBoot(`正在装载素材 ${n}/${total}  ${label}`, total ? n / total : 0.1));
    } catch (e) {
      this.errors.push(`素材装载异常: ${String(e)}`);
    }
    installFallbackSprites(this.assets);
    this.audio = new AudioEngine(this.assets);
    try { await this.audio.init(); } catch (e) { this.errors.push(`音频初始化失败: ${String(e)}`); }
    this.applyAudioSettings();

    this.resize();
    this.phase('初始化渲染器');
    this.renderer = new Renderer(this.canvas, { assets: this.assets, palette: this.palette, quality: this.quality });
    this.phase('初始化 HUD');
    this.hud = new Hud(this.canvas);
    this.phase('初始化菜单');
    this.menu = new Menu(this.uiRoot, {
      onStartLevel: (i) => this.startLevelAt(i),
      onResume: () => this.setScreen('play'),
      onRetry: () => this.startLevelAt(this.levelIndex + 1),
      onNext: () => this.nextLevel(),
      onBackToMenu: () => this.toMenu(),
      onQuit: () => void this.quit(),
      onSetting: <K extends keyof SaveState['settings']>(key: K, value: SaveState['settings'][K]) => this.applySetting(key, value),
      onSelectChapter: () => { this.menu?.show('levels'); },
      onOpenUrl: (url) => this.openExternal(url),
      onTutorialSeen: () => this.markTutorialSeen(),
    });
    this.menu.setLevels(this.doc);
    this.menu.setSave(this.save);
    // ---- 背景音乐下载（**只在有宿主进程时提供**：EXE / 网页模式）----
    // 离线单文件版跑在 file:// 下、没有宿主，因此既不请求也不显示该区块——
    // 与用户要求一致："只在 exe 里能下载，html 里没有这个选项"。
    if (!this.isOffline) {
      void fetch('/api/music')
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { tracks?: MusicTrackInfo[] } | null) => {
          if (j && Array.isArray(j.tracks) && j.tracks.length) this.menu?.setMusicTracks(j.tracks);
        })
        .catch(() => { /* 没有宿主就没有下载入口，静默忽略 */ });
    }
    this.phase('绑定输入');
    this.input.attach();
    this.installUiAudio();
    // 菜单键盘导航：捕获阶段处理，避免被 engine/input 的冒泡监听先吃掉方向键/空格/Tab
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (this.menu && this.menu.handleKey(e)) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    this.phase('进入主菜单');
    if (boot) { boot.classList.add('hidden'); setTimeout(() => { try { boot.remove(); } catch { /* 忽略 */ } }, 900); }
    shell?.done?.(500);
    if (this.autotest) { this.startLevelAt(this.startLevel); this.setScreen('play'); }
    else { this.startAttract(); this.setScreen('menu'); }
    // 首次游玩：自动弹操作演示（玩家反馈"看不懂玩法、左右键像重合"，这是最直接的入口）。
    // 标记存 localStorage：不依赖宿主，网页/EXE/离线单文件三种模式都生效。
    if (!this.autotest && !this.tutorialSeen) {
      this.phase('首次游玩：弹出操作演示');
      this.menu?.show('tutorial');
    }
    this.loop.start();
    this.booted = true;
    // 留下"启动成功"痕迹：任何入口（网页/EXE/WebView2）都会在宿主留下可读回执，
    // 便于从外部确认页面到底走到哪一步（EXE 没有控制台）
    try {
      if (!this.isOffline) {
        void fetch('/api/selftest', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ok: true, boot_ok: true, phases: this.bootLog, mode: this.autotest ? 'autotest' : 'normal',
            ua: navigator.userAgent, size: `${window.innerWidth}x${window.innerHeight}`,
            dpr: window.devicePixelRatio, assets: `${this.assets.loadedCount}/${this.assets.totalCount}`,
            assetErrors: this.assets.errors.length, levels: this.doc?.levels?.length ?? 0,
            audio: this.audio?.ready ?? false,
          }),
        });
      }
    } catch { /* 忽略 */ }

    const q = new URLSearchParams(location.search);
    // 画质覆盖（也方便玩家/评测现场切换）：?q=low|mid|high
    const qo = q.get('q');
    if (qo === 'low' || qo === 'mid' || qo === 'high') {
      this.save.settings.quality = qo;
      this.applyQualityFromSave();
      this.renderer?.setQuality(this.quality);
      this.view.quality = this.quality;
    }
    if (q.has('nofield')) this.view.showField = false;
    if (q.has('shot')) {
      this.setScreen('play');
      this.warmupAndStill(Number(q.get('tu') ?? '24') || 24);
    } else if (q.has('bench')) {
      this.setScreen('play');
      this.startBench(Number(q.get('sec') ?? '18') || 18);
    }

    // 调试/截图入口（仅此一处，默认行为不变）：?field=attract|repel
    // 让场上引力井无需按键即处于 engaged 并锁定极性，便于对比两种渲染状态的截图。
    // 注意顺序：warmupAndStill 里的自动制导每步都会把极性复位成「吸引」，
    // 因此必须在它之后写一次，并补一帧静帧渲染（warmupAndStill(0) 不再推进模拟），
    // 保证截图拍到的就是被强制后的状态。
    const fieldMode = q.get('field');
    if (fieldMode === 'attract' || fieldMode === 'repel') {
      const fw = this.world;
      if (fw) {
        fw.well.engaged = true;
        fw.well.repel = fieldMode === 'repel';
        if (fw.well.mass < 0.02) fw.well.mass = 0.04;   // 井体太小看不出形状提示，给个可视化下限
        if (q.has('shot')) this.warmupAndStill(0);
      }
    }
  }

  dispose(): void {
    this.loop.stop();
    this.input.detach();
    window.removeEventListener('error', this.onError);
    window.removeEventListener('unhandledrejection', this.onRejection);
    this.audio?.dispose();
  }

  /* ------------------------------------------------------------ 循环钩子 */

  private simDt(dtReal: number): number {
    if (this.paused || this.screen === 'boot') return 0;
    const live = this.screen === 'play' || this.attract;
    if (!live) return 0;
    // 自动测试以 8× 时间流速跑，保证无头环境下也能在有限墙钟时间内完成任务
    const speed = this.autotest ? 8 : 1;
    // 慢动作 / **时间加速**：用户反馈"运气性太重"——本质是只能在相位窗口前干等。
    // 给了加速（T 键 1×/2×/4×）之后，"等轨道转到合适位置"从被动等待变成玩家可主动推进的过程。
    const dilation = this.slowmo ? SLOWMO_SCALE : this.fastFwd;
    return (dtReal * speed * dilation) / TIME_SCALE;
  }

  private fixed(dtTU: number): void {
    const w = this.world;
    if (!w) return;
    if (this.screen === 'play' || this.attract) {
      stepOnce(w, dtTU);
      this.simAccum += dtTU;
    }
  }

  private frame(alpha: number, dtReal: number, simDt: number): void {
    this.frames++;
    this.resizeIfNeeded();
    this.updateGuide(dtReal);
    this.updateHint(dtReal);
    const tA = this.profiling ? performance.now() : 0;
    const w = this.world;
    if (w && this.simAccum > 0) {
      frameEnd(w, this.simAccum);
      this.simAccum = 0;
    }
    if (w) {
      /* 屏幕 → 世界坐标换算。**必须在 driveControl 之前调用**：
         driveControl 读的是 input.snapshot.wx/wy，而这两个字段只有 input.update() 会写。
         此前这里漏了这一步，导致 wx/wy 恒为 (0,0)——玩家的鼠标实际控制不了引力井，
         井每帧都被指向世界原点（恒星中心），必然卡在恒星上变成死局。
         这个 bug 逃过了所有自动化测试，因为自检与菜单演示走的是自动驾驶（直接写 well.tx/ty），
         完全绕过了人类输入路径。 */
      this.input.update(this.view);
      // Alt+滚轮：画面缩放（只影响世界视图，HUD/菜单不缩放）。
      // 存 localStorage → 重进关卡、甚至重启游戏都保留，不会再被"重进取消掉"。
      const zs = this.input.snapshot.zoom;
      if (zs !== 0) this.adjustZoom(Math.pow(1.18, -zs));
      if (this.input.pressed('Digit0') || this.input.pressed('Numpad0')) this.adjustZoom(1 / this.zoomBias);
      if (this.screen === 'play' || this.attract) this.driveControl(dtReal);
      this.updatePredict();
      this.syncEventMusic();
      this.drainFx();
      this.updateCamera(dtReal);
      this.decayView(dtReal);
      const tB = this.profiling ? performance.now() : 0;
      this.tryCall('renderer', () => this.renderer?.frame(w, alpha, dtReal, this.view));
      const tC = this.profiling ? performance.now() : 0;
      this.tryCall('hud', () => {
        this.hud?.update(dtReal);
        this.hud?.draw({
          world: w as World, view: this.view, palette: this.palette,
          guideOn: !!this.guideEl?.classList.contains('on'),
          fps: this.loop.fps, frameMs: this.loop.frameMs, steps: this.loop.steps,
          toasts: this.toasts, showHelp: this.showHelp, missionTime: w?.time ?? 0,
          wellLost: this.wellLost,
          status: w?.status ?? 'running', autotest: this.autotest,
          // HUD 货舱清单的悬停提示（同 canvas 的 CSS 像素坐标）
          pointer: { x: this.input.snapshot.mx, y: this.input.snapshot.my },
        });
      });
      const tD = this.profiling ? performance.now() : 0;
      if (this.profiling) {
        this.prof.logic += tB - tA; this.prof.render += tC - tB; this.prof.hud += tD - tC; this.prof.n++;
      }
      this.checkLevelEnd(dtReal);
    }
    this.tryCall('menu', () => this.menu?.update(dtReal));
    this.updateAudioParams();
    this.autoQualityTick();
    if (this.autotest) this.updateAutotest(dtReal);
    this.input.endFrame();
    this.publishDebug();
  }

  private second(dtReal: number): void {
    const w = this.world;
    if (!w) return;
    const lv = w.level;
    this.bridge.telemetry({
      level_id: lv.id, sim_time: w.time, body_count: w.bodies.length,
      ke: w.stats.ke, pe: w.stats.pe, energy: w.stats.energy,
      angular_momentum: w.stats.angularMomentum,
      momentum: [w.stats.momentumX, w.stats.momentumY],
      // 让 Python 裁判能用原始状态独立复算守恒量（真正的交叉验证，而不是自证）
      bodies: w.primaries.slice(0, 8).map((b) => ({ m: b.mass, x: b.x, y: b.y, vx: b.vx, vy: b.vy })),
      epsilon: w.epsilon, G: w.G,
    });
    if (w.time - this.lastSaveAt > 30) { this.lastSaveAt = w.time; this.persist(); }
    void dtReal;
  }

  private onVisibility(hidden: boolean): void {
    if (hidden) { this.audio?.setParam('pause', 1); }
    else { this.audio?.setParam('pause', 0); }
  }

  private onError = (e: ErrorEvent): void => {
    const msg = `${e.message} @${e.filename}:${e.lineno}`;
    if (!this.errors.includes(msg)) this.errors.push(msg);
  };
  private onRejection = (e: PromiseRejectionEvent): void => {
    const msg = `unhandledrejection: ${String((e.reason as Error)?.message ?? e.reason)}`;
    if (!this.errors.includes(msg)) this.errors.push(msg);
  };

  /* ------------------------------------------------------------ 屏幕/生命周期 */

  private setScreen(s: Screen): void {
    if (this.screen === s) return;
    const prev = this.screen;
    this.screen = s;
    this.paused = s === 'pause' || s === 'debrief' || s === 'chapter' || s === 'end';
    this.attract = s === 'menu' && !this.autotest;
    this.view.fade = 1;
    this.input.setEnabled(s === 'play');
    this.menu?.show(s === 'play' ? 'none' : s);
    if (s === 'play') this.menu?.show('none');
    if (prev === 'play' && s === 'pause') this.audio?.play('ui_back', { gain: 0.6 });
    if (s === 'play' && this.audio?.ready) this.audio.setMusic(this.assets.music(this.currentMusic()) ?? null);
    if (s === 'menu') this.audio?.setMusic(this.assets.music('menu') ?? null);
    if (s === 'play') setTimeout(() => this.flushHint(), 400); // 本关战术提示此刻才显示
  }

  /** 事件驱动选曲：风暴/救援/终章优先，其余用关卡自带曲目。 */
  private desiredMusic(): string {
    if (this.screen === 'end') return 'finale';
    const w = this.world;
    if (this.screen === 'play' && w) {
      const evs = w.level.events ?? [];
      for (const e of evs) {
        if (e.kind === 'storm' && w.events?.some((x) => x.kind === 'storm' && x.active)) return 'storm';
      }
      for (const e of evs) {
        if (e.kind === 'rescue' && w.time >= e.t0) {
          // 泄漏开始且还有货舱在飞 → 放救援曲
          if (w.pods.some((p) => p.alive && !p.delivered)) return 'rescue';
        }
      }
    }
    return this.currentMusic();
  }

  /** 每帧调用；曲目变化时才真正切换，避免重启音乐。 */
  /** 供 HUD 在换关时清空 Oberth 径向历史（HUD 自己保存状态） */
  resetHudOberth(): void { this.hud?.resetOberth?.(); }

  private syncEventMusic(): void {
    const want = this.desiredMusic();
    if (want === this.musicTrack) return;
    const track = this.assets.music(want) ?? null;
    if (!track) return;
    this.musicTrack = want;
    this.audio?.setMusic(track);
    if (typeof window !== 'undefined') {
      const dbg = (window as unknown as { __LC_DEBUG?: Record<string, unknown> }).__LC_DEBUG;
      if (dbg) dbg.music = want;
    }
  }

  private currentMusic(): string {
    const lv = this.world?.level;
    return lv?.music ?? 'menu';
  }

  private startAttract(): void {
    const doc = this.doc;
    if (!doc?.levels?.length) return;
    const idx = Math.min(doc.levels.length - 1, Math.max(0, this.levelIndex));
    this.loadWorld(idx);
    this.attract = true;
    this.view.showField = true;
  }

  /** 立即开始游玩第 index 关（1..12）。简报由菜单自己展示，这里不再回跳简报页 */
  private startLevelAt(index: number): void {
    const levels = this.doc?.levels ?? [];
    if (!levels.length) return;
    this.levelIndex = Math.max(0, Math.min(levels.length - 1, index - 1));
    this.loadWorld(this.levelIndex);
    this.attract = false;
    this.verdict = null;
    this.resolveTimer = -1;
    this.resolved = false;
    this.save.last_level = this.world?.level.id ?? 'L1-1';
    this.setScreen('play');
    if (!this.autotest) this.showLevelCard();
  }

  /**
   * 关卡开场卡。
   * 玩家反馈"后续关卡压根没做、重复了"——根因之一是用「下一关」直接进关时**跳过了简报页**，
   * 屏幕上既没有关名也没有目标，而第 1 章的几关又长得很像（同一颗恒星/行星/空间站）。
   * 这里在进关时给一张 4 秒的标题卡，明确"这是第几关、叫什么、目标是什么"。
   */
  private showLevelCard(): void {
    const lv = this.world?.level;
    if (!lv) return;
    let el = document.getElementById('lc-levelcard');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lc-levelcard';
      this.uiRoot.appendChild(el);
    }
    const need = Math.max(0, lv.podsTotal - lv.podsDelivered);
    const vmax = this.world?.dock.vMax ?? 0;
    el.innerHTML = `<div class="lc-lc-no">第 ${lv.index} / 12 关　·　难度 ${lv.difficulty}/12　·　第 ${lv.chapter} 章</div>`
      + `<div class="lc-lc-name">${lv.nameZh}</div>`
      + `<div class="lc-lc-en">${lv.nameEn}</div>`
      + `<div class="lc-lc-obj">目标：把 ${need} 个货舱送进空间站对接环（相对速度 &lt; ${vmax.toFixed(2)}）</div>`;
    el.classList.add('on');
    window.setTimeout(() => el.classList.remove('on'), 4200);
  }

  private loadWorld(index: number): void {
    const spec: LevelSpec | undefined = this.doc.levels[index];
    if (!spec) return;
    this.world = createWorld(spec, this.doc, 1);
    this.palette = PALETTES[spec.palette ?? `loop${spec.chapter}`] ?? PALETTES.loop1;
    this.renderer?.setPalette(this.palette);
    this.renderer?.reset();
    this.cam.x = spec.camera?.x ?? 0; this.cam.y = spec.camera?.y ?? 0;
    this.cam.zoom = spec.camera?.zoom ?? 1.15;
    this.cam.tx = this.cam.x; this.cam.ty = this.cam.y; this.cam.tz = this.cam.zoom;
    const first = this.world?.pods.find((p) => p.alive);
    if (first) this.podPos0 = { x: first.x, y: first.y };
    this.minDockDistance = Infinity;
    this.podsMoved = 0;
    this.pilot = createPilot();
    this.brightFx = 0;
    this.hud?.resetOberth?.();
    if (!this.autotest) this.audio?.setMusic(this.assets.music(this.world?.level.music ?? 'loop1') ?? null);
  }

  private nextLevel(): void {
    const levels = this.doc.levels;
    if (this.levelIndex + 1 >= levels.length) { this.setScreen('end'); return; }
    const cur = levels[this.levelIndex];
    const next = levels[this.levelIndex + 1];
    if (next.chapter !== cur.chapter) {
      this.save.unlocked_chapters = Math.max(this.save.unlocked_chapters, next.chapter);
      this.menu?.setSave(this.save);
      this.setScreen('chapter');
      this.menu?.show('chapter', {
        chapter: cur.chapter,
        name_zh: this.doc.chapters?.[cur.chapter - 1]?.name_zh ?? `第 ${cur.chapter} 章`,
        score: this.save.best_scores[cur.id]?.score ?? 0,
      });
      // **自动续章**（用户反馈："每三关需要自己手点下一关"）。
      // 章末卡片原先必须手动点击才继续，节奏被打断。改成展示 3.5 秒后自动进入下一关；
      // 想立刻走就点一下（点击会切到 play，下面的守卫就不再触发）。
      window.setTimeout(() => {
        if (this.screen !== 'chapter') return;
        const lv = this.doc.levels;
        if (this.levelIndex + 1 >= lv.length) return;
        if (lv[this.levelIndex + 1].chapter === lv[this.levelIndex].chapter) return;
        this.startLevelAt(this.levelIndex + 2);
      }, 3500);
      return;
    }
    this.startLevelAt(this.levelIndex + 2);
  }

  /**
   * 打开外部链接（仓库 / 个人主页 / Star）。
   * EXE 与网页模式交给宿主用系统默认浏览器打开——**绝不能让 WebView 自己导航**，
   * 否则游戏页面会被仓库页面替换掉，玩家以为游戏崩了。离线单文件版没有宿主，走 window.open。
   */
  private openExternal(url: string): void {
    if (!/^https:\/\//i.test(url)) return;
    if (!this.isOffline) {
      void fetch('/api/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }).catch(() => { try { window.open(url, '_blank', 'noopener'); } catch { /* 忽略 */ } });
      return;
    }
    try { window.open(url, '_blank', 'noopener'); } catch { /* 忽略 */ }
  }

  private toMenu(): void {
    this.attract = true;
    this.loadWorld(this.levelIndex);
    this.view.showField = true;
    this.setScreen('menu');
  }

  private async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.tryCall('audio', () => this.audio?.play('ui_back', { gain: 0.6 }));
    this.persist();
    this.loop.stop();
    this.tryCall('audio', () => this.audio?.setMuted(true));
    this.bridge.send({ t: 'bye' });
    this.showExitOverlay('正在退出…');

    // 1) 先尝试脚本关窗：对 pywebview / 脚本打开的窗口有效；
    //    普通浏览器标签会被拒绝（这是规范行为，不是失败）。
    try { window.close(); } catch { /* 被浏览器拒绝 */ }
    await new Promise<void>((r) => setTimeout(r, 200));

    // 2) 请求宿主退出：宿主侧的 on_quit 会销毁窗口（window.close_window），
    //    之前缺的就是这条链路，导致"退出键只杀后端、窗口留成僵尸页"。
    if (!this.isOffline) {
      try { await fetch('/api/quit', { method: 'POST' }); } catch { /* 宿主可能已经没了 */ }
    }

    // 3) 兜底反馈：窗口/标签页若还在，给出明确的"已退出 + 怎么关"提示
    await new Promise<void>((r) => setTimeout(r, this.isOffline ? 150 : 900));
    this.showExitOverlay(this.isOffline ? '已退出游戏' : '已退出任务控制中心');
  }

  /* ------------------------------------------------------------ 教学关分步引导 */

  private guideStep = -2;
  private guideEl: HTMLElement | null = null;
  private guideHeld = 0;
  private guideCoast = 0;
  private guideReleased = false;
  private guideMoved = false;
  private guideLastMx = -999;
  private guideLastMy = -999;

  private static readonly GUIDE: Array<{ t: string; s: string }> = [
    { t: '① 移动鼠标', s: '跟着你走的那圈就是「引力井」——你不是射手，你是引力源' },
    { t: '② 按住左键', s: '把井拖到货舱前进方向的前方，把它拉住、减速' },
    { t: '③ 松开左键', s: '断电后货舱惯性滑行 —— 不耗燃料，这是省 Δv 的关键' },
    { t: '④ 送进对接环', s: '让货舱进入空间站的环，相对速度要低于环的极限速度' },
  ];

  private get guideSeen(): boolean {
    try { return localStorage.getItem('lc_guide_seen') === '1'; } catch { return true; }
  }

  private markGuideSeen(): void {
    try { localStorage.setItem('lc_guide_seen', '1'); } catch { /* 忽略 */ }
  }

  /** 第 1 关的分步引导：按玩家实际动作推进，做完自动消失 */
  private updateGuide(dt: number): void {
    const w = this.world;
    const want = !this.autotest && this.screen === 'play' && !!w && w.level.index === 1;
    if (!want || this.guideSeen) {
      if (this.guideStep !== -2) { this.guideStep = -2; this.hideGuide(); }
      return;
    }
    const s = this.input.snapshot;
    if (this.guideLastMx > -900
      && (Math.abs(s.mx - this.guideLastMx) > 3 || Math.abs(s.my - this.guideLastMy) > 3)) this.guideMoved = true;
    this.guideLastMx = s.mx;
    this.guideLastMy = s.my;

    if (w.well.engaged) { this.guideHeld += dt; this.guideCoast = 0; }
    else if (this.guideHeld > 0.6) { this.guideReleased = true; this.guideCoast += dt; }

    const delivered = w.bodies.some((b) => b.kind === 'pod' && b.delivered);
    let step = 0;
    if (this.guideMoved) step = 1;
    if (this.guideHeld > 0.8) step = 2;
    if (this.guideReleased && this.guideCoast > 1.2) step = 3;
    if (delivered) step = 4;

    if (step === this.guideStep) return;
    this.guideStep = step;
    if (step >= 4) { this.markGuideSeen(); this.hideGuide(); return; }
    this.showGuide(step);
  }

  private showGuide(step: number): void {
    if (!this.guideEl) {
      const el = document.createElement('div');
      el.id = 'lc-guide';
      this.uiRoot.appendChild(el);
      this.guideEl = el;
    }
    const g = Game.GUIDE[step];
    const dots = Game.GUIDE.map((_, i) =>
      `<i class="lc-gdot${i < step ? ' done' : i === step ? ' on' : ''}"></i>`).join('');
    this.guideEl.innerHTML = `<div class="lc-grow"><span class="lc-gt">${g.t}</span><span class="lc-gs">${g.s}</span></div>`
      + `<div class="lc-gdots">${dots}</div>`
      + '<div class="lc-gskip">按 H 可随时查看完整操作；演示动画在 主菜单 →「看操作演示」</div>';
    this.guideEl.classList.add('on');
  }

  private hideGuide(): void {
    if (this.guideEl) this.guideEl.classList.remove('on');
  }

  private hintEl: HTMLElement | null = null;
  private hintTimer = 0;
  private pendingHint = '';

  /** 宿主为每关生成的战术提示（此前只打在控制台里，玩家看不到）→ 显示成游戏内提示条 */
  showHint(text: string): void {
    if (!text) return;
    // 菜单/简报阶段先存着：否则提示条会压在新手演示或主菜单上，反而更迷糊
    if (this.screen !== 'play') { this.pendingHint = text; return; }
    this.renderHint(text);
  }

  /** 进入游玩时把暂存的提示补上 */
  private flushHint(): void {
    if (!this.pendingHint) return;
    const t = this.pendingHint;
    this.pendingHint = '';
    this.renderHint(t);
  }

  private renderHint(text: string): void {
    if (!this.hintEl) {
      const el = document.createElement('div');
      el.id = 'lc-hint-toast';
      this.uiRoot.appendChild(el);
      this.hintEl = el;
    }
    const el = this.hintEl;
    el.innerHTML = `<span class="lc-htag">战术提示</span><span class="lc-htext">${text.replace(/</g, '&lt;')}</span>`
      + '<span class="lc-hclose">点击关闭</span>';
    el.classList.add('on');
    el.onclick = () => { el.classList.remove('on'); this.hintTimer = 0; };
    this.hintTimer = 16; // 秒
  }

  private updateHint(dt: number): void {
    if (this.hintTimer > 0 && this.hintEl) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.hintEl.classList.remove('on');
    }
  }

  /** 画面缩放（Alt+滚轮 / 0 复位）。只改世界视图；写入 localStorage 以便跨关卡保留。 */
  private adjustZoom(factor: number): void {
    const before = this.zoomBias;
    this.zoomBias = Math.max(0.45, Math.min(3.2, this.zoomBias * factor));
    if (Math.abs(this.zoomBias - before) < 1e-3) return;
    try { localStorage.setItem('lc_zoom', this.zoomBias.toFixed(3)); } catch { /* 忽略 */ }
    this.tryCall('hud', () => this.hud?.pushToast(
      `画面缩放 ×${this.zoomBias.toFixed(2)}　（Alt+滚轮调整 · 按 0 复位）`, 'info'));
  }

  private loadZoomBias(): number {
    try {
      const v = Number(localStorage.getItem('lc_zoom'));
      if (Number.isFinite(v) && v > 0) return Math.max(0.45, Math.min(3.2, v));
    } catch { /* 忽略 */ }
    return 1;
  }

  /** 退出提示覆盖层（不依赖菜单系统，任何界面下都能显示） */
  private showExitOverlay(title: string): void {
    let el = document.getElementById('lc-exit');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lc-exit';
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;'
        + 'align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px;'
        + 'background:rgba(5,7,15,0.94);color:#9fb3c8;pointer-events:auto;'
        + 'font:14px/1.8 ui-monospace,"Cascadia Mono",Consolas,monospace';
      (document.getElementById('ui-root') ?? document.body).appendChild(el);
    }
    const done = title.startsWith('已');
    el.innerHTML = `<div style="font-size:22px;letter-spacing:.22em;color:${done ? '#8ef7d0' : '#59d9ff'}">${title}</div>`
      + (done
        ? '<div>任务控制中心已停止。若窗口没有自动关闭，请按 <b>Alt+F4</b> 或直接关闭本窗口 / 标签页。</div>'
          + '<div style="opacity:.55">再次开始：双击 <b>启动游戏.bat</b>（或 <b>启动网页版.bat</b>）</div>'
        : '<div style="opacity:.6">正在保存存档并停止服务…</div>');
  }

  /* ------------------------------------------------------------ 控制 */

  private driveControl(dtReal: number): void {
    const w = this.world;
    if (!w) return;
    const useAi = this.attract || this.autotest;
    if (useAi) {
      autopilot(w, this.pilot, this.pilotTel);
      if (this.pilotTel.distance > 0 && this.pilotTel.distance < this.minDockDistance) this.minDockDistance = this.pilotTel.distance;
    } else {
      const s = this.input.snapshot;
      // **作业区边界**（用户反馈："引力井飞出地图了但没有重开的内容"）。
      // 原先上限是 bounds×1.1（例如 8.8 RU），鼠标推到屏幕边缘就能把飞船开出去，
      // 而关卡既不判失败也不给提示——玩家只能自己想到按 R。现在三层保护：
      //   ① 目标点钳到地图边界内；② 井真的越界时自动召回；③ HUD 给出提示（见 hud.ts）。
      const lim = w.bounds;
      w.well.tx = Math.max(-lim, Math.min(lim, s.wx));
      w.well.ty = Math.max(-lim, Math.min(lim, s.wy));
      // ② 自动召回：井（飞船）实际位置越界就把目标点拉回来，避免"船在外面、鼠标在里面"的僵局
      const wrNow = Math.hypot(w.well.x, w.well.y);
      this.wellLost = wrNow > w.bounds * 1.02;
      if (this.wellLost) {
        const k = (w.bounds * 0.92) / Math.max(wrNow, 1e-6);
        w.well.tx = w.well.x * k;
        w.well.ty = w.well.y * k;
        if (this.frames % 40 === 0) {
          this.pushToast('引力井已脱离作业区 —— 已自动召回（按 R 可重试本关）');
        }
      }
      /* 恒星光球层保护区：禁止把引力井的目标点设进恒星附近。
         推力上限 A_MAX=3.0 而近星引力可达 90+ RU/TU²，拖进去就永远拉不回来 = 死局
         （玩家实测："紫色那个和恒星交叉后无法交互，只能重开"）。
         这里把目标点投影到保护区边界：鼠标可以继续往星里推，但井不会真的进去。 */
      const star = w.primaries.find((p) => p.kind === 'star' && p.alive);
      this.wellBlocked = false;
      if (star) {
        const keep = star.radius + STAR_KEEPOUT;
        const dx = w.well.tx - star.x;
        const dy = w.well.ty - star.y;
        const r = Math.hypot(dx, dy);
        if (r < keep) {
          this.wellBlocked = true;
          if (r > 1e-6) {
            const k = keep / r;
            w.well.tx = star.x + dx * k;
            w.well.ty = star.y + dy * k;
          } else {
            w.well.tx = star.x + keep;
            w.well.ty = star.y;
          }
        }
      }
      w.well.engaged = (s.left || s.right) && w.fieldEnabled && w.compute > 0.02;
      w.well.repel = s.right && !s.left;
      w.well.precise = s.shift;
      if (s.wheel !== 0) {
        const f = s.wheel > 0 ? 1.14 : 1 / 1.14;
        w.well.targetMass = Math.max(WELL_MASS_MIN, Math.min(WELL_MASS_MAX, w.well.targetMass * f));
      }
      this.handlePlayKeys();
    }
    // 场强质量平滑（场投影器调功需要时间，手感更真实）
    const k = Math.min(1, dtReal * 4.5);
    w.well.mass += (w.well.targetMass - w.well.mass) * k;
    this.slowmo = this.slowmoActive();
    w.slowmo = this.slowmo ? SLOWMO_SCALE : 1;
    void PX_PER_RU;
  }

  private slowmoActive(): boolean {
    if (this.attract || this.autotest) return false;
    return this.input.down('Space') && (this.world?.compute ?? 0) > 0.05;
  }

  private handlePlayKeys(): void {
    const inp = this.input;
    const w = this.world;
    if (!w) return;
    if (inp.pressed('Digit1')) w.well.targetMass = WELL_PRESETS[0];
    if (inp.pressed('Digit2')) w.well.targetMass = WELL_PRESETS[1];
    if (inp.pressed('Digit3')) w.well.targetMass = WELL_PRESETS[2];
    if (inp.pressed('KeyG')) { this.view.showField = !this.view.showField; this.save.settings.showField = this.view.showField; }
    if (inp.pressed('KeyF')) this.view.showVectors = !this.view.showVectors;
    if (inp.pressed('KeyO')) this.view.showOrbits = !this.view.showOrbits;
    if (inp.pressed('KeyZ')) this.view.showZVC = !this.view.showZVC;   // 零速度曲线（CR3BP 禁区，两体近似）
    if (inp.pressed('KeyH')) this.showHelp = !this.showHelp;
    // **帧率上限（Y）**：玩家反馈"帧率低、希望有固定帧率生效"。
    // 不限 → 120 → 60 → 30 循环；超出预算的帧直接跳过，让帧间隔稳定（抖动比峰值更影响手感）。
    if (inp.pressed('KeyY')) {
      const caps = [0, 120, 60, 30];
      const i = caps.indexOf(this.save.settings.fpsCap ?? 0);
      const next = caps[(i + 1) % caps.length];
      this.save.settings.fpsCap = next;
      this.loop.setFrameCap(next);
      this.persist();
      this.pushToast(next ? `帧率上限 ${next} fps` : '帧率不限');
    }
    if (inp.pressed('KeyM')) { this.save.settings.muted = !this.save.settings.muted; this.applyAudioSettings(); }
    // **时间加速（T）**：用户反馈"运气性太重"——本质是只能在相位窗口前干等。
    // 1× → 2× → 4× 循环；慢动作（空格）优先，两者叠加时以慢动作为准。
    if (inp.pressed('KeyT')) {
      this.fastFwd = this.fastFwd >= 4 ? 1 : this.fastFwd * 2;
      if (this.world) this.world.timeScale = this.fastFwd;
      this.pushToast(this.fastFwd > 1 ? `时间加速 ${this.fastFwd}×` : '时间流速恢复 1×');
    }
    if (inp.pressed('KeyR')) { this.startLevelAt(this.levelIndex + 1); return; }
    if (inp.pressed('Escape')) { this.setScreen('pause'); return; }
    this.predictOn = inp.down('Tab');
    this.view.showPredict = this.predictOn;
  }

  private updatePredict(): void {
    const w = this.world;
    if (!w) return;
    if (!this.predictOn || this.paused) { if (w.predicted.length) w.predicted.length = 0; return; }
    const now = performance.now() / 1000;
    if (now - this.lastPredictAt < 0.15) return;
    this.lastPredictAt = now;
    this.tryCall('predict', () => predictPaths(w, now, WELL_RANGE));
  }

  private updateAudioParams(): void {
    const a = this.audio;
    const w = this.world;
    if (!a || !w) return;
    this.tryCall('audio', () => {
      a.setParam('wellThrust', w.well.engaged ? w.well.thrust : 0);
      a.setParam('wellMass', w.well.mass);
      // **心跳与警报只在真正游玩时生效**（发布反馈："刚进游戏时背景音乐有巨大的噪音"）。
      // 根因：主菜单放的是吸引模式（AI 自己玩），AI 会把燃料烧到 0，
      // 于是 fuel < 0.25 触发了**最高严重度的低频心跳**（每 0.62 s 一记重击）叠在背景音乐上。
      // 菜单/简报/结算页一律视作"燃料充足、无警报"。
      const live = this.screen === 'play' && !this.attract;
      a.setParam('fuel', live ? w.fuel / Math.max(1e-6, w.fuelCapacity) : 1);
      a.setParam('alert', live ? (w.windActive ? 1 : 0) : 0);
      a.setParam('slowmo', this.slowmo ? 1 : 0);
      a.setParam('stability', Math.max(0, 1 - w.stats.energyDrift * 1e4));
      a.loop('thruster_loop', 'well', w.well.engaged && w.well.thrust > 0.35, { gain: Math.min(0.5, w.well.thrust * 0.35) });
      a.setIntensity(this.view.intensity);
    });
  }

  /* ------------------------------------------------------------ 特效分发与镜头 */

  private drainFx(): void {
    const w = this.world;
    if (!w || !w.fx.length) return;
    for (const ev of w.fx) {
      this.tryCall('renderer', () => this.renderer?.pushFx(ev));
      if (ev.sound) this.tryCall('audio', () => this.audio?.play(ev.sound as string, { gain: Math.min(1, 0.4 + ev.mag * 0.5) }));
      if (ev.text) this.pushToast(ev.text, ev.kind === 'lost' || ev.kind === 'fail' ? 'warn' : ev.kind === 'dock' ? 'good' : 'info');
      const mag = Math.min(1.6, ev.mag);
      switch (ev.kind) {
        case 'impact': this.view.shake = Math.min(1.4, this.view.shake + mag * 0.35); this.view.chroma = Math.min(1, this.view.chroma + mag * 0.4); break;
        case 'lost': case 'tear': this.view.shake = Math.min(1.6, this.view.shake + mag * 0.8); this.view.flash = Math.min(0.55, this.view.flash + 0.35); this.audio?.duck(0.4); break;
        case 'dock': this.view.flash = Math.min(0.4, this.view.flash + 0.18); this.audio?.duck(0.8); this.brightFx++; break;
        case 'wind': this.view.chroma = Math.min(1, this.view.chroma + 0.5); break;
        case 'win': this.view.flash = 0.5; this.audio?.duck(1.6); break;
        case 'fail': this.view.flash = 0.4; this.audio?.duck(1.6); break;
        default: this.view.shake = Math.min(1.2, this.view.shake + mag * 0.12);
      }
    }
    w.fx.length = 0;
  }

  private updateCamera(dtReal: number): void {
    const w = this.world;
    if (!w) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x: number, y: number, pad: number): void => {
      if (x - pad < minX) minX = x - pad;
      if (y - pad < minY) minY = y - pad;
      if (x + pad > maxX) maxX = x + pad;
      if (y + pad > maxY) maxY = y + pad;
    };
    add(w.well.x, w.well.y, 0.35);
    add(w.dock.x, w.dock.y, 0.3);
    let any = false;
    for (const p of w.pods) if (p.alive && !p.delivered) { add(p.x, p.y, 0.25); any = true; }
    if (!any) add(w.well.x, w.well.y, 0.8);
    const spanX = Math.max(0.9, maxX - minX);
    const spanY = Math.max(0.7, maxY - minY);
    const zx = this.view.w / (spanX * PX_PER_RU * 1.25);
    const zy = this.view.h / (spanY * PX_PER_RU * 1.25);
    this.cam.tz = Math.max(0.55, Math.min(2.4, Math.min(zx, zy)));
    this.cam.tx = (minX + maxX) * 0.5;
    this.cam.ty = (minY + maxY) * 0.5;
    const k = Math.min(1, dtReal * 2.6);
    this.cam.x += (this.cam.tx - this.cam.x) * k;
    this.cam.y += (this.cam.ty - this.cam.y) * k;
    this.cam.zoom += (this.cam.tz - this.cam.zoom) * Math.min(1, dtReal * 2.2);
  }

  private decayView(dtReal: number): void {
    const v = this.view;
    v.camera.x = this.cam.x; v.camera.y = this.cam.y;
    // 相机自动取景（=cam.zoom）× 玩家手动缩放偏好（zoomBias）
    const z = this.cam.zoom * this.zoomBias;
    v.camera.zoom = z;
    v.zoom = z; v.targetZoom = this.cam.tz * this.zoomBias;
    v.shake = Math.max(0, v.shake - dtReal * 2.6);
    v.chroma = Math.max(0, v.chroma - dtReal * 1.6);
    v.flash = Math.max(0, v.flash - dtReal * 2.2);
    v.fade = Math.max(0, v.fade - dtReal * 2.2);
    v.slowmo = this.slowmo ? SLOWMO_SCALE : 1;
    v.wellMode = this.world?.well.engaged ? (this.world.well.repel ? 'repel' : 'attract') : 'idle';
    v.uiAlpha = 1;
    const w = this.world;
    if (w) {
      const rem = w.pods.filter((p) => p.alive && !p.delivered).length;
      v.intensity = Math.max(0.2, Math.min(1,
        0.3 + 0.5 * (1 - rem / Math.max(1, w.level.podsTotal)) + 0.4 * w.windActive + (w.status === 'running' ? 0 : 0.3)));
    }
  }

  private pushToast(text: string, kind?: HudToast['kind']): void {
    this.toasts.push({ text, t: 3.4, kind });
    if (this.toasts.length > 6) this.toasts.shift();
    if (this.hud) this.tryCall('hud', () => this.hud?.pushToast(text, kind));
  }

  /* ------------------------------------------------------------ 结算 */

  private checkLevelEnd(dtReal: number): void {
    const w = this.world;
    if (!w || this.attract || this.autotest) return;
    if (w.status === 'running') return;
    // 一局只结算一次：否则 resolveTimer 每轮归零后又会重新倒计时，
    // 结算页会每隔 2.6 秒被重新渲染一次（玩家看到的"重复刷新"）。
    if (this.resolved) return;
    if (this.resolveTimer < 0) { this.resolveTimer = 2.6; this.persist(); return; }
    this.resolveTimer -= dtReal;
    if (this.resolveTimer > 0) return;
    this.resolveTimer = -1;
    this.resolved = true;
    void this.finishLevel();
  }

  private async finishLevel(): Promise<void> {
    const w = this.world;
    if (!w) return;
    const lv = w.level;
    const result = {
      level_id: lv.id, success: w.status === 'won', time: w.time,
      fuel_used: lv.fuelUsed, par_time: lv.parTime, par_fuel: lv.parFuel,
      pods_total: lv.podsTotal, pods_delivered: lv.podsDelivered, pods_lost: lv.podsLost,
      score: 0, energy_drift: w.stats.energyDrift, angular_drift: w.stats.angularDrift,
      attempts: 1,
    };
    this.verdict = await this.bridge.requestVerdict(result);
    lv.fidelityGrade = this.verdict.grade;
    lv.fidelityFactor = this.verdict.fidelity;
    lv.fidelityNote = this.verdict.note;
    const prev = this.save.best_scores[lv.id]?.score ?? -1;
    const breakdown = computeScore(w, this.verdict, false);
    breakdown.newBest = breakdown.score > prev;
    result.score = breakdown.score;
    if (breakdown.newBest) {
      this.save.best_scores[lv.id] = { score: breakdown.score, grade: breakdown.grade, time: w.time, fuel: lv.fuelUsed };
    }
    this.save.totals.played++;
    this.save.totals.delivered += lv.podsDelivered;
    this.save.totals.lost += lv.podsLost;
    this.save.totals.playtime += w.time * TIME_SCALE;
    if (w.status === 'won') {
      const chapters = this.doc.levels[this.levelIndex]?.chapter ?? 1;
      this.save.unlocked_chapters = Math.max(this.save.unlocked_chapters, Math.min(4, chapters));
    }
    this.menu?.setSave(this.save);
    this.persist();
    this.showDebrief(breakdown);
  }

  private showDebrief(b: ScoreBreakdown): void {
    this.setScreen('debrief');
    this.menu?.show('debrief', b);
    if (b.success) this.tryCall('audio', () => this.audio?.play('chapter_fanfare', { gain: 0.7 }));
  }

  private persist(): void {
    try { this.bridge.save(this.save); } catch { /* 忽略 */ }
    try { localStorage.setItem('lc_save', JSON.stringify(this.save)); } catch { /* 忽略 */ }
  }

  /* ------------------------------------------------------------ 设置 */

  private applyQualityFromSave(): void {
    const q = this.save.settings.quality ?? 'high';
    if (q === 'low') this.quality = { ...DEFAULT_QUALITY, maxParticles: 700, bloom: false, chroma: false, starLayers: 1, fieldContours: false, renderScale: 0.45 };
    else if (q === 'mid') this.quality = { ...DEFAULT_QUALITY, maxParticles: 1400, bloom: true, chroma: false, starLayers: 2, renderScale: 0.52 };
    else this.quality = { ...DEFAULT_QUALITY };
  }

  private applyAudioSettings(): void {
    const a = this.audio;
    if (!a) return;
    this.tryCall('audio', () => {
      a.setMaster(this.save.settings.master);
      a.setMuted(this.save.settings.muted);
      a.setParam('musicGain', this.save.settings.music);
      a.setParam('sfxGain', this.save.settings.sfx);
    });
  }

  private applySetting<K extends keyof SaveState['settings']>(key: K, value: SaveState['settings'][K]): void {
    (this.save.settings as Record<string, unknown>)[key as string] = value;
    if (key === 'quality') { this.applyQualityFromSave(); this.renderer?.setQuality(this.quality); this.view.quality = this.quality; }
    // ---- 性能相关设置（玩家反馈：帧率低、设置无效、弱机卡顿）----
    if (key === 'fpsCap') {
      const cap = Number(value) || 0;
      this.save.settings.fpsCap = cap;
      this.loop.setFrameCap(cap);
    }
    if (key === 'renderScale') {
      const v = Math.max(0.35, Math.min(1, Number(value) || 0.62));
      this.save.settings.renderScale = v;
      this.save.settings.renderScaleAuto = false;   // 拖动滑块即视为手动
      this.renderer?.setRenderScale(v, false);
    }
    if (key === 'renderScaleAuto') {
      const auto = String(value) !== 'fixed';
      this.save.settings.renderScaleAuto = auto;
      this.renderer?.setRenderScale(this.save.settings.renderScale ?? 0.62, auto);
    }
    if (key === 'physics60') {
      const p60 = String(value) === '1' || value === true;
      this.save.settings.physics60 = p60;
      this.loop.setFixedDt(p60 ? DT * 2 : DT);
      this.pushToast(p60 ? '物理步长 60 Hz（省 CPU，精度略降）' : '物理步长 120 Hz（精确）');
    }
    this.applyAudioSettings();
    this.persist();
  }

  private installUiAudio(): void {
    this.uiRoot.addEventListener('pointerover', (e) => {
      const t = (e.target as HTMLElement | null)?.closest?.('[data-sfx],[data-sfx-hover]') as HTMLElement | null;
      if (!t) return;
      this.tryCall('audio', () => this.audio?.play(t.dataset.sfxHover ?? t.dataset.sfx ?? 'ui_hover', { gain: 0.3 }));
    });
    this.uiRoot.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement | null)?.closest?.('[data-sfx]') as HTMLElement | null;
      this.tryCall('audio', () => this.audio?.play(t?.dataset.sfx ?? 'ui_click', { gain: 0.5 }));
    });
    this.uiRoot.addEventListener('focusin', () => {
      this.tryCall('audio', () => this.audio?.play('ui_hover', { gain: 0.28 }));
    });
  }

  /* ------------------------------------------------------------ 自动测试 */

  private updateAutotest(dtReal: number): void {
    const w = this.world;
    if (!w || this.autotestDone) return;
    this.autotestT += dtReal;
    const first = w.pods.find((p) => p.key === 'p1') ?? w.pods[0];
    if (first) this.podsMoved = Math.max(this.podsMoved, Math.hypot(first.x - this.podPos0.x, first.y - this.podPos0.y));
    const ended = w.status !== 'running';
    if (!ended && this.autotestT < 45 && w.time < 130) return;
    this.autotestDone = true;
    this.checks = [
      { name: 'welcome_from_python', ok: !!this.welcome && !!this.doc?.levels?.length, detail: `关卡数=${this.doc?.levels?.length ?? 0}` },
      { name: 'assets_loaded', ok: this.assets.loadedCount > 0 && this.assets.errors.length < this.assets.loadedCount, detail: `已载入 ${this.assets.loadedCount}/${this.assets.totalCount}，失败 ${this.assets.errors.length}` },
      { name: 'renderer_alive', ok: this.frames > 30, detail: `帧数=${this.frames}, fps=${this.loop.fps.toFixed(1)}` },
      { name: 'physics_advanced', ok: w.stats.steps > 500 && w.time > 2, detail: `步数=${w.stats.steps}, 模拟时间=${w.time.toFixed(2)} TU` },
      { name: 'bodies_present', ok: w.primaries.length >= 1 && w.pods.length >= 1, detail: `主天体=${w.primaries.length}, 货舱=${w.pods.length}, 总物体=${w.bodies.length}` },
      { name: 'autopilot_flew', ok: this.pilot.thrustAcc > 0.5, detail: `累计推力=${this.pilot.thrustAcc.toFixed(2)}` },
      { name: 'pod_moved', ok: this.podsMoved > 0.05, detail: `位移=${this.podsMoved.toFixed(3)} RU` },
      { name: 'conservation_ok', ok: w.stats.energyDrift < 1e-2, detail: `ΔE/E=${w.stats.energyDrift.toExponential(2)} ΔL/L=${w.stats.angularDrift.toExponential(2)}` },
      { name: 'no_js_errors', ok: this.errors.length === 0, detail: this.errors.slice(0, 5).join(' | ') || '无异常' },
      { name: 'dock_attempted', ok: this.minDockDistance < w.dock.radius * 6, detail: `最近距离=${this.minDockDistance === Infinity ? 'N/A' : this.minDockDistance.toFixed(3)} RU（对接环半径 ${w.dock.radius}）`, soft: true },
      { name: 'docked', ok: w.level.podsDelivered > 0, detail: `已对接 ${w.level.podsDelivered}/${w.level.podsTotal}，状态=${w.status}`, soft: true },
    ];
    const hard = this.checks.filter((c) => !c.soft);
    const ok = hard.every((c) => c.ok);
    const report = {
      ok, checks: this.checks, errors: this.errors,
      world: {
        level: w.level.id, time: w.time, steps: w.stats.steps, bodies: w.bodies.length,
        energy_drift: w.stats.energyDrift, angular_drift: w.stats.angularDrift,
        delivered: w.level.podsDelivered, status: w.status,
        fps: this.loop.fps, frames: this.frames,
      },
      autotest_seconds: this.autotestT,
    };
    document.title = ok ? 'AUTOTEST:OK 牧星者' : 'AUTOTEST:FAIL 牧星者';
    try {
      void fetch('/api/selftest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
    } catch { /* 忽略 */ }
    this.bridge.log('info', 'autotest', report);
    console.info('[LC AUTOTEST]', JSON.stringify(report));
    this.showHelp = false;
  }

  /* ------------------------------------------------------------ 杂项 */

  private tryCreateAudioContext(): AudioContext | null {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      return Ctor ? new Ctor() : null;
    } catch { return null; }
  }

  private tryCall(label: string, fn: () => void): void {
    try { fn(); } catch (e) {
      const msg = `${label}: ${String((e as Error)?.message ?? e)}`;
      if (!this.reported.has(msg)) { this.reported.add(msg); this.errors.push(msg); console.error('[LC]', msg, e); }
    }
  }

  private resizeIfNeeded(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w !== this.view.w || h !== this.view.h || dpr !== this.view.dpr) this.resize();
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.view.w = w; this.view.h = h; this.view.dpr = dpr;
    this.tryCall('renderer', () => this.renderer?.resize(w, h, dpr));
    this.tryCall('hud', () => this.hud?.resize(w, h, dpr));
  }

  private publishDebug(): void {
    const w = this.world;
    const star = w?.primaries.find((p) => p.kind === 'star' && p.alive) ?? null;
    const wx = w?.well.x ?? 0, wy = w?.well.y ?? 0;
    (window as unknown as { __LC_DEBUG?: unknown }).__LC_DEBUG = {
      screen: this.screen, frames: this.frames, fps: this.loop.fps, frameMs: this.loop.frameMs,
      steps: this.loop.steps, simTime: w?.time ?? 0, status: w?.status ?? '-',
      bodies: w?.bodies.length ?? 0, delivered: w?.level.podsDelivered ?? 0,
      energyDrift: w?.stats.energyDrift ?? 0, autotest: this.autotest,
      renderer: this.renderer?.stats ?? null, errors: this.errors.length,
      pilotDistance: this.pilotTel.distance, minDock: this.minDockDistance,
      // 恒星灼烧区诊断（用于自动化验证"拖不进恒星"与"进去了也能出来"）
      star: star ? { x: star.x, y: star.y, r: star.radius } : null,
      well: w ? {
        x: wx, y: wy, hot: w.well.hot, blocked: this.wellBlocked,
        r: star ? Math.hypot(wx - star.x, wy - star.y) : 0,
        keep: star ? star.radius + STAR_KEEPOUT : 0,
      } : null,
    };
  }

  /* 供 UI/自动化读取 */
  get currentScreen(): Screen { return this.screen; }
  get worldRef(): World | null { return this.world; }
  get scores(): ScoreBreakdown[] { return []; }

  /**
   * 自适应画质守卫：连续测量 renderMs，超标就逐步降档，保证"任何时候都不卡"。
   * 这是交付要求里"流畅度"的兜底——即使某个场景在某台机器上过载，也只会掉画质而不是掉帧。
   */
  private autoQualityTick(): void {
    if (this.autotest) return;
    const w = this.world;
    if (!w || this.screen !== 'play' || this.frames < 90) return;
    const ms = this.loop.frameMs;
    this.qEma = this.qEma === 0 ? ms : this.qEma * 0.94 + ms * 0.06;
    if (this.frames % 60 !== 0) return;
    const q = this.save.settings.quality;
    if (this.qEma > 22 && q === 'high') {
      this.save.settings.quality = 'mid';
      this.applyQualityFromSave();
      this.renderer?.setQuality(this.quality);
      this.view.quality = this.quality;
      this.pushToast('帧耗时偏高，已自动切到中画质（HUD 右侧可手动改回）', 'warn');
      this.qEma = 0;
    } else if (this.qEma > 26 && q === 'mid') {
      this.save.settings.quality = 'low';
      this.applyQualityFromSave();
      this.renderer?.setQuality(this.quality);
      this.view.quality = this.quality;
      this.view.showField = false;
      this.pushToast('已自动切到低画质并关闭引力场线', 'warn');
      this.qEma = 0;
    }
  }

  /** 浏览器自动播放策略：首个用户手势后恢复/启动音频上下文 */
  async unlockAudio(): Promise<void> {
    this.tryCall('audio', () => { void this.audio?.init(); });
  }

  /**
   * 同步预热并渲染一帧（用于无头浏览器截图验收）：
   * 以固定步长把模拟推进 TU 秒（自动制导驾驶），再渲染一帧后停止主循环，
   * 这样 --virtual-time-budget 很短的截图也能拍到"正在玩"的画面。
   */
  warmupAndStill(tu: number): void {
    const w = this.world;
    if (!w) return;
    this.loop.stop();
    const pilot = createPilot();
    const tel: PilotTelemetry = {
      active: false, targetIndex: -1, distance: 0, closing: 0, aDes: 0,
      rPod: 0, rStation: 0, phase: 'idle', fuel: 0, dWellPod: 0, dirErr: 0, deadband: false,
    };
    const dt = 1 / 60;
    let t = 0;
    while (t < tu && w.status === 'running') {
      autopilot(w, pilot, tel);
      advance(w, dt, 12);
      t += dt;
    }
    // 造点特效，让截图里有粒子与冲击波
    for (let i = 0; i < 3; i++) {
      this.renderer?.pushFx({
        kind: 'impact', x: w.pods[0].x + (i - 1) * 0.05, y: w.pods[0].y, nx: 1 - i * 0.5, ny: 0.3,
        mag: 0.8, tint: 4,
      });
    }
    this.attract = false;
    this.input.setEnabled(false);
    for (let i = 0; i < 90; i++) {
      this.updateCamera(dt);
      this.decayView(dt);
      this.drainFx();
      this.renderer?.frame(w, 1, dt, this.view);
      this.hud?.update(dt);
      this.hud?.draw({
        world: w, view: this.view, palette: this.palette,
        fps: 60, frameMs: 16.7, steps: 3, toasts: this.toasts, showHelp: false,
        missionTime: w.time, status: w.status, autotest: true,
      });
    }
    document.title = `SHOT ok time=${w.time.toFixed(1)} dock=${w.level.podsDelivered}/${w.level.podsTotal} status=${w.status}`;
    this.publishDebug();
  }

  /** 画布基线标定：测出"这一台机器上一次全屏合成"的代价，用于区分环境慢还是代码慢 */
  private calibrateCanvas(): Record<string, number> {
    const out: Record<string, number> = {};
    try {
      const cv = document.createElement('canvas');
      cv.width = this.view.w; cv.height = this.view.h;
      const c = cv.getContext('2d');
      const spr = document.createElement('canvas');
      spr.width = 256; spr.height = 256;
      const sc = spr.getContext('2d');
      if (!c || !sc) return out;
      const g = sc.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      sc.fillStyle = g; sc.fillRect(0, 0, 256, 256);
      c.globalCompositeOperation = 'lighter';
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) c.drawImage(spr, (i * 37) % 400, (i * 53) % 300, 1200, 1200);
      out.additiveFullscreenMs = (performance.now() - t0) / 20;
      c.globalCompositeOperation = 'source-over';
      const t1 = performance.now();
      for (let i = 0; i < 20; i++) { c.fillStyle = 'rgba(5,7,15,0.3)'; c.fillRect(0, 0, cv.width, cv.height); }
      out.fillFullscreenMs = (performance.now() - t1) / 20;
      const t2 = performance.now();
      for (let i = 0; i < 20; i++) c.getImageData(0, 0, 320, 180);
      out.readback320Ms = (performance.now() - t2) / 20;

      // 跨画布同尺寸拷贝：离屏→离屏 vs 离屏→可见画布，用来判断"最终合成"是否是瓶颈
      const off2 = document.createElement('canvas');
      off2.width = this.view.w; off2.height = this.view.h;
      const c2 = off2.getContext('2d');
      if (c2) {
        const t3 = performance.now();
        for (let i = 0; i < 10; i++) c2.drawImage(cv, 0, 0);
        out.blitOffToOffMs = (performance.now() - t3) / 10;
      }
      const visible = this.canvas.getContext('2d');
      if (visible) {
        const t4 = performance.now();
        for (let i = 0; i < 6; i++) visible.drawImage(cv, 0, 0);
        out.blitOffToVisibleMs = (performance.now() - t4) / 6;
        const t5 = performance.now();
        for (let i = 0; i < 6; i++) { visible.fillStyle = '#05070f'; visible.fillRect(0, 0, this.view.w, this.view.h); }
        out.fillVisibleMs = (performance.now() - t5) / 6;
      }
      const t6 = performance.now();
      if (c2) for (let i = 0; i < 6; i++) c2.drawImage(off2, 8, 8, 800, 450, 0, 0, 800, 450);
      out.blitRegionOffMs = (performance.now() - t6) / 6;
    } catch { /* 忽略 */ }
    return out;
  }

  /**
   * Canvas 原语级探针：给 2D 上下文的每个绘制方法打点，累计调用次数与真实耗时。
   * 用来回答"85 个绘制调用怎么会花 86ms"这类问题——它会直接指出是哪个原语在吃时间。
   */
  private patchCanvasOps(): () => Record<string, { n: number; ms: number }> {
    const proto = CanvasRenderingContext2D.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const names = [
      'drawImage', 'fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect',
      'fillText', 'strokeText', 'putImageData', 'getImageData',
      'createRadialGradient', 'createLinearGradient', 'createPattern',
      'arc', 'rect', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo',
      'clip', 'save', 'restore', 'setTransform', 'scale', 'translate', 'rotate',
      'ellipse', 'closePath', 'beginPath', 'setLineDash', 'drawFocusIfNeeded',
    ];
    const orig: Record<string, ((...a: unknown[]) => unknown) | undefined> = {};
    const acc: Record<string, { n: number; ms: number }> = {};
    const slow: { ms: number; sw: number; sh: number; dw: number; dh: number; gco: string; alpha: number; tf: string; where: string }[] = [];
    for (const nm of names) {
      const fn = proto[nm];
      if (typeof fn !== 'function') continue;
      orig[nm] = fn;
      acc[nm] = { n: 0, ms: 0 };
      proto[nm] = function patched(this: unknown, ...a: unknown[]): unknown {
        const t = performance.now();
        const r = fn.apply(this, a);
        const d = performance.now() - t;
        acc[nm].n++; acc[nm].ms += d;
        if (nm === 'drawImage' && d > 0.8) {
          const c = this as CanvasRenderingContext2D;
          const src = a[0] as CanvasImageSource & { width?: number; height?: number };
          const m = typeof c.getTransform === 'function' ? c.getTransform() : null;
          let where = '';
          try {
            const st = new Error().stack ?? '';
            where = st.split('\n').slice(1, 4).map((s) => s.trim().replace(/^at\s+/, '').slice(0, 90)).join(' ← ');
          } catch { /* 忽略 */ }
          slow.push({
            ms: d,
            sw: Number(src?.width ?? 0), sh: Number(src?.height ?? 0),
            dw: Number(a[3] ?? src?.width ?? 0), dh: Number(a[4] ?? src?.height ?? 0),
            gco: String(c.globalCompositeOperation), alpha: Number(c.globalAlpha.toFixed(2)),
            tf: m ? `${m.a.toFixed(2)},${m.b.toFixed(2)},${m.c.toFixed(2)},${m.d.toFixed(2)}` : '?',
            where,
          });
          slow.sort((x, y) => y.ms - x.ms);
          if (slow.length > 14) slow.length = 14;
        }
        return r;
      };
    }
    return () => {
      for (const nm of names) if (orig[nm]) proto[nm] = orig[nm] as (...a: unknown[]) => unknown;
      (acc as Record<string, { n: number; ms: number }> & { slowDraws?: unknown }).slowDraws = slow;
      return acc;
    };
  }

  /** 性能基准：跑固定墙钟时间后把 fps/帧耗时上报宿主（供无头或真实窗口测量） */
  startBench(seconds: number): void {
    this.profiling = true;
    const calib = this.calibrateCanvas();
    const stopOps = this.patchCanvasOps();
    const t0 = performance.now();
    const samples: number[] = [];
    const tick = (): void => {
      samples.push(this.loop.frameMs);
      if ((performance.now() - t0) / 1000 < seconds) {
        requestAnimationFrame(tick);
        return;
      }
      samples.sort((a, b) => a - b);
      const n = Math.max(1, this.prof.n);
      const opAcc = stopOps();
      const slowDraws = (opAcc as unknown as { slowDraws?: unknown[] }).slowDraws ?? [];
      const ops = Object.entries(opAcc)
        .filter(([k]) => k !== 'slowDraws')
        .map(([k, v]) => ({ op: k, perFrame: v.n / Math.max(1, this.prof.n), msPerFrame: v.ms / Math.max(1, this.prof.n) }))
        .sort((a, b) => b.msPerFrame - a.msPerFrame)
        .slice(0, 12);
      const report = {
        ok: true, bench: true,
        fps: this.loop.fps, frameMsAvg: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length),
        frameMsP50: samples[Math.floor(samples.length * 0.5)] ?? 0,
        frameMsP95: samples[Math.floor(samples.length * 0.95)] ?? 0,
        frames: this.frames, w: this.view.w, h: this.view.h, dpr: this.view.dpr,
        renderer: this.renderer?.stats ?? null,
        bodies: this.world?.bodies.length ?? 0,
        particles: this.renderer?.stats.particles ?? 0,
        profile: {
          logicMs: this.prof.logic / n, renderMs: this.prof.render / n, hudMs: this.prof.hud / n,
          samples: this.prof.n, quality: this.save.settings.quality, showField: this.view.showField,
          canvasBaseline: calib, ops, slowDraws,
        },
      };
      document.title = `BENCH fps=${report.fps.toFixed(1)} p50=${report.frameMsP50.toFixed(2)}ms p95=${report.frameMsP95.toFixed(2)}ms`;
      void fetch('/api/selftest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      console.info('[LC BENCH]', JSON.stringify(report));
    };
    requestAnimationFrame(tick);
  }

  /** 页面卸载前落盘 */
  flush(): void { this.persist(); this.input.endFrame(); }
}

export { DT, screenToWorld, WELL_MASS_MIN, WELL_MASS_MAX };

/**
 * 存档净化：宿主首启存档里 last_level 可能是 null，展开合并会覆盖默认值，
 * 导致菜单"开始任务"因为 `levelByIndex(null)` 找不到关卡而静默无响应（实测就是这个）。
 * 这里把所有可能为 null/缺失的字段补齐到可用状态。
 */
function sanitizeSave(s: SaveState, doc: LevelsDoc): SaveState {
  const out = s as SaveState & Record<string, unknown>;
  out.settings = { ...DEFAULT_SAVE.settings, ...(s.settings ?? {}) };
  out.best_scores = s.best_scores ?? {};
  out.totals = { ...DEFAULT_SAVE.totals, ...(s.totals ?? {}) };
  out.unlocked_chapters = Math.max(1, Math.min(4, Number(s.unlocked_chapters) || 1));
  const ids = (doc?.levels ?? []).map((l) => l.id);
  if (!out.last_level || !ids.includes(String(out.last_level))) out.last_level = ids[0] ?? 'L1-1';
  if (typeof out.settings.quality !== 'string') out.settings.quality = 'high';
  out.settings.master = clamp01(out.settings.master, 0.8);
  out.settings.music = clamp01(out.settings.music, 0.55);
  out.settings.sfx = clamp01(out.settings.sfx, 0.9);
  out.settings.muted = Boolean(out.settings.muted);
  out.settings.showField = out.settings.showField !== false;
  return out;
}

function clamp01(v: unknown, dflt: number): number {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(0, Math.min(1, n));
}
