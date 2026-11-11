// SPDX-License-Identifier: GPL-3.0-only
using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class PlayerWindow : Form
{
    private const string AppTitle = "短剧小窗";
    private const string Shortcut = "Ctrl + Alt + F9";
    private const int HotkeyId = 1;
    private const int WmHotkey = 0x0312;
    private const uint CtrlAltNoRepeat = 0x4003;
    private const string PauseMediaScript = "document.querySelectorAll('video,audio').forEach(media => media.pause())";
    private const string BilibiliPreviewScript = @"(() => {
        if (!document.getElementById('shortdrama-taskbar-style')) {
            const style = document.createElement('style');
            style.id = 'shortdrama-taskbar-style';
            style.textContent = `
                html.shortdrama-taskbar, html.shortdrama-taskbar body {
                    margin: 0 !important; overflow: hidden !important; background: #000 !important;
                }
                html.shortdrama-taskbar body * { visibility: hidden !important; }
                html.shortdrama-taskbar body :has(video) { overflow: visible !important; transform: none !important; }
                html.shortdrama-taskbar video {
                    visibility: visible !important; position: fixed !important; inset: 0 !important;
                    width: 100vw !important; height: 100vh !important; max-width: none !important;
                    max-height: none !important; margin: 0 !important; transform: none !important;
                    object-fit: contain !important; object-position: center !important;
                }
                html.shortdrama-taskbar.shortdrama-taskbar-cropped video {
                    object-fit: cover !important; object-position: 50% 42% !important;
                }`;
            document.head.append(style);
        }
        document.documentElement.classList.add('shortdrama-taskbar');
    })();";
    private const double MinimumExpandedZoom = 0.10;
    private const double DefaultExpandedZoom = 0.40;
    private const double MaximumExpandedZoom = 0.65;
    private readonly WebView2 browser = new WebView2();
    private readonly Button sizeButton = new Button();
    private readonly Button taskbarButton = new Button();
    private readonly Label shortcutLabel = new Label();
    private readonly Label loading = new Label();
    private readonly FlowLayoutPanel toolbar = new FlowLayoutPanel();
    private readonly System.Windows.Forms.Timer taskbarTimer = new System.Windows.Forms.Timer { Interval = 1500 };
    private readonly System.Windows.Forms.Timer taskbarClickTimer = new System.Windows.Forms.Timer();
    private Process service;
    private Uri home;
    private CoreWebView2Frame bilibiliFrame;
    private CoreWebView2Frame taskbarBilibiliFrame;
    private bool hotkeyRegistered;
    private bool compact;
    private Rectangle originalBounds;
    private FormWindowState originalState;
    private FormWindowState lastVisibleState;
    private bool wasMinimized;
    private bool inTaskbar;
    private bool taskbarExpanded;
    private bool taskbarBusy;
    private Rectangle compactBounds;
    private Rectangle taskbarSlot;
    private double taskbarAspect = 9.0 / 16.0;
    private double taskbarStripZoom = 3;
    private double taskbarExpandedZoom;
    private double rememberedExpandedZoom = DefaultExpandedZoom;
    private string expandedZoomPath;
    private Point? expandedLocation;
    private Point? taskbarDragOffset;

    [STAThread]
    private static void Main()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool firstInstance;
        using (var instance = new Mutex(true, @"Local\HongguoStandalonePlayer", out firstInstance))
        {
            if (!firstInstance)
            {
                MessageBox.Show("播放器已打开，可以从任务栏切回。", AppTitle);
                return;
            }
            using (var window = new PlayerWindow())
            {
                Application.Run(window);
            }
            instance.ReleaseMutex();
        }
    }

    private PlayerWindow()
    {
        Text = AppTitle;
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1120, 790);
        MinimumSize = new Size(390, 500);
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(15, 16, 21);
        ForeColor = Color.White;
        Font = new Font("Microsoft YaHei UI", 9F);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

        browser.Dock = DockStyle.Fill;
        browser.DefaultBackgroundColor = BackColor;
        browser.Visible = false;
        Controls.Add(browser);

        loading.Dock = DockStyle.Fill;
        loading.Text = "正在启动播放器…";
        loading.TextAlign = ContentAlignment.MiddleCenter;
        Controls.Add(loading);

        toolbar.Dock = DockStyle.Top;
        toolbar.Height = 42;
        toolbar.Padding = new Padding(8, 4, 8, 4);
        toolbar.BackColor = Color.FromArgb(27, 29, 39);
        toolbar.WrapContents = false;
        sizeButton.Text = "小窗(&M)";
        sizeButton.AccessibleName = "切换为小窗";
        sizeButton.Size = new Size(92, 30);
        sizeButton.Margin = new Padding(0, 0, 12, 0);
        sizeButton.BackColor = Color.FromArgb(49, 52, 68);
        sizeButton.ForeColor = Color.White;
        sizeButton.UseVisualStyleBackColor = false;
        sizeButton.Click += delegate { ToggleSize(); };
        toolbar.Controls.Add(sizeButton);

        taskbarButton.Text = "任务栏(&T)";
        taskbarButton.AccessibleName = "在任务栏空位中播放";
        taskbarButton.Size = new Size(92, 30);
        taskbarButton.Margin = new Padding(0, 0, 12, 0);
        taskbarButton.BackColor = sizeButton.BackColor;
        taskbarButton.ForeColor = Color.White;
        taskbarButton.UseVisualStyleBackColor = false;
        taskbarButton.Enabled = false;
        taskbarButton.Click += async delegate { await EnterTaskbar(); };
        toolbar.Controls.Add(taskbarButton);

        shortcutLabel.Text = Shortcut + " 收起／恢复";
        shortcutLabel.AutoSize = true;
        shortcutLabel.Margin = new Padding(0, 7, 0, 0);
        toolbar.Controls.Add(shortcutLabel);
        Controls.Add(toolbar);

        Shown += Initialize;
        Resize += HandleResize;
        taskbarTimer.Tick += async delegate { await RefreshTaskbar(); };
        taskbarClickTimer.Tick += async delegate
        {
            taskbarClickTimer.Stop();
            await ToggleTaskbarPlayback();
        };
    }

    private async void Initialize(object sender, EventArgs args)
    {
        hotkeyRegistered = RegisterHotKey(Handle, HotkeyId, CtrlAltNoRepeat, (uint)Keys.F9);
        if (!hotkeyRegistered)
        {
            shortcutLabel.Text = "快捷键被占用，可从任务栏切换";
        }

        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string data = Path.Combine(root, "data");
            Directory.CreateDirectory(data);
            expandedZoomPath = Path.Combine(data, "taskbar-expanded-zoom.txt");
            rememberedExpandedZoom = ReadExpandedZoom();
            int port = await StartService(root, data);
            if (IsDisposed) return;
            home = new Uri("http://127.0.0.1:" + port + "/");
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(data, "webview"));
            if (IsDisposed) return;
            await browser.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;
            CoreWebView2 core = browser.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.NavigationStarting += delegate(object _, CoreWebView2NavigationStartingEventArgs nav)
            {
                nav.Cancel = !IsLocal(nav.Uri);
            };
            core.FrameCreated += delegate(object _, CoreWebView2FrameCreatedEventArgs created)
            {
                CoreWebView2Frame frame = created.Frame;
                frame.NavigationStarting += delegate(object frameSender, CoreWebView2NavigationStartingEventArgs nav)
                {
                    Uri target;
                    if (Uri.TryCreate(nav.Uri, UriKind.Absolute, out target)
                        && target.Scheme == Uri.UriSchemeHttps && target.IsDefaultPort
                        && target.IdnHost == "player.bilibili.com" && target.AbsolutePath == "/player.html")
                    {
                        bilibiliFrame = frame;
                    }
                    else if (bilibiliFrame == frame) bilibiliFrame = null;
                };
                frame.Destroyed += delegate { if (bilibiliFrame == frame) bilibiliFrame = null; };
            };
            core.NewWindowRequested += delegate(object _, CoreWebView2NewWindowRequestedEventArgs pop)
            {
                pop.Handled = true;
                Uri target;
                if (pop.IsUserInitiated && Uri.TryCreate(pop.Uri, UriKind.Absolute, out target) && target.Scheme == "https")
                {
                    try { Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true }); }
                    catch (System.ComponentModel.Win32Exception) { }
                }
            };
            core.PermissionRequested += delegate(object _, CoreWebView2PermissionRequestedEventArgs permission)
            {
                permission.State = CoreWebView2PermissionState.Deny;
            };
            core.NavigationCompleted += delegate(object _, CoreWebView2NavigationCompletedEventArgs nav)
            {
                if (nav.IsSuccess) loading.Visible = false;
                else if (!browser.Visible) loading.Text = "加载失败。请关闭窗口后重新打开。";
                browser.Visible = nav.IsSuccess || browser.Visible;
                taskbarButton.Enabled = nav.IsSuccess;
            };
            core.WebMessageReceived += async delegate(object _, CoreWebView2WebMessageReceivedEventArgs message)
            {
                if (!inTaskbar || WindowState == FormWindowState.Minimized || !IsLocal(message.Source)) return;
                string command = message.WebMessageAsJson;
                switch (command)
                {
                    case "\"taskbar:click\"":
                        taskbarClickTimer.Stop();
                        taskbarClickTimer.Interval = SystemInformation.DoubleClickTime;
                        taskbarClickTimer.Start();
                        break;
                    case "\"taskbar:toggle\"":
                        await ToggleTaskbarPreview();
                        break;
                    case "\"taskbar:play\"":
                        taskbarClickTimer.Stop();
                        await ToggleTaskbarPlayback();
                        break;
                    case "\"taskbar:exit\"":
                        await LeaveTaskbar();
                        break;
                    case "\"taskbar:back\"":
                        if (taskbarExpanded) await ToggleTaskbarPreview();
                        else await LeaveTaskbar();
                        break;
                    case "\"taskbar:drag-start\"":
                        if (taskbarExpanded) taskbarDragOffset = Cursor.Position - new Size(Location);
                        break;
                    case "\"taskbar:drag-move\"":
                        MoveExpandedPreview(Cursor.Position);
                        break;
                    case "\"taskbar:drag-end\"":
                        taskbarDragOffset = null;
                        break;
                    default:
                        await AdjustTaskbarZoom(command);
                        break;
                }
            };
            core.IsMuted = WindowState == FormWindowState.Minimized;
            browser.Source = home;
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (!IsDisposed) loading.Text = "需要 Microsoft Edge WebView2 Runtime。\n下载入口见使用说明。";
        }
        catch (Exception ex)
        {
            if (!IsDisposed) loading.Text = "播放器启动失败。\n" + ex.Message;
        }
    }

    private bool IsLocal(string url)
    {
        Uri target;
        return Uri.TryCreate(url, UriKind.Absolute, out target)
            && target.Scheme == home.Scheme && target.Host == home.Host && target.Port == home.Port;
    }

    private async Task<int> StartService(string root, string data)
    {
        string engine = Path.Combine(root, "player");
        var info = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), "desktop/windows/desktop-host.js") {
            WorkingDirectory = engine, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        info.EnvironmentVariables["HONGGUO_DATA_DIR"] = Path.Combine(data, "player");
        info.EnvironmentVariables["HONGGUO_LOG_DIR"] = Path.Combine(data, "logs");
        info.EnvironmentVariables["HONGGUO_BVC2_FFMPEG"] = Path.Combine(root, "runtime", "ffmpeg.exe");
        info.EnvironmentVariables.Remove("NODE_OPTIONS");
        info.EnvironmentVariables.Remove("NODE_PATH");
        var ready = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        service = new Process { StartInfo = info, EnableRaisingEvents = true };
        service.OutputDataReceived += delegate(object _, DataReceivedEventArgs line)
        {
            int port;
            if (line.Data != null && line.Data.StartsWith("PLAYER_PORT=", StringComparison.Ordinal)
                && int.TryParse(line.Data.Substring(12), NumberStyles.None, CultureInfo.InvariantCulture, out port)
                && port > 0 && port <= 65535)
            {
                ready.TrySetResult(port);
            }
        };
        service.Exited += delegate
        {
            ready.TrySetException(new InvalidOperationException("本地播放服务已退出，请确认 ZIP 已完整解压。"));
        };
        service.Start();
        service.BeginOutputReadLine();
        service.BeginErrorReadLine();
        if (await Task.WhenAny(ready.Task, Task.Delay(12000)) != ready.Task)
        {
            StopService();
            throw new TimeoutException("本地播放服务启动超时。");
        }
        return await ready.Task;
    }

    private void ToggleSize()
    {
        Rectangle area = Screen.FromControl(this).WorkingArea;
        if (!compact)
        {
            originalState = WindowState;
            originalBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            WindowState = FormWindowState.Normal;
            int width = Math.Min(420 * DeviceDpi / 96, area.Width);
            int height = Math.Min(710 * DeviceDpi / 96, area.Height);
            Bounds = new Rectangle(area.Right - width, area.Bottom - height, width, height);
        }
        else
        {
            Bounds = originalBounds;
            WindowState = originalState;
        }
        compact = !compact;
        TopMost = compact;
        sizeButton.Text = compact ? "大窗(&M)" : "小窗(&M)";
        sizeButton.AccessibleName = compact ? "恢复大窗口" : "切换为小窗";
    }

    private async Task EnterTaskbar()
    {
        if (inTaskbar || taskbarBusy || browser.CoreWebView2 == null) return;
        taskbarBusy = true;
        try
        {
            Rectangle slot = await Task.Run(() => TaskbarPlacement.Find());
            if (IsDisposed || WindowState == FormWindowState.Minimized) return;
            if (slot.IsEmpty)
            {
                MessageBox.Show(this, "主任务栏没有足够的空位，或已开启自动隐藏。可以继续使用竖屏小窗。", AppTitle);
                return;
            }
            CoreWebView2Frame frame = bilibiliFrame;
            double? aspect = await ReadTaskbarAspect(frame);
            if (IsDisposed || WindowState == FormWindowState.Minimized || frame != bilibiliFrame) return;
            if (!aspect.HasValue)
            {
                MessageBox.Show(this, "请先打开并播放视频，再点「任务栏」。", AppTitle);
                return;
            }
            taskbarAspect = aspect.Value;
            if (!compact) ToggleSize();
            compactBounds = Bounds;
            MinimumSize = Size.Empty;
            FormBorderStyle = FormBorderStyle.None;
            toolbar.Visible = false;
            inTaskbar = true;
            taskbarBilibiliFrame = frame;
            taskbarExpanded = false;
            PlaceTaskbar(slot);
            await UpdateTaskbarView();
            await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('.taskbar-preview-button')?.focus()");
            if (!IsDisposed && inTaskbar) taskbarTimer.Start();
        }
        catch (InvalidOperationException)
        {
            if (!IsDisposed && inTaskbar) RestoreCompactBounds();
        }
        finally
        {
            taskbarBusy = false;
        }
    }

    private async Task RefreshTaskbar()
    {
        if (!inTaskbar || taskbarBusy || WindowState == FormWindowState.Minimized) return;
        taskbarBusy = true;
        try
        {
            Rectangle slot = await Task.Run(() => TaskbarPlacement.Find());
            if (IsDisposed || !inTaskbar || WindowState == FormWindowState.Minimized) return;
            if (slot.IsEmpty)
            {
                await LeaveTaskbar();
                return;
            }
            CoreWebView2Frame frame = taskbarBilibiliFrame;
            double? aspect = frame != null && frame != bilibiliFrame ? null : await ReadTaskbarAspect(frame);
            if (IsDisposed || !inTaskbar || WindowState == FormWindowState.Minimized) return;
            if (!aspect.HasValue) await LeaveTaskbar();
            else
            {
                taskbarAspect = aspect.Value;
                PlaceTaskbar(slot);
            }
        }
        catch (InvalidOperationException)
        {
            if (!IsDisposed && inTaskbar) RestoreCompactBounds();
        }
        finally
        {
            taskbarBusy = false;
        }
    }

    private async Task<double?> ReadTaskbarAspect(CoreWebView2Frame frame)
    {
        string result = frame != null
            ? await frame.ExecuteScriptAsync("(() => { const v = document.querySelector('video'); return v?.videoHeight ? v.videoWidth / v.videoHeight : null; })()")
            : await browser.CoreWebView2.ExecuteScriptAsync(
                "(() => { const v = document.querySelector('.theater-view video'); return v ? (v.videoHeight ? v.videoWidth / v.videoHeight : 0) : null; })()");
        if (result == "null") return null;
        double aspect;
        return double.TryParse(result, NumberStyles.Float, CultureInfo.InvariantCulture, out aspect)
            && aspect > 0 && !double.IsInfinity(aspect) ? aspect : taskbarAspect;
    }

    private async Task ToggleTaskbarPlayback()
    {
        if (!inTaskbar || WindowState == FormWindowState.Minimized) return;
        try
        {
            CoreWebView2Frame frame = taskbarBilibiliFrame;
            if (frame == null) browser.CoreWebView2.PostWebMessageAsString("taskbar:play");
            else if (frame == bilibiliFrame)
            {
                await frame.ExecuteScriptAsync(
                    "(() => { const v = document.querySelector('video'); if (!v) return; " +
                    "if (v.paused) v.play().catch(() => {}); else v.pause(); })()");
            }
        }
        catch (InvalidOperationException) { }
    }

    private async Task ToggleTaskbarPreview()
    {
        taskbarClickTimer.Stop();
        taskbarDragOffset = null;
        expandedLocation = null;
        taskbarExpanded = !taskbarExpanded;
        if (taskbarExpanded) taskbarExpandedZoom = rememberedExpandedZoom;
        PlaceTaskbar(taskbarSlot);
        await UpdateTaskbarView();
    }

    private void MoveExpandedPreview(Point cursor)
    {
        if (!taskbarExpanded || !taskbarDragOffset.HasValue) return;
        taskbarClickTimer.Stop();
        expandedLocation = cursor - new Size(taskbarDragOffset.Value);
        PlaceTaskbar(taskbarSlot);
    }

    private async Task AdjustTaskbarZoom(string command)
    {
        double minimum = taskbarExpanded ? MinimumExpandedZoom : 1;
        double maximum = taskbarExpanded ? MaximumExpandedZoom : Math.Max(1, taskbarSlot.Width / (taskbarSlot.Height * taskbarAspect));
        double zoom = Math.Min(maximum, taskbarExpanded ? taskbarExpandedZoom : taskbarStripZoom);
        bool fromWheel = false;
        switch (command)
        {
            case "\"taskbar:zoom-in\"":
                zoom = Math.Min(maximum, zoom * 1.35);
                fromWheel = true;
                break;
            case "\"taskbar:zoom-out\"":
                zoom = Math.Max(minimum, zoom / 1.35);
                fromWheel = true;
                break;
            case "\"taskbar:max\"": zoom = taskbarExpanded ? maximum : double.PositiveInfinity; break;
            case "\"taskbar:fit\"": zoom = taskbarExpanded ? DefaultExpandedZoom : minimum; break;
            default: return;
        }
        if (taskbarExpanded)
        {
            taskbarExpandedZoom = zoom;
            if (fromWheel) RememberExpandedZoom(zoom);
        }
        else taskbarStripZoom = zoom;
        PlaceTaskbar(taskbarSlot);
        if (!taskbarExpanded) await UpdateTaskbarView();
    }

    private double ReadExpandedZoom()
    {
        try
        {
            double zoom;
            if (double.TryParse(File.ReadAllText(expandedZoomPath), NumberStyles.Float, CultureInfo.InvariantCulture, out zoom)
                && zoom >= MinimumExpandedZoom && zoom <= MaximumExpandedZoom)
            {
                return zoom;
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return DefaultExpandedZoom;
    }

    private void RememberExpandedZoom(double zoom)
    {
        if (zoom == rememberedExpandedZoom) return;
        rememberedExpandedZoom = zoom;

        try
        {
            string pending = expandedZoomPath + ".tmp";
            File.WriteAllText(pending, zoom.ToString("R", CultureInfo.InvariantCulture));
            if (File.Exists(expandedZoomPath)) File.Replace(pending, expandedZoomPath, null);
            else File.Move(pending, expandedZoomPath);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private void PlaceTaskbar(Rectangle slot)
    {
        taskbarSlot = slot;
        if (taskbarExpanded)
        {
            Rectangle area = Screen.FromRectangle(slot).WorkingArea;
            Rectangle target = TaskbarPlacement.FitAbove(area, slot, taskbarAspect, taskbarExpandedZoom);
            if (expandedLocation.HasValue)
            {
                Point location = expandedLocation.Value;
                target.Location = new Point(
                    Math.Max(area.Left, Math.Min(area.Right - target.Width, location.X)),
                    Math.Max(area.Top, Math.Min(area.Bottom - target.Height, location.Y)));
                expandedLocation = target.Location;
            }
            if (Bounds != target) Bounds = target;
        }
        else
        {
            int width = Math.Max(1, (int)Math.Round(Math.Min(slot.Width, slot.Height * taskbarAspect * taskbarStripZoom)));
            SetWindowPos(Handle, new IntPtr(-1), slot.Right - width, slot.Top, width, slot.Height, 0x10);
        }
    }

    private async Task UpdateTaskbarView()
    {
        string cropped = !taskbarExpanded && taskbarStripZoom > 1 ? "true" : "false";
        string expanded = taskbarExpanded ? "true" : "false";
        string action = taskbarExpanded ? "缩回任务栏" : "展开完整画面";
        string dragHint = taskbarExpanded ? "，按住左键可拖动" : "";
        try
        {
            await browser.CoreWebView2.ExecuteScriptAsync(
                "(() => { const root = document.documentElement; root.classList.add('taskbar-preview'); " +
                "root.classList.toggle('taskbar-cropped', " + cropped + "); " +
                "root.classList.toggle('taskbar-expanded', " + expanded + "); " +
                "const button = document.querySelector('.taskbar-preview-button'); if (!button) return; " +
                "button.setAttribute('aria-label', '" + action + "'); " +
                "button.title = '单击播放或暂停，双击" + action + "，右键返回小窗，滚轮缩放" + dragHint + "'; })()");
            CoreWebView2Frame frame = taskbarBilibiliFrame;
            if (frame != null && frame == bilibiliFrame)
            {
                string frameCropped = !taskbarExpanded && taskbarStripZoom > 1 ? "true" : "false";
                await frame.ExecuteScriptAsync(BilibiliPreviewScript +
                    "document.documentElement.classList.toggle('shortdrama-taskbar-cropped', " + frameCropped + ");");
            }
        }
        catch (InvalidOperationException) { }
    }

    private void RestoreCompactBounds()
    {
        inTaskbar = false;
        taskbarBilibiliFrame = null;
        taskbarDragOffset = null;
        taskbarTimer.Stop();
        taskbarClickTimer.Stop();
        FormBorderStyle = FormBorderStyle.Sizable;
        MinimumSize = new Size(390, 500);
        Bounds = compactBounds;
        toolbar.Visible = true;
    }

    private async Task LeaveTaskbar()
    {
        if (!inTaskbar || IsDisposed) return;
        CoreWebView2Frame frame = taskbarBilibiliFrame;
        RestoreCompactBounds();
        try
        {
            await browser.CoreWebView2.ExecuteScriptAsync(
                "document.documentElement.classList.remove('taskbar-preview', 'taskbar-cropped', 'taskbar-expanded'); " +
                "document.querySelector('.player-container, .bilibili-frame')?.focus()");
            if (frame != null && frame == bilibiliFrame)
            {
                await frame.ExecuteScriptAsync(
                    "document.documentElement.classList.remove('shortdrama-taskbar', 'shortdrama-taskbar-cropped'); " +
                    "document.getElementById('shortdrama-taskbar-style')?.remove()");
            }
        }
        catch (InvalidOperationException) { }
    }

    private async void HandleResize(object sender, EventArgs args)
    {
        bool minimized = WindowState == FormWindowState.Minimized;
        if (!minimized) lastVisibleState = WindowState;
        if (wasMinimized == minimized) return;
        wasMinimized = minimized;
        if (minimized)
        {
            taskbarClickTimer.Stop();
            taskbarDragOffset = null;
        }
        CoreWebView2 core = browser.CoreWebView2;
        if (core == null) return;
        core.IsMuted = minimized;
        if (minimized)
        {
            try
            {
                await core.ExecuteScriptAsync(PauseMediaScript);
                if (bilibiliFrame != null) await bilibiliFrame.ExecuteScriptAsync(PauseMediaScript);
            }
            catch (InvalidOperationException) { }
        }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmHotkey && message.WParam.ToInt32() == HotkeyId)
        {
            if (WindowState == FormWindowState.Minimized)
            {
                WindowState = lastVisibleState;
                Activate();
            }
            else
            {
                WindowState = FormWindowState.Minimized;
            }
        }
        base.WndProc(ref message);
    }

    protected override void OnFormClosed(FormClosedEventArgs args)
    {
        taskbarTimer.Dispose();
        taskbarClickTimer.Dispose();
        if (hotkeyRegistered) UnregisterHotKey(Handle, HotkeyId);
        browser.Dispose();
        StopService();
        base.OnFormClosed(args);
    }

    private void StopService()
    {
        if (service == null) return;
        using (Process running = service)
        {
            service = null;
            try
            {
                if (!running.HasExited)
                {
                    running.StandardInput.Close();
                    if (!running.WaitForExit(1500)) running.Kill();
                }
            }
            catch (InvalidOperationException) { }
        }
    }

    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr window, int id);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}
