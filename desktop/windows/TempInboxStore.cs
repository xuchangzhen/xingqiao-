using System.Collections.ObjectModel;
using System.IO;

namespace XingqiaoDesktop;

public sealed class TempInboxStore : IDisposable
{
    private sealed record PendingFile(TransferFile File, FileStream Stream);

    private readonly object _gate = new();
    private readonly Dictionary<string, PendingFile> _pending = new();
    private readonly string _root;

    public ObservableCollection<TransferFile> Files { get; } = [];
    public event Action? Changed;

    public TempInboxStore()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        _root = Path.Combine(local, "Xingqiao", "Inbox");
        // The inbox is intentionally a session cache. An earlier crash must
        // not retain files that the user did not explicitly choose to save.
        TryDeleteDirectory(_root);
        Directory.CreateDirectory(_root);
    }

    public (string Token, string Folder) Begin(string rawName, string mime)
    {
        var name = SafeName(rawName);
        var token = Guid.NewGuid().ToString("N");
        var folder = Path.Combine(_root, token);
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, name);
        var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.SequentialScan);
        var file = new TransferFile(Guid.NewGuid(), name, mime, path, DateTimeOffset.Now);
        lock (_gate) _pending[token] = new PendingFile(file, stream);
        return (token, "星桥临时收件箱");
    }

    public void Append(string token, string base64)
    {
        var bytes = Convert.FromBase64String(base64);
        lock (_gate)
        {
            if (!_pending.TryGetValue(token, out var pending)) throw new InvalidOperationException("临时接收任务已失效");
            pending.Stream.Write(bytes, 0, bytes.Length);
        }
    }

    public TransferFile Finish(string token)
    {
        PendingFile pending;
        lock (_gate)
        {
            if (!_pending.Remove(token, out var found)) throw new InvalidOperationException("临时接收任务已失效");
            pending = found;
        }
        pending.Stream.Flush(flushToDisk: true);
        pending.Stream.Dispose();
        Files.Insert(0, pending.File);
        Changed?.Invoke();
        return pending.File;
    }

    public void Abort(string token)
    {
        PendingFile? pending;
        lock (_gate)
        {
            _pending.Remove(token, out pending);
        }
        if (pending is null) return;
        pending.Stream.Dispose();
        TryDeleteDirectory(Path.GetDirectoryName(pending.File.Path)!);
    }

    public TransferFile Save(TransferFile file, string destinationFolder)
    {
        var target = UniquePath(destinationFolder, file.Name);
        try
        {
            File.Move(file.Path, target);
        }
        catch (IOException)
        {
            File.Copy(file.Path, target, overwrite: false);
            File.Delete(file.Path);
        }
        TryDeleteDirectory(Path.GetDirectoryName(file.Path)!);
        Files.Remove(file);
        Changed?.Invoke();
        return file with { Name = Path.GetFileName(target), Path = target };
    }

    public void Discard(TransferFile file)
    {
        TryDeleteDirectory(Path.GetDirectoryName(file.Path)!);
        Files.Remove(file);
        Changed?.Invoke();
    }

    public void DiscardAll()
    {
        PendingFile[] pending;
        lock (_gate)
        {
            pending = _pending.Values.ToArray();
            _pending.Clear();
        }
        foreach (var item in pending) item.Stream.Dispose();
        Files.Clear();
        TryDeleteDirectory(_root);
    }

    public void Dispose() => DiscardAll();

    private static string SafeName(string rawName)
    {
        var name = Path.GetFileName(rawName.Trim());
        foreach (var invalid in Path.GetInvalidFileNameChars()) name = name.Replace(invalid, '_');
        return string.IsNullOrWhiteSpace(name) || name is "." or ".." ? "星桥接收文件" : name;
    }

    private static string UniquePath(string folder, string preferredName)
    {
        Directory.CreateDirectory(folder);
        var stem = Path.GetFileNameWithoutExtension(preferredName);
        var extension = Path.GetExtension(preferredName);
        for (var attempt = 1; ; attempt++)
        {
            var name = attempt == 1 ? preferredName : $"{stem} ({attempt}){extension}";
            var candidate = Path.Combine(folder, name);
            if (!File.Exists(candidate)) return candidate;
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
