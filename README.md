# 短剧小窗 ShortDramaPlayer

短剧小窗是一款 Windows x64 便携短剧播放器。解压即可运行，支持常规播放窗口、置顶竖屏小窗和任务栏内预览。

[下载 Windows x64 便携版](https://github.com/zhangga/ShortDramaPlayer/releases/latest) · [使用说明](desktop/windows/使用说明.txt) · [构建与维护](docs/windows-maintenance.md)

## 快速开始

1. 从发布页下载 `ShortDramaPlayer-win-x64.zip`，完整解压到可写目录。
2. 双击 `ShortDramaPlayer.exe`。搜索剧名或从榜单浏览，点击封面开始播放。
3. 播放时点窗口上方的「小窗」或「任务栏」，切换观看方式。

支持 Windows 10/11 x64。运行需要网络连接、.NET Framework 4.8 和 Microsoft Edge WebView2 Runtime。[下载 WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

## 小窗与任务栏观看

| 操作 | 效果 |
| --- | --- |
| 点「小窗」 | 切换为置顶竖屏小窗。点「大窗」恢复原窗口。 |
| 点「任务栏」 | 将正在播放的画面放到主任务栏的空位。 |
| 在任务栏模式下单击画面 | 播放或暂停。 |
| 双击画面 | 从任务栏上方等比展开完整画面。再双击缩回任务栏。 |
| 展开后按住左键拖动 | 移动画面。 |
| 在画面上滚动鼠标滚轮 | 等比缩放。展开时用滚轮调好的大小会在下次展开时恢复，重启后也有效。 |
| 右键单击画面 | 直接回到带控制栏的小窗。 |
| 按 `Ctrl + Alt + F9` | 在其他应用里也能收起或恢复窗口。收起时暂停并静音，恢复后按空格继续播放。 |

主任务栏开启自动隐藏或空位不足时，可以使用置顶小窗。任务栏模式的完整操作见压缩包内的 `使用说明.txt`。

## 播放与记录

- 支持剧名搜索、榜单和分类浏览，可按集选择、连续播放和调整弹幕。
- 观看历史、播放进度、收藏和设置保存在解压目录的 `data/` 中。升级时，退出旧版后将整个 `data` 文件夹复制到新版目录即可带走这些记录。

## 从源码构建

在 Windows x64 上运行以下命令，生成 `dist/ShortDramaPlayer-win-x64.zip`。构建依赖和验证步骤见 [Windows 构建与维护](docs/windows-maintenance.md)。

```powershell
pwsh -File .\scripts\package-windows.ps1
```

## 开源来源

短剧小窗基于 `zfdang/hongguo-open-player` 的播放服务和 Vue 界面，加入 WinForms 与 WebView2 窗口、任务栏预览和全局快捷键。[上游源码版本](https://github.com/zfdang/hongguo-open-player/tree/3f687c5b07e04eb194141f8eeb78ded86d646024) · [仓库许可证](LICENSE) · [ByteVC2 解码器来源](vendor/bytevc2/README.md)
