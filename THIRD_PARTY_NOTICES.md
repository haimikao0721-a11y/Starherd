# 第三方组件与许可 / THIRD-PARTY NOTICES

《牧星者 / STARHERD》**自身不含任何第三方素材**（美术、音效、音乐全部由本仓库的
`python/assets_gen.py` 与 `python/music_gen.py` 程序化生成，详见 [LICENSE](LICENSE)）。
本文件列出构建与运行时实际使用的第三方**软件组件**及其许可证。

> 说明：本表按本机实际安装/使用的版本与用途核对（`npm ls`、`importlib.metadata`）。
> 下表仅作合规声明，不改变各组件自身的许可条款。

## 运行时组件（会随 EXE 一起分发）

| 组件 | 版本 | 许可证 | 用途 | 分发说明 |
|---|---|---|---|---|
| **Python 运行时** | 3.13.x | PSF-2.0 | 宿主进程（HTTP + WebSocket + 窗口管理） | 由 PyInstaller 打入 EXE；PSF 许可允许再分发 |
| **pywebview** | 6.2.1 | BSD-3-Clause | 原生窗口（WebView2 / EdgeChromium 后端） | 打入 EXE |
| **pythonnet / clr-loader** | 随 pywebview | MIT | pywebview 的 .NET 互操作 | 打入 EXE |
| **PyInstaller**（bootloader） | 6.22.3 | GPL-2.0-or-later **附 Bootloader Exception** | 单文件打包 | 见下方"关于 PyInstaller" |
| **WebView2 Runtime** | 系统组件 | Microsoft 专有（可再分发运行时） | 渲染窗口内容 | **不随本包分发**：Win11 自带，Win10 通常随 Edge 存在；缺失时程序自动回退到 Edge `--app` 模式 |

### 关于 PyInstaller（重要）

PyInstaller 本体是 GPL-2.0-or-later，但**其 bootloader 带有明确例外条款**
（*Bootloader Exception*）：允许将打包产物以**任意许可证**分发，不要求产物开源。
因此 `Starherd.exe` / `Starherd_安装程序.exe` 按本项目的 MIT 许可分发是合规的。

## 构建期组件（不随产物分发）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| **esbuild** | ^0.24.0 | MIT | 把 `src/**` 打包成 `dist/app.js` |
| **TypeScript** | ^5.6.3 | Apache-2.0 | 类型检查（`tsc --noEmit`） |

## 开发/验收期组件（不随产物分发）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| **Playwright (Python)** | 1.56.0 | Apache-2.0 | 无头浏览器端到端验收（`tools/verify_ui.py`、`tools/verify_offline.py`） |
| **Node.js** | — | MIT | 运行 esbuild 与验收脚本 |

## 字体

界面只使用系统等宽字体（CSS `ui-monospace, Consolas, monospace`），
**仓库内不含任何字体文件**，因此不涉及字体再分发许可。

## 素材原创性声明

| 类别 | 数量 | 生成方式 |
|---|---|---|
| 美术（PNG/ICO） | 17 | `python/assets_gen.py`（纯标准库 PNG 编码器，固定种子 `20260101`） |
| 音效（WAV） | 17 | 同上（纯标准库 WAV 写入器，程序化合成） |
| 音乐（谱面 JSON） | 5 | `python/music_gen.py`（各章不同调式：aeolian / dorian / lydian / phrygian / mixolydian） |
| 音乐（下载用 WAV） | 按需 | `python/music_render.py`（离线渲染同一份谱面） |

> 以上生成器与种子均在仓库内，任何人可用相同命令复现出一致的素材；
> 因此本项目可以声明：**除上表列出的软件组件外，无任何第三方版权内容**。
