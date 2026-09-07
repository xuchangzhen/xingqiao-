const state = { mode: "photos", files: [], session: null, received: [], receiving: new Set(), device: localStorage.getItem("xingqiao-device") || `${navigator.platform.includes("Mac") ? "Mac" : "我的"}设备`, source: "" };
const $ = (selector) => document.querySelector(selector);
const picker = $("#picker");
const list = $("#selected");
const coordinatorToken = new URLSearchParams(location.search).get("host");
if (coordinatorToken) history.replaceState(null, "", location.pathname);
const modeLabels = { photos: ["选择相片或视频", "也可将文件拖到这里"], files: ["选择文件", "打开文件管理器，或拖到这里"], social: ["从社交媒体导入", "将微信、QQ 中的内容分享到星桥，或从文件中选取"] };
const MAX_PARALLEL_UPLOADS = 3;
const MAX_IN_MEMORY_RECEIVE_BYTES = 128 * 1024 * 1024;

function deviceId() {
  let id = localStorage.getItem("xingqiao-id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("xingqiao-id", id); }
  return id;
}
function size(bytes) { if (bytes < 1024) return `${bytes} B`; const units = ["KB", "MB", "GB"]; let i = -1; do { bytes /= 1024; i++; } while (bytes >= 1024 && i < 2); return `${bytes.toFixed(bytes < 10 && i > 0 ? 1 : 0)} ${units[i]}`; }
function icon(file) { return file.type?.startsWith("image/") ? "IMG" : file.type?.startsWith("video/") ? "VID" : "DOC"; }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2600); }
function api(path, opts = {}) { return fetch(path, { ...opts, headers: { "X-Xingqiao-Device": deviceId(), ...(opts.headers || {}) } }); }

function addDownloadDragData(event, link, resource = null) {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  // Chromium's native drag-out path must be backed by a fetchable HTTP(S)
  // resource. A blob: URL and a JavaScript-created File work for in-page drops,
  // but cannot be materialized as a file by another desktop application.
  const url = new URL(link.dataset.dragUrl || link.href, location.href).href;
  const name = (link.download || "xingqiao-file").replaceAll(":", "_");
  transfer.effectAllowed = "copy";
  if (resource) {
    try { transfer.items?.add(resource); } catch (_) {}
  }
  // DownloadURL lets Chromium drag directly to Finder / Explorer. URI and
  // plain-text fallbacks also make the resource useful in other drop targets.
  transfer.setData("DownloadURL", `${link.dataset.mime || "application/octet-stream"}:${name}:${url}`);
  transfer.setData("text/uri-list", url);
  transfer.setData("text/plain", url);
  if (resource?.type?.startsWith("image/")) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = name;
    try { transfer.setData("text/html", image.outerHTML); } catch (_) {}
  }
}

function receivedPreview(file) {
  if (!file.mime.startsWith("image/")) return "";
  return `<a class="received-preview received-preview-link" draggable="true" data-received-id="${file.id}" data-drag-url="${file.dragUrl || file.url}" data-mime="${escapeHtml(file.mime)}" href="${file.url}" download="${escapeHtml(file.name)}" title="拖动这张预览图即可交给聊天窗口、网页上传区或桌面"><img src="${file.url}" alt="${escapeHtml(file.name)}"><span>拖动预览图，直接使用</span></a>`;
}

