# Windows 便携版维护

短剧小窗在 Windows x64 上使用 WinForms 和系统 WebView2，Node.js 播放服务只监听本机。Windows 外壳测量主任务栏空位，并根据屏幕的可用工作区和视频比例定位展开的小窗。页面负责渲染视频和响应鼠标操作。

| 目录 | 内容 |
| --- | --- |
| `desktop/windows/` | WinForms 窗口、全局快捷键、任务栏模式定位和播放服务入口 |
| `src/client/` | 剧目、选集、播放界面和任务栏预览布局 |
| `src/server/` | 搜索、片源、流媒体和本地记录 |
| `scripts/` | Windows 便携版打包和 ByteVC2 解码器构建 |
| `test/` | 单元测试及上游端到端验证 |

## 构建

需要 Windows x64、PowerShell 7、.NET Framework 4.8 开发人员包和 Git。首次编译 ByteVC2 解码器需要 MSYS2 UCRT64 环境，其中安装 GCC 和 GNU make。MSYS2 装在其他目录时，把实际路径传给 `-Msys2Root`。

```powershell
pwsh -File .\scripts\package-windows.ps1
```

脚本校验并缓存指定版本的 Node.js、WebView2 SDK 和编解码器源码，按 `package-lock.json` 安装生产依赖，生成 `dist/ShortDramaPlayer-win-x64.zip`。构建缓存位于 `.build/windows/`。FFmpeg、x264、ByteVC2 补丁或构建脚本发生变化时，打包会重新编译解码器。

完整解压后运行 `ShortDramaPlayer.exe`。运行需要 Microsoft Edge WebView2 Runtime，HEVC 片源依赖系统的 HEVC 解码支持。使用记录保存在解压目录的 `data/` 中。

## 验证

使用 Node.js 22 运行以下命令。

```powershell
npm ci --ignore-scripts
npm run test:unit
```

改动任务栏布局后，用新打包的 ZIP 播放一集，确认单击切换播放和暂停，双击在任务栏内预览和完整画面间切换，右键直接返回带控制栏的小窗。展开后应沿任务栏上沿等比显示，初次使用约为可用高度的 40%，可缩放到 10% 至 65%。用左键拖动展开画面，确认拖动不会触发播放或暂停，后续缩放会留在当前位置。用滚轮调整后，确认收起再展开及重启后均能恢复所选比例。再验证 `Ctrl + Alt + F9` 在两种尺寸下的收起暂停和恢复。实时片源验证可以运行 `npm run test:e2e`，结果会受到片源和网络影响。

## 来源

当前版本基于 [zfdang/hongguo-open-player](https://github.com/zfdang/hongguo-open-player) 的 `3f687c5b07e04eb194141f8eeb78ded86d646024`。许可证全文见 [LICENSE](../LICENSE)。上游 GitHub 发布工作流仅在原上游仓库执行。Windows 便携包包含播放服务源码以及对应的 FFmpeg 和 x264 源码、ByteVC2 补丁和构建脚本。
