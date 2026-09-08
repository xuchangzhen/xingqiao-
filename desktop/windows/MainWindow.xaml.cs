using Microsoft.Web.WebView2.Core;
using System.Diagnostics;
using System.IO;
using System.Windows;
using WpfMessageBox = System.Windows.MessageBox;

namespace XingqiaoDesktop;

public partial class MainWindow : Window
{
    private readonly TempInboxStore _store = new();
    private readonly InboxWindow _shelf;
    private readonly DesktopBridge _bridge;
    private readonly string _webProfile;
    private Uri? _endpoint;
    private bool _webReady;

    public MainWindow()
    {
        InitializeComponent();
        _shelf = new InboxWindow(_store);
        _bridge = new DesktopBridge(_store, _shelf, CheckForUpdates);
        _webProfile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Xingqiao", "WebView");
        VersionText.Text = $"版本 v{DesktopUpdateService.CurrentVersion}";
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await EnsureWebViewAsync();
            var current = EndpointSettings.Load();
            if (!TryEndpoint(current, out var endpoint))
            {
                if (!PromptEndpoint(current, out endpoint)) return;
            }
            Navigate(endpoint);
        }
        catch (Exception error)
        {
            WpfMessageBox.Show($"无法启动网页界面：{error.Message}\n\n请确认 Microsoft Edge WebView2 Runtime 已安装。", "星桥", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task EnsureWebViewAsync()
    {
        if (_webReady) return;
        TryDeleteDirectory(_webProfile);
        Directory.CreateDirectory(_webProfile);
        var options = new CoreWebView2EnvironmentOptions("--inprivate");
        var environment = await CoreWebView2Environment.CreateAsync(null, _webProfile, options);
        await WebView.EnsureCoreWebView2Async(environment);
        await WebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(DesktopBridge.BootstrapScript);
        WebView.CoreWebView2.WebMessageReceived += (_, args) =>
            _bridge.Handle(args.Source, args.WebMessageAsJson, WebView.CoreWebView2.PostWebMessageAsJson);
        WebView.CoreWebView2.NavigationCompleted += (_, args) => UpdateTrustedOrigin(args.IsSuccess);
        WebView.CoreWebView2.NavigationStarting += (_, args) => OpenExternalLink(args);
        _webReady = true;
    }

    private void Navigate(Uri endpoint)
    {
        _endpoint = endpoint;
        _bridge.TrustedOrigin = null;
        EndpointSettings.Save(endpoint);
        var builder = new UriBuilder(endpoint);
        var query = builder.Query.TrimStart('?');
        builder.Query = string.IsNullOrEmpty(query) ? "xingqiao_desktop=1" : $"{query}&xingqiao_desktop=1";
        WebView.CoreWebView2.Navigate(builder.Uri.AbsoluteUri);
    }

    private void UpdateTrustedOrigin(bool succeeded)
    {
        if (!succeeded || !Uri.TryCreate(WebView.Source?.AbsoluteUri, UriKind.Absolute, out var current) || _endpoint is null || !SameOrigin(current, _endpoint))
        {
            _bridge.TrustedOrigin = null;
            return;
        }
        _bridge.TrustedOrigin = current;
    }

    private void OpenExternalLink(CoreWebView2NavigationStartingEventArgs args)
    {
        if (_endpoint is null || !Uri.TryCreate(args.Uri, UriKind.Absolute, out var target) || SameOrigin(target, _endpoint)) return;
        if (args.IsUserInitiated)
        {
            args.Cancel = true;
            Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true });
        }
    }

    private void ShowInbox_Click(object sender, RoutedEventArgs e) => _shelf.ShowInbox();
    private void Refresh_Click(object sender, RoutedEventArgs e) => WebView.CoreWebView2?.Reload();
    private async void CheckUpdate_Click(object sender, RoutedEventArgs e) => await CheckForUpdatesAsync();

    private void CheckForUpdates()
    {
        if (Dispatcher.CheckAccess())
        {
            _ = CheckForUpdatesAsync();
            return;
        }
        _ = Dispatcher.InvokeAsync(() => { _ = CheckForUpdatesAsync(); });
    }

    private async Task CheckForUpdatesAsync()
    {
        if (!UpdateButton.IsEnabled) return;
        UpdateButton.IsEnabled = false;
        UpdateButton.Content = "检查中…";
        var check = await DesktopUpdateService.CheckAsync();
        UpdateButton.IsEnabled = true;
        UpdateButton.Content = "检查更新";
        if (check.State == DesktopUpdateState.Latest)
        {
            UpdateButton.Content = "已是最新";
            WpfMessageBox.Show($"当前版本 v{DesktopUpdateService.CurrentVersion} 已是最新。", "星桥", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (check.State == DesktopUpdateState.Failed || check.Release is null)
        {
            WpfMessageBox.Show(check.Message ?? "检查更新失败，请稍后重试。", "星桥", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var choice = WpfMessageBox.Show(
            $"发现新版本 v{check.Release.Version}。\n\n将下载 Windows 更新包到“下载”文件夹；退出星桥后请解压并替换旧版。",
            "星桥更新", MessageBoxButton.YesNo, MessageBoxImage.Information, MessageBoxResult.Yes);
        if (choice != MessageBoxResult.Yes) return;

        UpdateButton.IsEnabled = false;
        UpdateButton.Content = $"下载 v{check.Release.Version}…";
        try
        {
            var path = await DesktopUpdateService.DownloadAsync(check.Release);
            UpdateButton.IsEnabled = true;
            UpdateButton.Content = $"已下载 v{check.Release.Version}";
            WpfMessageBox.Show($"更新包已下载到：\n{path}\n\n退出星桥后请解压并替换旧版。", "星桥更新", MessageBoxButton.OK, MessageBoxImage.Information);
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
        }
        catch
        {
            UpdateButton.IsEnabled = true;
            UpdateButton.Content = "检查更新";
            WpfMessageBox.Show("下载更新失败，请检查网络后重试。", "星桥", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void ChangeEndpoint_Click(object sender, RoutedEventArgs e)
    {
        if (PromptEndpoint(_endpoint?.AbsoluteUri ?? EndpointSettings.Load(), out var endpoint)) Navigate(endpoint);
    }

    private bool PromptEndpoint(string? current, out Uri endpoint)
    {
        var dialog = new EndpointDialog(current) { Owner = this };
        if (dialog.ShowDialog() == true && dialog.Endpoint is not null)
        {
            endpoint = dialog.Endpoint;
            return true;
        }
        endpoint = null!;
        return false;
    }

    private static bool TryEndpoint(string? raw, out Uri endpoint)
    {
        if (Uri.TryCreate(raw, UriKind.Absolute, out var parsed) && EndpointDialogAllowed(parsed))
        {
            endpoint = parsed;
            return true;
        }
        endpoint = null!;
        return false;
    }

    private static bool EndpointDialogAllowed(Uri endpoint) => endpoint.Scheme == Uri.UriSchemeHttps || (
        endpoint.Scheme == Uri.UriSchemeHttp && endpoint.Host is "localhost" or "127.0.0.1" or "::1"
    );

    private static bool SameOrigin(Uri first, Uri second) =>
        first.Scheme.Equals(second.Scheme, StringComparison.OrdinalIgnoreCase) &&
        first.Host.Equals(second.Host, StringComparison.OrdinalIgnoreCase) && first.Port == second.Port;

    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        _shelf.CloseForApplication();
        WebView.Dispose();
        _store.Dispose();
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
