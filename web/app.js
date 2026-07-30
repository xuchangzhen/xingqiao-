const state = { mode: "photos", files: [], session: null, device: localStorage.getItem("xingqiao-device") || `${navigator.platform.includes("Mac") ? "Mac" : "我的"}设备`, source: "" };
const $ = (selector) => document.querySelector(selector);
const picker = $("#picker");
const list = $("#selected");
const coordinatorToken = new URLSearchParams(location.search).get("host");
if (coordinatorToken) history.replaceState(null, "", location.pathname);
const modeLabels = { photos: ["选择相片或视频", "也可将文件拖到这里"], files: ["选择文件", "打开文件管理器，或拖到这里"], social: ["从社交媒体导入", "将微信、QQ 中的内容分享到星桥，或从文件中选取"] };

function deviceId() {
  let id = localStorage.getItem("xingqiao-id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("xingqiao-id", id); }
  return id;
}
function size(bytes) { if (bytes < 1024) return `${bytes} B`; const units = ["KB", "MB", "GB"]; let i = -1; do { bytes /= 1024; i++; } while (bytes >= 1024 && i < 2); return `${bytes.toFixed(bytes < 10 && i > 0 ? 1 : 0)} ${units[i]}`; }
function icon(file) { return file.type?.startsWith("image/") ? "IMG" : file.type?.startsWith("video/") ? "VID" : "DOC"; }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2600); }
function api(path, opts = {}) { return fetch(path, { ...opts, headers: { "X-Xingqiao-Device": deviceId(), ...(opts.headers || {}) } }); }

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
  const form = new FormData(); form.append("sender", state.device); form.append("mode", state.mode); state.files.forEach(file => form.append("files", file, file.name));
  try {
    const response = await api("/api/sessions", { method: "POST", body: form }); const data = await response.json();
    if (!response.ok) throw Error(data.error || "发送失败");
    state.session = data;
    button.innerHTML = "正在发送 <i>●</i>"; $("#privacy").textContent = "保持此页面打开；关闭后文件会立即消失";
    state.heartbeat = setInterval(async () => { const r = await api(`/api/sessions/${state.session.id}/heartbeat`, { method: "POST" }); if (!r.ok) endSession("发送会话已结束"); }, 6000);
    toast("文件已就绪，附近设备现在可以选择接收"); refresh();
  } catch (error) { toast(error.message); button.textContent = "开始发送 →"; button.disabled = false; }
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
  if (!sessions.length) { target.innerHTML = '<div class="empty">暂时没有等待接收的文件</div>'; return; }
  target.innerHTML = sessions.map(session => `<article class="transfer"><div class="transfer-top"><span class="avatar">✦</span><div><b>${escapeHtml(session.sender)} 正在分享</b><small>${session.files.length} 个文件 · 剩余约 ${session.expiresIn} 秒</small></div></div><div class="transfer-files">${session.files.map(file => `<a class="download" draggable="true" data-mime="${escapeHtml(file.mime)}" href="/api/sessions/${session.id}/files/${file.id}" download="${escapeHtml(file.name)}"><strong>${escapeHtml(file.name)}</strong><span>${size(file.size)} ↓</span></a>`).join("")}</div><div class="transfer-actions"><button class="decline" data-decline="${session.id}">不接收</button></div></article>`).join("");
  target.querySelectorAll("[data-decline]").forEach(button => button.onclick = async () => { await api(`/api/sessions/${button.dataset.decline}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: deviceId() }) }); refresh(); });
  target.querySelectorAll(".download").forEach(link => link.addEventListener("dragstart", event => {
    // Chromium's DownloadURL lets a received item be dropped straight into Finder/Explorer or another app.
    event.dataTransfer.setData("DownloadURL", `${link.dataset.mime}:${link.download}:${new URL(link.href, location.href)}`);
  }));
}
function showSocialChoice() {
  const source = window.prompt("选择导入来源：输入 微信、QQ 或 其他。\n在 Android 上也可先在聊天中点“分享”，选择星桥。", "微信");
  if (source === null) return; state.source = source.trim() || "社交媒体";
  if (window.AndroidBridge?.hasPendingSocial?.()) { window.AndroidBridge.uploadPendingSocial(location.origin, state.device, state.source); toast("正在从分享内容导入…"); return; }
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
});
setMode("photos"); renderFiles(); refresh(); setInterval(refresh, 5000);
