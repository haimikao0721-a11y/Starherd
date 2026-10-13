/**
 * src/ui/menu.ts — 纯 DOM + CSS 菜单系统（冻结 API）
 *
 * 设计要点：
 *  1. 只操作 DOM 与样式类（样式全部在 web/styles.css，`lc-` 前缀），不使用任何动画库；
 *     面板进场 / 扫光 / 按钮辉光全由 CSS 动画完成。
 *  2. 音效不由本模块播放：所有可交互元素都带 `data-sfx="ui_click"`（悬停用
 *     `data-sfx-hover="ui_hover"`），游戏层在 document 上做事件委托即可。
 *     键盘导航会把选中项 focus 到，游戏层监听 `focusin` 也能拿到悬停音效。
 *  3. `handleKey()` 只有在有界面时（screen !== 'none'）才消费按键，游戏层据此屏蔽。
 *  4. `onStartLevel(levelIndex)` 传入的是 `LevelSpec.index`（1..12，不是数组下标）。
 */
import type {
  ChapterSpec, LevelSpec, LevelsDoc, SaveState, ScoreBreakdown,
} from '../sim/types';
import { DEFAULT_SAVE, podClassCounts } from '../sim/types';
import { clamp01, fmtDv, fmtDurationShort, fmtInt, fmtPct, fmtSci, fmtTime } from './format';
import { TUT_STEPS, TutorialAnim } from './tutorial';

/**
 * 制作者与仓库信息（**要改个人主页，只改下面的 `homepage` 这一行即可**）。
 * 游戏内「关于本作」界面与 README/Release 说明共用这套信息。
 */
export const AUTHOR = {
  name: '海米糕',
  handle: 'haimikao0721-a11y',
  /** GitHub 仓库（Star 按钮就指向这里） */
  repo: 'https://github.com/haimikao0721-a11y/Starherd',
  /** 个人主页：默认用 GitHub 主页；若你有独立博客/其他主页，把这一行换成你的网址 */
  homepage: 'https://github.com/haimikao0721-a11y',
  /** 联系邮箱（想改就改这一行；关于页会显示并可一键复制） */
  email: 'haimikao0721@gmail.com',
  version: 'v1.1.0',
};

export type ScreenName =
  | 'none' | 'boot' | 'menu' | 'levels' | 'briefing' | 'pause'
  | 'debrief' | 'chapter' | 'end' | 'help' | 'settings' | 'tutorial' | 'about';

/** 可下载曲目（由宿主 /api/music 提供；离线单文件版为空） */
export interface MusicTrackInfo {
  id: string; title_zh: string; title_en: string; url: string;
  bpm: number; key: string; mode: string; seconds: number;
}

export interface MenuCallbacks {
  onStartLevel(levelIndex: number): void;
  onResume(): void;
  onRetry(): void;
  onNext(): void;
  onBackToMenu(): void;
  onQuit(): void;
  onSetting<K extends keyof SaveState['settings']>(key: K, value: SaveState['settings'][K]): void;
  onSelectChapter(chapter: number): void;
  /** 打开外部链接（EXE 走宿主默认浏览器；离线版走 window.open） */
  onOpenUrl(url: string): void;
  /** 玩家看过（或跳过）操作演示 —— 用于"首次游玩自动弹演示" */
  onTutorialSeen(): void;
}

/* ------------------------------------------------------------------ 工具 */

const HTML_ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESC[c] ?? c);
}

/** 难度 1..12 → 5 颗点 */
function difficultyDots(d: number): string {
  const n = Math.max(1, Math.min(5, Math.round((Number.isFinite(d) ? d : 1) / 12 * 5)));
  let out = '<span class="lc-dots">';
  for (let i = 0; i < 5; i++) out += i < n ? '<i class="on"></i>' : '<i></i>';
  return out + '</span>';
}

/** 评级 → 颜色类 */
function gradeClass(grade: string | undefined): string {
  const g = (grade ?? '').trim().toUpperCase().slice(0, 1);
  if (g === 'S') return 'g-s';
  if (g === 'A') return 'g-a';
  if (g === 'B') return 'g-b';
  if (g === 'C') return 'g-c';
  if (g === 'D') return 'g-d';
  return 'g-none';
}

/** 时间因子等 0..1 系数 → 进度条 */
function factorBar(label: string, factor: number, detail: string, tone: string): string {
  const pct = clamp01(factor) * 100;
  return `<div class="lc-bar ${tone}">
    <span class="lc-bar-label">${esc(label)}</span>
    <span class="lc-bar-track"><i style="width:${pct.toFixed(1)}%"></i></span>
    <span class="lc-bar-val">${esc(detail)}</span>
  </div>`;
}

function btn(act: string, label: string, opts: { sfx?: string; cls?: string; level?: number; disabled?: boolean; title?: string } = {}): string {
  const cls = ['lc-btn', opts.cls ?? ''].filter(Boolean).join(' ');
  const lvl = typeof opts.level === 'number' ? ` data-level="${opts.level}"` : '';
  const dis = opts.disabled ? ' disabled' : '';
  const ttl = opts.title ? ` title="${esc(opts.title)}"` : '';
  return `<button class="${cls}" data-act="${esc(act)}" data-sfx="${esc(opts.sfx ?? 'ui_click')}" data-sfx-hover="ui_hover"${lvl}${dis}${ttl}>${esc(label)}</button>`;
}

/* ------------------------------------------------------------------ Menu */

export class Menu {
  private root: HTMLElement;
  private cb: MenuCallbacks;
  private el: HTMLElement;
  private current: ScreenName = 'none';
  /** 操作演示：动画实例 + 当前幕（自身带 rAF，不占用主循环） */
  private tut = new TutorialAnim();
  private tutStep = 0;
  private data: unknown = undefined;
  private levels: LevelsDoc | null = null;
  private save: SaveState = DEFAULT_SAVE;
  /** 可下载背景音乐（仅在有宿主时非空：EXE / 网页；离线单文件版恒为空 → 暂停页不渲染该区块） */
  private musicTracks: MusicTrackInfo[] = [];
  /** 「关于本作」页：仓库地址是否刚被复制（用于按钮回显） */
  private aboutCopied = false;
  /** 「关于本作」页：联系邮箱是否刚被复制 */
  private mailCopied = false;
  private items: HTMLElement[] = [];
  private sel = 0;
  private tickerEl: HTMLElement | null = null;
  private facts: string[] = [];
  private factIdx = 0;
  private factT = 0;
  private bound = false;

  constructor(root: HTMLElement, cb: MenuCallbacks) {
    if (!root) throw new Error('[Menu] 构造需要一个挂载节点（#ui-root）');
    this.root = root;
    this.cb = cb;
    const doc = root.ownerDocument;
    this.el = doc.createElement('div');
    this.el.className = 'lc-overlay';
    this.el.setAttribute('data-screen', 'none');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-live', 'polite');
    this.root.appendChild(this.el);
    this.rebuildFacts();
    this.bind();
  }

  /* ---------------------------------------------------------- 外部 API */

  setLevels(doc: LevelsDoc): void {
    this.levels = doc ?? null;
    this.rebuildFacts();
  }

  setSave(save: SaveState): void {
    if (save) this.save = save;
    // 设置界面不在此自动重绘：滑杆拖动中重绘会打断拖动
    if (this.current === 'levels' || this.current === 'end' || this.current === 'chapter') this.render();
  }

