// SPDX-License-Identifier: GPL-3.0-only
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle(PlayerWindow.AppTitle)]
[assembly: AssemblyProduct(PlayerWindow.AppTitle)]

internal sealed class PlayerWindow : Form
{
    internal const string AppTitle = "摸鱼侠";
    private const string Shortcut = "Ctrl + Alt + F9";
    private const int HotkeyId = 1;
    private const int WmHotkey = 0x0312;
    private const uint CtrlAltNoRepeat = 0x4003;
    private const string PauseMediaScript = "document.querySelectorAll('video,audio').forEach(media => media.pause())";
    private const string BilibiliVideoSelector = "document.querySelector('#live-player video, #bilibili-player video, .bpx-player-container video') || document.querySelector('video')";
    private const string DouyinVideoSelector = @"(() => {
        const selected = document.querySelector('video.shortdrama-taskbar-video');
        if (document.documentElement.classList.contains('shortdrama-taskbar'))
            return selected?.videoHeight ? selected : null;
        let active = null;
        let largestArea = 0;
        for (const video of document.querySelectorAll('video')) {
            if (!video.videoHeight || video.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false) continue;
            const rect = video.getBoundingClientRect();
            const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
            const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
            const area = width * height;
            if (!area) continue;
            if (!active || (active.paused && !video.paused) || (active.paused === video.paused && area > largestArea)) {
                active = video;
                largestArea = area;
            }
        }
        return active;
    })()";
    private const string SiteTaskbarWorld = "ShortDramaPlayerTaskbar";
    private const string SiteTaskbarBinding = "sendShortDramaTaskbarCommand";
    private static string AspectScript(string selector)
    {
        return "(() => { const video = (" + selector + "); return video?.videoHeight ? video.videoWidth / video.videoHeight : null; })()";
    }

    private static string TogglePlaybackScript(string selector)
    {
        return "(() => { const video = (" + selector +
            "); if (!video) return; if (video.paused) video.play().catch(() => {}); else video.pause(); })()";
    }

    private static string FishingPlaybackScript(string selector)
    {
        return "(() => { const video = (" + selector +
            "); return !!(video && !video.paused && !video.ended && !video.error && (video.currentSrc || video.srcObject)); })()";
    }

    private static string PreviewScript(string selector)
    {
        return @"(() => {
        if (!document.getElementById('shortdrama-taskbar-style')) {
            const style = document.createElement('style');
            style.id = 'shortdrama-taskbar-style';
            style.textContent = `
                html.shortdrama-taskbar, html.shortdrama-taskbar body {
                    margin: 0 !important; overflow: hidden !important; background: #000 !important;
                }
                html.shortdrama-taskbar body * { visibility: hidden !important; }
                html.shortdrama-taskbar body :has(.shortdrama-taskbar-video) { overflow: visible !important; transform: none !important; }
                html.shortdrama-taskbar .shortdrama-taskbar-video {
                    visibility: visible !important; position: fixed !important; inset: 0 !important;
                    width: 100vw !important; height: 100vh !important; max-width: none !important;
                    max-height: none !important; margin: 0 !important; transform: none !important;
                    object-fit: contain !important; object-position: center !important;
                }
                html.shortdrama-taskbar.shortdrama-taskbar-cropped .shortdrama-taskbar-video {
                    object-fit: cover !important; object-position: 50% 42% !important;
                }`;
            document.head.append(style);
        }
        const video = (" + selector + @");
        document.querySelectorAll('.shortdrama-taskbar-video').forEach(previous => {
            if (previous !== video) previous.classList.remove('shortdrama-taskbar-video');
        });
        if (video) video.classList.add('shortdrama-taskbar-video');
        document.documentElement.classList.add('shortdrama-taskbar');
    })();";
    }

    private const string ClearPreviewScript =
        "document.documentElement.classList.remove('shortdrama-taskbar', 'shortdrama-taskbar-cropped', 'shortdrama-taskbar-expanded'); " +
        "document.querySelectorAll('.shortdrama-taskbar-video').forEach(video => video.classList.remove('shortdrama-taskbar-video')); " +
        "document.getElementById('shortdrama-taskbar-style')?.remove();";
    private const double MinimumExpandedZoom = 0.10;
    private const double DefaultExpandedZoom = 0.40;
    private const double MaximumExpandedZoom = 0.65;
    private const string BrowseBilibiliCommand = "bilibili:browse:";
    private const string BrowseDouyinCommand = "douyin:browse:";

    private sealed class SiteView
    {
        internal readonly WebView2 Browser = new WebView2();
        internal readonly string Name;
        internal readonly string Home;
        internal readonly string Profile;
        internal readonly string VideoSelector;
        internal readonly Func<Uri, bool> AllowsUrl;
        internal Task Ready;
        internal bool HasTaskbarBinding;

        internal SiteView(string name, string home, string profile, string videoSelector, Func<Uri, bool> allowsUrl)
        {
            Name = name;
            Home = home;
            Profile = profile;
            VideoSelector = videoSelector;
            AllowsUrl = allowsUrl;
        }
    }

    private readonly WebView2 browser = new WebView2();
    private readonly SiteView bilibili = new SiteView("B 站", "https://www.bilibili.com/", "bilibili-webview", BilibiliVideoSelector, IsBilibiliSite);
    private readonly SiteView douyin = new SiteView("抖音", "https://www.douyin.com/series", "douyin-webview", DouyinVideoSelector, IsDouyinSite);
    private readonly Button sizeButton = new Button();
    private readonly Button taskbarButton = new Button();
    private readonly Button playBilibiliVideoButton = new Button();
    private readonly Button returnToPlayerButton = new Button();
    private readonly Label shortcutLabel = new Label();
    private readonly Label loading = new Label();
    private readonly FlowLayoutPanel toolbar = new FlowLayoutPanel();
    private readonly System.Windows.Forms.Timer taskbarTimer = new System.Windows.Forms.Timer { Interval = 1500 };
    private readonly System.Windows.Forms.Timer taskbarClickTimer = new System.Windows.Forms.Timer();
    private readonly System.Windows.Forms.Timer fishingTimer = new System.Windows.Forms.Timer { Interval = 1000 };
    private readonly TaskCompletionSource<string> fishingExit = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool fishingSampling;
    private bool fishingClosing;
    private bool fishingReadyToClose;
    private bool screenLocked;
    private int fishingVisibilityRevision;
    private Process service;
    private Uri home;
    private CoreWebView2Frame bilibiliFrame;
    private CoreWebView2Frame taskbarBilibiliFrame;
    private SiteView browsingSite;
    private int siteBrowseRequest;
    private readonly JavaScriptSerializer siteTaskbarJson = new JavaScriptSerializer();
    private int siteTaskbarContext;
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

        foreach (var view in new[] { bilibili, douyin })
        {
            view.Browser.Dock = DockStyle.Fill;
            view.Browser.DefaultBackgroundColor = BackColor;
            view.Browser.Visible = false;
            Controls.Add(view.Browser);
        }

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
        sizeButton.Size = new Size(70, 30);
        sizeButton.Margin = new Padding(0, 0, 6, 0);
        sizeButton.BackColor = Color.FromArgb(49, 52, 68);
        sizeButton.ForeColor = Color.White;
        sizeButton.UseVisualStyleBackColor = false;
        sizeButton.Click += delegate { ToggleSize(); };
        toolbar.Controls.Add(sizeButton);

        taskbarButton.Text = "任务栏(&T)";
        taskbarButton.AccessibleName = "在任务栏空位中播放";
        taskbarButton.Size = new Size(74, 30);
        taskbarButton.Margin = sizeButton.Margin;
        taskbarButton.BackColor = sizeButton.BackColor;
        taskbarButton.ForeColor = Color.White;
        taskbarButton.UseVisualStyleBackColor = false;
        taskbarButton.Enabled = false;
        taskbarButton.Click += async delegate { await EnterTaskbar(); };
        toolbar.Controls.Add(taskbarButton);

        playBilibiliVideoButton.Text = "在播放器播放";
        playBilibiliVideoButton.Size = new Size(96, 30);
        playBilibiliVideoButton.Margin = sizeButton.Margin;
        playBilibiliVideoButton.BackColor = sizeButton.BackColor;
        playBilibiliVideoButton.ForeColor = Color.White;
        playBilibiliVideoButton.UseVisualStyleBackColor = false;
        playBilibiliVideoButton.Visible = false;
        playBilibiliVideoButton.Click += async delegate { await PlayBilibiliPage(); };
        toolbar.Controls.Add(playBilibiliVideoButton);

        returnToPlayerButton.Text = "返回播放器";
        returnToPlayerButton.Size = new Size(88, 30);
        returnToPlayerButton.Margin = taskbarButton.Margin;
        returnToPlayerButton.BackColor = sizeButton.BackColor;
        returnToPlayerButton.ForeColor = Color.White;
        returnToPlayerButton.UseVisualStyleBackColor = false;
        returnToPlayerButton.Visible = false;
        returnToPlayerButton.Click += async delegate { await ReturnFromSite(); };
        toolbar.Controls.Add(returnToPlayerButton);

        shortcutLabel.Text = Shortcut + " 收起／恢复";
        shortcutLabel.AutoSize = true;
        shortcutLabel.Margin = new Padding(0, 7, 0, 0);
        toolbar.Controls.Add(shortcutLabel);
        Controls.Add(toolbar);

        Shown += Initialize;
        Resize += HandleResize;
        fishingTimer.Tick += async delegate { await SampleFishingPlayback(); };
        taskbarTimer.Tick += async delegate { await RefreshTaskbar(); };
        taskbarClickTimer.Tick += async delegate
        {
            taskbarClickTimer.Stop();
            await ToggleTaskbarPlayback();
        };
    }

    private async void Initialize(object sender, EventArgs args)
    {
        SystemEvents.SessionSwitch += OnFishingSessionSwitch;
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
            core.NewWindowRequested += async delegate(object _, CoreWebView2NewWindowRequestedEventArgs pop)
            {
                pop.Handled = true;
                Uri target;
                if (pop.IsUserInitiated && Uri.TryCreate(pop.Uri, UriKind.Absolute, out target) && target.Scheme == "https")
                {
                    if (IsBilibiliSite(target))
                    {
                        await OpenSite(bilibili, target.AbsoluteUri);
                        return;
                    }
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
                if (browsingSite == null)
                {
                    browser.Visible = nav.IsSuccess || browser.Visible;
                    taskbarButton.Enabled = nav.IsSuccess;
                }
            };
            core.WebMessageReceived += async delegate(object _, CoreWebView2WebMessageReceivedEventArgs message)
            {
                if (WindowState == FormWindowState.Minimized || !IsLocal(message.Source)) return;
                string command;
                try { command = message.TryGetWebMessageAsString(); }
                catch (ArgumentException) { return; }
                if (command == null) return;
                if (command.StartsWith(BrowseBilibiliCommand, StringComparison.Ordinal))
                {
                    await OpenSite(bilibili, command.Substring(BrowseBilibiliCommand.Length));
                    return;
                }
                if (command.StartsWith(BrowseDouyinCommand, StringComparison.Ordinal))
                {
                    await OpenSite(douyin, command.Substring(BrowseDouyinCommand.Length));
                    return;
                }
                if (browsingSite == null) await HandleTaskbarCommand(command);
            };
            core.IsMuted = WindowState == FormWindowState.Minimized;
            browser.Source = home;
            fishingTimer.Start();
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

    private static bool IsBilibiliSite(Uri url)
    {
        return IsHttpsSite(url) && (url.IdnHost == "bilibili.com" || url.IdnHost == "b23.tv"
                || url.IdnHost.EndsWith(".bilibili.com", StringComparison.Ordinal));
    }

    private static bool IsDouyinSite(Uri url)
    {
        return IsHttpsSite(url) && (url.IdnHost == "douyin.com" || url.IdnHost.EndsWith(".douyin.com", StringComparison.Ordinal));
    }

    private static bool IsHttpsSite(Uri url)
    {
        return url != null && url.IsAbsoluteUri && url.Scheme == Uri.UriSchemeHttps && url.IsDefaultPort && url.UserInfo.Length == 0;
    }

    private async Task InitializeSiteBrowser(SiteView view)
    {
        string profile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", view.Profile);
        var environment = await CoreWebView2Environment.CreateAsync(null, profile);
        if (IsDisposed) return;
        await view.Browser.EnsureCoreWebView2Async(environment);
        if (IsDisposed) return;
        CoreWebView2 site = view.Browser.CoreWebView2;
        site.Settings.AreHostObjectsAllowed = false;
        site.Settings.IsWebMessageEnabled = false;
        site.Settings.AreDevToolsEnabled = false;
        site.NavigationStarting += delegate(object _, CoreWebView2NavigationStartingEventArgs nav)
        {
            Uri target;
            nav.Cancel = (browsingSite == view && inTaskbar)
                || !Uri.TryCreate(nav.Uri, UriKind.Absolute, out target) || !view.AllowsUrl(target);
        };
        site.NewWindowRequested += delegate(object _, CoreWebView2NewWindowRequestedEventArgs pop)
        {
            pop.Handled = true;
            Uri target;
            if (browsingSite == view && !inTaskbar && pop.IsUserInitiated &&
                Uri.TryCreate(pop.Uri, UriKind.Absolute, out target) && view.AllowsUrl(target))
                site.Navigate(target.AbsoluteUri);
        };
        site.LaunchingExternalUriScheme += delegate(object _, CoreWebView2LaunchingExternalUriSchemeEventArgs launch) { launch.Cancel = true; };
        site.PermissionRequested += delegate(object _, CoreWebView2PermissionRequestedEventArgs permission) { permission.State = CoreWebView2PermissionState.Deny; };
        site.SourceChanged += delegate { if (browsingSite == view) UpdateSiteButtons(); };
        site.NavigationCompleted += delegate { if (browsingSite == view) UpdateSiteButtons(); };
        site.GetDevToolsProtocolEventReceiver("Runtime.bindingCalled").DevToolsProtocolEventReceived += async delegate(
            object _, CoreWebView2DevToolsProtocolEventReceivedEventArgs received)
        {
            if (browsingSite != view || !inTaskbar || siteTaskbarContext == 0 || !CanUseSiteTaskbar(view)) return;
            var payload = siteTaskbarJson.Deserialize<Dictionary<string, object>>(received.ParameterObjectAsJson);
            if ((string)payload["name"] != SiteTaskbarBinding || Convert.ToInt32(payload["executionContextId"]) != siteTaskbarContext) return;
            try
            {
                await HandleTaskbarCommand((string)payload["payload"]);
                return;
            }
            catch (InvalidOperationException) { }
            await LeaveTaskbar();
        };
        UpdateWebViewMute();
    }

    private async Task OpenSite(SiteView view, string url)
    {
        bool resume = string.IsNullOrEmpty(url);
        Uri target;
        if (inTaskbar || !Uri.TryCreate(resume ? view.Home : url, UriKind.Absolute, out target) || !view.AllowsUrl(target)) return;

        int request = ++siteBrowseRequest;
        try
        {
            SiteView previous = browsingSite;
            SetSiteView(view);
            await PausePlayerMedia();
            if (previous != null && previous != view) await PauseSite(previous);
            if (IsDisposed || request != siteBrowseRequest) return;
            if (view.Ready == null) view.Ready = InitializeSiteBrowser(view);
            await view.Ready;
            if (IsDisposed || request != siteBrowseRequest) return;
            if (!resume || !view.AllowsUrl(view.Browser.Source)) view.Browser.CoreWebView2.Navigate(target.AbsoluteUri);
            if (WindowState != FormWindowState.Minimized) view.Browser.Focus();
        }
        catch (Exception)
        {
            if (view.Ready != null && view.Ready.IsFaulted) view.Ready = null;
            if (IsDisposed || request != siteBrowseRequest) return;
            SetSiteView(null);
            MessageBox.Show(this, "无法打开" + view.Name + "页面，请重试。", AppTitle);
        }
    }

    private void SetSiteView(SiteView view)
    {
        browsingSite = view;
        browser.Visible = view == null;
        bilibili.Browser.Visible = view == bilibili;
        douyin.Browser.Visible = view == douyin;
        returnToPlayerButton.Visible = view != null;
        playBilibiliVideoButton.Visible = view == bilibili;
        shortcutLabel.Visible = view == null;
        UpdateSiteButtons();
        UpdateWebViewMute();
    }

    private Uri BilibiliVideoPage()
    {
        Uri current = bilibili.Browser.CoreWebView2 == null ? null : bilibili.Browser.Source;
        return IsBilibiliSite(current) && (current.IdnHost == "www.bilibili.com" || current.IdnHost == "m.bilibili.com" || current.IdnHost == "bilibili.com")
            && Regex.IsMatch(current.AbsolutePath, @"^/video/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,17})/?$") ? current : null;
    }

    private void UpdateSiteButtons()
    {
        playBilibiliVideoButton.Enabled = browsingSite == bilibili && BilibiliVideoPage() != null;
        taskbarButton.Enabled = browsingSite == null ? browser.CoreWebView2 != null : CanUseSiteTaskbar(browsingSite);
    }

    private bool CanUseSiteTaskbar(SiteView view)
    {
        Uri current = view.Browser.CoreWebView2 == null ? null : view.Browser.Source;
        if (view == douyin)
            return IsDouyinSite(current) && (current.IdnHost == "www.douyin.com" || current.IdnHost == "douyin.com");
        if (BilibiliVideoPage() != null) return true;
        return IsBilibiliSite(current) && current.IdnHost == "live.bilibili.com"
            && Regex.IsMatch(current.AbsolutePath, @"^/[1-9]\d{0,17}/?$");
    }

    private async Task<int> PrepareSiteTaskbar(SiteView view)
    {
        CoreWebView2 site = view.Browser.CoreWebView2;
        if (!view.HasTaskbarBinding)
        {
            // The site's own JavaScript never receives the host's taskbar binding.
            await site.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");
            await site.CallDevToolsProtocolMethodAsync("Runtime.addBinding",
                siteTaskbarJson.Serialize(new { name = SiteTaskbarBinding, executionContextName = SiteTaskbarWorld }));
            view.HasTaskbarBinding = true;
        }

        var tree = siteTaskbarJson.Deserialize<Dictionary<string, object>>(
            await site.CallDevToolsProtocolMethodAsync("Page.getFrameTree", "{}"));
        var frame = (Dictionary<string, object>)((Dictionary<string, object>)tree["frameTree"])["frame"];
        var world = siteTaskbarJson.Deserialize<Dictionary<string, object>>(
            await site.CallDevToolsProtocolMethodAsync("Page.createIsolatedWorld",
                siteTaskbarJson.Serialize(new { frameId = frame["id"], worldName = SiteTaskbarWorld })));
        return Convert.ToInt32(world["executionContextId"]);
    }

    private async Task ExecuteInSiteTaskbar(SiteView view, string script, int context)
    {
        string result;
        try
        {
            result = await view.Browser.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate",
                siteTaskbarJson.Serialize(new { expression = script, contextId = context }));
        }
        catch (COMException error) { throw new InvalidOperationException("Site taskbar context is unavailable.", error); }
        var response = siteTaskbarJson.Deserialize<Dictionary<string, object>>(result);
        if (response.ContainsKey("exceptionDetails")) throw new InvalidOperationException("Site taskbar script failed.");
    }

    private async Task MountSiteTaskbar(SiteView view)
    {
        string player = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "player");
        string controls = File.ReadAllText(Path.Combine(player, "src", "client", "js", "taskbar-controls.js"));
        string overlay = File.ReadAllText(Path.Combine(player, "desktop", "windows", "site-taskbar.js"));
        await ExecuteInSiteTaskbar(view, "(() => {\n" + controls + "\n" + overlay +
            "\nmountSiteTaskbar(action => " + SiteTaskbarBinding + "('taskbar:' + action)); })();", siteTaskbarContext);
    }

    private async Task ReturnFromSite()
    {
        if (inTaskbar || browsingSite == null) return;
        siteBrowseRequest++;
        SiteView view = browsingSite;
        SetSiteView(null);
        await PauseSite(view);
    }

    private async Task PlayBilibiliPage()
    {
        Uri video = BilibiliVideoPage();
        if (video == null) return;
        await ReturnFromSite();
        if (!IsDisposed && browsingSite == null && IsLocal(browser.CoreWebView2.Source))
            browser.CoreWebView2.PostWebMessageAsString("bilibili:play:" + video.AbsoluteUri);
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
            if (line.Data != null && line.Data.StartsWith("FISHING_EXIT=", StringComparison.Ordinal))
                fishingExit.TrySetResult(DecodeFishingMessage(line.Data.Substring(13)));
            if (line.Data != null && line.Data.StartsWith("FISHING_RECAP=", StringComparison.Ordinal))
                DispatchFishing(delegate { ShowFishingRecap(DecodeFishingMessage(line.Data.Substring(14))); });
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
        SiteView view = browsingSite;
        if (view != null && !CanUseSiteTaskbar(view)) return;
        Uri sitePage = view == null ? null : view.Browser.Source;
        taskbarBusy = true;
        try
        {
            Rectangle slot = await Task.Run(() => TaskbarPlacement.Find());
            if (IsDisposed || WindowState == FormWindowState.Minimized || view != browsingSite) return;
            if (slot.IsEmpty)
            {
                MessageBox.Show(this, "主任务栏没有足够的空位，或已开启自动隐藏。可以继续使用竖屏小窗。", AppTitle);
                return;
            }
            CoreWebView2Frame frame = view == null ? bilibiliFrame : null;
            double? aspect = await ReadTaskbarAspect(view, frame);
            if (IsDisposed || WindowState == FormWindowState.Minimized || view != browsingSite || (view == null && frame != bilibiliFrame)) return;
            if (!aspect.HasValue)
            {
                MessageBox.Show(this, "请先打开并播放视频，再点「任务栏」。", AppTitle);
                return;
            }
            if (view != null)
            {
                int context = await PrepareSiteTaskbar(view);
                if (IsDisposed || view != browsingSite || WindowState == FormWindowState.Minimized || sitePage != view.Browser.Source) return;
                siteTaskbarContext = context;
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
            if (view != null)
            {
                await UpdateTaskbarView();
                if (IsDisposed || !inTaskbar) return;
                PlaceTaskbar(slot);
                await MountSiteTaskbar(view);
            }
            else
            {
                PlaceTaskbar(slot);
                await UpdateTaskbarView();
                await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('.taskbar-preview-button')?.focus()");
            }
            if (!IsDisposed && inTaskbar) taskbarTimer.Start();
            return;
        }
        catch (Exception error) { Debug.WriteLine(error); }
        finally
        {
            taskbarBusy = false;
        }
        if (!IsDisposed && inTaskbar) await LeaveTaskbar();
        siteTaskbarContext = 0;
        if (!IsDisposed && view != null && view == browsingSite) MessageBox.Show(this, "无法进入任务栏模式，请重试。", AppTitle);
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
            double? aspect = frame != null && frame != bilibiliFrame ? null : await ReadTaskbarAspect(browsingSite, frame);
            if (IsDisposed || !inTaskbar || WindowState == FormWindowState.Minimized) return;
            if (!aspect.HasValue) await LeaveTaskbar();
            else
            {
                taskbarAspect = aspect.Value;
                PlaceTaskbar(slot);
                if (siteTaskbarContext != 0) await UpdateTaskbarView();
            }
            return;
        }
        catch (InvalidOperationException) { }
        finally
        {
            taskbarBusy = false;
        }
        if (!IsDisposed && inTaskbar) await LeaveTaskbar();
    }

    private async Task<double?> ReadTaskbarAspect(SiteView view, CoreWebView2Frame frame)
    {
        string result;
        if (view != null)
        {
            if (!CanUseSiteTaskbar(view)) return null;
            result = await view.Browser.CoreWebView2.ExecuteScriptAsync(AspectScript(view.VideoSelector));
            if (result == "null" && inTaskbar && view == bilibili) return taskbarAspect;
        }
        else if (frame != null) result = await frame.ExecuteScriptAsync(AspectScript(BilibiliVideoSelector));
        else result = await browser.CoreWebView2.ExecuteScriptAsync(
            "(() => { const v = document.querySelector('.theater-view video'); return v ? (v.videoHeight ? v.videoWidth / v.videoHeight : 0) : null; })()");
        if (result == "null") return null;
        double aspect;
        return double.TryParse(result, NumberStyles.Float, CultureInfo.InvariantCulture, out aspect)
            && aspect > 0 && !double.IsInfinity(aspect) ? aspect : taskbarAspect;
    }

    private async Task HandleTaskbarCommand(string command)
    {
        if (!inTaskbar || WindowState == FormWindowState.Minimized) return;
        if (command == "taskbar:click" || command == "taskbar:toggle" || command == "taskbar:play" ||
            command == "taskbar:exit" || command == "taskbar:back") SendFishing("FISHING_RECAP");
        switch (command)
        {
            case "taskbar:click":
                taskbarClickTimer.Stop();
                taskbarClickTimer.Interval = SystemInformation.DoubleClickTime;
                taskbarClickTimer.Start();
                break;
            case "taskbar:toggle":
                await ToggleTaskbarPreview();
                break;
            case "taskbar:play":
                taskbarClickTimer.Stop();
                await ToggleTaskbarPlayback();
                break;
            case "taskbar:exit":
                await LeaveTaskbar();
                break;
            case "taskbar:back":
                if (taskbarExpanded) await ToggleTaskbarPreview();
                else await LeaveTaskbar();
                break;
            case "taskbar:drag-start":
                if (taskbarExpanded) taskbarDragOffset = Cursor.Position - new Size(Location);
                break;
            case "taskbar:drag-move":
                MoveExpandedPreview(Cursor.Position);
                break;
            case "taskbar:drag-end":
                taskbarDragOffset = null;
                break;
            default:
                await AdjustTaskbarZoom(command);
                break;
        }
    }

    private async Task ToggleTaskbarPlayback()
    {
        if (!inTaskbar || WindowState == FormWindowState.Minimized) return;
        try
        {
            CoreWebView2Frame frame = taskbarBilibiliFrame;
            if (siteTaskbarContext != 0)
                await ExecuteInSiteTaskbar(browsingSite, TogglePlaybackScript(browsingSite.VideoSelector), siteTaskbarContext);
            else if (frame == null) browser.CoreWebView2.PostWebMessageAsString("taskbar:play");
            else if (frame == bilibiliFrame) await frame.ExecuteScriptAsync(TogglePlaybackScript(BilibiliVideoSelector));
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
            case "taskbar:zoom-in":
                zoom = Math.Min(maximum, zoom * 1.35);
                fromWheel = true;
                break;
            case "taskbar:zoom-out":
                zoom = Math.Max(minimum, zoom / 1.35);
                fromWheel = true;
                break;
            case "taskbar:max": zoom = taskbarExpanded ? maximum : double.PositiveInfinity; break;
            case "taskbar:fit": zoom = taskbarExpanded ? DefaultExpandedZoom : minimum; break;
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
        if (siteTaskbarContext != 0)
        {
            string cursor = taskbarExpanded ? "grab" : "pointer";
            SiteView view = browsingSite;
            await ExecuteInSiteTaskbar(view, PreviewScript(view.VideoSelector) +
                (view == douyin ? "if (!document.querySelector('.shortdrama-taskbar-video')) throw new Error('Video is no longer available');" : "") +
                "document.documentElement.classList.toggle('shortdrama-taskbar-cropped', " + cropped + ");" +
                "document.documentElement.classList.toggle('shortdrama-taskbar-expanded', " + expanded + ");" +
                "document.getElementById('shortdrama-taskbar-input')?.style.setProperty('cursor', '" + cursor + "', 'important');",
                siteTaskbarContext);
            return;
        }
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
                await frame.ExecuteScriptAsync(PreviewScript(BilibiliVideoSelector) +
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
        SiteView view = browsingSite;
        int context = siteTaskbarContext;
        siteTaskbarContext = 0;
        RestoreCompactBounds();
        try
        {
            if (context != 0)
            {
                await ExecuteInSiteTaskbar(view,
                    "document.getElementById('shortdrama-taskbar-input')?.remove();" + ClearPreviewScript, context);
                return;
            }
            await browser.CoreWebView2.ExecuteScriptAsync(
                "document.documentElement.classList.remove('taskbar-preview', 'taskbar-cropped', 'taskbar-expanded'); " +
                "document.querySelector('.player-container, .bilibili-frame')?.focus()");
            if (frame != null && frame == bilibiliFrame)
                await frame.ExecuteScriptAsync(ClearPreviewScript);
        }
        catch (InvalidOperationException) { }
    }

    private async void HandleResize(object sender, EventArgs args)
    {
        bool minimized = WindowState == FormWindowState.Minimized;
        if (!minimized) lastVisibleState = WindowState;
        if (wasMinimized == minimized) return;
        wasMinimized = minimized;
        UpdateWebViewMute();
        if (!minimized) return;
        StopFishingPlayback();
        taskbarClickTimer.Stop();
        taskbarDragOffset = null;
        if (browsingSite != null) await PauseSite(browsingSite);
        else await PausePlayerMedia();
    }

    private void UpdateWebViewMute()
    {
        bool minimized = WindowState == FormWindowState.Minimized;
        CoreWebView2 player = browser.CoreWebView2;
        if (player != null) player.IsMuted = minimized || browsingSite != null;
        foreach (var view in new[] { bilibili, douyin })
        {
            CoreWebView2 site = view.Browser.CoreWebView2;
            if (site != null) site.IsMuted = minimized || browsingSite != view;
        }
    }

    private async Task PausePlayerMedia()
    {
        CoreWebView2 core = browser.CoreWebView2;
        if (core == null || !IsLocal(core.Source)) return;
        try
        {
            await core.ExecuteScriptAsync(PauseMediaScript);
            if (bilibiliFrame != null) await bilibiliFrame.ExecuteScriptAsync(PauseMediaScript);
        }
        catch (InvalidOperationException) { }
    }

    private async Task PauseSite(SiteView view)
    {
        CoreWebView2 site = view.Browser.CoreWebView2;
        if (site == null || !view.AllowsUrl(view.Browser.Source)) return;
        try { await site.ExecuteScriptAsync(PauseMediaScript); }
        catch (InvalidOperationException) { }
    }

    private string FishingMode()
    {
        if (fishingClosing || screenLocked || !Visible || WindowState == FormWindowState.Minimized) return "off";
        return inTaskbar ? (taskbarExpanded ? "compact" : "taskbar") : (compact ? "compact" : "large");
    }

    private async Task SampleFishingPlayback()
    {
        string mode = FishingMode();
        if (fishingSampling || mode == "off") return;
        fishingSampling = true;
        int revision = fishingVisibilityRevision;
        SiteView view = browsingSite;
        CoreWebView2Frame frame = view == null ? bilibiliFrame : null;
        Uri page = view == null ? browser.Source : view.Browser.Source;
        try
        {
            string playing = "false";
            if (view != null && CanUseSiteTaskbar(view))
                playing = await view.Browser.CoreWebView2.ExecuteScriptAsync(FishingPlaybackScript(view.VideoSelector));
            else if (frame != null)
                playing = await frame.ExecuteScriptAsync(FishingPlaybackScript(BilibiliVideoSelector));
            else if (view == null && browser.CoreWebView2 != null && IsLocal(browser.CoreWebView2.Source))
                playing = await browser.CoreWebView2.ExecuteScriptAsync(FishingPlaybackScript("document.querySelector('.theater-view video.video-element')"));
            if (!IsDisposed && !fishingClosing && revision == fishingVisibilityRevision)
            {
                bool sameSource = browsingSite == view && (view == null
                    ? frame == bilibiliFrame && page == browser.Source
                    : page == view.Browser.Source);
                SendFishing("FISHING_MODE=" + (sameSource && playing == "true" ? FishingMode() : "off"));
            }
        }
        catch (InvalidOperationException) { if (!IsDisposed) StopFishingPlayback(); }
        catch (COMException) { if (!IsDisposed) StopFishingPlayback(); }
        finally { fishingSampling = false; }
    }

    private bool SendFishing(string command)
    {
        if (service == null) return false;
        try
        {
            service.StandardInput.WriteLine(command);
            return true;
        }
        catch (IOException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private void StopFishingPlayback()
    {
        fishingVisibilityRevision++;
        SendFishing("FISHING_MODE=off");
    }

    private void DispatchFishing(Action action)
    {
        try { if (!IsDisposed && IsHandleCreated) BeginInvoke(action); }
        catch (InvalidOperationException) { }
    }

    private void OnFishingSessionSwitch(object sender, SessionSwitchEventArgs args)
    {
        if (args.Reason != SessionSwitchReason.SessionLock && args.Reason != SessionSwitchReason.SessionUnlock) return;
        DispatchFishing(delegate
        {
            screenLocked = args.Reason == SessionSwitchReason.SessionLock;
            StopFishingPlayback();
        });
    }

    private static string DecodeFishingMessage(string value)
    {
        try { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
        catch (FormatException) { return ""; }
    }

    private async void ShowFishingRecap(string message)
    {
        if (fishingClosing || screenLocked || String.IsNullOrEmpty(message)) return;
        using (var notice = new NotifyIcon { Icon = Icon, Visible = true })
        {
            notice.ShowBalloonTip(5000, "鱼塘", message, ToolTipIcon.None);
            await Task.Delay(7000);
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

    protected override async void OnFormClosing(FormClosingEventArgs args)
    {
        base.OnFormClosing(args);
        if (args.Cancel || fishingReadyToClose || args.CloseReason != CloseReason.UserClosing || service == null) return;
        args.Cancel = true;
        if (fishingClosing) return;
        fishingClosing = true;
        fishingTimer.Stop();
        await Task.Yield();
        if (SendFishing("FISHING_EXIT") && await Task.WhenAny(fishingExit.Task, Task.Delay(1500)) == fishingExit.Task)
        {
            string message = await fishingExit.Task;
            if (!String.IsNullOrEmpty(message)) MessageBox.Show(this, message, "鱼塘结算");
        }
        fishingReadyToClose = true;
        Close();
    }

    protected override void OnFormClosed(FormClosedEventArgs args)
    {
        SystemEvents.SessionSwitch -= OnFishingSessionSwitch;
        fishingTimer.Dispose();
        taskbarTimer.Dispose();
        taskbarClickTimer.Dispose();
        if (hotkeyRegistered) UnregisterHotKey(Handle, HotkeyId);
        browser.Dispose();
        bilibili.Browser.Dispose();
        douyin.Browser.Dispose();
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
