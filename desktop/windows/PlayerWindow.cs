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
    private readonly WebView2 browser = new WebView2();
    private readonly Button sizeButton = new Button();
    private readonly Button taskbarButton = new Button();
    private readonly Label shortcutLabel = new Label();
    private readonly Label loading = new Label();
    private readonly FlowLayoutPanel toolbar = new FlowLayoutPanel();
    private readonly System.Windows.Forms.Timer taskbarTimer = new System.Windows.Forms.Timer { Interval = 1500 };
    private Process service;
    private Uri home;
    private bool hotkeyRegistered;
    private bool compact;
    private Rectangle originalBounds;
    private FormWindowState originalState;
    private FormWindowState lastVisibleState;
    private bool wasMinimized;
    private bool inTaskbar;
    private bool taskbarBusy;
    private Rectangle compactBounds;
    private Rectangle taskbarSlot;
    private double taskbarAspect = 9.0 / 16.0;
    private double taskbarZoom = 3;

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
        taskbarButton.AccessibleName = "把播放预览放到任务栏";
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
                if (!inTaskbar || !IsLocal(message.Source)) return;
                if (message.WebMessageAsJson == "\"taskbar:expand\"") await LeaveTaskbar();
                else AdjustTaskbarZoom(message.WebMessageAsJson);
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
            double? aspect = await ReadTaskbarAspect();
            if (IsDisposed || WindowState == FormWindowState.Minimized) return;
            if (!aspect.HasValue)
            {
                MessageBox.Show(this, "打开一集后，就可以把画面放到任务栏。", AppTitle);
                return;
            }
            taskbarAspect = aspect.Value;
            if (!compact) ToggleSize();
            compactBounds = Bounds;
            MinimumSize = Size.Empty;
            FormBorderStyle = FormBorderStyle.None;
            toolbar.Visible = false;
            inTaskbar = true;
            PlaceTaskbar(slot);
            await browser.CoreWebView2.ExecuteScriptAsync(
                "document.documentElement.classList.add('taskbar-preview'); document.documentElement.classList.toggle('taskbar-fit', "
                + (taskbarZoom == 1 ? "true" : "false") + "); document.querySelector('.taskbar-strip-button')?.focus()");
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
            double? aspect = await ReadTaskbarAspect();
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

    private async Task<double?> ReadTaskbarAspect()
    {
        string result = await browser.CoreWebView2.ExecuteScriptAsync(
            "(() => { const v = document.querySelector('.theater-view video'); return v ? (v.videoHeight ? v.videoWidth / v.videoHeight : 0) : null; })()");
        if (result == "null") return null;
        double aspect;
        return double.TryParse(result, NumberStyles.Float, CultureInfo.InvariantCulture, out aspect)
            && aspect > 0 && !double.IsInfinity(aspect) ? aspect : taskbarAspect;
    }

    private void AdjustTaskbarZoom(string command)
    {
        double maximum = Math.Max(1, taskbarSlot.Width / (taskbarSlot.Height * taskbarAspect));
        double current = Math.Min(taskbarZoom, maximum);
        switch (command)
        {
            case "\"taskbar:zoom-in\"": taskbarZoom = Math.Min(maximum, current * 1.35); break;
            case "\"taskbar:zoom-out\"": taskbarZoom = Math.Max(1, current / 1.35); break;
            case "\"taskbar:max\"": taskbarZoom = double.PositiveInfinity; break;
            case "\"taskbar:fit\"": taskbarZoom = 1; break;
            default: return;
        }
        PlaceTaskbar(taskbarSlot);
    }

    private void PlaceTaskbar(Rectangle slot)
    {
        taskbarSlot = slot;
        int width = Math.Max(1, (int)Math.Round(Math.Min(slot.Width, slot.Height * taskbarAspect * taskbarZoom)));
        SetWindowPos(Handle, new IntPtr(-1), slot.Right - width, slot.Top, width, slot.Height, 0x10);
    }

    private void RestoreCompactBounds()
    {
        inTaskbar = false;
        taskbarTimer.Stop();
        FormBorderStyle = FormBorderStyle.Sizable;
        MinimumSize = new Size(390, 500);
        Bounds = compactBounds;
        toolbar.Visible = true;
    }

    private async Task LeaveTaskbar()
    {
        if (!inTaskbar || IsDisposed) return;
        RestoreCompactBounds();
        try
        {
            await browser.CoreWebView2.ExecuteScriptAsync(
                "document.documentElement.classList.remove('taskbar-preview', 'taskbar-fit'); document.querySelector('.player-container')?.focus()");
        }
        catch (InvalidOperationException) { }
    }

    private async void HandleResize(object sender, EventArgs args)
    {
        bool minimized = WindowState == FormWindowState.Minimized;
        if (!minimized) lastVisibleState = WindowState;
        if (wasMinimized == minimized) return;
        wasMinimized = minimized;
        CoreWebView2 core = browser.CoreWebView2;
        if (core == null) return;
        core.IsMuted = minimized;
        if (minimized)
        {
            try { await core.ExecuteScriptAsync("document.querySelectorAll('video,audio').forEach(media => media.pause())"); }
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
