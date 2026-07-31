const $ = (selector) => document.querySelector(selector);
const state = {
  mode: "photos",
  files: [],
  clipboardImages: [],
  clipboardText: "",
  activeFiles: [],
  device: localStorage.getItem("xingqiao-device") || `${navigator.platform.includes("Mac") ? "Mac" : "我的"}设备`,
  hosted: null,
  pendingHost: null,
  hostMeta: null,
  rooms: [],
  received: [],
  outgoingProgress: null,
  incomingProgress: new Map(),
  dismissedRooms: new Set(),
};
const picker = $("#picker");
const selected = $("#selected");
const clipboardPanel = $("#clipboardPanel");
const socialPanel = $("#socialPanel");
const modes = {
  photos: ["选择相片或视频", "也可将文件拖到这里"],
  files: ["选择文件", "打开文件管理器，或拖到这里"],
  social: ["从社交媒体导入", "将微信、QQ 中的内容分享到星桥，或从文件中选取"],
  clipboard: ["剪贴板内容", "复制内容后，在下方粘贴或读取剪贴板"],
};
let socket;
let iceServers = [];
const peers = new Map();
const channels = new Set();
const pendingCandidates = new Map();
const receiveFolders = new Map();
let hostPublishRetry;
const RENDERED_FILE_LIMIT = 60;
const META_PREVIEW_LIMIT = 12;
const IMAGE_PREVIEW_SIZE_LIMIT = 8 * 1024 * 1024;
const MAX_BATCH_FILES = 40;
const PROGRESS_PAINT_INTERVAL = 160;
// Keep Android's queued WebView/MediaStore work bounded, but leave enough data
// in flight to fill a normal Wi-Fi link even when WebRTC has a higher RTT.
const TRANSFER_CHUNK_BYTES = 32 * 1024;
const RECEIVE_ACK_BYTES = 256 * 1024;
const MAX_IN_FLIGHT_BYTES = 1024 * 1024;
const MAX_DATA_CHANNEL_BUFFERED_BYTES = 512 * 1024;
const BROWSER_FALLBACK_MAX_BYTES = 128 * 1024 * 1024;

function escapeHtml(value) { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; }
function size(bytes) { if (bytes < 1024) return `${bytes} B`; const units = ["KB", "MB", "GB"]; let unit = -1; do { bytes /= 1024; unit++; } while (bytes >= 1024 && unit < 2); return `${bytes.toFixed(bytes < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`; }
function speed(bytesPerSecond) { return bytesPerSecond > 0 ? `${size(bytesPerSecond)}/s` : "计算中…"; }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2800); }
function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}
function newRoomCode() { return Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(36).padStart(4, "0").slice(-4)).join(""); }
function isImage(file) { return file.type.startsWith("image/"); }
function isVideo(file) { return file.type.startsWith("video/"); }
function canPreviewImage(file) { return !window.AndroidBridge && isImage(file) && file.size <= IMAGE_PREVIEW_SIZE_LIMIT; }

function newTransferProgress(room, files, direction, sender = "") {
  const now = performance.now();
  const items = files.map(file => ({ name: file.name, size: Number(file.size) || 0, mime: file.type || file.mime || "application/octet-stream" }));
  return { room, direction, sender, files: items, totalBytes: items.reduce((total, file) => total + file.size, 0), bytes: 0, totalFiles: items.length, completedFiles: 0, currentName: "", startedAt: now, sampleAt: now, sampleBytes: 0, speed: 0, lastPaint: 0, finished: false };
}

function progressPercent(progress) {
  if (!progress.totalBytes) return progress.finished ? 100 : 0;
  return Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100));
}

function progressTitle(progress) {
  if (progress.finished) return progress.direction === "send" ? "本批发送完成" : "接收完成";
  const action = progress.direction === "send" ? "正在发送" : "正在接收";
  const count = progress.totalFiles > 1 ? ` ${Math.min(progress.completedFiles + 1, progress.totalFiles)}/${progress.totalFiles}` : "";
  return `${action}${count}${progress.currentName ? ` · ${progress.currentName}` : ""}`;
}

function progressMeta(progress) {
  return `${size(progress.bytes)} / ${size(progress.totalBytes)} · ${progressPercent(progress)}% · ${progress.finished ? "完成" : speed(progress.speed)}`;
}

function paintProgress(panel, progress) {
  if (!panel) return;
  const title = panel.querySelector("[data-progress-title]");
  const meta = panel.querySelector("[data-progress-meta]");
  const bar = panel.querySelector("[data-progress-bar]");
  if (title) title.textContent = progressTitle(progress);
  if (meta) meta.textContent = progressMeta(progress);
  if (bar) bar.style.width = `${progressPercent(progress)}%`;
}

function renderSendProgress() {
  const panel = $("#sendProgress");
  const progress = state.outgoingProgress;
  panel.hidden = !progress;
  if (progress) paintProgress(panel, progress);
}

function progressMarkup(progress) {
  return `<div class="transfer-progress compact" data-progress-room="${progress.room}"><div class="progress-copy"><b data-progress-title>${escapeHtml(progressTitle(progress))}</b><span data-progress-meta>${escapeHtml(progressMeta(progress))}</span></div><div class="progress-track"><i data-progress-bar style="width:${progressPercent(progress)}%"></i></div></div>`;
}

function renderIncomingProgress(progress) {
  const panel = document.querySelector(`[data-progress-room="${progress.room}"]`);
  if (panel) paintProgress(panel, progress);
  else renderIncoming();
}

