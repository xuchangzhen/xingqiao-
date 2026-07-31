package com.xingqiao.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Android entrance for Xingqiao. The transfer UI itself stays on the responsive web page,
 * while this activity supplies an app-quality launch, loading and recovery experience.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILE = 42;
    private static final String PREFS = "xingqiao";
    private static final String PREF_ENDPOINT = "endpoint";

    private WebView web;
    private View welcomeLayer;
    private TextView welcomeStatus;
    private Button welcomePrimary;
    private ValueCallback<Uri[]> chooserCallback;
    private final ArrayList<Uri> pendingSocial = new ArrayList<>();
    private final Map<String, PendingReceive> pendingReceives = new ConcurrentHashMap<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;
    private boolean pageLoaded;
    private String activeEndpoint;
    /** Written by WebView callbacks on the UI thread, read by the JavaScript bridge thread. */
    private volatile boolean trustedBridgePage;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(244, 246, 251));
        getWindow().setNavigationBarColor(Color.rgb(244, 246, 251));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(244, 246, 251));
        web = createWebView();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        welcomeLayer = createWelcome();
        root.addView(welcomeLayer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        readShareIntent(getIntent());
        openPreferredEndpoint();
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private WebView createWebView() {
        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        // The transfer page changes together with the native bridge. Never let an old
        // cached cloud.js keep an installed App on an incompatible protocol.
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        view.clearCache(true);
        view.addJavascriptInterface(new ShareBridge(), "AndroidBridge");
        view.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                trustedBridgePage = isTrustedPageUrl(url);
                if (!pageLoaded) showLoading("正在打开星桥…");
            }
            @Override public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                hideWelcome();
                view.evaluateJavascript("document.documentElement.classList.add('xingqiao-android');", null);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { trustedBridgePage = false; showConnectionError(); }
            }
            @Override @SuppressWarnings("deprecation") public void onReceivedError(WebView view, int code, String description, String failingUrl) {
                trustedBridgePage = false;
                showConnectionError();
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                chooserCallback = callback;
                String[] types = params.getAcceptTypes();
                Intent intent;
                if (wantsVisualMedia(types) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    // Android 13+ system Photo Picker: this opens the gallery, not DocumentsUI.
                    intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit());
                } else {
                    intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    if (wantsVisualMedia(types)) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
                }
                startActivityForResult(intent, PICK_FILE);
                return true;
            }
        });
        return view;
    }

    private View createWelcome() {
        FrameLayout frame = new FrameLayout(this);
        frame.setBackground(gradient("#E8F0FF", "#F9F7FF"));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(28), dp(38), dp(28), dp(28));
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        scroll.addView(column, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView mark = text("✦", 30, Color.WHITE);
        mark.setGravity(Gravity.CENTER);
        mark.setBackground(round("#287BF4", 24));
        column.addView(mark, box(48, 48, 0, 0, 0, 18));

        TextView eyebrow = text("XINGQIAO · PRIVATE BY DESIGN", 11, Color.rgb(91, 110, 151));
        eyebrow.setLetterSpacing(.16f);
        eyebrow.setGravity(Gravity.CENTER);
        column.addView(eyebrow, width(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0, 0, 10));

        TextView title = text("星桥", 38, Color.rgb(23, 35, 62));
        title.setGravity(Gravity.CENTER);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        column.addView(title, width(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0, 0, 6));
        TextView subtitle = text("让文件，轻轻跨过设备之间。", 18, Color.rgb(69, 84, 115));
        subtitle.setGravity(Gravity.CENTER);
        column.addView(subtitle, width(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0, 0, 28));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(22), dp(22), dp(22), dp(22));
        card.setBackground(round("#FDFDFFFF", 28));
        TextView ready = text("准备安全直连", 21, Color.rgb(23, 35, 62));
        ready.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        card.addView(ready);
        welcomeStatus = text("正在准备星桥…", 14, Color.rgb(100, 116, 145));
        card.addView(welcomeStatus, width(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0, 0, 18));
        welcomePrimary = button("正在打开…", "#287BF4", Color.WHITE);
        welcomePrimary.setOnClickListener(v -> openPreferredEndpoint());
        card.addView(welcomePrimary, width(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0, 0, 12));
        Button learn = button("为什么不需要账号？", "#EEF3FF", Color.rgb(37, 97, 194));
        learn.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("星桥如何保护你的内容？")
            .setMessage("星桥不需要账号。文件优先在两台设备之间直连；关闭发送页面后，等待接收的内容会结束。请只向可信设备发送文件。")
            .setPositiveButton("知道了", null).show());
        card.addView(learn, width(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0, 0, 0));
        column.addView(card, width(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0, 0, 18));

        TextView details = text("照片 · 视频 · 文档 · 剪贴板\n无需账号，发送端离开即结束", 14, Color.rgb(91, 110, 151));
        details.setGravity(Gravity.CENTER);
        details.setLineSpacing(dp(5), 1f);
        column.addView(details, width(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0, 0, 24));
        Button alternate = button("连接其他星桥", "#00000000", Color.rgb(80, 102, 145));
        alternate.setOnClickListener(v -> showEndpointDialog());
        column.addView(alternate, width(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0, 0, 0));

        frame.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return frame;
    }

    private void openPreferredEndpoint() {
        String saved = prefs.getString(PREF_ENDPOINT, "");
        String configured = BuildConfig.DEFAULT_WEB_URL;
        activeEndpoint = normalizeEndpoint(saved.isEmpty() ? configured : saved);
        if (activeEndpoint.isEmpty()) {
            showWelcome("此开发包尚未配置星桥入口", "连接其他星桥");
            welcomePrimary.setOnClickListener(v -> showEndpointDialog());
            return;
        }
        pageLoaded = false;
        trustedBridgePage = false;
        showLoading("正在建立安全连接…");
        welcomePrimary.setOnClickListener(v -> openPreferredEndpoint());
        web.loadUrl(activeEndpoint);
    }

    private void showEndpointDialog() {
        final android.widget.EditText input = new android.widget.EditText(this);
        input.setHint("https://transfer.example.com");
        input.setSingleLine(true);
        input.setText(prefs.getString(PREF_ENDPOINT, ""));
        input.setSelectAllOnFocus(false);
        int padding = dp(24);
        FrameLayout holder = new FrameLayout(this);
        holder.setPadding(padding, 0, padding, 0);
        holder.addView(input);
        new AlertDialog.Builder(this)
            .setTitle("连接其他星桥")
            .setMessage("仅在你使用自己的部署地址或局域网协调端时需要设置一次。日常使用会自动打开星桥。")
            .setView(holder)
            .setNeutralButton("清除设置", (d, w) -> { prefs.edit().remove(PREF_ENDPOINT).apply(); openPreferredEndpoint(); })
            .setNegativeButton("取消", null)
            .setPositiveButton("连接", (d, w) -> {
                String endpoint = normalizeEndpoint(input.getText().toString());
                if (endpoint.isEmpty()) { Toast.makeText(this, "请输入有效的网页地址", Toast.LENGTH_SHORT).show(); return; }
                prefs.edit().putString(PREF_ENDPOINT, endpoint).apply();
                openPreferredEndpoint();
            }).show();
    }

    private void showLoading(String message) { showWelcome(message, "正在打开…"); }
    private void showConnectionError() {
        pageLoaded = false;
        showWelcome("暂时无法连接。请检查网络后重试。", "重新连接");
    }
    private void showWelcome(String message, String primary) {
        if (welcomeLayer != null) { welcomeLayer.setVisibility(View.VISIBLE); welcomeLayer.setAlpha(1f); }
        if (welcomeStatus != null) welcomeStatus.setText(message);
        if (welcomePrimary != null) { welcomePrimary.setText(primary); welcomePrimary.setEnabled(true); }
    }
    private void hideWelcome() {
        if (welcomeLayer == null || welcomeLayer.getVisibility() != View.VISIBLE) return;
        welcomeLayer.animate().alpha(0f).setDuration(260).withEndAction(() -> welcomeLayer.setVisibility(View.GONE)).start();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readShareIntent(intent);
        if (web != null && pageLoaded) web.reload();
    }

    private void readShareIntent(Intent intent) {
        if (!Intent.ACTION_SEND.equals(intent.getAction()) && !Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) return;
        Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (one != null) pendingSocial.add(one);
        ArrayList<Uri> multiple = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (multiple != null) pendingSocial.addAll(multiple);
        ClipData clips = intent.getClipData();
        if (clips != null) for (int i = 0; i < clips.getItemCount(); i++) if (clips.getItemAt(i).getUri() != null) pendingSocial.add(clips.getItemAt(i).getUri());
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != PICK_FILE || chooserCallback == null) return;
        ArrayList<Uri> uris = new ArrayList<>();
        if (result == RESULT_OK && data != null) {
            if (data.getData() != null) uris.add(data.getData());
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
        }
        chooserCallback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
        chooserCallback = null;
    }

    @Override public void onBackPressed() {
        if (welcomeLayer != null && welcomeLayer.getVisibility() == View.VISIBLE && pageLoaded) { hideWelcome(); return; }
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        for (String token : new ArrayList<>(pendingReceives.keySet())) new ShareBridge().abortReceiveFile(token);
        io.shutdownNow();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    final class ShareBridge {
        @android.webkit.JavascriptInterface public boolean hasPendingSocial() { return !pendingSocial.isEmpty(); }
        @android.webkit.JavascriptInterface public String pendingSocialManifest() {
            if (!isTrustedBridgeCall()) return "{\"files\":[]}";
            try {
                JSONArray files = new JSONArray();
                for (Uri uri : pendingSocial) {
                    JSONObject item = new JSONObject();
                    item.put("name", displayName(uri));
                    item.put("mime", getContentResolver().getType(uri) == null ? "application/octet-stream" : getContentResolver().getType(uri));
                    item.put("size", displaySize(uri));
                    files.put(item);
                }
                return new JSONObject().put("files", files).toString();
            } catch (Exception error) { return "{\"files\":[]}"; }
        }
        @android.webkit.JavascriptInterface public String readPendingSocialChunk(int index, long offset, int length) {
            if (!isTrustedBridgeCall() || index < 0 || index >= pendingSocial.size() || length < 1 || length > 96 * 1024) return "";
            try (java.io.InputStream input = getContentResolver().openInputStream(pendingSocial.get(index))) {
                if (input == null) return "";
                long remaining = offset;
                while (remaining > 0) {
                    long skipped = input.skip(remaining);
                    if (skipped > 0) { remaining -= skipped; continue; }
                    if (input.read() == -1) return "";
                    remaining--;
                }
                byte[] buffer = new byte[length];
                int count = input.read(buffer);
                if (count < 1) return "";
                return Base64.encodeToString(count == buffer.length ? buffer : java.util.Arrays.copyOf(buffer, count), Base64.NO_WRAP);
            } catch (Exception error) { return ""; }
        }
        @android.webkit.JavascriptInterface public void clearPendingSocial() { if (isTrustedBridgeCall()) pendingSocial.clear(); }
        /** Opens the requested social app; Android intentionally does not expose its chat data. */
        @android.webkit.JavascriptInterface public void openSocialApp(String packageName) {
            if (!isTrustedBridgeCall()) return;
            runOnUiThread(() -> {
                Intent intent = getPackageManager().getLaunchIntentForPackage(packageName);
                if (intent == null) { Toast.makeText(MainActivity.this, "未安装该应用", Toast.LENGTH_SHORT).show(); return; }
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            });
        }

        /** Creates an Android 10+ MediaStore item; WebRTC data is streamed into it by the page. */
        @android.webkit.JavascriptInterface public String beginReceiveFile(String rawName, String rawMime) {
            if (!isTrustedBridgeCall() || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "{\"ok\":false}";
            String name = safeFileName(rawName);
            String mime = rawMime == null || rawMime.isEmpty() ? "application/octet-stream" : rawMime;
            try {
                ReceiveDestination destination = receiveDestination(mime);
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, destination.relativePath);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(destination.collection, values);
                if (uri == null) throw new IOException("无法创建保存位置");
                OutputStream output = getContentResolver().openOutputStream(uri, "w");
                if (output == null) { getContentResolver().delete(uri, null, null); throw new IOException("无法写入保存位置"); }
                String token = UUID.randomUUID().toString();
                pendingReceives.put(token, new PendingReceive(uri, output, destination.displayFolder));
                return new JSONObject().put("ok", true).put("token", token).put("folder", destination.displayFolder).toString();
            } catch (Exception error) { return "{\"ok\":false}"; }
        }

        @android.webkit.JavascriptInterface public boolean writeReceiveChunk(String token, String base64) {
            PendingReceive receive = pendingReceives.get(token);
            if (receive == null) return false;
            try {
                receive.output.write(Base64.decode(base64, Base64.NO_WRAP));
                return true;
            } catch (Exception error) { abortReceiveFile(token); return false; }
        }

        @android.webkit.JavascriptInterface public String finishReceiveFile(String token) {
            PendingReceive receive = pendingReceives.remove(token);
            if (receive == null) return "{\"ok\":false}";
            try {
                receive.output.flush();
                receive.output.close();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(receive.uri, values, null, null);
                return new JSONObject().put("ok", true).put("folder", receive.folder).toString();
            } catch (Exception error) {
                try { getContentResolver().delete(receive.uri, null, null); } catch (Exception ignored) { }
                return "{\"ok\":false}";
            }
        }

        @android.webkit.JavascriptInterface public void abortReceiveFile(String token) {
            PendingReceive receive = pendingReceives.remove(token);
            if (receive == null) return;
            try { receive.output.close(); } catch (Exception ignored) { }
            try { getContentResolver().delete(receive.uri, null, null); } catch (Exception ignored) { }
        }
        /** Local-network server compatibility: the desktop coordinator accepts this multipart upload. */
        @android.webkit.JavascriptInterface public void uploadPendingSocial(String origin, String sender, String source) {
            final ArrayList<Uri> items = new ArrayList<>(pendingSocial);
            pendingSocial.clear();
            io.execute(() -> {
                try {
                    JSONObject session = upload(origin + "/api/sessions", items, sender + " · " + source);
                    String callback = JSONObject.quote(new JSONObject().put("ok", true).put("session", session).toString());
                    runOnUiThread(() -> web.evaluateJavascript("window.NativeSocial.onUploaded(" + callback + ")", null));
                } catch (Exception error) {
                    String message = error.getMessage() == null ? "导入失败" : error.getMessage();
                    String callback = JSONObject.quote("{\"ok\":false,\"error\":\"" + escapeJson(message) + "\"}");
                    runOnUiThread(() -> web.evaluateJavascript("window.NativeSocial.onUploaded(" + callback + ")", null));
                }
            });
        }
    }

    private JSONObject upload(String endpoint, List<Uri> items, String sender) throws Exception {
        String boundary = "----Xingqiao" + System.currentTimeMillis();
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(120000);
        connection.setDoOutput(true);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (DataOutputStream out = new DataOutputStream(connection.getOutputStream())) {
            field(out, boundary, "sender", sender);
            field(out, boundary, "mode", "social");
            for (Uri uri : items) {
                String name = displayName(uri);
                String mime = getContentResolver().getType(uri);
                out.writeBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename*=UTF-8''" + Uri.encode(name) + "\r\nContent-Type: " + (mime == null ? "application/octet-stream" : mime) + "\r\n\r\n");
                try (BufferedInputStream input = new BufferedInputStream(getContentResolver().openInputStream(uri))) {
                    byte[] buffer = new byte[1024 * 1024];
                    for (int count; (count = input.read(buffer)) != -1;) out.write(buffer, 0, count);
                }
                out.writeBytes("\r\n");
            }
            out.writeBytes("--" + boundary + "--\r\n");
        }
        if (connection.getResponseCode() / 100 != 2) throw new IOException("服务拒绝了文件（" + connection.getResponseCode() + "）");
        try (java.io.InputStream input = connection.getInputStream()) {
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private void field(DataOutputStream out, String boundary, String name, String value) throws IOException {
        out.writeBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n");
    }
    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        }
        return "shared-file";
    }
    private long displaySize(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getLong(0);
        }
        return 0;
    }
    private static String escapeJson(String value) { return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " "); }

    private static boolean wantsVisualMedia(String[] types) {
        if (types == null) return false;
        for (String type : types) if (type != null && (type.contains("image") || type.contains("video"))) return true;
        return false;
    }
    private boolean isTrustedBridgeCall() {
        return trustedBridgePage;
    }
    private boolean isTrustedPageUrl(String pageUrl) {
        try {
            Uri expected = Uri.parse(activeEndpoint == null ? "" : activeEndpoint);
            Uri current = Uri.parse(pageUrl == null ? "" : pageUrl);
            if (expected.getHost() == null || !expected.getHost().equalsIgnoreCase(current.getHost())) return false;
            if ("https".equalsIgnoreCase(current.getScheme())) return true;
            return "http".equalsIgnoreCase(current.getScheme()) && isPrivateHost(current.getHost());
        } catch (Exception ignored) { return false; }
    }
    private static boolean isPrivateHost(String host) {
        return "localhost".equalsIgnoreCase(host) || host.endsWith(".local") || host.startsWith("10.") || host.startsWith("192.168.") || host.matches("^172\\.(1[6-9]|2\\d|3[01])\\..+$");
    }
    private static String safeFileName(String name) {
        String value = name == null ? "" : name.replace('/', '_').replace('\\', '_').replace('\n', ' ').replace('\r', ' ').trim();
        return value.isEmpty() ? "星桥接收文件" : value;
    }
    private static ReceiveDestination receiveDestination(String mime) {
        if (mime.startsWith("image/")) return new ReceiveDestination(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, Environment.DIRECTORY_PICTURES + "/星桥", "图片 / 星桥");
        if (mime.startsWith("video/")) return new ReceiveDestination(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, Environment.DIRECTORY_MOVIES + "/星桥", "视频 / 星桥");
        if (mime.startsWith("audio/")) return new ReceiveDestination(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, Environment.DIRECTORY_MUSIC + "/星桥", "音乐 / 星桥");
        return new ReceiveDestination(MediaStore.Downloads.EXTERNAL_CONTENT_URI, Environment.DIRECTORY_DOWNLOADS + "/星桥", "下载 / 星桥");
    }
    private static final class PendingReceive {
        final Uri uri; final OutputStream output; final String folder;
        PendingReceive(Uri uri, OutputStream output, String folder) { this.uri = uri; this.output = output; this.folder = folder; }
    }
    private static final class ReceiveDestination {
        final Uri collection; final String relativePath; final String displayFolder;
        ReceiveDestination(Uri collection, String relativePath, String displayFolder) { this.collection = collection; this.relativePath = relativePath; this.displayFolder = displayFolder; }
    }

    private static String normalizeEndpoint(String value) {
        String endpoint = value == null ? "" : value.trim().replaceAll("/+$", "");
        if (endpoint.isEmpty()) return "";
        if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
            boolean local = endpoint.equalsIgnoreCase("localhost") || endpoint.startsWith("localhost:") || endpoint.matches("^(\\d{1,3}\\.){3}\\d{1,3}(:\\d+)?$") || endpoint.matches("^.+\\.local(:\\d+)?$");
            endpoint = (local ? "http://" : "https://") + endpoint;
        }
        try { Uri uri = Uri.parse(endpoint); return uri.getHost() == null ? "" : endpoint; } catch (Exception ignored) { return ""; }
    }
    private TextView text(String value, float size, int color) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); return view; }
    private Button button(String label, String background, int color) { Button view = new Button(this); view.setText(label); view.setTextColor(color); view.setTextSize(15); view.setAllCaps(false); view.setMinHeight(dp(52)); view.setBackground(round(background, 17)); return view; }
    private GradientDrawable round(String color, int radius) { GradientDrawable drawable = new GradientDrawable(); drawable.setColor(Color.parseColor(color)); drawable.setCornerRadius(dp(radius)); return drawable; }
    private GradientDrawable gradient(String first, String second) { return new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{Color.parseColor(first), Color.parseColor(second)}); }
    private LinearLayout.LayoutParams width(int width, int left, int top, int right, int bottom) { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT); params.setMargins(dp(left), dp(top), dp(right), dp(bottom)); return params; }
    private LinearLayout.LayoutParams box(int width, int height, int left, int top, int right, int bottom) { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(width), dp(height)); params.setMargins(dp(left), dp(top), dp(right), dp(bottom)); return params; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
