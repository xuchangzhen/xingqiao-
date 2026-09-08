using System.Text.Json;
using System.Windows;

namespace XingqiaoDesktop;

public sealed class DesktopBridge
{
    public const string BootstrapScript = """
    (() => {
      const host = window.chrome && window.chrome.webview;
      if (!host) return;
      let nextId = 0;
      const pending = new Map();
      host.addEventListener('message', event => {
        const reply = event.data || {};
        const request = pending.get(reply.id);
        if (!request) return;
        pending.delete(reply.id);
        if (reply.error) request.reject(new Error(reply.error));
        else request.resolve(reply.result);
      });
      const call = (action, payload = {}) => new Promise((resolve, reject) => {
        const id = `xingqiao-${Date.now()}-${++nextId}`;
        pending.set(id, { resolve, reject });
        host.postMessage({ id, action, ...payload });
      });
      window.XingqiaoDesktop = Object.freeze({
        beginReceiveFile: (name, mime) => call('beginReceiveFile', { name, mime }),
        writeReceiveChunk: (token, base64) => call('writeReceiveChunk', { token, base64 }),
        finishReceiveFile: token => call('finishReceiveFile', { token }),
        abortReceiveFile: token => call('abortReceiveFile', { token }),
        setTransferActive: active => call('setTransferActive', { active: !!active }),
        showInbox: () => call('showInbox'),
        checkForUpdate: () => call('checkForUpdate'),
        appVersion: () => call('appVersion'),
      });
    })();
    """;

    private readonly TempInboxStore _store;
    private readonly InboxWindow _shelf;
    private readonly Action _checkForUpdate;

    public Uri? TrustedOrigin { get; set; }

    public DesktopBridge(TempInboxStore store, InboxWindow shelf, Action checkForUpdate)
    {
        _store = store;
        _shelf = shelf;
        _checkForUpdate = checkForUpdate;
    }

    public void Handle(string source, string json, Action<string> reply)
    {
        string id = "";
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            id = ReadString(root, "id") ?? "";
            if (!IsTrusted(source)) throw new InvalidOperationException("网页来源未获授权");
            var action = ReadString(root, "action") ?? throw new InvalidOperationException("无效请求");
            object result = action switch
            {
                "beginReceiveFile" => Begin(ReadString(root, "name") ?? "星桥接收文件", ReadString(root, "mime") ?? "application/octet-stream"),
                "writeReceiveChunk" => Write(ReadString(root, "token"), ReadString(root, "base64")),
                "finishReceiveFile" => Finish(ReadString(root, "token")),
                "abortReceiveFile" => Abort(ReadString(root, "token")),
                "showInbox" => ShowInbox(),
                "checkForUpdate" => CheckForUpdate(),
                "appVersion" => new { version = DesktopUpdateService.CurrentVersion },
                "setTransferActive" => new { ok = true },
                _ => new { ok = false, error = "未知请求" },
            };
            reply(JsonSerializer.Serialize(new { id, result }));
        }
        catch (Exception error)
        {
            reply(JsonSerializer.Serialize(new { id, error = error.Message }));
        }
    }

    private object Begin(string name, string mime)
    {
        var target = _store.Begin(name, mime);
        return new { ok = true, token = target.Token, folder = target.Folder, binary = false };
    }

    private object Write(string? token, string? base64)
    {
        if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(base64)) throw new InvalidOperationException("无效请求");
        _store.Append(token, base64);
        return true;
    }

    private object Finish(string? token)
    {
        if (string.IsNullOrEmpty(token)) throw new InvalidOperationException("无效请求");
        _store.Finish(token);
        _shelf.ShowInbox();
        // WebView2 cannot start a native OS file drag from a DOM rectangle.
        // Do not claim that the web card itself is draggable on Windows; the
        // real FileDrop drag is provided by the native inbox shelf.
        return new { ok = true, folder = "星桥临时收件箱", temporary = true };
    }

    private object Abort(string? token)
    {
        if (!string.IsNullOrEmpty(token)) _store.Abort(token);
        return true;
    }

    private object ShowInbox()
    {
        _shelf.ShowInbox();
        return true;
    }

    private object CheckForUpdate()
    {
        _checkForUpdate();
        return true;
    }

    private bool IsTrusted(string source)
    {
        if (!Uri.TryCreate(source, UriKind.Absolute, out var origin) || TrustedOrigin is null) return false;
        return origin.Scheme.Equals(TrustedOrigin.Scheme, StringComparison.OrdinalIgnoreCase) &&
               origin.Host.Equals(TrustedOrigin.Host, StringComparison.OrdinalIgnoreCase) &&
               origin.Port == TrustedOrigin.Port;
    }

    private static string? ReadString(JsonElement root, string key) =>
        root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