function recordProgress(progress, bytes, render, force = false) {
  progress.bytes = Math.min(progress.totalBytes, progress.bytes + bytes);
  const now = performance.now();
  if (now - progress.sampleAt >= 400) {
    progress.speed = (progress.bytes - progress.sampleBytes) * 1000 / (now - progress.sampleAt);
    progress.sampleAt = now;
    progress.sampleBytes = progress.bytes;
  }
  if (force || now - progress.lastPaint >= PROGRESS_PAINT_INTERVAL) {
    progress.lastPaint = now;
    render(progress);
  }
}

function beginOutgoingProgress(room, files) {
  const progress = newTransferProgress(room, files, "send");
  state.outgoingProgress = progress;
  renderSendProgress();
  return progress;
}

function advanceOutgoingProgress(room, bytes, force = false) {
  const progress = state.outgoingProgress;
  if (progress?.room === room) recordProgress(progress, bytes, renderSendProgress, force);
}

function finishOutgoingProgress(room) {
  const progress = state.outgoingProgress;
  if (progress?.room !== room) return;
  progress.bytes = progress.totalBytes;
  progress.completedFiles = progress.totalFiles;
  progress.finished = true;
  recordProgress(progress, 0, renderSendProgress, true);
  setTimeout(() => {
    if (state.outgoingProgress === progress) {
      state.outgoingProgress = null;
      renderSendProgress();
    }
  }, 3500);
}

function stopOutgoingProgress(room) {
  if (state.outgoingProgress?.room === room) {
    state.outgoingProgress = null;
    renderSendProgress();
  }
}

function advanceIncomingProgress(room, bytes, force = false) {
  const progress = state.incomingProgress.get(room);
  if (progress) recordProgress(progress, bytes, renderIncomingProgress, force);
}

function finishIncomingProgress(room) {
  const progress = state.incomingProgress.get(room);
  if (!progress) return;
  progress.bytes = progress.totalBytes;
  progress.completedFiles = progress.totalFiles;
  progress.finished = true;
  recordProgress(progress, 0, renderIncomingProgress, true);
  setTimeout(() => {
    if (state.incomingProgress.get(room) === progress) {
      state.incomingProgress.delete(room);
      renderIncoming();
    }
  }, 3500);
}

function transferItems() {
  const items = state.files.map((file, index) => ({ file, source: "files", index }));
  state.clipboardImages.forEach((file, index) => items.push({ file, source: "clipboardImages", index }));
  if (state.clipboardText.trim()) items.push({ file: new File([state.clipboardText], "剪贴板文本.txt", { type: "text/plain;charset=utf-8" }), source: "clipboardText", index: 0 });
  return items;
}

function localPreview(file, allowImagePreview = false) {
  if (canPreviewImage(file) && allowImagePreview) return `<img class="file-preview" src="${URL.createObjectURL(file)}" alt="${escapeHtml(file.name)}">`;
  if (isVideo(file)) return '<span class="file-badge">VID</span>';
  if (file.type.startsWith("text/")) return '<span class="file-badge">TXT</span>';
  return '<span class="file-badge">DOC</span>';
}

function renderFiles() {
  const items = transferItems();
  const batchActive = Boolean(state.hosted || state.pendingHost);
  selected.hidden = items.length === 0;
  const showImagePreviews = items.length <= META_PREVIEW_LIMIT;
  const visibleItems = items.slice(0, RENDERED_FILE_LIMIT);
  selected.innerHTML = visibleItems.map((item, position) => `<div class="file-row">${localPreview(item.file, showImagePreviews)}<span class="file-info"><b>${escapeHtml(item.file.name)}</b><small>${size(item.file.size)}</small></span><button class="remove" data-position="${position}" aria-label="移除" ${state.hosted || state.pendingHost ? "disabled" : ""}>×</button></div>`).join("") + (items.length > visibleItems.length ? `<div class="file-more">还有 ${items.length - visibleItems.length} 个文件已加入本批，不生成预览以保证流畅。</div>` : "");
  selected.querySelectorAll("img.file-preview").forEach(image => image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true }));
  $("#sendButton").disabled = !items.length || batchActive || socket?.readyState !== WebSocket.OPEN;
  $("#cancelBatch").hidden = !batchActive;
  selected.querySelectorAll(".remove").forEach(button => button.onclick = () => {
    const item = items[Number(button.dataset.position)];
    if (item.source === "clipboardText") { state.clipboardText = ""; $("#clipboardText").value = ""; }
    else state[item.source].splice(item.index, 1);
    renderFiles();
  });
}

function addFiles(files) {
  if (queueIsLocked()) return;
  const valid = [...files].filter(file => file.size > 0 && file.size <= 4 * 1024 * 1024 * 1024);
  const available = Math.max(0, MAX_BATCH_FILES - state.files.length - state.clipboardImages.length - (state.clipboardText.trim() ? 1 : 0));
  const allowed = valid.slice(0, available);
  if (valid.length !== files.length) toast("已忽略空文件或超过 4 GB 的文件");
  if (allowed.length !== valid.length) toast(`为保证设备流畅，每批最多 ${MAX_BATCH_FILES} 个文件；其余内容请下一批发送`);
  state.files.push(...allowed);
  renderFiles();
}