  show(screen: ScreenName, data?: unknown): void {
    // 离开演示界面时停掉动画循环（它自带 rAF，不挂到主循环上）
    if (this.current === 'tutorial' && screen !== 'tutorial') this.tut.detach();
    this.current = screen;
    this.data = data;
    this.factT = 0;
    if (screen === 'none') {
      this.el.setAttribute('data-screen', 'none');
      this.el.className = 'lc-overlay';
      this.el.innerHTML = '';
      this.items = [];
      this.tickerEl = null;
      return;
    }
    this.el.className = 'lc-overlay lc-on';
    this.el.setAttribute('data-screen', screen);
    this.render();
  }

  get screen(): ScreenName {
    return this.current;
  }

  get visible(): boolean {
    return this.current !== 'none';
  }

  /** 返回 true = 菜单已消费该按键（游戏层应屏蔽自己的处理） */
  handleKey(e: KeyboardEvent): boolean {
    if (this.current === 'none') return false;
    const k = e.key;
    if (k === 'Tab') { this.move(e.shiftKey ? -1 : 1); return true; }
    // 演示界面：左右键/空格翻幕，优先于焦点导航
    if (this.current === 'tutorial') {
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { this.tutStep = Math.max(0, this.tutStep - 1); this.render(); return true; }
      if (k === 'ArrowRight' || k === 'd' || k === 'D' || k === ' ') { this.tutStep = Math.min(TUT_STEPS.length - 1, this.tutStep + 1); this.render(); return true; }
    }
    switch (k) {
      case 'ArrowUp': case 'w': case 'W': this.move(-1); return true;
      case 'ArrowDown': case 's': case 'S': this.move(1); return true;
      case 'ArrowLeft': case 'a': case 'A': this.move(-1); return true;
      case 'ArrowRight': case 'd': case 'D': this.move(1); return true;
      case 'Enter': case ' ': case 'Spacebar': this.activate(); return true;
      case 'Escape': case 'Backspace':
        if (this.current === 'menu' || this.current === 'boot') return false; // 交给游戏层（例如恢复游戏）
        this.back();
        return true;
      default: return false;
    }
  }

  /** 顶部滚动小字：实时从 LevelsDoc 里轮换一条物理事实 */
  update(dtReal: number): void {
    const dt = Number.isFinite(dtReal) && dtReal > 0 ? Math.min(dtReal, 0.5) : 0;
    if (this.current === 'none' || !this.tickerEl || this.facts.length === 0) return;
    this.factT += dt;
    if (this.factT >= 6.5) {
      this.factT = 0;
      this.factIdx = (this.factIdx + 1) % this.facts.length;
      this.tickerEl.textContent = this.facts[this.factIdx];
      // 重启 CSS 进场动画（唯一的一次强制回流，频率 0.15 Hz）
      this.tickerEl.classList.remove('lc-tick-in');
      void this.tickerEl.offsetWidth;
      this.tickerEl.classList.add('lc-tick-in');
    }
  }

  /* ---------------------------------------------------------- 事件绑定 */

  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    const el = this.el;

