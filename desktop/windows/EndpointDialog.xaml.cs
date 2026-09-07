using System.Windows;

namespace XingqiaoDesktop;

public partial class EndpointDialog : Window
{
    public Uri? Endpoint { get; private set; }

    public EndpointDialog(string? current)
    {
        InitializeComponent();
        EndpointBox.Text = current ?? "";
        Loaded += (_, _) => EndpointBox.Focus();
    }

    private void Connect_Click(object sender, RoutedEventArgs e)
    {
        var value = EndpointBox.Text.Trim();
        if (!Uri.TryCreate(value, UriKind.Absolute, out var endpoint) || !IsAllowed(endpoint))
        {
            ErrorText.Text = "请输入 HTTPS 地址；开发时只允许 http://localhost 或 127.0.0.1。";
            ErrorText.Visibility = Visibility.Visible;
            return;
        }
        Endpoint = endpoint;
        DialogResult = true;
    }

    private static bool IsAllowed(Uri endpoint) => endpoint.Scheme == Uri.UriSchemeHttps || (
        endpoint.Scheme == Uri.UriSchemeHttp && endpoint.Host is "localhost" or "127.0.0.1" or "::1"
    );
}