function queueIsLocked() {
  if (!state.hosted && !state.pendingHost) return false;
  toast("当前批次正在分享；本批完成后请重新选择文件并点击“开始发送”");
  return true;
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-card").forEach(card => card.classList.toggle("active", card.dataset.mode === mode));
  const [title, hint] = modes[mode];
  $("#dropTitle").textContent = title;
  $("#dropHint").textContent = hint;
  picker.accept = mode === "photos" ? "image/*,video/*" : "*/*";
  const clipboard = mode === "clipboard";
  const social = mode === "social";
  $("#dropzone").hidden = clipboard || social;
  clipboardPanel.hidden = !clipboard;
  socialPanel.hidden = !social;
  $("#privacy").textContent = clipboard ? "剪贴板内容将端到端直传" : "文件不会保存到星桥服务器";
}

async function readClipboard() {
  if (queueIsLocked()) return;
  try {
    if (!navigator.clipboard?.read) throw new Error("当前浏览器只支持直接粘贴");
    const entries = await navigator.clipboard.read();
    let added = 0;
    for (const entry of entries) {
      if (entry.types.includes("text/plain")) {
        state.clipboardText = await (await entry.getType("text/plain")).text();
        $("#clipboardText").value = state.clipboardText;
        added++;
      }
      const imageType = entry.types.find(type => type.startsWith("image/"));
      if (imageType) {
        const blob = await entry.getType(imageType);
        state.clipboardImages.push(new File([blob], `剪贴板图片-${Date.now()}.${imageType.split("/")[1] || "png"}`, { type: imageType }));
        added++;
      }
    }
    if (!added) throw new Error("剪贴板中没有可发送的文字或图片");
    toast("已读取剪贴板内容");
    renderFiles();
  } catch (error) { toast(error.message || "无法读取剪贴板，请直接在文本框中粘贴"); }
}

function pasteClipboardData(clipboardData, appendText = false) {
  if (queueIsLocked()) return 0;
  let added = 0;
  const text = clipboardData.getData("text/plain");
  if (text) {
    state.clipboardText = appendText ? state.clipboardText + text : text;
    $("#clipboardText").value = state.clipboardText;
    added++;
  }
  for (const item of clipboardData.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (file.type.startsWith("image/")) state.clipboardImages.push(new File([file], `剪贴板图片-${Date.now()}.${file.type.split("/")[1] || "png"}`, { type: file.type }));
    else state.files.push(file);
    added++;
  }
  return added;
}

async function imageThumbnail(file) {
  return new Promise(resolve => {
    const image = new Image(); const source = URL.createObjectURL(file);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.src = "";
      URL.revokeObjectURL(source);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 2500);
    image.onload = () => {
      try {
        const scale = Math.min(1, 280 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", 0.72));
      } catch (_) { finish(null); }
    };
    image.onerror = () => finish(null);
    image.src = source;
  });
}

async function fileMeta(file, includePreview) {
  const meta = { name: file.name, size: file.size, mime: file.type || "application/octet-stream" };
  // Video frame extraction is expensive and unreliable in Android WebView for large
  // local files. Videos intentionally use the lightweight VID badge instead.
  if (!includePreview) return meta;
  if (canPreviewImage(file)) {
    const data = await imageThumbnail(file);
    if (data) meta.preview = { type: "image", data };
  } else if (file.type.startsWith("text/") && file.size <= 1024 * 1024) {
    try { meta.preview = { type: "text", data: (await file.slice(0, 600).text()).trim() }; } catch (_) {}
  }
  return meta;
}

async function prepareFileMeta(files, pending) {
  const metadata = [];
  for (let index = 0; index < files.length; index++) {
    if (state.pendingHost !== pending) return null;
    $("#sendButton").innerHTML = `准备传输信息 ${index + 1}/${files.length}…`;
    metadata.push(await fileMeta(files[index], index < META_PREVIEW_LIMIT));
  }
  return metadata;
}

function preview(meta, localFile) {
  if (localFile && isImage(localFile)) return `<div class="transfer-preview"><img class="file-preview" src="${localFile.url || URL.createObjectURL(localFile)}" alt="${escapeHtml(localFile.name)}"></div>`;
  if (localFile && isVideo(localFile)) return `<div class="transfer-preview"><video class="file-preview" src="${localFile.url || URL.createObjectURL(localFile)}" controls preload="metadata"></video></div>`;
  if (meta.preview?.type === "image") return `<div class="transfer-preview"><img class="file-preview" src="${meta.preview.data}" alt="${escapeHtml(meta.name)}"></div>`;
  if (meta.preview?.type === "text" && meta.preview.data) return `<div class="transfer-preview"><div class="text-preview">${escapeHtml(meta.preview.data)}</div></div>`;
  return "";
}

function rowPreview(meta) {
  if (meta.preview?.type === "image") return `<img class="file-preview" src="${meta.preview.data}" alt="${escapeHtml(meta.name)}">`;
  if (meta.preview?.type === "text") return '<span class="file-badge">TXT</span>';
  if (meta.mime?.startsWith("video/")) return '<span class="file-badge">VID</span>';
  return '<span class="file-badge">DOC</span>';
}

function waitingCard(room) {
  return `<article class="transfer" data-transfer="${room.room}"><div class="transfer-top"><span class="avatar">✦</span><div><b>${escapeHtml(room.sender)} 正在分享</b><small>${room.files.length} 个文件 · 点对点直连</small></div><button class="primary accept" data-room="${room.room}">接收</button></div><div class="select-row"><label><input class="select-all" type="checkbox" checked> 全部接收</label><span>可勾选需要的文件</span></div><div class="transfer-files">${room.files.map((file, index) => `<label class="receive-file"><input class="receive-check" type="checkbox" data-index="${index}" checked><div class="download">${rowPreview(file)}<strong>${escapeHtml(file.name)}</strong><span>${size(file.size)}</span></div></label>`).join("")}</div><div class="transfer-actions"><button class="decline" data-decline="${room.room}">不接收</button></div></article>`;
}

