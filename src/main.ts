/**
 * 入口：连接 Python 任务控制中心（WebSocket，失败自动回退 HTTP）→ 装载素材 → 进入生命周期状态机。
 * 依据 docs/DESIGN.md 的交付形态，本入口同时服务「网页模式」与「桌面窗口模式」。
 */
import { Bridge } from './net/bridge';
import { Game } from './game/game';
import type { WelcomeMsg } from './sim/types';

const VERSION = '1.0.0';

/** 供看门狗复用的致命错误面板（定义在下面，这里先占位避免 TDZ） */
let showFatal: (msg: string, detail: string) => void = () => { /* 占位 */ };

function bootText(t: string): void {
  const el = document.getElementById('boot-text') ?? document.getElementById('boot');
  if (el) el.textContent = t;
}

function fatal(msg: string, detail: string): void {
  const el = document.getElementById('boot');
  if (el) {
    el.classList.remove('hidden');
    el.innerHTML = `<div class="boot-panel"><h1>无法启动</h1><p>${msg}</p><pre>${detail.replace(/</g, '&lt;')}</pre>
      <p class="dim">请确认已通过 <code>python python/mission_control.py --web</code> 启动本地任务控制中心。</p></div>`;
  }
  document.title = 'STARHERD — 启动失败';
}
showFatal = fatal;

async function fetchWelcome(autotest: boolean): Promise<WelcomeMsg> {
  const [levels, manifest, save] = await Promise.all([
    fetch('/api/levels').then((r) => r.json()),
    fetch('/api/manifest').then((r) => r.json()),
    fetch('/api/save').then((r) => r.json()).catch(() => null),
  ]);
  return {
    t: 'welcome', version: VERSION, mode: 'web', backend: 'http',
    server_time: Date.now() / 1000, port: Number(location.port || 80),
    config: {
      time_scale: 1.6, phys_hz: 120, epsilon: 0.02, isp: 320, g0: 9.80665,
      autotest, vsync: true, max_substeps: 8,
    },
    levels, manifest,
    music_index: (manifest?.music ?? []).map((m: { name: string; file: string; bpm: number }) => ({ name: m.name, file: m.file, bpm: m.bpm })),
    save: save ?? ({} as WelcomeMsg['save']),
    asset_base: '/assets/',
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui-root');
  if (!canvas || !uiRoot) { fatal('页面结构缺失（#game / #ui-root）', ''); return; }

  // 启动期的任何未处理异常/拒绝都要显示出来，而不是让页面停在加载界面
  window.addEventListener('error', (e) => {
    const g = (window as unknown as { __LC_GAME?: { isBooted?: boolean } }).__LC_GAME;
    if (g && g.isBooted) return;
    fatal('启动期 JavaScript 异常', `${e.message}\n${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const g = (window as unknown as { __LC_GAME?: { isBooted?: boolean } }).__LC_GAME;
    if (g && g.isBooted) return;
    const r = (e as PromiseRejectionEvent).reason as Error | undefined;
    fatal('启动期未处理的 Promise 拒绝', String(r?.stack ?? r ?? ''));
  });

  const params = new URLSearchParams(location.search);
  const autotest = params.has('autotest');
  const startLevel = Math.max(1, Number(params.get('level') ?? '1') || 1);

  bootText('正在连接任务控制中心…');
  const bridge = new Bridge();
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${autotest ? '?autotest=1' : ''}`;
  let welcome: WelcomeMsg | null = null;
  let wsError = '';

  // 离线单文件版：关卡 + 素材 + 配乐索引全部内联在页面里，不需要宿主、不需要联网
  const offline = (window as unknown as { __LC_OFFLINE__?: WelcomeMsg }).__LC_OFFLINE__;
  if (offline && offline.levels && offline.manifest) {
    welcome = offline;
    console.info('[LC] 离线单文件模式：已跳过任务控制中心连接（关卡与素材均内联）');
  } else {
    try {
      welcome = await bridge.connect(wsUrl, { mode: autotest ? 'autotest' : 'window', version: VERSION });
    } catch (e) {
      wsError = String((e as Error)?.message ?? e);
      console.warn('[LC] WebSocket 连接失败，回退 HTTP 接口：', wsError);
      try {
        welcome = await fetchWelcome(autotest);
      } catch (e2) {
        fatal('无法从任务控制中心获取任务数据。', `${wsError}\n${String(e2)}`);
        return;
      }
    }
  }

  const game = new Game({ canvas, uiRoot, welcome, bridge, autotest, startLevel });
  // 提前挂载，看门狗才能在启动过程中读到阶段信息
  (window as unknown as { __LC_GAME?: Game }).__LC_GAME = game;
  bridge.on('shutdown', () => { try { window.close(); } catch { /* 忽略 */ } });
  bridge.on('hint', (m) => {
    const t = (m as { text?: string }).text;
    if (t) {
      console.info('[LC 提示]', t);
      // 显示给玩家（此前只打控制台）：宿主按关卡数据生成的战术提示
      game.showHint(t);
    }
  });

  // 启动看门狗：catch 只能抓"抛出的异常"，抓不到"永远 pending 的 await"（例如
  // AudioContext.resume() 在自动播放策略下会一直 pending）。超时就显式暴露阶段与诊断。
  const t0 = performance.now();
  const watchdog = window.setInterval(() => {
    if (game.isBooted) { window.clearInterval(watchdog); return; }
    if (performance.now() - t0 < 30000) return;
    window.clearInterval(watchdog);
    const phases = game.phases.join(' → ');
    const msg = `启动超时：30 秒未完成初始化。\n已完成的阶段：${phases || '（无）'}`;
    void fetch('/api/selftest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false, boot_failure: true, timeout: true, error: msg, phases: game.phases,
        ua: navigator.userAgent, size: `${window.innerWidth}x${window.innerHeight}`, dpr: window.devicePixelRatio,
      }),
    }).catch(() => undefined);
    fatal('启动超时（页面停在加载界面）', msg);
  }, 2000);

  await game.start();
  window.clearInterval(watchdog);

  // 浏览器自动播放策略：首个用户手势时恢复音频上下文
  const unlock = (): void => { void game.unlockAudio(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot());
else void boot();
