using Microsoft.Web.WebView2.Core;
using System.Diagnostics;
using System.Windows;

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
        _bridge = new DesktopBridge(_store, _shelf);
        _webProfile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Xingqiao", "WebView");
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
            MessageBox.Show($"无法启动网页界面：{error.Message}\n\n请确认 Microsoft Edge WebView2 Runtime 已安装。", "星桥", MessageBoxButton.OK, MessageBoxImage.Error);
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