function receivingCard(progress) {
  return `<article class="transfer" data-transfer="${progress.room}"><div class="transfer-top"><span class="avatar">↓</span><div><b>${escapeHtml(progress.sender || "对方设备")} 正在传输</b><small>${progress.totalFiles} 个文件 · 正在写入设备</small></div></div><div class="transfer-files">${progress.files.map(file => `<div class="download">${rowPreview(file)}<strong>${escapeHtml(file.name)}</strong><span>${size(file.size)}</span></div>`).join("")}</div>${progressMarkup(progress)}</article>`;
}

function renderIncoming() {
  const ownPendingRoom = state.pendingHost?.room;
  const activeRooms = new Set(state.incomingProgress.keys());
  const receiving = [...state.incomingProgress.values()].map(receivingCard).join("");
  const waiting = state.rooms.filter(room => room.room !== state.hosted && room.room !== ownPendingRoom && !activeRooms.has(room.room) && !state.dismissedRooms.has(room.room)).map(waitingCard).join("");
  const completed = state.received.map(file => `<article class="transfer"><div class="transfer-top"><span class="avatar">✓</span><div><b>已接收</b><small>${file.saved ? `已直接保存至“${escapeHtml(file.folder)}”` : "已下载到浏览器默认位置"}</small></div></div>${file.saved ? `<div class="transfer-files"><div class="download"><strong>${escapeHtml(file.name)}</strong><span>已保存 ✓</span></div></div>` : `${preview(file, file)}<div class="transfer-files"><a class="download" draggable="true" data-mime="${escapeHtml(file.mime)}" href="${file.url}" download="${escapeHtml(file.name)}"><strong>${escapeHtml(file.name)}</strong><span>${size(file.size)} ↓</span></a></div>`}</article>`).join("");
  $("#incomingList").innerHTML = waiting || receiving || completed ? receiving + waiting + completed : '<div class="empty">暂时没有等待接收的内容</div>';
  document.querySelectorAll(".select-all").forEach(toggle => toggle.onchange = () => toggle.closest(".transfer").querySelectorAll(".receive-check").forEach(box => { box.checked = toggle.checked; }));
  document.querySelectorAll(".receive-check").forEach(box => box.onchange = () => { const card = box.closest(".transfer"); const all = [...card.querySelectorAll(".receive-check")]; card.querySelector(".select-all").checked = all.every(item => item.checked); });
  document.querySelectorAll(".accept").forEach(button => button.onclick = () => acceptFiles(button));
  document.querySelectorAll("[data-decline]").forEach(button => button.onclick = () => { state.dismissedRooms.add(button.dataset.decline); receiveFolders.delete(button.dataset.decline); renderIncoming(); toast("已清理此传输，未选择的文件不会下载"); });
  document.querySelectorAll(".download").forEach(link => link.addEventListener("dragstart", event => event.dataTransfer.setData("DownloadURL", `${link.dataset.mime}:${link.download}:${link.href}`)));
}

async function acceptFiles(button) {
  const card = button.closest(".transfer");
  const selectedIndexes = [...card.querySelectorAll(".receive-check:checked")].map(box => Number(box.dataset.index));
  if (!selectedIndexes.length) { toast("请先选择至少一个文件"); return; }
  let folder = null;
  // Some Android WebViews expose showDirectoryPicker but cannot complete it.
  // Prefer the native MediaStore bridge before probing browser-only directory APIs.
  if (androidAutoSaveAvailable()) {
    toast("安卓会按文件类型自动保存到星桥目录");
  } else if (window.showDirectoryPicker) {
    try {
      // Start at Desktop instead of the browser's last-used location. Browsers
      // intentionally deny sensitive system folders, while Desktop is a normal
      // user-writable location once the user confirms the permission prompt.
      folder = await window.showDirectoryPicker({ id: "xingqiao-receive", mode: "readwrite", startIn: "desktop" });
      const permission = await folder.queryPermission({ mode: "readwrite" });
      if (permission !== "granted" && await folder.requestPermission({ mode: "readwrite" }) !== "granted") throw new DOMException("保存权限未授权", "NotAllowedError");
    } catch (error) {
      const denied = error?.name === "AbortError" || error?.name === "NotAllowedError";
      toast(denied ? "系统目录不能保存；请在打开的窗口中选择“桌面”或普通文件夹并允许写入" : "未选择保存位置，尚未开始接收");
      return;
    }
  } else toast("此浏览器不支持选择目录，将保存到浏览器默认下载位置");
  const source = state.rooms.find(room => room.room === button.dataset.room);
  const files = selectedIndexes.map(index => source?.files?.[index]).filter(Boolean);
  if (!folder && !androidAutoSaveAvailable() && files.some(file => file.size > BROWSER_FALLBACK_MAX_BYTES)) {
    toast("此浏览器不能安全保存超过 128 MB 的文件；请用 Chrome 或 Edge 并选择保存文件夹");
    return;
  }
  receiveFolders.set(button.dataset.room, folder);
  state.incomingProgress.set(button.dataset.room, newTransferProgress(button.dataset.room, files, "receive", source?.sender || "对方设备"));
  renderIncoming();
  send({ type: "join", room: button.dataset.room, selected: selectedIndexes });
  toast("正在建立设备直连…");
}