function renderFiles() {
  list.hidden = !state.files.length;
  list.innerHTML = state.files.map((file, i) => `<div class="file-row"><span class="file-badge">${icon(file)}</span><span class="file-info"><b>${escapeHtml(file.name)}</b><small>${size(file.size)}</small></span><button class="remove" data-index="${i}" aria-label="移除">×</button></div>`).join("");
  $("#sendButton").disabled = !state.files.length || !!state.session;
  list.querySelectorAll(".remove").forEach(btn => btn.onclick = () => { state.files.splice(+btn.dataset.index, 1); renderFiles(); });
}
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function setMode(mode) {
  state.mode = mode; state.source = "";
  document.querySelectorAll(".mode-card").forEach(el => el.classList.toggle("active", el.dataset.mode === mode));
  const [title, hint] = modeLabels[mode]; $("#dropTitle").textContent = title; $("#dropHint").textContent = hint;
  picker.accept = mode === "photos" ? "image/*,video/*" : "*/*";
  picker.setAttribute("capture", mode === "photos" ? "environment" : "");
  $("#privacy").textContent = mode === "social" ? "每次都会询问导入来源" : "不会上传到互联网";
}
function pick() {
  if (state.mode === "social") { showSocialChoice(); return; }
  picker.click();
}
function addFiles(newFiles) {
  const accepted = [...newFiles].filter(file => file.size > 0 && file.size <= 4 * 1024 * 1024 * 1024);
  if (accepted.length !== newFiles.length) toast("已忽略空文件或超过 4 GB 的文件");
  state.files.push(...accepted); renderFiles();
}
async function send() {
  if (!state.files.length) return;
  const button = $("#sendButton"); button.disabled = true; button.textContent = "正在传送…";
  try {
    const response = await api("/api/sessions/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: state.device, mode: state.mode, files: state.files.map(file => ({ name: file.name, size: file.size, mime: file.type || "application/octet-stream" })) }),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "发送失败");
    state.session = data;
    state.heartbeat = setInterval(async () => {
      const session = state.session;
      if (!session) return;
      const r = await api(`/api/sessions/${session.id}/heartbeat`, { method: "POST" });
      if (!r.ok) endSession("发送会话已结束");
    }, 6000);
    refresh();
    toast("已建立传输，附近设备现在可以边接收边传送");
    await uploadFiles(data);
    button.innerHTML = "正在分享 <i>●</i>";
    $("#privacy").textContent = "文件已传完；保持此页面打开，接收方仍可拖取";
  } catch (error) {
    const failedSession = state.session;
    state.session = null;
    clearInterval(state.heartbeat);
    if (failedSession) await api(`/api/sessions/${failedSession.id}`, { method: "DELETE" }).catch(() => {});
    toast(error.message || "发送失败"); button.textContent = "开始发送 →"; button.disabled = false; refresh();
  }
}

async function uploadFiles(session) {
  const loaded = state.files.map(() => 0);
  const total = state.files.reduce((sum, file) => sum + file.size, 0);
  let nextIndex = 0;
  const progress = (index, bytes) => {
    loaded[index] = bytes;
    const sent = loaded.reduce((sum, value) => sum + value, 0);
    const percent = total ? Math.min(100, Math.round(sent * 100 / total)) : 100;
    $("#sendButton").textContent = `正在传送 ${percent}%`;
    $("#privacy").textContent = `${size(sent)} / ${size(total)} · 接收方可同时开始下载`;
  };
  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= state.files.length) return;
      await uploadFile(session.id, session.files[index].id, state.files[index], bytes => progress(index, bytes));
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_UPLOADS, state.files.length) }, worker));
}