    el.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement | null;
      const target = t && t.closest ? (t.closest('[data-act]') as HTMLElement | null) : null;
      if (!target || target.hasAttribute('disabled')) return;
      const act = target.getAttribute('data-act') ?? '';
      const lvl = Number(target.getAttribute('data-level'));
      this.act(act, lvl, target);
    });

    el.addEventListener('mouseover', (ev) => {
      const t = ev.target as HTMLElement | null;
      const target = t && t.closest ? (t.closest('[data-act]') as HTMLElement | null) : null;
      if (!target || target.hasAttribute('disabled')) return;
      const idx = this.items.indexOf(target);
      if (idx >= 0 && idx !== this.sel) this.setSel(idx);
    });

    el.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement | null;
      if (!t || !t.getAttribute) return;
      const key = t.getAttribute('data-set');
      if (!key) return;
      this.applySetting(key, t);
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement | null;
      if (!t || !t.getAttribute) return;
      const key = t.getAttribute('data-set');
      if (!key) return;
      this.applySetting(key, t);
    });
  }

  private applySetting(key: string, t: HTMLInputElement): void {
    const out = this.el.querySelector(`[data-out="${key}"]`);
    switch (key) {
      case 'master': case 'music': case 'sfx': {
        const v = clamp01(Number(t.value));
        if (out) out.textContent = fmtPct(v);
        this.save.settings[key] = v;
        this.cb.onSetting(key, v);
        break;
      }
      case 'quality': {
        const v = (t.value === 'low' || t.value === 'mid' || t.value === 'high') ? t.value : 'high';
        if (out) out.textContent = v === 'low' ? '低' : v === 'mid' ? '中' : '高';
        this.save.settings.quality = v;
        this.cb.onSetting('quality', v);
        break;
      }
      // ---- 性能设置（玩家反馈：帧率低 / 分辨率设置无效 / 弱机卡顿）----
      case 'fpsCap': {
        const v = Number(t.value) || 0;
        if (out) out.textContent = v === 0 ? '不限' : `${v}`;
        this.save.settings.fpsCap = v;
        this.cb.onSetting('fpsCap', v);
        break;
      }
      case 'renderScale': {
        const v = Math.max(0.35, Math.min(1, Number(t.value) || 0.62));
        if (out) out.textContent = fmtPct(v);
        this.save.settings.renderScale = v;
        this.save.settings.renderScaleAuto = false;
        this.cb.onSetting('renderScale', v);
        break;
      }
      case 'renderScaleAuto': {
        const auto = t.value !== 'fixed';
        if (out) out.textContent = auto ? '自动' : '手动';
        this.save.settings.renderScaleAuto = auto;
        this.cb.onSetting('renderScaleAuto', auto);
        // 重渲染：手动模式才允许拖动分辨率滑块（否则 disabled 的滑块收不到事件）
        this.renderSettings();
        break;
      }
      case 'physics60': {
        const p60 = t.value === '1';
        if (out) out.textContent = p60 ? '60 Hz' : '120 Hz';
        this.save.settings.physics60 = p60;
        this.cb.onSetting('physics60', p60);
        break;
      }
      case 'muted': {
        const v = !!t.checked;
        if (out) out.textContent = v ? '静音' : '开启';
        this.save.settings.muted = v;
        this.cb.onSetting('muted', v);
        break;
      }
      case 'showField': {
        const v = !!t.checked;
        if (out) out.textContent = v ? '显示' : '隐藏';
        this.save.settings.showField = v;
        this.cb.onSetting('showField', v);
        break;
      }
      default: break;
    }
  }

  /* ---------------------------------------------------------- 选择与动作 */

  private collectItems(): void {
    const all = Array.from(this.el.querySelectorAll('[data-act]')) as HTMLElement[];
    this.items = all.filter((n) => !n.hasAttribute('disabled'));
    this.sel = this.items.length ? 0 : -1;
    this.setSel(this.sel, true);
  }

  private setSel(idx: number, silent = false): void {
    if (this.items.length === 0) { this.sel = -1; return; }
    const n = this.items.length;
    const i = ((idx % n) + n) % n;
    for (let k = 0; k < n; k++) {
      const on = k === i;
      const node = this.items[k];
      if (on) node.classList.add('lc-sel');
      else node.classList.remove('lc-sel');
    }
    this.sel = i;
    if (!silent) {
      const node = this.items[i];
      try { node.focus({ preventScroll: true }); } catch { /* 忽略 */ }
      try { node.scrollIntoView({ block: 'nearest' }); } catch { /* 忽略 */ }
    }
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.setSel(this.sel + delta);
  }

  private activate(): void {
    if (this.sel < 0 || this.sel >= this.items.length) return;
    const node = this.items[this.sel];
    const tag = node.tagName.toUpperCase();
    if (tag === 'INPUT') {
      try { (node as HTMLInputElement).focus(); } catch { /* 忽略 */ }
      return;
    }
    node.click();
  }

  private act(act: string, level: number, node?: HTMLElement): void {
    switch (act) {
      case 'start-levels': this.show('levels'); break;
      case 'continue': {
        const lv = this.levelByIndex(this.lastLevelIndex());
        if (lv) this.show('briefing', lv.index); else this.show('levels');
        break;
      }
      case 'levels': this.show('levels'); break;
      case 'help': this.show('help'); break;
      case 'tutorial': this.tutStep = 0; this.cb.onTutorialSeen(); this.show('tutorial'); break;
      case 'tut-next': this.tutStep = Math.min(TUT_STEPS.length - 1, this.tutStep + 1); this.render(); break;
      case 'tut-prev': this.tutStep = Math.max(0, this.tutStep - 1); this.render(); break;
      case 'tut-replay': this.render(); break;
      case 'tut-step': this.tutStep = Math.max(0, Math.min(TUT_STEPS.length - 1, level)); this.render(); break;
      case 'tut-done': this.cb.onTutorialSeen(); this.show('menu'); break;
      case 'settings': this.show('settings'); break;
      case 'about': this.show('about'); break;
      case 'open-repo': this.cb.onOpenUrl(AUTHOR.repo); break;
      case 'open-home': this.cb.onOpenUrl(AUTHOR.homepage); break;
      case 'copy-repo':
        void this.copyText(AUTHOR.repo);
        break;
      case 'copy-mail':
        void this.copyText(AUTHOR.email);
        break;
      case 'quit': this.cb.onQuit(); break;
      case 'level': {
        const lv = this.levelByIndex(level);
        if (!lv || !this.levelUnlocked(lv)) return;
        this.show('briefing', lv.index);
        break;
      }
      case 'chapter': this.cb.onSelectChapter(level); this.show('levels'); break;
      case 'start': {
        const lv = this.levelByIndex(this.briefingIndex());
        if (!lv) return;
        this.cb.onStartLevel(lv.index);
        break;
      }
      case 'resume': this.cb.onResume(); break;
      case 'retry': this.cb.onRetry(); break;
      case 'next': this.cb.onNext(); break;
      case 'menu': this.cb.onBackToMenu(); break;
      case 'back': this.back(); break;
      case 'end': this.show('end'); break;
      default: break;
    }
    void node;
  }

  /** Esc / 返回：按界面的来源回退 */
  private back(): void {
    switch (this.current) {
      case 'levels': case 'help': case 'settings': case 'tutorial': case 'about': this.show('menu'); break;
      case 'briefing': this.show('levels'); break;
      case 'pause': this.cb.onResume(); break;
      case 'debrief': this.cb.onBackToMenu(); break;
      case 'chapter': case 'end': this.show('menu'); break;
      default: break;
    }
  }

  /* ---------------------------------------------------------- 关卡辅助 */

  private lastLevelIndex(): number {
    const id = this.save.last_level;
    const lv = this.levels?.levels.find((l) => l.id === id);
    if (lv) return lv.index;
    return this.levels?.levels[0]?.index ?? 1;
  }

  /** show('briefing', n) 里 n 可以是 index、数组下标、关卡 id，或省略（用存档） */
  private briefingIndex(): number {
    const d = this.data;
    if (typeof d === 'number' && Number.isFinite(d)) return d;
    if (typeof d === 'string') {
      const lv = this.levels?.levels.find((l) => l.id === d);
      if (lv) return lv.index;
    }
    if (d && typeof d === 'object') {
      const o = d as { index?: number; levelIndex?: number; id?: string };
      if (typeof o.index === 'number') return o.index;
      if (typeof o.levelIndex === 'number') return o.levelIndex;
      if (typeof o.id === 'string') {
        const lv = this.levels?.levels.find((l) => l.id === o.id);
        if (lv) return lv.index;
      }
    }
    return this.lastLevelIndex();
  }

  private levelByIndex(index: number): LevelSpec | undefined {
    const list = this.levels?.levels ?? [];
    if (!Number.isFinite(index)) return undefined;
    // 同时接受 1..12 的 LevelSpec.index 与 0..11 的数组下标
    return list.find((l) => l.index === index) ?? list[index] ?? list[index - 1];
  }

  private chapterOf(level: LevelSpec): ChapterSpec | undefined {
    return this.levels?.chapters.find((c) => c.index === level.chapter);
  }

  /** 顺序解锁：已解锁章节内，前一关有成绩才解锁下一关 */
  private levelUnlocked(level: LevelSpec): boolean {
    const un = this.save.unlocked_chapters ?? 1;
    if (level.chapter < un) return true;
    if (level.chapter > un) return false;
    const inCh = (this.levels?.levels ?? [])
      .filter((l) => l.chapter === level.chapter)
      .sort((a, b) => a.index - b.index);
    const pos = inCh.findIndex((l) => l.index === level.index);
    if (pos <= 0) return true;
    for (let i = 0; i < pos; i++) {
      if (!this.save.best_scores[inCh[i].id]) return false;
    }
    return true;
  }

  private bestOf(level: LevelSpec): { score: number; grade: string; time: number; fuel: number } | undefined {
    return this.save.best_scores[level.id];
  }

  /* ---------------------------------------------------------- 物理事实滚动条 */

  private rebuildFacts(): void {
    const doc = this.levels;
    const out: string[] = [];
    if (doc) {
      const c = doc.constants;
      out.push(`万有引力 F = G·m₁m₂/r²，本作取 G = ${c.G}、μ★ = ${c.mu_star} —— 屏幕上的每一次摆动都是真解`);
      out.push(`辛积分器（速度 Verlet / KDK 蛙跳）步长 h = 1/(120×${c.time_scale}) TU，长期能量漂移 |ΔE/E| < 1e-5`);
      out.push(`洛希极限 d ≈ R·(2ρ_M/ρ_m)^{1/3} —— 靠得太近，货舱会被潮汐力撕成碎片`);
      out.push(`齐奥尔科夫斯基火箭方程 Δv = I_sp·g₀·ln(m₀/m_f)，本作 I_sp = ${c.isp}s、g₀ = ${c.g0} m/s²`);
      out.push(`霍曼转移 Δv₁ = √(μ/r₁)·(√(2r₂/(r₁+r₂)) − 1) —— 最省燃料的轨道路径，也是 par_fuel 的来源`);
      out.push(`圆轨道速度 v_c = √(μ/r)，r = 1 处恰为 1 RU/TU；逃逸速度 v_esc = √(2μ/r) = √2·v_c`);
      out.push(`开普勒第三定律 T = 2π√(a³/μ) —— r = 1 处的轨道周期约 ${(2 * Math.PI).toFixed(3)} TU ≈ ${(2 * Math.PI * c.time_scale).toFixed(1)} 秒实时`);
      out.push(`Plummer 软化 ε = ${c.epsilon}：让 r→0 时加速度不发散，这是真实 N 体模拟的标准做法`);
      out.push('拉格朗日点 L4/L5 与两天体构成等边三角形，是天然的稳定停泊位');
      out.push('引力时间膨胀 Δt_∞ = Δt/√(1 − r_s/r)：黑洞视界附近，货舱的时间流速会真的变慢');
      for (const ch of doc.chapters) {
        out.push(`LOOP ${ch.index} ${ch.name_zh} / ${ch.name_en} —— ${ch.desc_zh}`);
      }
      for (const lv of doc.levels) {
        if (lv.solution && lv.solution.notes) {
          out.push(`${lv.name_zh}（${lv.id}）参考解：${lv.solution.notes}，Δv_min = ${fmtDv(lv.solution.dv_min)}`);
        }
      }
    } else {
      out.push('正在连接任务控制中心，等待星图数据…');
    }
    this.facts = out;
    if (this.factIdx >= out.length) this.factIdx = 0;
  }

  /* ---------------------------------------------------------- 渲染 */

  private render(): void {
    const s = this.current;
    switch (s) {
      case 'boot': this.renderBoot(); break;
      case 'menu': this.renderMenu(); break;
      case 'levels': this.renderLevels(); break;
      case 'briefing': this.renderBriefing(); break;
      case 'pause': this.renderPause(); break;
      case 'debrief': this.renderDebrief(); break;
      case 'chapter': this.renderChapter(); break;
      case 'end': this.renderEnd(); break;
      case 'help': this.renderHelp(); break;
      case 'tutorial': this.renderTutorial(); break;
      case 'settings': this.renderSettings(); break;
      case 'about': this.renderAbout(); break;
      default: this.el.innerHTML = ''; break;
    }
  }

  private shell(body: string, opts: { ticker?: boolean; wide?: boolean; cls?: string } = {}): void {
    const tick = opts.ticker === false ? '' : `<footer class="lc-ticker"><span class="lc-ticker-label">PHYSICS</span><span class="lc-ticker-text lc-tick-in">${esc(this.facts[this.factIdx] ?? '')}</span></footer>`;
    this.el.innerHTML = `
      <div class="lc-veil"></div>
      <div class="lc-scan" aria-hidden="true"></div>
      <section class="lc-panel lc-enter ${opts.wide ? 'lc-wide' : ''} ${opts.cls ?? ''}">
        ${body}
      </section>
      ${tick}`;
    this.tickerEl = this.el.querySelector('.lc-ticker-text') as HTMLElement | null;
    this.collectItems();
  }

  private header(titleZh: string, titleEn: string, sub?: string): string {
    return `<header class="lc-head">
      <h1 class="lc-title"><span class="lc-title-zh">${esc(titleZh)}</span><span class="lc-title-en">${esc(titleEn)}</span></h1>
      ${sub ? `<p class="lc-sub">${esc(sub)}</p>` : ''}
      <div class="lc-rule" aria-hidden="true"></div>
    </header>`;
  }

  /* ---- boot ---- */
  private renderBoot(): void {
    const d = (this.data ?? {}) as { text?: string; progress?: number };
    const pct = clamp01(typeof d.progress === 'number' ? d.progress : 0) * 100;
    this.shell(`${this.contactBlock()}` + `
      <div class="lc-boot">
        <div class="lc-boot-ring" aria-hidden="true"></div>
        <h2 class="lc-boot-title">正在连接任务控制中心…</h2>
        <p class="lc-boot-text">${esc(d.text ?? '建立遥测链路 · 校验素材 sha256 · 载入星图')}</p>
        <div class="lc-progress"><i style="width:${pct.toFixed(1)}%"></i></div>
        <p class="lc-boot-pct">${fmtPct(pct / 100)}</p>
      </div>`, { ticker: false });
  }

  /* ---- menu ---- */
  private renderMenu(): void {
    const hasSave = (this.levels?.levels?.length ?? 0) > 0;
    const body = `
      ${this.header('牧星者', 'STARHERD', '你不是射手，你是引力源')}
      <nav class="lc-nav">
        ${btn('tutorial', '看操作演示（30 秒学会）', { title: '5 幕动画：引力井 / 左右键区别 / 怎么对接' })}
        ${btn('about', '关于本作 · 制作者与仓库', { title: '制作者 / GitHub 仓库 / 给仓库点 Star / 个人主页' })}
        ${btn('start-levels', '开始任务', { title: '选择关卡' })}
        ${btn('continue', '继续', { disabled: !hasSave, title: '从上次的关卡继续' })}
        ${btn('levels', '章节选择')}
        ${btn('help', '操作与公式')}
        ${btn('settings', '设置')}
        ${btn('quit', '退出', { cls: 'lc-danger' })}
      </nav>
      
      <p class="lc-hint">↑↓ 选择 · Enter 确认 · Esc 返回 · 鼠标可直接点击 · 首次游玩建议先看操作演示</p>${this.contactBlock()}`;
    this.shell(body);
  }

  /* ---- levels ---- */
  private renderLevels(): void {
    const doc = this.levels;
    if (!doc || doc.levels.length === 0) {
      this.shell(`${this.header('章节选择', 'CHAPTER SELECT', '等待星图数据…')}
        <nav class="lc-nav">${btn('back', '返回')}</nav>`);
      return;
    }
    const un = this.save.unlocked_chapters ?? 1;
    let chips = '';
    for (const ch of doc.chapters) {
      const locked = ch.index > un;
      chips += `<button class="lc-chip ${locked ? 'lc-locked' : ''}" data-act="chapter" data-level="${ch.index}"
        data-sfx="ui_click" data-sfx-hover="ui_hover" ${locked ? 'disabled' : ''}>LOOP ${ch.index} ${esc(ch.name_zh)}</button>`;
    }
    let groups = '';
    for (const ch of doc.chapters) {
      const lvls = doc.levels.filter((l) => l.chapter === ch.index).sort((a, b) => a.index - b.index);
      const locked = ch.index > un;
      let cards = '';
      for (const lv of lvls) {
        const best = this.bestOf(lv);
        const unlocked = this.levelUnlocked(lv);
        cards += `<button class="lc-card ${unlocked ? '' : 'lc-locked'} ${best ? 'lc-done' : ''}"
          data-act="level" data-level="${lv.index}" data-grade="${esc(lv.difficulty_label ?? '')}" data-sfx="ui_click" data-sfx-hover="ui_hover" ${unlocked ? '' : 'disabled'}>
          <span class="lc-card-no">${String(lv.index).padStart(2, '0')}</span>
          <span class="lc-card-name">${esc(lv.name_zh)}</span>
          <span class="lc-card-en">${esc(lv.name_en)}</span>
          <span class="lc-card-foot">
            ${difficultyDots(lv.difficulty)}
              ${lv.difficulty_label ? `<span class="lc-gradetag" data-grade="${esc(lv.difficulty_label)}">${esc(lv.difficulty_label)}</span>` : ''}
            ${best
              ? `<span class="lc-best ${gradeClass(best.grade)}">${fmtInt(best.score)} ${esc(best.grade)}</span>`
              : '<span class="lc-best g-none">未通关</span>'}
          </span>
          ${unlocked ? '' : '<span class="lc-lock">锁定</span>'}
        </button>`;
      }
      groups += `<section class="lc-chapter ${locked ? 'lc-locked' : ''}">
        <h3 class="lc-chapter-head">
          <span class="lc-chapter-no">LOOP ${ch.index}</span>
          <span class="lc-chapter-zh">${esc(ch.name_zh)}</span>
          <span class="lc-chapter-en">${esc(ch.name_en)}</span>
          ${locked ? '<span class="lc-lock">未解锁</span>' : ''}
        </h3>
        <div class="lc-cards">${cards}</div>
      </section>`;
    }
    const body = `
      ${this.header('章节选择', 'CHAPTER SELECT', `已解锁 ${un}/${doc.chapters.length} 章 · 共 ${doc.levels.length} 关`)}
      <div class="lc-chips">${chips}</div>
      <div class="lc-scroll">${groups}</div>
      <nav class="lc-nav lc-nav-row">${btn('back', '返回主菜单')}</nav>`;
    this.shell(body, { ticker: true });
  }

  /* ---- briefing ---- */
  private renderBriefing(): void {
    const lv = this.levelByIndex(this.briefingIndex());
    if (!lv) {
      this.shell(`${this.header('任务简报', 'MISSION BRIEFING', '无可用关卡')}
        <nav class="lc-nav">${btn('back', '返回')}</nav>`);
      return;
    }
    const ch = this.chapterOf(lv);
    const pods = lv.pods.length;
    const required = Math.max(1, Math.round(pods * (lv.difficulty <= 2 ? 1 : 0.6)));
    const sol = lv.solution;
    // 本关货舱构成（cargo pod variants）：级别标签 + 数量，缺省级别按标准舱计
    const comp = podClassCounts(lv.pods);
    const compChips = comp.map(({ cls, n }) =>
      `<span class="lc-podchip" style="color:${esc(cls.color)};border-color:${esc(cls.color)}">${esc(cls.nameZh)} ×${n}</span>`).join('');
    const compNotes = comp.map(({ cls }) =>
      `<p><b style="color:${esc(cls.color)}">${esc(cls.nameZh)}</b> <span class="lc-dim">${esc(cls.nameEn)}</span> · ${esc(cls.note)}</p>`).join('');
    const body = `
      ${this.header(`${lv.name_zh}`, lv.name_en, `CH.${lv.chapter}${ch ? ' ' + ch.name_zh : ''} · 难度 ${lv.difficulty}/12${lv.difficulty_label ? ` · ${esc(lv.difficulty_label)}` : ''} · ${lv.id}`)}
      <div class="lc-brief">
        <div class="lc-stat-grid">
          <div class="lc-stat"><span class="lc-stat-k">任务目标</span><span class="lc-stat-v">把 ${required} / ${pods} 个货舱送入对接环</span></div>
          <div class="lc-stat"><span class="lc-stat-k">时限</span><span class="lc-stat-v">${fmtTime(Math.max(90, lv.par_time * 3.4), 'floor')}</span></div>
          <div class="lc-stat"><span class="lc-stat-k">Δv 预算</span><span class="lc-stat-v">${fmtDv((40 + 6 * lv.difficulty) * (lv.fuel_scale ?? 1))}${lv.fuel_scale ? ` <span class="lc-dim">(×${lv.fuel_scale} 余量)</span>` : ''}</span></div>
          <div class="lc-stat"><span class="lc-stat-k">par 时间 / par Δv</span><span class="lc-stat-v">${fmtTime(lv.par_time, 'floor')} / ${fmtDv(lv.par_fuel)}</span></div>
          <div class="lc-stat"><span class="lc-stat-k">星域尺度</span><span class="lc-stat-v">bounds ${lv.bounds} RU · μ★ ${lv.mu_star}</span></div>
          <div class="lc-stat"><span class="lc-stat-k">对接门限</span><span class="lc-stat-v">|v_rel| &lt; ${lv.dock.v_max} RU/TU · 环半径 ${lv.dock.radius}</span></div>
          <div class="lc-stat"><span class="lc-stat-k">货舱构成</span><span class="lc-stat-v">货舱 ${pods}：${compChips}</span></div>
        </div>
        <div class="lc-note lc-note-pods">
          <span class="lc-note-k">货舱级别 / CARGO POD CLASSES</span>
          ${compNotes}
        </div>
        <div class="lc-note">
          <span class="lc-note-k">简报 / HINT</span>
          <p>${esc(lv.hint_zh)}</p>
        </div>
        <div class="lc-note lc-note-sol">
          <span class="lc-note-k">霍曼转移参考解 / REFERENCE SOLUTION</span>
          <p>${esc(sol ? sol.method : 'hohmann')} · Δv_min = <b>${fmtDv(sol ? sol.dv_min : 0)}</b></p>
          <p class="lc-dim">${esc(sol ? sol.notes : '由 Python physics_ref.py 用真实公式估算')}</p>
        </div>
      </div>
      <nav class="lc-nav lc-nav-row">
        ${btn('start', '开始任务', { cls: 'lc-primary' })}
        ${btn('back', '返回')}
      </nav>
      <p class="lc-hint">提示：按住左键把货舱拖出原轨道，接近空间站时松开，让惯性完成对接</p>`;
    this.shell(body);
  }

  /* ---- pause ---- */
  private renderPause(): void {
    // **背景音乐下载**：只在"有宿主进程"的模式下出现（EXE / 网页）。
    // 离线单文件版（file://）没有宿主，`musicTracks` 永远为空 → 这个区块根本不渲染，
    // 因此天然满足"只在 exe 里能下载"的要求。
    const musicBlock = this.musicTracks.length
      ? `<section class="lc-note lc-note-music">
          <h4>背景音乐下载 / SOUNDTRACK</h4>
          <p class="lc-hint">全部由项目自身的程序化合成器生成（谱面 → 离线渲染 WAV，无第三方素材）。</p>
          <nav class="lc-nav lc-nav-music">
            ${this.musicTracks.map((t) => `<a class="lc-btn" href="${esc(t.url)}" download
              title="${esc(t.title_en)} · ${t.bpm} BPM · ${esc(String(t.key))} ${esc(String(t.mode))} · ${t.seconds}s">
              ${esc(t.title_zh)}<span class="lc-music-en">${esc(t.title_en)}</span>
              <span class="lc-music-meta">${t.bpm} BPM · ${t.seconds}s</span></a>`).join('')}
          </nav>
          <p class="lc-hint">首次点击需要在宿主端渲染约 10 秒（之后走缓存，秒下）。</p>
        </section>`
      : '';
    const body = `
      ${this.header('暂停', 'PAUSED', '牧星者号待机中 · 时空坐标已冻结')}
      <nav class="lc-nav">
        ${btn('resume', '继续', { cls: 'lc-primary' })}
        ${btn('retry', '重试本关')}
        ${btn('settings', '设置')}
        ${btn('menu', '返回主菜单')}
      </nav>
      <p class="lc-hint">Esc 继续 · R 重试 · M 静音 · T 加速</p>
      ${musicBlock}`;
    this.shell(body);
  }

  /** 由游戏层在有宿主时注入可下载曲目；离线单文件版不会调用它 */
  setMusicTracks(tracks: MusicTrackInfo[]): void {
    this.musicTracks = tracks;
    if (this.screen === 'pause') this.renderPause();
  }

  /* ---- about（制作者 / 仓库 / Star / 个人主页）---- */
  private renderAbout(): void {
    const body = `
      ${this.header('关于本作', 'ABOUT', `${AUTHOR.version} · 制作者与仓库`)}
      <section class="lc-note lc-note-about">
        <h4>制作者</h4>
        <p class="lc-about-line"><b>${esc(AUTHOR.name)}</b>
          <span class="lc-about-handle">@${esc(AUTHOR.handle)}</span></p>
        <p class="lc-hint">一个人写完的：物理公式库、12 关关卡、渲染与音频合成、三种交付形态。</p>
        <p class="lc-about-line">联系邮箱
          <span class="lc-about-url lc-about-mail" title="可选中复制">${esc(AUTHOR.email)}</span></p>
        <nav class="lc-nav lc-nav-about">
          ${btn('copy-mail', this.mailCopied ? '已复制 ✓' : '复制邮箱', { title: '把邮箱复制到剪贴板' })}
        </nav>
        <p class="lc-hint">${this.mailCopied
          ? '邮箱已复制，欢迎反馈 bug、建议关卡或聊聊物理。'
          : '发现问题、想加关卡、或想聊公式，都欢迎写信 —— 独立开发最需要的就是反馈。'}</p>
      </section>
      <section class="lc-note lc-note-about">
        <h4>GitHub 仓库 · 觉得好玩就点个 Star ⭐</h4>
        <p class="lc-about-url" title="可选中复制">${esc(AUTHOR.repo)}</p>
        <nav class="lc-nav lc-nav-about">
          ${btn('open-repo', '⭐ 去仓库点 Star', { cls: 'lc-primary', title: '用默认浏览器打开仓库页面，右上角点 Star' })}
          ${btn('open-home', '我的个人主页', { title: esc(AUTHOR.homepage) })}
          ${btn('copy-repo', this.aboutCopied ? '已复制 ✓' : '复制仓库地址', { title: '把地址复制到剪贴板，方便分享给朋友' })}
        </nav>
        <p class="lc-hint">${this.aboutCopied
          ? '仓库地址已复制到剪贴板，可以直接粘贴给朋友。'
          : '一键 Star 是独立开发者最实在的鼓励 —— 也能让更多人看到这个项目。'}</p>
      </section>
      <section class="lc-note lc-note-about">
        <h4>许可与素材</h4>
        <p class="lc-hint">源码与素材均为 <b>MIT</b> 许可；美术、音效、音乐全部由本项目
          <b>程序化生成</b>（生成器与固定种子都在仓库里），<b>不含任何第三方素材</b>。</p>
        <p class="lc-hint">游戏内背景音乐可在暂停页下载（仅 EXE / 网页模式）。</p>
      </section>
      <nav class="lc-nav">
        ${btn('back', '返回主菜单', { cls: 'lc-primary' })}
      </nav>`;
    this.shell(body);
  }

  /** 复制到剪贴板（离线 file:// 下 clipboard API 可能不可用，用 textarea 兜底） */
  private async copyText(text: string): Promise<void> {
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* 继续走兜底 */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch { ok = false; }
    }
    this.aboutCopied = ok;
    this.mailCopied = ok && text === AUTHOR.email;
    this.aboutCopied = ok && text !== AUTHOR.email;
    if (this.current === 'about') this.renderAbout();
  }

  /* ---- debrief ---- */
  /** 联系区块：结算页与启动页共用。作者最需要的是反馈与 Star，所以放在曝光最高的位置。 */
  private contactBlock(): string {
    return `
      <div class="lc-contact">
        <p class="lc-contact-lead">喜欢《牧星者》？给个 ⭐ <b>Star</b> 是独立开发者最实在的鼓励。</p>
        <nav class="lc-nav lc-nav-row">
          ${btn('copy-mail', '复制邮箱', { title: AUTHOR.email })}
          ${btn('copy-repo', '复制仓库地址', { title: AUTHOR.repo })}
        </nav>
        <p class="lc-hint">发现 bug、想加关卡、想聊公式，都欢迎写信：<b>${esc(AUTHOR.email)}</b>
          · 仓库 <span class="lc-mono">${esc(AUTHOR.repo)}</span></p>
      </div>`;
  }

  private renderDebrief(): void {
    const sb = (this.data ?? null) as ScoreBreakdown | null;
    if (!sb) {
      this.shell(`${this.header('任务结算', 'DEBRIEF', '无结算数据')}
        <nav class="lc-nav">${btn('menu', '返回主菜单')}</nav>`);
      return;
    }
    const gcls = gradeClass(sb.grade);
    const body = `
      ${this.header(sb.title || (sb.success ? '任务完成' : '任务失败'), sb.subtitle || (sb.success ? 'MISSION COMPLETE' : 'MISSION FAILED'))}
      <div class="lc-score-row">
        <div class="lc-score-box">
          <span class="lc-score-num">${fmtInt(sb.score)}</span>
          <span class="lc-score-unit">分</span>
          ${sb.newBest ? '<span class="lc-newbest">新纪录 / NEW RECORD</span>' : ''}
        </div>
        <div class="lc-grade ${gcls}"><span class="lc-grade-letter">${esc(sb.grade || 'D')}</span><span class="lc-grade-cap">FIDELITY &amp; PERF</span></div>
      </div>
      <div class="lc-bars">
        ${factorBar('时间', sb.timeFactor, `${fmtTime(sb.time, 'floor')} / par ${fmtTime(sb.parTime, 'floor')} · ${fmtPct(sb.timeFactor)}`, 't-time')}
        ${factorBar('燃料', sb.fuelFactor, `Δv 已消耗 ${fmtDv(sb.fuelUsed)} · 理论下限 ${fmtDv(sb.parFuel)} · 得分系数 ${fmtPct(sb.fuelFactor)}`, 't-fuel')}
        ${factorBar('物理保真度', sb.fidelityFactor, `${esc(sb.fidelityGrade)} 级 · ${fmtPct(sb.fidelityFactor)}`, 't-fid')}
        ${factorBar('货舱存活', sb.survivalFactor, `${sb.delivered}/${sb.total} 送达 · 损毁 ${sb.lost} · ${fmtPct(sb.survivalFactor)}`, 't-surv')}
      </div>
      <div class="lc-note lc-note-verdict">
        <span class="lc-note-k">物理裁判 / PHYSICS VERDICT</span>
        <p>${esc(sb.fidelityNote || '守恒量审计未返回评语')}</p>
        <p class="lc-mono">ΔE/E = ${esc(fmtSci(sb.energyDrift, 2))}    ΔL/L = ${esc(fmtSci(sb.angularDrift, 2))}    连击 ×${fmtInt(sb.combo)}    难度 ${sb.difficulty}</p>
      </div>
      ${this.contactBlock()}
      <nav class="lc-nav lc-nav-row">
        ${sb.success ? btn('next', '下一关', { cls: 'lc-primary' }) : ''}
        ${btn('retry', sb.success ? '重试本关' : '重试', { cls: sb.success ? '' : 'lc-primary' })}
        ${btn('menu', '返回主菜单')}
      </nav>`;
    this.shell(body);
  }

  /* ---- chapter ---- */
  private renderChapter(): void {
    const d = (this.data ?? {}) as { chapter?: number; name_zh?: string; score?: number };
    const idx = Number.isFinite(d.chapter) ? Number(d.chapter) : 1;
    const ch = this.levels?.chapters.find((c) => c.index === idx);
    const next = this.levels?.chapters.find((c) => c.index === idx + 1);
    const unlocked = (this.save.unlocked_chapters ?? 1) > idx && !!next;
    const body = `
      ${this.header(`LOOP ${idx} 完成`, 'CHAPTER CLEAR', ch ? ch.name_en : '')}
      <div class="lc-celebrate">
        <div class="lc-celebrate-name">${esc(d.name_zh ?? ch?.name_zh ?? '章节完成')}</div>
        <div class="lc-celebrate-score"><span>${fmtInt(d.score ?? 0)}</span><small>章节总分</small></div>
        <p class="lc-celebrate-unlock">${unlocked && next
          ? `新章节已解锁：LOOP ${next.index} ${esc(next.name_zh)} / ${esc(next.name_en)}`
          : (next ? `继续挑战 LOOP ${next.index} ${esc(next.name_zh)}` : '全部章节已通关，向深渊视界致敬。')}</p>
      </div>
      <nav class="lc-nav lc-nav-row">
        ${btn('next', '继续', { cls: 'lc-primary' })}
        ${btn('levels', '关卡选择')}
        ${btn('menu', '返回主菜单')}
      </nav>`;
    this.shell(body);
  }

  /* ---- end ---- */
  private renderEnd(): void {
    const t = this.save.totals;
    const scores = Object.keys(this.save.best_scores ?? {});
    let totalScore = 0;
    let grades = '';
    for (const k of scores) {
      const b = this.save.best_scores[k];
      totalScore += b.score || 0;
      grades += b.grade || '';
    }
    const sCount = (grades.match(/S/g) ?? []).length;
    const body = `
      ${this.header('全部通关', 'ALL CHAPTERS CLEAR', '四段 LOOP，一整条拉格朗日航线')}
      <div class="lc-stat-grid lc-stat-grid-4">
        <div class="lc-stat"><span class="lc-stat-k">任务数</span><span class="lc-stat-v">${fmtInt(t.played)}</span></div>
        <div class="lc-stat"><span class="lc-stat-k">货舱送达</span><span class="lc-stat-v">${fmtInt(t.delivered)}</span></div>
        <div class="lc-stat"><span class="lc-stat-k">货舱损毁</span><span class="lc-stat-v">${fmtInt(t.lost)}</span></div>
        <div class="lc-stat"><span class="lc-stat-k">总时长</span><span class="lc-stat-v">${fmtDurationShort(t.playtime)}</span></div>
      </div>
      <div class="lc-celebrate">
        <div class="lc-celebrate-score"><span>${fmtInt(totalScore)}</span><small>最佳分总和</small></div>
        <p class="lc-celebrate-unlock">已通关 ${scores.length} 关 · S 级 ${sCount} 个 · 送达/损毁比 ${t.lost > 0 ? (t.delivered / t.lost).toFixed(2) : '∞'}</p>
      </div>
      <nav class="lc-nav lc-nav-row">
        ${btn('levels', '关卡选择')}
        ${btn('menu', '返回主菜单', { cls: 'lc-primary' })}
        ${btn('quit', '退出', { cls: 'lc-danger' })}
      </nav>`;
    this.shell(body);
  }

  /* ---- tutorial（操作演示）---- */
  private renderTutorial(): void {
    const n = TUT_STEPS.length;
    const i = Math.max(0, Math.min(n - 1, this.tutStep));
    const st = TUT_STEPS[i];
    const dots = TUT_STEPS.map((s, k) =>
      `<button class="lc-dot${k === i ? ' on' : ''}" data-act="tut-step" data-level="${k}" data-sfx="ui_click"`
      + ` title="${esc(s.title)}" aria-label="第 ${k + 1} 幕：${esc(s.title)}"></button>`).join('');
    const press = st.press === 'left' ? '<span class="lc-tut-mouse left">按住左键</span>'
      : st.press === 'right' ? '<span class="lc-tut-mouse right">按住右键</span>'
        : '<span class="lc-tut-mouse free">松开按键</span>';
    const body = `
      ${this.header('操作演示', 'INTERACTIVE BRIEFING', `第 ${i + 1} / ${n} 幕 · 看完就知道怎么玩了`)}
      <div class="lc-tut">
        <canvas id="lc-tut-canvas" class="lc-tut-canvas" width="900" height="360"></canvas>
        <aside class="lc-tut-side">
          <div class="lc-tut-dots">${dots}</div>
          <h3 class="lc-tut-title">${esc(st.title)}</h3>
          <div class="lc-tut-sub">${esc(st.sub)}</div>
          <p class="lc-tut-text">${esc(st.text)}</p>
          <div class="lc-tut-foot">${press}<span class="lc-tut-hint">${esc(st.hint)}</span></div>
        </aside>
      </div>
      <nav class="lc-nav lc-nav-row">
        ${btn('tut-prev', '上一幕', { disabled: i === 0 })}
        ${btn('tut-next', i === n - 1 ? '再看一遍' : '下一幕', { disabled: false })}
        ${i === n - 1 ? btn('tut-done', '我懂了，开始游戏', { cls: 'lc-go' }) : ''}
        ${btn('tut-replay', '重播本幕')}
        ${btn('back', '返回菜单')}
      </nav>
      <p class="lc-hint">← → 或空格翻幕 · 点击圆点跳幕 · 动画里左键=吸引、右键=排斥（方向相反）</p>`;
    this.shell(body, { wide: true });
    const cv = this.el.querySelector('#lc-tut-canvas') as HTMLCanvasElement | null;
    if (cv) {
      this.tut.attach(cv);
      this.tut.setStep(i);
    }
  }

  /* ---- help ---- */
  private renderHelp(): void {
    const isp = this.levels?.constants.isp ?? 320;
    const ts = this.levels?.constants.time_scale ?? 1.6;
    const eps = this.levels?.constants.epsilon ?? 0.02;
    const controls: Array<[string, string]> = [
      ['鼠标移动', '设定引力井目标位置（弹簧-阻尼追随，有惯性、有滞后）'],
      ['左键按住', '井通电 = 吸引；松开则待机（质量归零，只留探测器本体）'],
      ['右键按住', '极性反转 = 斥力井（紧急制动 / 防撞）'],
      ['鼠标滚轮', '连续调节井质量 M_w（0.004 → 0.08 M★，1/2/3 为预设）'],
      ['空格', '时间膨胀 ×0.25（慢动作），消耗算力，自动回充'],
      ['1 / 2 / 3', '质量预设：轻（精确）/ 中（均衡）/ 重（强引力，费燃料）'],
      ['Shift', '精确模式：阻尼比 ζ→1.0（临界阻尼，跟手不甩尾）'],
      ['Tab', '轨道预测：用同一积分器前推 6 s 的虚影轨迹'],
      ['G', '引力场可视化：等势线 + 场向量箭头'],
      ['F', '惯性参考系：速度矢量与轨道要素'],
      ['R / Esc / M', '重置关卡 / 暂停菜单 / 静音'],
      ['H', '展开 / 收起这张操作卡片'],
    ];
    const formulas: Array<[string, string, string]> = [
      ['万有引力', 'F = G·m₁m₂/r²', '一切运动的唯一来源；Plummer 软化 ε 防止 r→0 发散'],
      ['辛积分器', 'KDK 蛙跳，h = 1/(120·' + ts + ') TU', '长期能量守恒，ΔE/E 稳定在 1e-6 量级'],
      ['洛希极限', 'd ≈ R·(2ρ_M/ρ_m)^{1/3}', '太近则潮汐撕裂成碎片（第 4 章必修）'],
      ['齐奥尔科夫斯基', `Δv = I_sp·g₀·ln(m₀/m_f)`, `I_sp = ${isp}s、g₀ = 9.80665 m/s²，Δv 预算的由来`],
      ['霍曼转移', 'Δv₁ = √(μ/r₁)(√(2r₂/(r₁+r₂))−1)', '最省燃料的轨道机动，par_fuel 由它反解'],
      ['光压', 'a_rad = k·sail·A/(r²·m)', '光帆货舱被恒星推离，可当微推力用'],
      ['二次阻力', 'F_d = −½ρ·C_d·A·|v_rel|·v_rel', '星云共转系里的气动刹车（真实减速手段）'],
      ['开普勒第三定律', 'T = 2π√(a³/μ)', '轨道周期与半长轴的三次方成正比'],
      ['拉格朗日点', 'L₁ ≈ R·(1−(m/3M)^{1/3})', 'L4/L5 与两天体成等边三角形，稳定停泊位'],
      ['引力时间膨胀', 'Δt_∞ = Δt/√(1−r_s/r)', '黑洞关卡的时间流速可视化'],
    ];
    const body = `
      ${this.header('操作与公式', 'CONTROLS & FORMULAS', `G=1 · μ★=1 · ε=${eps} · 1 TU = ${ts} s 实时`)}
      <div class="lc-cols lc-scroll">
        <div class="lc-col">
          <h3 class="lc-col-head">操作 / CONTROLS</h3>
          ${controls.map(([k, v]) => `<div class="lc-kv"><span class="lc-kbd">${esc(k)}</span><span class="lc-kv-v">${esc(v)}</span></div>`).join('')}
        </div>
        <div class="lc-col">
          <h3 class="lc-col-head">物理公式 / FORMULAS</h3>
          ${formulas.map(([n, f, u]) => `<div class="lc-formula"><span class="lc-formula-n">${esc(n)}</span><code class="lc-formula-f">${esc(f)}</code><span class="lc-formula-u">${esc(u)}</span></div>`).join('')}
        </div>
      </div>
      <nav class="lc-nav lc-nav-row">${btn('back', '返回')}</nav>`;
    this.shell(body, { wide: true });
  }

  /* ---- settings ---- */
  private renderSettings(): void {
    const st = this.save.settings;
    const q = st.quality;
    const qText = q === 'low' ? '低' : q === 'mid' ? '中' : '高';
    const body = `
      ${this.header('设置', 'SETTINGS', '变更立即生效并写入存档 · 卡顿就调低「渲染分辨率」或切到 60 Hz 物理步长')}
      <div class="lc-sliders">
        <div class="lc-slider-row">
          <span class="lc-label">主音量</span>
          <input class="lc-range" type="range" min="0" max="1" step="0.01" value="${st.master}" data-set="master" data-sfx="ui_click" aria-label="主音量">
          <span class="lc-value" data-out="master">${fmtPct(st.master)}</span>
        </div>
        <div class="lc-slider-row">
          <span class="lc-label">音乐</span>
          <input class="lc-range" type="range" min="0" max="1" step="0.01" value="${st.music}" data-set="music" data-sfx="ui_click" aria-label="音乐音量">
          <span class="lc-value" data-out="music">${fmtPct(st.music)}</span>
        </div>
        <div class="lc-slider-row">
          <span class="lc-label">音效</span>
          <input class="lc-range" type="range" min="0" max="1" step="0.01" value="${st.sfx}" data-set="sfx" data-sfx="ui_click" aria-label="音效音量">
          <span class="lc-value" data-out="sfx">${fmtPct(st.sfx)}</span>
        </div>
        <div class="lc-slider-row">
          <span class="lc-label">画质</span>
          <select class="lc-select" data-set="quality" data-sfx="ui_click" aria-label="画质">
            <option value="low" ${q === 'low' ? 'selected' : ''}>低</option>
            <option value="mid" ${q === 'mid' ? 'selected' : ''}>中</option>
            <option value="high" ${q === 'high' ? 'selected' : ''}>高</option>
          </select>
          <span class="lc-value" data-out="quality">${qText}</span>
        </div>
        <div class="lc-slider-row">
          <span class="lc-label">帧率上限</span>
          <select class="lc-select" data-set="fpsCap" data-sfx="ui_click" aria-label="帧率上限">
            <option value="0" ${(st.fpsCap ?? 0) === 0 ? 'selected' : ''}>不限</option>
            <option value="120" ${st.fpsCap === 120 ? 'selected' : ''}>120 fps</option>
            <option value="60" ${st.fpsCap === 60 ? 'selected' : ''}>60 fps</option>
            <option value="30" ${st.fpsCap === 30 ? 'selected' : ''}>30 fps</option>
          </select>
          <span class="lc-value" data-out="fpsCap">${(st.fpsCap ?? 0) === 0 ? '不限' : `${st.fpsCap}`}</span>
        </div>
        <div class="lc-slider-row">
          <span class="lc-label">渲染分辨率</span>
          <input class="lc-range" type="range" min="0.35" max="1" step="0.05" value="${st.renderScale ?? 0.62}"
            data-set="renderScale" data-sfx="ui_click" aria-label="渲染分辨率"
            ${st.renderScaleAuto === false ? '' : 'disabled'}>
          <span class="lc-value" data-out="renderScale">${st.renderScaleAuto === false ? fmtPct(st.renderScale ?? 0.62) : '自动'}</span>
        </div>
        <div class="lc-slider-row">
          <span class="lc-label">分辨率模式</span>
          <select class="lc-select" data-set="renderScaleAuto" data-sfx="ui_click" aria-label="分辨率模式">
            <option value="auto" ${st.renderScaleAuto === false ? '' : 'selected'}>自动（按帧率调节）</option>
            <option value="fixed" ${st.renderScaleAuto === false ? 'selected' : ''}>手动（用上面的滑块）</option>
          </select>
          <span class="lc-value" data-out="renderScaleAuto">${st.renderScaleAuto === false ? '手动' : '自动'}</span>
        </div>
        <div class="lc-slider-row">
          <span class="lc-label">物理步长</span>
          <select class="lc-select" data-set="physics60" data-sfx="ui_click" aria-label="物理步长">
            <option value="0" ${st.physics60 ? '' : 'selected'}>120 Hz（精确）</option>
            <option value="1" ${st.physics60 ? 'selected' : ''}>60 Hz（弱机省 CPU）</option>
          </select>
          <span class="lc-value" data-out="physics60">${st.physics60 ? '60 Hz' : '120 Hz'}</span>
        </div>
        <div class="lc-slider-row">
          <span class="lc-label">引力场线</span>
          <label class="lc-toggle"><input type="checkbox" data-set="showField" data-sfx="ui_click" ${st.showField ? 'checked' : ''}><i></i></label>
          <span class="lc-value" data-out="showField">${st.showField ? '显示' : '隐藏'}</span>
        </div>
        <div class="lc-slider-row">
          <span class="lc-label">静音</span>
          <label class="lc-toggle"><input type="checkbox" data-set="muted" data-sfx="ui_click" ${st.muted ? 'checked' : ''}><i></i></label>
          <span class="lc-value" data-out="muted">${st.muted ? '静音' : '开启'}</span>
        </div>
      </div>
      <p class="lc-hint">滑杆用 ←→ 微调 · Esc 返回</p>
      <nav class="lc-nav lc-nav-row">${btn('back', '返回')}</nav>`;
    this.shell(body);
  }
}