async function host() {
  const items = transferItems();
  if (!items.length || state.hosted || state.pendingHost) return;
  state.activeFiles = items.map(item => item.file);
  const room = newRoomCode();
  const pending = { room, meta: null };
  state.pendingHost = pending;
  $("#sendButton").innerHTML = "准备传输信息…";
  renderFiles();
  try {
    const files = await prepareFileMeta(state.activeFiles, pending);
    if (!files || state.pendingHost !== pending) return;
    state.hostMeta = { sender: state.device, mode: state.mode, files };
    pending.meta = state.hostMeta;
    publishPendingHost();
  } catch (_) {
    if (state.pendingHost !== pending) return;
    state.activeFiles = [];
    state.hostMeta = null;
    state.pendingHost = null;
    renderFiles();
    toast("无法准备文件预览，请重新选择后发送");
  }
}

function publishPendingHost() {
  const pending = state.pendingHost;
  if (!pending) return;
  if (!pending.meta) return;
  clearTimeout(hostPublishRetry);
  if (!send({ type: "host", room: pending.room, meta: pending.meta })) {
    $("#sendButton").innerHTML = "等待连接… <i>●</i>";
    $("#privacy").textContent = "连接恢复后会自动开始分享";
    return;
  }
  $("#sendButton").innerHTML = "正在发布… <i>●</i>";
  $("#privacy").textContent = "正在通知可接收的设备…";
  hostPublishRetry = setTimeout(() => {
    if (state.pendingHost === pending) publishPendingHost();
  }, 3000);
}

function buildPeer(remote, room, selectedIndexes = null) {
  const connection = new RTCPeerConnection({ iceServers });
  peers.set(remote, connection);
  connection.onicecandidate = event => { if (event.candidate) send({ type: "signal", target: remote, room, payload: { kind: "candidate", candidate: event.candidate } }); };
  connection.ondatachannel = event => setupChannel(event.channel, remote, room, selectedIndexes);
  connection.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(connection.connectionState)) peers.delete(remote); };
  return connection;
}

function setupChannel(channel, remote, room, selectedIndexes = null) {
  channel.binaryType = "arraybuffer";
  channel.currentFile = null;
  channel.isSender = Array.isArray(selectedIndexes);
  channel.selectedIndexes = selectedIndexes || [];
  channel.outgoingFiles = [];
  channel.room = room;
  channel.folder = receiveFolders.get(room) || null;
  channel.inFlightBytes = 0;
  channel.receivedSinceAck = 0;
  channel.ackWaiters = [];
  channels.add(channel);
  channel.onopen = () => {
    if (!channel.isSender || state.hosted !== room) return;
    channel.outgoingFiles = state.activeFiles.filter((_, index) => channel.selectedIndexes.includes(index));
    beginOutgoingProgress(room, channel.outgoingFiles);
    $("#sendButton").innerHTML = "正在传输… <i>●</i>";
    sendFiles(channel).catch(() => toast("传输中断，请保持两个设备都打开星桥后重试"));
  };
  channel.writeQueue = Promise.resolve();
  channel.onmessage = event => {
    if (typeof event.data === "string") {
      const control = readBridgeJson(event.data);
      if (control?.type === "ack") {
        releaseRemoteCredit(channel, Number(control.bytes) || 0);
        return;
      }
    }
    channel.writeQueue = channel.writeQueue.then(() => receive(channel, event.data)).catch(() => stopIncomingChannel(channel, "文件写入失败，已停止传输"));
  };
  channel.onclose = () => {
    channels.delete(channel);
    wakeAckWaiters(channel);
    toast("设备连接已关闭");
  };
}

async function createOffer(remote, room, selectedIndexes) {
  const connection = buildPeer(remote, room, selectedIndexes);
  const channel = connection.createDataChannel("xingqiao-files", { ordered: true });
  setupChannel(channel, remote, room, selectedIndexes);
  await connection.setLocalDescription(await connection.createOffer());
  send({ type: "signal", target: remote, room, payload: { kind: "offer", sdp: connection.localDescription } });
}

async function handleSignal(remote, room, payload) {
  if (!payload) return;
  let connection = peers.get(remote);
  if (payload.kind === "offer") {
    connection = buildPeer(remote, room);
    await connection.setRemoteDescription(payload.sdp);
    for (const candidate of pendingCandidates.get(remote) || []) await connection.addIceCandidate(candidate);
    pendingCandidates.delete(remote);
    await connection.setLocalDescription(await connection.createAnswer());
    send({ type: "signal", target: remote, room, payload: { kind: "answer", sdp: connection.localDescription } });
  } else if (payload.kind === "answer" && connection) await connection.setRemoteDescription(payload.sdp);
  else if (payload.kind === "candidate") {
    if (connection) { try { await connection.addIceCandidate(payload.candidate); } catch (_) {} }
    else pendingCandidates.set(remote, [...(pendingCandidates.get(remote) || []), payload.candidate]);
  }
}

function wakeAckWaiters(channel) {
  const waiters = channel.ackWaiters.splice(0);
  waiters.forEach(resolve => resolve());
}

function releaseRemoteCredit(channel, bytes) {
  channel.inFlightBytes = Math.max(0, channel.inFlightBytes - bytes);
  wakeAckWaiters(channel);
}