function uploadFile(sessionId, fileId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", `/api/sessions/${sessionId}/files/${fileId}`);
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("X-Xingqiao-Device", deviceId());
    request.upload.onprogress = event => onProgress(event.loaded);
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error("文件上传失败"));
    request.onerror = () => reject(new Error("网络连接中断"));
    request.onabort = () => reject(new Error("文件上传已取消"));
    request.send(file);
  });
}
async function endSession(message) {
  if (!state.session) return;
  clearInterval(state.heartbeat); const id = state.session.id; state.session = null;
  await api(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
  $("#sendButton").innerHTML = "开始发送 <i>→</i>"; $("#sendButton").disabled = !state.files.length; $("#privacy").textContent = "不会上传到互联网";
  if (message) toast(message); refresh();
}
async function refresh() {
  try {
    const response = await api("/api/sessions"); const { sessions } = await response.json();
    const visible = sessions.filter(session => session.id !== state.session?.id); renderIncoming(visible);
  } catch { $("#incomingList").innerHTML = '<div class="empty">无法连接传输服务，请确认设备在同一局域网。</div>'; }
}
function renderIncoming(sessions) {
  const target = $("#incomingList");
  const receivedKeys = new Set(state.received.map(file => file.key));
  const waiting = sessions.map(session => {
    const files = session.files.filter(file => !receivedKeys.has(`${session.id}:${file.id}`));
    if (!files.length) return "";
    return `<article class="transfer"><div class="transfer-top"><span class="avatar">✦</span><div><b>${escapeHtml(session.sender)} 正在分享</b><small>${files.length} 个文件 · 全程局域网</small></div></div><div class="transfer-files">${files.map(file => `<a class="download" draggable="true" data-drag-url="/api/sessions/${session.id}/files/${file.id}" data-mime="${escapeHtml(file.mime)}" data-session="${session.id}" data-file="${file.id}" data-size="${file.size}" href="/api/sessions/${session.id}/files/${file.id}" download="${escapeHtml(file.name)}" title="可直接拖到桌面或支持文件投放的应用；点击则保留到当前页面"><strong>${escapeHtml(file.name)}</strong><span>${file.ready === false ? `上传中 ${Math.min(99, Math.round((file.received || 0) * 100 / file.size))}% · 可边传边收` : `${size(file.size)} · 点击接收 / 直接拖出`} ↓</span></a>`).join("")}</div><div class="transfer-actions"><button class="decline" data-decline="${session.id}">不接收</button></div></article>`;
  }).join("");
  const received = state.received.map(file => `<article class="transfer"><div class="transfer-top"><span class="avatar">✓</span><div><b>已接收，可直接拖出</b><small>文件保留在当前页面；点击文件可另存</small></div></div>${receivedPreview(file)}<div class="transfer-files"><a class="download received-resource" draggable="true" data-received-id="${file.id}" data-drag-url="${file.dragUrl || file.url}" data-mime="${escapeHtml(file.mime)}" href="${file.url}" download="${escapeHtml(file.name)}"><strong>${escapeHtml(file.name)}</strong><span>${size(file.size)} · 拖出使用 / 点击保存</span></a></div></article>`).join("");
  target.innerHTML = waiting || received ? waiting + received : '<div class="empty">暂时没有等待接收的文件</div>';
  target.querySelectorAll("[data-decline]").forEach(button => button.onclick = async () => { await api(`/api/sessions/${button.dataset.decline}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: deviceId() }) }); refresh(); });
  target.querySelectorAll("[data-drag-url], [data-received-id]").forEach(link => link.addEventListener("dragstart", event => {
    const received = state.received.find(file => file.id === link.dataset.receivedId);
    addDownloadDragData(event, link, received?.resource || null);
  }));
  target.querySelectorAll(".download").forEach(link => link.addEventListener("click", event => {
    if (link.dataset.receivedId) return;
    if (androidAutoSaveAvailable()) {
      event.preventDefault();
      saveLinkToAndroid(link);
      return;
    }
    if (Number(link.dataset.size) <= MAX_IN_MEMORY_RECEIVE_BYTES) {
      event.preventDefault();
      receiveLinkIntoPage(link);
    }
  }));
}
function androidAutoSaveAvailable() { return Boolean(window.AndroidBridge?.beginReceiveFile && window.AndroidBridge?.writeReceiveChunk && window.AndroidBridge?.finishReceiveFile); }
function bridgeJson(raw) { try { return JSON.parse(raw); } catch (_) { return null; } }
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer); let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
async function saveLinkToAndroid(link) {
  const target = bridgeJson(window.AndroidBridge.beginReceiveFile(link.download, link.dataset.mime || "application/octet-stream"));
  if (!target?.ok) { toast("无法创建安卓保存位置"); return; }
  try {
    const response = await fetch(link.href, { headers: { "X-Xingqiao-Device": deviceId() } });
    if (!response.ok || !response.body) throw Error("无法读取接收文件");
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!window.AndroidBridge.writeReceiveChunk(target.token, bufferToBase64(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)))) throw Error("保存通道已中断");
    }
    const result = bridgeJson(window.AndroidBridge.finishReceiveFile(target.token));
    if (!result?.ok) throw Error("保存失败");
    toast(`已自动保存 ${link.download} 到 ${result.folder}`);
  } catch (error) {
    window.AndroidBridge.abortReceiveFile(target.token);
    toast(error.message || "保存失败");
  }
}
async function receiveLinkIntoPage(link) {
  const key = `${link.dataset.session}:${link.dataset.file}`;
  if (state.received.some(file => file.key === key) || state.receiving.has(key)) return;
  state.receiving.add(key);
  link.dataset.loading = "true";
  const status = link.querySelector("span");
  if (status) status.textContent = "正在接收…";
  try {
    const response = await api(link.getAttribute("href"));
    if (!response.ok) throw new Error("文件已失效，请让发送方保持页面打开");
    const blob = await response.blob();
    const mime = link.dataset.mime || blob.type || "application/octet-stream";
    const resource = new File([blob], link.download, { type: mime, lastModified: Date.now() });
    const url = URL.createObjectURL(resource);
    state.received.unshift({ id: crypto.randomUUID(), key, name: resource.name, size: resource.size, mime, resource, url, dragUrl: new URL(link.getAttribute("href"), location.href).href });
    state.receiving.delete(key);
    toast(`${resource.name} 已接收，可直接拖到聊天或其他应用`);
    refresh();
  } catch (error) {
    state.receiving.delete(key);
    delete link.dataset.loading;
    if (status) status.textContent = "接收失败，请重试";
    toast(error.message || "接收失败");
  }
}
function showSocialChoice() {
  const source = window.prompt("选择导入来源：输入 微信、QQ 或 其他。\n在 Android 上也可先在聊天中点“分享”，选择星桥。", "微信");
  if (source === null) return; state.source = source.trim() || "社交媒体";
  if (window.AndroidBridge?.hasPendingSocial?.() && window.AndroidBridge?.uploadPendingSocial) { window.AndroidBridge.uploadPendingSocial(location.origin, state.device, state.source); toast("正在从分享内容导入…"); return; }
  picker.click();
}
window.NativeSocial = { onUploaded(raw) { try { const data = JSON.parse(raw); if (!data.ok) throw Error(data.error); state.session = data.session; state.files = []; renderFiles(); $("#sendButton").innerHTML = "正在发送 <i>●</i>"; $("#privacy").textContent = "保持此页面打开；关闭后文件会立即消失"; state.heartbeat = setInterval(() => api(`/api/sessions/${state.session.id}/heartbeat`, {method:"POST"}), 6000); toast("来自社交应用的文件已发送"); refresh(); } catch (e) { toast(e.message || "导入失败"); } } };

$("#deviceName").textContent = state.device; $("#nameInput").value = state.device;
$("#deviceButton").onclick = () => $("#nameDialog").showModal(); $("#saveName").onclick = () => { state.device = $("#nameInput").value.trim() || "我的设备"; localStorage.setItem("xingqiao-device", state.device); $("#deviceName").textContent = state.device; };
document.querySelectorAll(".mode-card").forEach(button => button.onclick = () => setMode(button.dataset.mode));
$("#dropzone").onclick = pick; picker.onchange = () => { addFiles(picker.files); picker.value = ""; };
$("#dropzone").ondragover = event => { event.preventDefault(); $("#dropzone").classList.add("drag"); }; $("#dropzone").ondragleave = () => $("#dropzone").classList.remove("drag"); $("#dropzone").ondrop = event => { event.preventDefault(); $("#dropzone").classList.remove("drag"); addFiles(event.dataTransfer.files); };
$("#sendButton").onclick = send; $("#refreshButton").onclick = refresh; window.addEventListener("pagehide", () => {
  if (state.session) navigator.sendBeacon(`/api/sessions/${state.session.id}/end`, "");
  // Only the browser tab opened by the launcher has this one-time token. A receiver closing
  // their own tab will therefore never shut down the coordinator on another computer.
  if (coordinatorToken) navigator.sendBeacon(`/api/server/stop?token=${encodeURIComponent(coordinatorToken)}`, "");
  state.received.forEach(file => URL.revokeObjectURL(file.url));
});
setMode("photos"); renderFiles(); refresh(); setInterval(refresh, 5000);
