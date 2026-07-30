package com.xingqiao.android;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native Android shell: browser transport plus a share target for QQ/WeChat/etc. */
public class MainActivity extends android.app.Activity {
    private static final int PICK_FILE = 42;
    private WebView web;
    private ValueCallback<Uri[]> chooserCallback;
    private final ArrayList<Uri> pendingSocial = new ArrayList<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("xingqiao", MODE_PRIVATE);
        web = new WebView(this); setContentView(web);
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(true); settings.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new ShareBridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                chooserCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*"); intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                String[] types = params.getAcceptTypes(); if (types != null && types.length > 0 && types[0].contains("image")) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
                startActivityForResult(intent, PICK_FILE); return true;
            }
        });
        readShareIntent(getIntent());
        loadSavedServer();
    }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); readShareIntent(intent); if (web != null) web.reload(); }
    private void readShareIntent(Intent intent) {
        if (!Intent.ACTION_SEND.equals(intent.getAction()) && !Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) return;
        Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (one != null) pendingSocial.add(one);
        ArrayList<Uri> multiple = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (multiple != null) pendingSocial.addAll(multiple);
        ClipData clips = intent.getClipData();
        if (clips != null) for (int i=0; i<clips.getItemCount(); i++) pendingSocial.add(clips.getItemAt(i).getUri());
        if (!pendingSocial.isEmpty()) Toast.makeText(this, "已收到社交应用的分享内容", Toast.LENGTH_SHORT).show();
    }
    private void loadSavedServer() { String base = prefs.getString("server", ""); if (base.isEmpty()) askServer(); else web.loadUrl(base); }
    private void askServer() {
        EditText input = new EditText(this); input.setHint("例如：http://192.168.1.20:8787"); input.setSingleLine(true);
        new AlertDialog.Builder(this).setTitle("连接星桥服务").setMessage("输入运行 server.py 的 Mac 或 Windows 局域网地址。")
            .setView(input).setNegativeButton("取消", null).setPositiveButton("连接", (d, which) -> {
                String base = input.getText().toString().trim().replaceAll("/$", "");
                if (!base.startsWith("http://") && !base.startsWith("https://")) base = "http://" + base;
                prefs.edit().putString("server", base).apply(); web.loadUrl(base);
            }).show();
    }
    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != PICK_FILE || chooserCallback == null) return;
        ArrayList<Uri> uris = new ArrayList<>();
        if (result == RESULT_OK && data != null) { if (data.getData() != null) uris.add(data.getData()); ClipData clip = data.getClipData(); if (clip != null) for (int i=0;i<clip.getItemCount();i++) uris.add(clip.getItemAt(i).getUri()); }
        chooserCallback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0])); chooserCallback = null;
    }
    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy() { io.shutdownNow(); super.onDestroy(); }

    final class ShareBridge {
        @JavascriptInterface public boolean hasPendingSocial() { return !pendingSocial.isEmpty(); }
        @JavascriptInterface public void uploadPendingSocial(String origin, String sender, String source) {
            final ArrayList<Uri> items = new ArrayList<>(pendingSocial); pendingSocial.clear();
            io.execute(() -> {
                try {
                    JSONObject session = upload(origin + "/api/sessions", items, sender + " · " + source);
                    String callback = JSONObject.quote(new JSONObject().put("ok", true).put("session", session).toString());
                    runOnUiThread(() -> web.evaluateJavascript("window.NativeSocial.onUploaded(" + callback + ")", null));
                }
                catch (Exception error) {
                    String message = error.getMessage() == null ? "导入失败" : error.getMessage();
                    String callback = JSONObject.quote("{\"ok\":false,\"error\":\"" + escapeJson(message) + "\"}");
                    runOnUiThread(() -> web.evaluateJavascript("window.NativeSocial.onUploaded(" + callback + ")", null));
                }
            });
        }
    }
    private JSONObject upload(String endpoint, List<Uri> items, String sender) throws Exception {
        String boundary = "----Xingqiao" + System.currentTimeMillis(); HttpURLConnection c = (HttpURLConnection)new URL(endpoint).openConnection();
        c.setConnectTimeout(10000); c.setReadTimeout(120000); c.setDoOutput(true); c.setRequestMethod("POST"); c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (DataOutputStream out = new DataOutputStream(c.getOutputStream())) {
            field(out, boundary, "sender", sender); field(out, boundary, "mode", "social");
            for (Uri uri : items) { String name = displayName(uri); String mime = getContentResolver().getType(uri); out.writeBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename*=UTF-8''" + Uri.encode(name) + "\r\nContent-Type: " + (mime == null ? "application/octet-stream" : mime) + "\r\n\r\n"); try (BufferedInputStream input = new BufferedInputStream(getContentResolver().openInputStream(uri))) { byte[] buffer = new byte[1024 * 1024]; for (int n; (n=input.read(buffer))!=-1;) out.write(buffer,0,n); } out.writeBytes("\r\n"); }
            out.writeBytes("--" + boundary + "--\r\n");
        }
        if (c.getResponseCode() / 100 != 2) throw new IOException("服务拒绝了文件（" + c.getResponseCode() + "）");
        try (java.io.InputStream input = c.getInputStream()) { return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8)); }
    }
    private void field(DataOutputStream out, String b, String name, String value) throws IOException { out.writeBytes("--" + b + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n"); }
    private String displayName(Uri uri) { try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) { if (cursor != null && cursor.moveToFirst()) return cursor.getString(0); } return "shared-file"; }
    private static String escapeJson(String value) { return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " "); }
}