async function waitForRemoteCredit(channel) {
  if (channel.aborted) throw new Error(channel.abortReason || "接收端已停止传输");
  while (channel.inFlightBytes >= MAX_IN_FLIGHT_BYTES) {
    await new Promise(resolve => channel.ackWaiters.push(resolve));
    if (channel.readyState !== "open" || channel.aborted) throw new Error(channel.abortReason || "连接已关闭");
  }
}

async function waitForAllRemoteCredit(channel) {
  while (channel.inFlightBytes > 0) {
    await new Promise(resolve => channel.ackWaiters.push(resolve));
    if (channel.readyState !== "open" || channel.aborted) throw new Error(channel.abortReason || "连接已关闭");
  }
}

function acknowledgeReceivedChunk(channel, bytes) {
  channel.receivedSinceAck += bytes;
  if (channel.receivedSinceAck >= RECEIVE_ACK_BYTES) flushReceiveAck(channel);
}

function flushReceiveAck(channel) {
  if (!channel.receivedSinceAck || channel.readyState !== "open") return;
  channel.send(JSON.stringify({ type: "ack", bytes: channel.receivedSinceAck }));
  channel.receivedSinceAck = 0;
}

function stopIncomingChannel(channel, message) {
  channel.aborted = true;
  channel.abortReason = message;
  if (channel.currentFile?.android?.token) {
    try { window.AndroidBridge.abortReceiveFile(channel.currentFile.android.token); } catch (_) {}
  }
  if (channel.readyState === "open") channel.send(JSON.stringify({ type: "abort", reason: message }));
  try { channel.close(); } catch (_) {}
  toast(message);
}

async function sendFiles(channel) {
  const files = channel.outgoingFiles;
  for (const file of files) {
    const progress = state.outgoingProgress;
    if (progress?.room === channel.room) {
      progress.currentName = file.name;
      renderSendProgress();
    }
    channel.send(JSON.stringify({ type: "file-start", name: file.name, size: file.size, mime: file.type || "application/octet-stream" }));
    for (let offset = 0; offset < file.size; offset += TRANSFER_CHUNK_BYTES) {
      await waitForRemoteCredit(channel);
      while (channel.bufferedAmount > MAX_DATA_CHANNEL_BUFFERED_BYTES) await new Promise(resolve => setTimeout(resolve, 10));
      const chunk = await file.slice(offset, offset + TRANSFER_CHUNK_BYTES).arrayBuffer();
      channel.send(chunk);
      channel.inFlightBytes += chunk.byteLength;
      advanceOutgoingProgress(channel.room, chunk.byteLength);
    }
    channel.send(JSON.stringify({ type: "file-end" }));
    if (progress?.room === channel.room) {
      progress.completedFiles += 1;
      advanceOutgoingProgress(channel.room, 0, true);
    }
  }
  channel.send(JSON.stringify({ type: "complete" }));
  await waitForAllRemoteCredit(channel);
  finishOutgoingProgress(channel.room);
  finishOutgoingBatch(channel.room);
  toast("内容已通过点对点连接发送");
}

function finishOutgoingBatch(room) {
  if (state.hosted !== room) return;
  // Each press of “开始发送” creates one immutable batch. Do not let files
  // selected later silently appear in the sender UI without being advertised.
  send({ type: "leave", room });
  state.dismissedRooms.add(room);
  state.hosted = null;
  state.pendingHost = null;
  state.hostMeta = null;
  state.activeFiles = [];
  state.files = [];
  state.clipboardImages = [];
  state.clipboardText = "";
  $("#clipboardText").value = "";
  $("#privacy").textContent = "本批已发送完成；请选择下一批文件后再次点击“开始发送”";
  $("#sendButton").innerHTML = "开始发送 <i>→</i>";
  renderFiles();
  renderIncoming();
}

function cancelOutgoingBatch() {
  const room = state.hosted || state.pendingHost?.room;
  if (!room) return;
  send({ type: "leave", room });
  channels.forEach(channel => {
    if (channel.isSender && channel.room === room) {
      channel.aborted = true;
      channel.abortReason = "发送方已取消本批";
      wakeAckWaiters(channel);
      try { channel.close(); } catch (_) {}
    }
  });
  state.dismissedRooms.add(room);
  clearTimeout(hostPublishRetry);
  state.hosted = null;
  state.pendingHost = null;
  state.hostMeta = null;
  state.activeFiles = [];
  stopOutgoingProgress(room);
  $("#privacy").textContent = "已取消本批；可调整文件后重新点击“开始发送”";
  $("#sendButton").innerHTML = "开始发送 <i>→</i>";
  renderFiles();
  renderIncoming();
  toast("本批已取消，文件仍保留在发送区");
}

async function nextAvailableName(folder, name) {
  const dot = name.lastIndexOf("."); const base = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : "";
  for (let attempt = 1; attempt < 1000; attempt++) {
    const candidate = attempt === 1 ? name : `${base} (${attempt})${ext}`;
    try { await folder.getFileHandle(candidate); } catch (_) { return candidate; }
  }
  return `${base}-${Date.now()}${ext}`;
}

function downloadFallback(blob, name) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function androidAutoSaveAvailable() { return Boolean(window.AndroidBridge?.beginReceiveFile && window.AndroidBridge?.writeReceiveChunk && window.AndroidBridge?.finishReceiveFile); }
function readBridgeJson(raw) { try { return JSON.parse(raw); } catch (_) { return null; } }
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer); let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
function startAndroidSave(name, mime) {
  if (!androidAutoSaveAvailable()) return null;
  const result = readBridgeJson(window.AndroidBridge.beginReceiveFile(name, mime));
  return result?.ok ? result : null;
}
function finishAndroidSave(token) {
  return readBridgeJson(window.AndroidBridge.finishReceiveFile(token));
}

