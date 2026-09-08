using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.IO;

namespace XingqiaoDesktop;

public sealed record DesktopRelease(string Version, Uri DownloadUri);

public enum DesktopUpdateState { Latest, Available, Failed }

public sealed record DesktopUpdateCheck(DesktopUpdateState State, DesktopRelease? Release = null, string? Message = null);

/// GitHub Releases is the public update catalogue. The downloaded zip is never
/// executed or used to overwrite the currently running app; Windows opens the
/// Downloads folder so the user can replace it after quitting 星桥.
public static class DesktopUpdateService
{
    private const string ReleaseApi = "https://api.github.com/repos/xuchangzhen/xingqiao-/releases/latest";
    private const string WindowsAsset = "xingqiao-windows-x64.zip";
    private static readonly HttpClient Client = new();

    public static string CurrentVersion
    {
        get
        {
            var version = Assembly.GetEntryAssembly()?.GetName().Version;
            return version is null ? "0.0.0" : $"{version.Major}.{version.Minor}.{Math.Max(0, version.Build)}";
        }
    }

    public static async Task<DesktopUpdateCheck> CheckAsync()
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, ReleaseApi);
            request.Headers.Accept.ParseAdd("application/vnd.github+json");
            request.Headers.UserAgent.ParseAdd("Xingqiao-Windows-Updater");
            using var response = await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            if (!response.IsSuccessStatusCode) return new(DesktopUpdateState.Failed, Message: "更新服务暂时不可用");
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var document = await JsonDocument.ParseAsync(stream);
            var root = document.RootElement;
            var version = (root.TryGetProperty("tag_name", out var tag) ? tag.GetString() : "")?.Trim().TrimStart('v', 'V') ?? "";
            if (string.IsNullOrWhiteSpace(version)) return new(DesktopUpdateState.Failed, Message: "更新版本无效");
            if (CompareVersions(version, CurrentVersion) <= 0) return new(DesktopUpdateState.Latest);

            if (!root.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array)
                return new(DesktopUpdateState.Failed, Message: "未找到 Windows 更新包");
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.TryGetProperty("name", out var assetName) ? assetName.GetString() : "";
                var rawUrl = asset.TryGetProperty("browser_download_url", out var download) ? download.GetString() : "";
                if (name == WindowsAsset && Uri.TryCreate(rawUrl, UriKind.Absolute, out var url))
                    return new(DesktopUpdateState.Available, new DesktopRelease(version, url));
            }
            return new(DesktopUpdateState.Failed, Message: "未找到 Windows 更新包");
        }
        catch
        {
            return new(DesktopUpdateState.Failed, Message: "检查更新失败，请稍后重试");
        }
    }

    public static async Task<string> DownloadAsync(DesktopRelease release)
    {
        var downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        Directory.CreateDirectory(downloads);
        var destination = UniquePath(downloads, $"星桥-v{release.Version}-Windows.zip");
        using var request = new HttpRequestMessage(HttpMethod.Get, release.DownloadUri);
        request.Headers.UserAgent.ParseAdd("Xingqiao-Windows-Updater");
        using var response = await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        await using var input = await response.Content.ReadAsStreamAsync();
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        await input.CopyToAsync(output);
        return destination;
    }

    private static string UniquePath(string folder, string name)
    {
        var path = Path.Combine(folder, name);
        var suffix = 2;
        var stem = Path.GetFileNameWithoutExtension(name);
        var extension = Path.GetExtension(name);
        while (File.Exists(path))
        {
            path = Path.Combine(folder, $"{stem}-{suffix}{extension}");
            suffix++;
        }
        return path;
    }

    private static int CompareVersions(string first, string second)
    {
        var left = first.TrimStart('v', 'V').Split('.', '-');
        var right = second.TrimStart('v', 'V').Split('.', '-');
        for (var index = 0; index < Math.Max(left.Length, right.Length); index++)
        {
            var a = index < left.Length && int.TryParse(left[index], out var parsedA) ? parsedA : 0;
            var b = index < right.Length && int.TryParse(right[index], out var parsedB) ? parsedB : 0;
            if (a != b) return a.CompareTo(b);
        }
        return 0;
    }
}
