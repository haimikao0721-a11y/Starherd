#!/usr/bin/env node
/**
 * tools/build.mjs —— 牧星者的 TS 打包脚本（esbuild）
 *
 * 用法：
 *   node tools/build.mjs            单次构建 src/main.ts → dist/app.js
 *   node tools/build.mjs --watch    监听模式（esbuild context.watch）
 *   node tools/build.mjs --minify   压缩输出（默认不压缩，便于调试）
 *   node tools/build.mjs --help     帮助
 *
 * 产物：
 *   dist/app.js        （Python 宿主把它映射到 /app.js）
 *   dist/build.json    （一行 JSON：构建时间戳 + 产物字节数，供宿主/selftest 校验）
 *
 * 注意：src/main.ts 由主 Agent 负责写入；若尚不存在，本脚本给出清晰提示并正常退出，
 *       不会创建该文件，也不会抛异常。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'main.ts');
const OUT_DIR = path.join(ROOT, 'dist');
const OUTFILE = path.join(OUT_DIR, 'app.js');
const STAMP = path.join(OUT_DIR, 'build.json');

const argv = process.argv.slice(2);
const has = (...names) => names.some((n) => argv.includes(n));
const WATCH = has('--watch', '-w');
const MINIFY = has('--minify', '-m');
const HELP = has('--help', '-h');

if (HELP) {
  console.log(`牧星者构建脚本
  node tools/build.mjs [--watch] [--minify]

  --watch, -w    监听 src/ 变化，增量重建
  --minify, -m   压缩 dist/app.js
  --help, -h     显示本帮助`);
  process.exit(0);
}

/* ------------------------------------------------------------------ 小工具 */

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '? B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function nowIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  const p = (v, w = 2) => String(v).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${hh}:${mm}`;
}

function writeStamp(extra = {}) {
  let bytes = 0;
  try { bytes = fs.statSync(OUTFILE).size; } catch { bytes = 0; }
  const line = JSON.stringify({
    built_at: nowIso(),
    epoch_ms: Date.now(),
    entry: 'src/main.ts',
    outfile: 'dist/app.js',
    bytes,
    minify: MINIFY,
    ...extra,
  });
  try { fs.writeFileSync(STAMP, line + '\n', 'utf8'); } catch (err) {
    console.warn(`[build] 无法写入 ${path.relative(ROOT, STAMP)}: ${err.message}`);
  }
  return bytes;
}

function banner(msg) {
  console.log(`\n=== ${msg} ===`);
}

/* ------------------------------------------------------------------ 前置检查 */

if (!fs.existsSync(path.join(ROOT, 'node_modules', 'esbuild'))) {
  console.error('[build] 缺少依赖 esbuild。请先执行：npm install');
  process.exit(1);
}

let esbuild;
try {
  esbuild = require('esbuild');
} catch (err) {
  console.error(`[build] 无法加载 esbuild：${err && err.message ? err.message : err}`);
  process.exit(1);
}

if (!fs.existsSync(ENTRY)) {
  banner('构建已跳过（WARN，不是错误）');
  console.warn('[build] 找不到入口文件: src/main.ts');
  console.warn('[build] 该文件由主 Agent 组装写入（把 sim/render/audio/game/ui 串起来），当前尚未创建。');
  console.warn('[build] 因此本次没有产生 dist/app.js —— 这不是脚本故障。');
  console.warn('[build] 写入 src/main.ts 后重新运行:  node tools/build.mjs');
  console.warn(`[build] 入口应为: ${path.relative(ROOT, ENTRY)}   产物: ${path.relative(ROOT, OUTFILE)}`);
  if (WATCH) {
    console.warn('[build] --watch 也需要入口文件，已退出。');
  }
  console.log('');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------------------------------------------ 构建配置 */

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: false,
  minify: MINIFY,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
  absWorkingDir: ROOT,
  define: {
    __BUILD_TIME__: JSON.stringify(nowIso()),
  },
};

function printSummary(bytes, ms, extra = '') {
  console.log('');
  console.log(`[build] 产物   ${path.relative(ROOT, OUTFILE)}  ${fmtBytes(bytes)} (${bytes} 字节)`);
  console.log(`[build] 时间戳 ${path.relative(ROOT, STAMP)}`);
  console.log(`[build] 耗时   ${ms.toFixed(1)} ms${extra ? `   ${extra}` : ''}`);
  console.log('');
}

/* ------------------------------------------------------------------ 单次构建 */

async function once() {
  const t0 = process.hrtime.bigint();
  const result = await esbuild.build(options);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (result.errors && result.errors.length) {
    console.error(`[build] 失败：${result.errors.length} 个错误`);
    process.exit(1);
  }
  const bytes = writeStamp({ mode: 'once', ms: Math.round(ms) });
  banner('STARHERD / 构建完成');
  console.log(`[build] 入口   ${path.relative(ROOT, ENTRY)}`);
  console.log(`[build] 格式   esm  target es2022  bundle=true  minify=${MINIFY}`);
  printSummary(bytes, ms);
}

/* ------------------------------------------------------------------ 监听构建 */

async function watch() {
  let first = true;
  let t0 = 0n;
  const stampPlugin = {
    name: 'lc-stamp',
    setup(build) {
      build.onStart(() => { t0 = process.hrtime.bigint(); });
      build.onEnd((result) => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (result.errors && result.errors.length) {
          console.error(`[build] 重建失败：${result.errors.length} 个错误（继续监听）`);
          return;
        }
        const bytes = writeStamp({ mode: 'watch', ms: Math.round(ms) });
        if (first) {
          first = false;
          banner('STARHERD / 首次构建完成（监听中）');
          console.log(`[build] 入口   ${path.relative(ROOT, ENTRY)}`);
          console.log(`[build] 格式   esm  target es2022  bundle=true  minify=${MINIFY}`);
          printSummary(bytes, ms, '监听中…  Ctrl+C 退出');
        } else {
          console.log(`[build] 已重建  ${path.relative(ROOT, OUTFILE)}  ${fmtBytes(bytes)} (${bytes} 字节)  耗时 ${ms.toFixed(1)} ms`);
        }
      });
    },
  };

  const ctx = await esbuild.context({
    ...options,
    plugins: [stampPlugin],
  });
  await ctx.watch();

  const stop = async (sig) => {
    console.log(`\n[build] 收到 ${sig}，关闭监听…`);
    try { await ctx.dispose(); } catch { /* 忽略 */ }
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop('SIGINT'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
}

/* ------------------------------------------------------------------ 入口 */

try {
  if (WATCH) await watch();
  else await once();
} catch (err) {
  const msg = err && err.message ? err.message : String(err);
  console.error(`\n[build] 构建失败：${msg}`);
  if (err && Array.isArray(err.errors) && err.errors.length) {
    for (const e of err.errors) {
      const loc = e.location ? ` (${e.location.file}:${e.location.line}:${e.location.column})` : '';
      console.error(`  - ${e.text}${loc}`);
    }
  }
  process.exit(1);
}