async function receive(channel, data) {
  if (typeof data === "string") {
    let message; try { message = JSON.parse(data); } catch (_) { return; }
    if (message.type === "abort") {
      channel.aborted = true;
      channel.abortReason = message.reason || "接收端已停止传输";
      wakeAckWaiters(channel);
      return;
    }
    if (message.type === "file-start") {
      channel.currentFile = { name: message.name, size: message.size, mime: message.mime, chunks: [] };
      const progress = state.incomingProgress.get(channel.room);
      if (progress) {
        progress.currentName = message.name;
        renderIncomingProgress(progress);
      }
      if (channel.folder) {
        try {
          const name = await nextAvailableName(channel.folder, message.name);
          const handle = await channel.folder.getFileHandle(name, { create: true });
          channel.currentFile.writer = await handle.createWritable();
          channel.currentFile.savedName = name;
        } catch (_) {
          stopIncomingChannel(channel, "无法写入所选文件夹，已停止传输");
          return;
        }
      } else {
        channel.currentFile.android = startAndroidSave(message.name, message.mime);
        if (androidAutoSaveAvailable() && !channel.currentFile.android) {
          stopIncomingChannel(channel, "安卓无法创建保存文件，已停止传输");
          return;
        }
      }
    }
    if (message.type === "file-end" && channel.currentFile) {
      const file = channel.currentFile;
      if (file.writer) {
        await file.writer.close();
        state.received.push({ ...file, saved: true, folder: channel.folder.name, type: file.mime });
        toast(`已保存 ${file.savedName} 到 ${channel.folder.name}`);
      } else if (file.android) {
        if (!file.androidFailed) {
          const result = finishAndroidSave(file.android.token);
          if (result?.ok) {
            state.received.push({ ...file, saved: true, folder: result.folder, type: file.mime });
            toast(`已自动保存 ${file.name} 到 ${result.folder}`);
          } else toast(`${file.name} 保存失败，请重新接收`);
        }
      } else {
        const blob = new Blob(file.chunks, { type: file.mime });
        const url = URL.createObjectURL(blob);
        downloadFallback(blob, file.name);
        state.received.push({ ...file, url, saved: false, type: file.mime });
        toast(`已下载 ${file.name}`);
      }
      channel.currentFile = null;
      const progress = state.incomingProgress.get(channel.room);
      if (progress) {
        progress.completedFiles += 1;
        advanceIncomingProgress(channel.room, 0, true);
      }
      flushReceiveAck(channel);
      renderIncoming();
    }
    if (message.type === "complete") {
      flushReceiveAck(channel);
      finishIncomingProgress(channel.room);
    }
    return;
  }
  const bytes = data.byteLength || 0;
  if (channel.currentFile?.writer) await channel.currentFile.writer.write(data);
  else if (channel.currentFile?.android && !channel.currentFile.androidFailed) {
    if (!window.AndroidBridge.writeReceiveChunk(channel.currentFile.android.token, bufferToBase64(data))) {
      channel.currentFile.androidFailed = true;
      stopIncomingChannel(channel, "安卓保存通道中断，已停止传输");
      return;
    }
  } else if (channel.currentFile && !channel.currentFile.android) channel.currentFile.chunks.push(data);
  else return;
  acknowledgeReceivedChunk(channel, bytes);
  advanceIncomingProgress(channel.room, bytes);
}

async function connect() {
  try { iceServers = (await fetch("/api/config", { cache: "no-store" }).then(response => response.json())).iceServers || []; } catch (_) {}
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const activeSocket = new WebSocket(`${protocol}://${location.host}/signal`);
  socket = activeSocket;
  activeSocket.onopen = () => {
    if (socket !== activeSocket) return;
    $("#privacy").textContent = "已连接：文件将点对点传输";
    renderFiles();
    send({ type: "list" });
    publishPendingHost();
  };
  activeSocket.onmessage = async event => {
    if (socket !== activeSocket) return;
    const message = JSON.parse(event.data);
    if (message.type === "rooms") { state.rooms = message.rooms; renderIncoming(); }
    if (message.type === "hosted" && state.pendingHost?.room === message.room) {
      clearTimeout(hostPublishRetry);
      state.hosted = message.room;
      state.pendingHost = null;
      $("#sendButton").innerHTML = "正在分享 <i>●</i>";
      $("#privacy").textContent = "正在等待其他设备接收；关闭页面会结束分享";
      renderFiles();
      renderIncoming();
    }
    if (message.type === "peer-joined" && state.hosted === message.room) {
      $("#sendButton").innerHTML = "正在传输… <i>●</i>";
      createOffer(message.peer, message.room, message.selected).catch(() => toast("无法建立设备直连，请确认双方仍在线后重试"));
    }
    if (message.type === "signal") await handleSignal(message.from, message.room, message.payload);
  };
  activeSocket.onclose = () => {
    if (socket !== activeSocket) return;
    clearTimeout(hostPublishRetry);
    if (state.hosted && state.hostMeta) state.pendingHost = { room: state.hosted, meta: state.hostMeta };
    state.hosted = null;
    if (state.pendingHost) $("#sendButton").innerHTML = "连接恢复后继续分享… <i>●</i>";
    $("#privacy").textContent = "连接已断开，正在重试…";
    renderFiles();
    setTimeout(connect, 2000);
  };
}

$("#deviceName").textContent = state.device;
$("#nameInput").value = state.device;
$("#deviceButton").onclick = () => $("#nameDialog").showModal();
$("#saveName").onclick = () => { state.device = $("#nameInput").value.trim() || "我的设备"; localStorage.setItem("xingqiao-device", state.device); $("#deviceName").textContent = state.device; };
document.querySelectorAll(".mode-card").forEach(card => card.onclick = () => setMode(card.dataset.mode));
$("#dropzone").onclick = () => { if (state.mode === "social" && !confirm("请从微信、QQ 等应用将内容分享到星桥，或点“确定”从文件中导入。")) return; picker.click(); };
picker.onchange = () => { addFiles(picker.files); picker.value = ""; };
$("#dropzone").ondragover = event => { event.preventDefault(); $("#dropzone").classList.add("drag"); };
$("#dropzone").ondragleave = () => $("#dropzone").classList.remove("drag");
$("#dropzone").ondrop = event => { event.preventDefault(); $("#dropzone").classList.remove("drag"); addFiles(event.dataTransfer.files); };
$("#pasteClipboard").onclick = readClipboard;
function openSocialApp(packageName, label) {
  if (!window.AndroidBridge?.openSocialApp) { toast(`请在${label}聊天中选择文件后，使用“分享”发送到星桥`); return; }
  window.AndroidBridge.openSocialApp(packageName);
  toast(`已打开${label}；选择内容后用“分享” → “星桥”，若没有分享项请先保存到手机`);
}
$("#openWeChat").onclick = () => openSocialApp("com.tencent.mm", "微信");
$("#openQQ").onclick = () => openSocialApp("com.tencent.mobileqq", "QQ");
function base64ToBytes(value) {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function updateButton() { return $("#checkUpdate"); }
function showAndroidUpdate(raw) {
  const message = readBridgeJson(raw) || raw || {};
  const button = updateButton();
  if (!button) return;
  button.hidden = false;
  const status = message.status;
  if (status === "checking") {
    button.disabled = true;
    button.textContent = "检查更新中…";
  } else if (status === "downloading") {
    button.disabled = true;
    button.textContent = `下载 v${message.version || ""}…`;
    toast("正在下载新版本，下载完成后会打开系统安装确认");
  } else if (status === "ready") {
    button.disabled = false;
    button.textContent = "重新检查";
    toast("安装包已准备好，请在系统安装确认中完成更新");
  } else if (status === "latest") {
    button.disabled = false;
    button.textContent = "已是最新";
    toast("当前已是最新版本");
  } else {
    button.disabled = false;
    button.textContent = "检查更新";
    if (message.message) toast(message.message);
  }
}

window.XingqiaoNative = { onUpdateStatus: showAndroidUpdate };

function setupAndroidUpdate() {
  const button = updateButton();
  if (!button || !window.AndroidBridge?.checkForUpdate) return;
  button.hidden = false;
  button.onclick = () => window.AndroidBridge.checkForUpdate();
}

async function importAndroidSharedFiles() {
  if (!window.AndroidBridge?.hasPendingSocial?.() || !window.AndroidBridge?.pendingSocialManifest || !window.AndroidBridge?.readPendingSocialChunk) return;
  if (queueIsLocked()) return;
  const manifest = readBridgeJson(window.AndroidBridge.pendingSocialManifest());
  if (!manifest?.files?.length) return;
  try {
    setMode("social");
    const limit = Math.max(0, MAX_BATCH_FILES - state.files.length - state.clipboardImages.length - (state.clipboardText.trim() ? 1 : 0));
    const imports = manifest.files.slice(0, limit);
    for (let index = 0; index < imports.length; index++) {
      const item = imports[index]; const chunks = [];
      for (let offset = 0; offset < item.size; offset += 96 * 1024) {
        const chunk = window.AndroidBridge.readPendingSocialChunk(index, offset, Math.min(96 * 1024, item.size - offset));
        if (!chunk) throw new Error(`无法读取 ${item.name}`);
        chunks.push(base64ToBytes(chunk));
      }
      state.files.push(new File(chunks, item.name, { type: item.mime }));
    }
    window.AndroidBridge.clearPendingSocial();
    renderFiles();
    toast(manifest.files.length > imports.length ? `已导入前 ${imports.length} 个文件；其余内容请下一批分享` : "已从社交应用导入，可开始发送");
  } catch (error) { toast(error.message || "社交文件导入失败"); }
}
$("#clipboardText").oninput = event => {
  if (queueIsLocked()) { event.target.value = state.clipboardText; return; }
  state.clipboardText = event.target.value;
  renderFiles();
};
$("#clipboardText").onpaste = event => {
  event.preventDefault();
  if (pasteClipboardData(event.clipboardData, true)) renderFiles();
};
document.addEventListener("paste", event => {
  if (state.mode !== "clipboard" || event.target === $("#clipboardText")) return;
  if (pasteClipboardData(event.clipboardData, false)) { event.preventDefault(); renderFiles(); toast("已粘贴剪贴板内容"); }
});
$("#sendButton").onclick = host;
$("#cancelBatch").onclick = cancelOutgoingBatch;
$("#refreshButton").onclick = () => send({ type: "list" });
window.addEventListener("pagehide", () => {
  clearTimeout(hostPublishRetry);
  const room = state.hosted || state.pendingHost?.room;
  if (room) send({ type: "leave", room });
  peers.forEach(peer => peer.close());
});
setMode("photos"); renderFiles(); importAndroidSharedFiles(); connect();
setupAndroidUpdate();
