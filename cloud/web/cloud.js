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
// Android's modern WebView bridge replies after each ArrayBuffer has reached
// MediaStore. Keeping this queue explicit prevents unbounded renderer-to-app
// copies while the disk writer is busy.
const binaryWriteWaiters = [];
const nativeTransferKeys = new Set();
let hostPublishRetry;
const RENDERED_FILE_LIMIT = 60;
const META_PREVIEW_LIMIT = 12;
const IMAGE_PREVIEW_SIZE_LIMIT = 8 * 1024 * 1024;
const MAX_BATCH_FILES = 40;
const PROGRESS_PAINT_INTERVAL = 160;
const SPEED_SMOOTHING = 0.28;
// Keep Android's queued WebView/MediaStore work bounded, but leave enough data
// in flight to fill a normal Wi-Fi link even when WebRTC has a higher RTT.
// Read Android content URIs in larger blocks. Android WebView pays a noticeable
// scheduling cost for every File.slice().arrayBuffer() call, so small network
// frames are carved out of a larger read instead of reopening the picker URI
// thousands of times for a long video.
const ANDROID_FILE_READ_BLOCK_BYTES = 1024 * 1024;
const BROWSER_FILE_READ_BLOCK_BYTES = 8 * 1024 * 1024;
// Keep Android's receive side deliberately conservative: every packet is
// eventually copied from WebRTC into WebView and MediaStore. A desktop browser
// receiving to an explicitly selected folder can safely use a deeper sender
// queue. Keep individual SCTP messages near 64 KiB to avoid costly large-message
// fragmentation; disk writes are coalesced separately below.
const ANDROID_DATA_CHANNEL_CHUNK_BYTES = 60 * 1024;
const BROWSER_DATA_CHANNEL_CHUNK_BYTES = 64 * 1024;
const MAX_DATA_CHANNEL_CHUNK_BYTES = 64 * 1024;
const ANDROID_RECEIVE_ACK_BYTES = 256 * 1024;
const BROWSER_RECEIVE_ACK_BYTES = 4 * 1024 * 1024;
const ANDROID_BINARY_WRITE_BATCH_BYTES = 256 * 1024;
const BROWSER_WRITABLE_BATCH_BYTES = 4 * 1024 * 1024;
const ANDROID_RECEIVER_MAX_IN_FLIGHT_BYTES = 1024 * 1024;
const BROWSER_RECEIVER_MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const ANDROID_RECEIVER_BUFFER_HIGH_BYTES = 768 * 1024;
// Chromium's per-channel send queue is commonly capped near 16 MiB. Leave
// generous headroom so a single send() can never trip that hard limit.
const BROWSER_RECEIVER_BUFFER_HIGH_BYTES = 6 * 1024 * 1024;
const BROWSER_FALLBACK_MAX_BYTES = 128 * 1024 * 1024;
const DIRECT_DRAG_CACHE = "xingqiao-direct-drag-v1";
const DIRECT_DRAG_PATH = "/_xingqiao_drag/";
const DIRECT_DRAG_LIFETIME_MS = 15 * 60 * 1000;
const directDragUrls = new Set();
let directDragWorker;

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
function canPreviewImage(file) { return !window.AndroidBridge && !window.XingqiaoDesktop && isImage(file) && file.size <= IMAGE_PREVIEW_SIZE_LIMIT; }

function addReceivedDragData(event, link, received) {
  const transfer = event.dataTransfer;
  if (!transfer || !received?.resource) return;
  transfer.effectAllowed = "copy";
  // Browser upload areas consume the File itself. Do not also offer blob: as a
  // URL: many chat editors prefer text/uri-list and would paste that unusable
  // renderer-local URL into the composer instead of accepting the file.
  try { transfer.items?.add(received.resource); } catch (_) {}
  const dragURL = link.dataset.dragUrl || "";
  const name = received.name.replaceAll(":", "_");
  if (/^https?:/i.test(dragURL)) {
    // DownloadURL is a Chromium-to-Finder/Explorer enhancement. It is only
    // safe for an actual HTTP(S) address supplied by the drag worker.
    try { transfer.setData("DownloadURL", `${received.mime}:${name}:${dragURL}`); } catch (_) {}
  }
}

function desktopShellExpected() {
  return new URLSearchParams(location.search).has("xingqiao_desktop");
}

function desktopBridgeUnavailable() {
  return desktopShellExpected() && !desktopInboxAvailable();
}

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
  if (now - progress.sampleAt >= 300) {
    const instantaneous = (progress.bytes - progress.sampleBytes) * 1000 / (now - progress.sampleAt);
    progress.speed = progress.speed > 0
      ? progress.speed * (1 - SPEED_SMOOTHING) + instantaneous * SPEED_SMOOTHING
      : instantaneous;
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

function preview(meta, localFile, receivedId = "", dragUrl = "") {
  if (localFile && isImage(localFile)) {
    const source = localFile.url || URL.createObjectURL(localFile);
    const image = `<img class="file-preview" src="${source}" alt="${escapeHtml(localFile.name)}">`;
    if (receivedId) return `<a class="transfer-preview received-preview-link" draggable="true" data-received-id="${receivedId}" data-drag-url="${dragUrl || source}" data-mime="${escapeHtml(localFile.mime || localFile.type || "image/*")}" href="${source}" download="${escapeHtml(localFile.name)}" title="拖动这张预览图即可交给聊天窗口、网页上传区或桌面">${image}<span>拖动预览图，直接使用</span></a>`;
    return `<div class="transfer-preview">${image}</div>`;
  }
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
  return `<article class="transfer" data-transfer="${room.room}"><div class="transfer-top"><span class="avatar">✦</span><div><b>${escapeHtml(room.sender)} 正在分享</b><small>${room.files.length} 个文件 · 同网优先局域网直连</small></div><button class="primary accept" data-room="${room.room}">接收</button></div><div class="select-row"><label><input class="select-all" type="checkbox" checked> 全部接收</label><span>可勾选需要的文件</span></div><div class="transfer-files">${room.files.map((file, index) => `<label class="receive-file"><input class="receive-check" type="checkbox" data-index="${index}" checked><div class="download">${rowPreview(file)}<strong>${escapeHtml(file.name)}</strong><span>${size(file.size)}</span></div></label>`).join("")}</div><div class="transfer-actions"><button class="decline" data-decline="${room.room}">不接收</button></div></article>`;
}

function receivingCard(progress) {
  return `<article class="transfer" data-transfer="${progress.room}"><div class="transfer-top"><span class="avatar">↓</span><div><b>${escapeHtml(progress.sender || "对方设备")} 正在传输</b><small>${progress.totalFiles} 个文件 · 正在写入设备</small></div></div><div class="transfer-files">${progress.files.map(file => `<div class="download">${rowPreview(file)}<strong>${escapeHtml(file.name)}</strong><span>${size(file.size)}</span></div>`).join("")}</div>${progressMarkup(progress)}</article>`;
}

const scheduleNativeDragTargets = (() => {
  let queued = false;
  const sync = () => {
    const bridge = window.XingqiaoDesktop;
    if (!bridge?.syncNativeDragTargets) return;
    const targets = [...document.querySelectorAll("[data-native-file-id]")].map(element => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.dataset.nativeFileId,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }).filter(target => target.id && target.width > 1 && target.height > 1);
    Promise.resolve(bridge.syncNativeDragTargets(targets)).catch(() => {});
  };
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  };
})();
window.addEventListener("resize", scheduleNativeDragTargets);
window.addEventListener("scroll", scheduleNativeDragTargets, true);

function nativeInboxControls(file) {
  const name = escapeHtml(file.name);
  const details = size(file.size);
  if (file.nativeFileId) {
    return `<div class="transfer-files native-inbox-actions"><button class="secondary native-inbox native-direct-drag" data-native-file-id="${escapeHtml(file.nativeFileId)}" title="按住并拖到聊天输入框、Codex 或其他应用"><strong>${name}</strong><span>${details} · 按住这里拖入聊天</span></button><button class="native-inbox-open" data-open-native-inbox title="打开临时收件箱后可预览、选择或保存">打开收件箱 / 预览</button></div>`;
  }
  return `<div class="transfer-files native-inbox-actions"><button class="secondary native-inbox" data-open-native-inbox title="打开临时收件箱"><strong>${name}</strong><span>${details} · 点击打开收件箱后拖出</span></button><button class="native-inbox-open" data-open-native-inbox title="打开临时收件箱后可预览、选择或保存">打开收件箱 / 预览</button></div>`;
}

function renderIncoming() {
  const ownPendingRoom = state.pendingHost?.room;
  const activeRooms = new Set(state.incomingProgress.keys());
  const receiving = [...state.incomingProgress.values()].map(receivingCard).join("");
  const waiting = state.rooms.filter(room => room.room !== state.hosted && room.room !== ownPendingRoom && !activeRooms.has(room.room) && !state.dismissedRooms.has(room.room)).map(waitingCard).join("");
  const completed = state.received.map(file => `<article class="transfer"><div class="transfer-top"><span class="avatar">✓</span><div><b>已接收</b><small>${file.resource ? (file.dragUrl ? "已准备跨窗口直接投放" : file.saved ? `已保存至“${escapeHtml(file.folder)}” · 也可直接拖出` : "已保留在当前页面 · 可直接拖到其他应用") : file.nativeInbox ? (file.nativeFileId ? "已暂存到星桥临时收件箱，可直接拖入聊天" : "已暂存到星桥临时收件箱") : `已直接保存至“${escapeHtml(file.folder)}”`}</small></div></div>${file.resource ? `${preview(file, file, file.id, file.dragUrl)}<div class="transfer-files"><a class="download received-resource" draggable="true" data-received-id="${file.id}" data-drag-url="${file.dragUrl || file.url}" data-mime="${escapeHtml(file.mime)}" href="${file.url}" download="${escapeHtml(file.name)}" title="拖到桌面、聊天窗口或其他应用；点击则另存"><strong>${escapeHtml(file.name)}</strong><span>${size(file.size)} · 拖出使用 / 点击保存</span></a></div>` : file.nativeInbox ? nativeInboxControls(file) : `<div class="transfer-files"><div class="download"><strong>${escapeHtml(file.name)}</strong><span>已保存 ✓</span></div></div>`}</article>`).join("");
  $("#incomingList").innerHTML = waiting || receiving || completed ? receiving + waiting + completed : '<div class="empty">暂时没有等待接收的内容</div>';
  document.querySelectorAll(".select-all").forEach(toggle => toggle.onchange = () => toggle.closest(".transfer").querySelectorAll(".receive-check").forEach(box => { box.checked = toggle.checked; }));
  document.querySelectorAll(".receive-check").forEach(box => box.onchange = () => { const card = box.closest(".transfer"); const all = [...card.querySelectorAll(".receive-check")]; card.querySelector(".select-all").checked = all.every(item => item.checked); });
  document.querySelectorAll(".accept").forEach(button => button.onclick = () => acceptFiles(button));
  document.querySelectorAll("[data-decline]").forEach(button => button.onclick = () => { state.dismissedRooms.add(button.dataset.decline); receiveFolders.delete(button.dataset.decline); renderIncoming(); toast("已清理此传输，未选择的文件不会下载"); });
  document.querySelectorAll("[data-received-id]").forEach(link => link.addEventListener("dragstart", event => {
    const received = state.received.find(file => file.id === link.dataset.receivedId);
    addReceivedDragData(event, link, received);
  }));
  document.querySelectorAll("[data-open-native-inbox]").forEach(button => button.onclick = () => {
    try { window.XingqiaoDesktop?.showInbox?.(); } catch (_) { toast("请在星桥桌面端打开临时收件箱"); }
  });
  scheduleNativeDragTargets();
}

async function acceptFiles(button) {
  const card = button.closest(".transfer");
  const selectedIndexes = [...card.querySelectorAll(".receive-check:checked")].map(box => Number(box.dataset.index));
  if (!selectedIndexes.length) { toast("请先选择至少一个文件"); return; }
  const source = state.rooms.find(room => room.room === button.dataset.room);
  const files = selectedIndexes.map(index => source?.files?.[index]).filter(Boolean);
  if (desktopBridgeUnavailable()) {
    toast("桌面原生收件箱未连接；已停止接收，避免错误下载。请安装最新版星桥，并部署服务器网页更新后重试");
    return;
  }
  const requiresStreamingFolder = files.some(file => file.size > BROWSER_FALLBACK_MAX_BYTES);
  let folder = null;
  // Some Android WebViews expose showDirectoryPicker but cannot complete it.
  // Prefer the native MediaStore bridge before probing browser-only directory APIs.
  if (nativeSaveAvailable()) {
    toast(window.XingqiaoDesktop ? "文件将暂存到星桥收件箱，可从悬浮窗直接拖入聊天" : "安卓会按文件类型自动保存到星桥目录");
  } else if (requiresStreamingFolder && window.showDirectoryPicker) {
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
  } else if (requiresStreamingFolder) {
    toast("此浏览器不能安全保存超过 128 MB 的文件；请用 Chrome 或 Edge 并选择保存文件夹");
    return;
  } else toast("文件将保留在当前页面；完成后可直接拖出，或点击保存");
  receiveFolders.set(button.dataset.room, folder);
  state.incomingProgress.set(button.dataset.room, newTransferProgress(button.dataset.room, files, "receive", source?.sender || "对方设备"));
  renderIncoming();
  // Start while this user action is visible. Android 12+ can reject a newly
  // created foreground service after the Activity has already gone background.
  setAndroidTransferActive(`receive:${button.dataset.room}`, true);
  send({ type: "join", room: button.dataset.room, selected: selectedIndexes, receiver: localReceiverKind() });
  toast("正在建立设备直连…");
}

async function host() {
  const items = transferItems();
  if (!items.length || state.hosted || state.pendingHost) return;
  state.activeFiles = items.map(item => item.file);
  const room = newRoomCode();
  const pending = { room, meta: null };
  state.pendingHost = pending;
  setAndroidTransferActive(`send-pending:${room}`, true);
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
    setAndroidTransferActive(`send-pending:${room}`, false);
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
  const existing = peers.get(remote);
  if (existing) {
    try { existing.close(); } catch (_) {}
  }
  // ICE assigns host candidates a higher priority than server-reflexive and
  // TURN relay candidates. Same-LAN devices therefore select the local path;
  // the public relay is only selected when the direct candidates cannot work.
  const connection = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
  peers.set(remote, connection);
  connection.onicecandidate = event => { if (event.candidate) send({ type: "signal", target: remote, room, payload: { kind: "candidate", candidate: event.candidate } }); };
  connection.ondatachannel = event => setupChannel(event.channel, remote, room, selectedIndexes);
  connection.onconnectionstatechange = () => { if (["failed", "closed"].includes(connection.connectionState) && peers.get(remote) === connection) peers.delete(remote); };
  return connection;
}

function setupChannel(channel, remote, room, selectedIndexes = null, receiverKind = "browser") {
  channel.binaryType = "arraybuffer";
  channel.currentFile = null;
  channel.isSender = Array.isArray(selectedIndexes);
  channel.selectedIndexes = selectedIndexes || [];
  channel.outgoingFiles = [];
  channel.room = room;
  channel.remote = remote;
  channel.folder = receiveFolders.get(room) || null;
  channel.inFlightBytes = 0;
  channel.receivedSinceAck = 0;
  channel.ackWaiters = [];
  // `receiverKind` is supplied by the receiver through signalling. For a
  // channel accepted from a remote sender, derive the local capability instead
  // so acknowledgement pacing always protects the actual receiving device.
  channel.remoteReceiverKind = receiverKind;
  channel.localReceiverKind = localReceiverKind();
  const sendTargetKind = channel.isSender ? channel.remoteReceiverKind : channel.localReceiverKind;
  channel.maxInFlightBytes = sendTargetKind === "android" ? ANDROID_RECEIVER_MAX_IN_FLIGHT_BYTES : BROWSER_RECEIVER_MAX_IN_FLIGHT_BYTES;
  channel.bufferHighWaterBytes = sendTargetKind === "android" ? ANDROID_RECEIVER_BUFFER_HIGH_BYTES : BROWSER_RECEIVER_BUFFER_HIGH_BYTES;
  channel.bufferLowWaterBytes = Math.floor(channel.bufferHighWaterBytes / 2);
  channel.receiveAckBytes = channel.localReceiverKind === "android" ? ANDROID_RECEIVE_ACK_BYTES : BROWSER_RECEIVE_ACK_BYTES;
  channel.bufferedAmountLowThreshold = channel.bufferLowWaterBytes;
  channels.add(channel);
  channel.onopen = () => {
    showConnectionPath(remote);
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
    setAndroidTransferActive(`receive:${channel.room}`, false);
    if (channel.currentFile?.android?.token) {
      abortAndroidSave(channel.currentFile.android.token);
      abortAndroidBinaryWrites("连接已关闭");
    }
    toast("设备连接已关闭");
  };
}

async function showConnectionPath(remote, attempt = 0) {
  const peer = peers.get(remote);
  if (!peer) return;
  try {
    const reports = new Map();
    (await peer.getStats()).forEach(report => reports.set(report.id, report));
    const pair = [...reports.values()].find(report => report.type === "candidate-pair"
      && report.state === "succeeded" && (report.selected || report.nominated));
    if (!pair) {
      if (attempt < 6) setTimeout(() => showConnectionPath(remote, attempt + 1), 500);
      return;
    }
    const local = reports.get(pair.localCandidateId);
    const remoteCandidate = reports.get(pair.remoteCandidateId);
    const localType = local?.candidateType || "未知";
    const remoteType = remoteCandidate?.candidateType || "未知";
    const pairName = `${localType} ↔ ${remoteType}`;
    if (localType === "relay" || remoteType === "relay") {
      $("#privacy").textContent = `已连接：公网中转传输（${pairName}，速度受网络影响）`;
    } else if (isPrivateLanCandidate(local) && isPrivateLanCandidate(remoteCandidate)) {
      $("#privacy").textContent = `已连接：局域网直连传输（${pairName}）`;
    } else {
      $("#privacy").textContent = `已连接：设备点对点直传（${pairName}，非中转）`;
    }
  } catch (_) {
    // Transfer itself does not depend on diagnostic statistics being available.
  }
}

function isPrivateLanCandidate(candidate) {
  const address = String(candidate?.address || candidate?.ip || "").toLowerCase();
  // Chromium may redact a directly-bound host candidate's address in getStats.
  if (!address && candidate?.candidateType === "host") return true;
  if (address.endsWith(".local")) return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(address)) return true;
  const parts = address.match(/^(172)\.(\d+)\./);
  if (parts && Number(parts[2]) >= 16 && Number(parts[2]) <= 31) return true;
  return /^(fc|fd|fe[89ab])/.test(address);
}

async function createOffer(remote, room, selectedIndexes, receiverKind = "browser") {
  const connection = buildPeer(remote, room, selectedIndexes);
  const channel = connection.createDataChannel("xingqiao-files", { ordered: true });
  setupChannel(channel, remote, room, selectedIndexes, receiverKind);
  await connection.setLocalDescription(await connection.createOffer());
  send({ type: "signal", target: remote, room, payload: { kind: "offer", sdp: connection.localDescription } });
  $("#privacy").textContent = "正在优先建立局域网直连…";
}

async function handleSignal(remote, room, payload) {
  if (!payload) return;
  let connection = peers.get(remote);
  if (payload.kind === "offer") {
    connection = buildPeer(remote, room);
    $("#privacy").textContent = "正在优先建立局域网直连…";
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
  while (channel.inFlightBytes >= channel.maxInFlightBytes) {
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

function dataChannelChunkBytes(channel) {
  const desired = channel.remoteReceiverKind === "android"
    ? ANDROID_DATA_CHANNEL_CHUNK_BYTES
    : BROWSER_DATA_CHANNEL_CHUNK_BYTES;
  const advertised = Number(peers.get(channel.remote)?.sctp?.maxMessageSize);
  if (Number.isFinite(advertised) && advertised > 0) {
    // Leave a small margin for implementations that account SCTP framing in
    // the reported size. The negotiated value is the authoritative limit.
    const safeSize = Math.floor(advertised - 1024);
    if (safeSize > 0) return Math.min(desired, MAX_DATA_CHANNEL_CHUNK_BYTES, safeSize);
  }
  return desired;
}

function waitForDataChannelDrain(channel) {
  if (channel.bufferedAmount <= channel.bufferHighWaterBytes) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeEventListener("bufferedamountlow", finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    channel.addEventListener("bufferedamountlow", finish);
    // Avoid the small race where the buffer drains between the first check and
    // listener registration.
    if (channel.bufferedAmount <= channel.bufferLowWaterBytes) finish();
  });
}

function acknowledgeReceivedChunk(channel, bytes) {
  channel.receivedSinceAck += bytes;
  if (channel.receivedSinceAck >= channel.receiveAckBytes) flushReceiveAck(channel);
}

function flushReceiveAck(channel) {
  if (!channel.receivedSinceAck || channel.readyState !== "open") return;
  channel.send(JSON.stringify({ type: "ack", bytes: channel.receivedSinceAck }));
  channel.receivedSinceAck = 0;
}

function stopIncomingChannel(channel, message) {
  channel.aborted = true;
  channel.abortReason = message;
  setAndroidTransferActive(`receive:${channel.room}`, false);
  abortAndroidBinaryWrites(message);
  if (channel.currentFile?.android?.token) {
    abortAndroidSave(channel.currentFile.android.token);
  }
  if (channel.readyState === "open") channel.send(JSON.stringify({ type: "abort", reason: message }));
  try { channel.close(); } catch (_) {}
  toast(message);
}

async function sendFiles(channel) {
  const transferKey = `send:${channel.room}`;
  setAndroidTransferActive(transferKey, true);
  try {
    await sendFilesImpl(channel);
  } finally {
    setAndroidTransferActive(transferKey, false);
  }
}

async function sendFilesImpl(channel) {
  const files = channel.outgoingFiles;
  for (const file of files) {
    const progress = state.outgoingProgress;
    if (progress?.room === channel.room) {
      progress.currentName = file.name;
      renderSendProgress();
    }
    channel.send(JSON.stringify({ type: "file-start", name: file.name, size: file.size, mime: file.type || "application/octet-stream" }));
    const chunkSize = dataChannelChunkBytes(channel);
    let readOffset = 0;
    const readBlockBytes = window.AndroidBridge ? ANDROID_FILE_READ_BLOCK_BYTES : BROWSER_FILE_READ_BLOCK_BYTES;
    const readNextBlock = () => {
      if (readOffset >= file.size) return null;
      const start = readOffset;
      readOffset += readBlockBytes;
      return file.slice(start, start + readBlockBytes).arrayBuffer();
    };
    // Keep exactly one block ahead of the network. This hides MediaStore / WebView
    // read latency without allowing a large video to accumulate in memory.
    let pendingBlock = readNextBlock();
    while (pendingBlock) {
      const block = await pendingBlock;
      pendingBlock = readNextBlock();
      for (let offset = 0; offset < block.byteLength; offset += chunkSize) {
        // Avoid creating a microtask for every packet while there is still
        // remote credit. That scheduling overhead is visible on Android
        // WebView when a long video contains tens of thousands of packets.
        if (channel.inFlightBytes >= channel.maxInFlightBytes) await waitForRemoteCredit(channel);
        while (channel.bufferedAmount > channel.bufferHighWaterBytes) await waitForDataChannelDrain(channel);
        const end = Math.min(offset + chunkSize, block.byteLength);
        const chunk = new Uint8Array(block, offset, end - offset);
        channel.send(chunk);
        channel.inFlightBytes += chunk.byteLength;
        advanceOutgoingProgress(channel.room, chunk.byteLength);
      }
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
  setAndroidTransferActive(`send-pending:${room}`, false);
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
  setAndroidTransferActive(`send-pending:${room}`, false);
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

function nativeSaveBridge() {
  if (window.AndroidBridge?.beginReceiveFile && window.AndroidBridge?.writeReceiveChunk && window.AndroidBridge?.finishReceiveFile) return window.AndroidBridge;
  if (window.XingqiaoDesktop?.beginReceiveFile && window.XingqiaoDesktop?.writeReceiveChunk && window.XingqiaoDesktop?.finishReceiveFile) return window.XingqiaoDesktop;
  return null;
}
function androidAutoSaveAvailable() {
  return Boolean(window.AndroidBridge?.beginReceiveFile && window.AndroidBridge?.writeReceiveChunk && window.AndroidBridge?.finishReceiveFile);
}
function desktopInboxAvailable() {
  return Boolean(window.XingqiaoDesktop?.beginReceiveFile && window.XingqiaoDesktop?.writeReceiveChunk && window.XingqiaoDesktop?.finishReceiveFile);
}
function nativeSaveAvailable() { return androidAutoSaveAvailable() || desktopInboxAvailable(); }
function localReceiverKind() {
  if (androidAutoSaveAvailable()) return "android";
  return desktopInboxAvailable() ? "desktop" : "browser";
}
function readBridgeJson(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
function setAndroidTransferActive(key, active) {
  const bridge = nativeSaveBridge();
  if (!bridge?.setTransferActive) return;
  if (active) nativeTransferKeys.add(key);
  else nativeTransferKeys.delete(key);
  try { bridge.setTransferActive(nativeTransferKeys.size > 0); } catch (_) {}
}
function supportsAndroidBinarySave() { return Boolean(window.XingqiaoBinaryBridge?.postMessage); }
function removeBinaryWriteWaiter(waiter) {
  const index = binaryWriteWaiters.indexOf(waiter);
  if (index >= 0) binaryWriteWaiters.splice(index, 1);
}
function abortAndroidBinaryWrites(message = "安卓保存通道已关闭") {
  const waiters = binaryWriteWaiters.splice(0);
  waiters.forEach(waiter => {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(message));
  });
}
function setupAndroidBinaryBridge() {
  const bridge = window.XingqiaoBinaryBridge;
  if (!bridge?.postMessage) return;
  bridge.onmessage = event => {
    const waiter = binaryWriteWaiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const result = readBridgeJson(event.data);
    if (result?.ok) waiter.resolve();
    else waiter.reject(new Error("安卓未能写入文件"));
  };
}
function writeAndroidBinaryChunk(buffer) {
  return new Promise((resolve, reject) => {
    const bridge = window.XingqiaoBinaryBridge;
    if (!bridge?.postMessage) { reject(new Error("安卓二进制保存通道不可用")); return; }
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      removeBinaryWriteWaiter(waiter);
      reject(new Error("安卓保存响应超时"));
    }, 15_000);
    binaryWriteWaiters.push(waiter);
    try { bridge.postMessage(buffer); }
    catch (error) {
      clearTimeout(waiter.timer);
      removeBinaryWriteWaiter(waiter);
      reject(error);
    }
  });
}
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer); let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
async function startAndroidSave(name, mime) {
  const bridge = nativeSaveBridge();
  if (!bridge) return null;
  const result = readBridgeJson(await bridge.beginReceiveFile(name, mime));
  if (result?.binary && !supportsAndroidBinarySave()) result.binary = false;
  return result?.ok ? result : null;
}
async function finishAndroidSave(token) {
  const bridge = nativeSaveBridge();
  return bridge ? readBridgeJson(await bridge.finishReceiveFile(token)) : null;
}
async function writeAndroidSaveChunk(token, base64) {
  const bridge = nativeSaveBridge();
  return Boolean(bridge && await bridge.writeReceiveChunk(token, base64));
}
function abortAndroidSave(token) {
  try { nativeSaveBridge()?.abortReceiveFile(token); } catch (_) {}
}

function mergeArrayBuffers(buffers, byteLength) {
  if (buffers.length === 1) return buffers[0];
  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const buffer of buffers) {
    const view = new Uint8Array(buffer);
    merged.set(view, offset);
    offset += view.byteLength;
  }
  return merged.buffer;
}

/**
 * Modern Android WebView can pass ArrayBuffers to the native MediaStore bridge
 * without Base64. Coalesce a few safe WebRTC packets before crossing that
 * bridge: this removes most UI-thread round trips while retaining the 1 MiB
 * Android back-pressure limit and bounded memory use.
 */
async function flushAndroidBinaryBuffer(channel) {
  const file = channel.currentFile;
  if (!file?.android?.binary || !file.androidPendingBytes) return true;
  const byteLength = file.androidPendingBytes;
  const payload = mergeArrayBuffers(file.androidPendingBuffers, byteLength);
  file.androidPendingBuffers = [];
  file.androidPendingBytes = 0;
  try {
    await writeAndroidBinaryChunk(payload);
  } catch (_) {
    file.androidFailed = true;
    stopIncomingChannel(channel, "安卓保存通道中断，已停止传输");
    return false;
  }
  acknowledgeReceivedChunk(channel, byteLength);
  advanceIncomingProgress(channel.room, byteLength);
  return true;
}

async function flushBrowserWritableBuffer(channel) {
  const file = channel.currentFile;
  if (!file?.writer || !file.writerPendingBytes) return true;
  const byteLength = file.writerPendingBytes;
  const payload = mergeArrayBuffers(file.writerPendingBuffers, byteLength);
  file.writerPendingBuffers = [];
  file.writerPendingBytes = 0;
  try {
    await file.writer.write(payload);
  } catch (_) {
    stopIncomingChannel(channel, "无法写入所选文件夹，已停止传输");
    return false;
  }
  acknowledgeReceivedChunk(channel, byteLength);
  advanceIncomingProgress(channel.room, byteLength);
  return true;
}

function directDragFilename(name) {
  return String(name || "xingqiao-file").replace(/[\\/\r\n:]/g, "_");
}

function prepareDirectDragWorker() {
  if (!window.isSecureContext || !navigator.serviceWorker || !window.caches) return Promise.reject(new Error("当前页面不支持临时拖拽文件"));
  if (!directDragWorker) directDragWorker = navigator.serviceWorker.register("/drag-worker.js", { scope: "/" });
  return directDragWorker.then(() => navigator.serviceWorker.ready);
}

async function discardDirectDragUrl(url) {
  if (!url || !directDragUrls.delete(url)) return;
  try { (await caches.open(DIRECT_DRAG_CACHE)).delete(url); } catch (_) {}
}

/**
 * Chromium's DownloadURL protocol expects an HTTP(S) URL, not a page-owned
 * blob URL. Store a short-lived copy behind a service-worker route so dropping
 * onto Finder/Explorer or a native app creates the promised file at the target
 * instead of handing it an unusable browser URL.
 */
async function prepareDirectDragUrl(resource, name, mime) {
  if (!resource) return "";
  try {
    await prepareDirectDragWorker();
    const url = new URL(`${DIRECT_DRAG_PATH}${crypto.randomUUID()}`, location.origin).href;
    const response = new Response(resource, { headers: {
      "Content-Type": mime || resource.type || "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(directDragFilename(name))}`,
      "Cache-Control": "no-store",
    }});
    await (await caches.open(DIRECT_DRAG_CACHE)).put(url, response);
    directDragUrls.add(url);
    setTimeout(() => { discardDirectDragUrl(url); }, DIRECT_DRAG_LIFETIME_MS);
    return url;
  } catch (_) {
    // In non-secure contexts or browsers without service workers the normal
    // File drag data remains available to compatible web upload targets.
    return "";
  }
}

async function rememberReceivedFile(file, resource, saved, folder = "", nativeInbox = false, nativeFileId = "") {
  const url = resource ? URL.createObjectURL(resource) : "";
  const dragUrl = resource ? await prepareDirectDragUrl(resource, file.savedName || file.name, file.mime) : "";
  state.received.push({
    id: crypto.randomUUID(),
    name: file.savedName || file.name,
    size: file.size,
    mime: file.mime,
    type: file.mime,
    saved,
    folder,
    resource,
    url,
    dragUrl,
    nativeInbox,
    nativeFileId,
  });
}

async function receive(channel, data) {
  if (typeof data === "string") {
    let message; try { message = JSON.parse(data); } catch (_) { return; }
    if (message.type === "abort") {
      channel.aborted = true;
      channel.abortReason = message.reason || "接收端已停止传输";
      wakeAckWaiters(channel);
      setAndroidTransferActive(`receive:${channel.room}`, false);
      return;
    }
    if (message.type === "file-start") {
      channel.currentFile = { name: message.name, size: message.size, mime: message.mime, chunks: [] };
      setAndroidTransferActive(`receive:${channel.room}`, true);
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
          channel.currentFile.handle = handle;
          channel.currentFile.savedName = name;
          channel.currentFile.writerPendingBuffers = [];
          channel.currentFile.writerPendingBytes = 0;
        } catch (_) {
          stopIncomingChannel(channel, "无法写入所选文件夹，已停止传输");
          return;
        }
      } else {
        channel.currentFile.android = await startAndroidSave(message.name, message.mime);
        if (nativeSaveAvailable() && !channel.currentFile.android) {
          stopIncomingChannel(channel, "原生收件箱无法创建临时文件，已停止传输");
          return;
        }
        if (channel.currentFile.android?.binary) {
          channel.currentFile.androidPendingBuffers = [];
          channel.currentFile.androidPendingBytes = 0;
        }
      }
    }
    if (message.type === "file-end" && channel.currentFile) {
      const file = channel.currentFile;
      if (file.writer) {
        if (!await flushBrowserWritableBuffer(channel)) return;
        await file.writer.close();
        const resource = await file.handle.getFile();
        await rememberReceivedFile(file, resource, true, channel.folder.name);
        toast(`已保存 ${file.savedName} 到 ${channel.folder.name}`);
      } else if (file.android) {
        if (!file.androidFailed) {
          if (!await flushAndroidBinaryBuffer(channel)) return;
          const result = await finishAndroidSave(file.android.token);
          if (result?.ok) {
            await rememberReceivedFile(file, null, true, result.folder, Boolean(result.temporary), result.nativeFileId || "");
            if (result.temporary) {
              try { window.XingqiaoDesktop?.showInbox?.(); } catch (_) {}
              toast(`${file.name} 已暂存到星桥收件箱，可从悬浮窗拖入聊天`);
            } else toast(`已自动保存 ${file.name} 到 ${result.folder}`);
          } else toast(`${file.name} 保存失败，请重新接收`);
        }
      } else {
        const resource = new File(file.chunks, file.name, { type: file.mime, lastModified: Date.now() });
        await rememberReceivedFile(file, resource, false);
        toast(`已接收 ${file.name}，可直接拖到其他应用`);
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
      setAndroidTransferActive(`receive:${channel.room}`, false);
    }
    return;
  }
  const bytes = data.byteLength || 0;
  if (channel.currentFile?.writer) {
    const file = channel.currentFile;
    file.writerPendingBuffers.push(data);
    file.writerPendingBytes += bytes;
    if (file.writerPendingBytes < BROWSER_WRITABLE_BATCH_BYTES) return;
    await flushBrowserWritableBuffer(channel);
    return;
  }
  else if (channel.currentFile?.android && !channel.currentFile.androidFailed) {
    const file = channel.currentFile;
    if (file.android.binary) {
      file.androidPendingBuffers.push(data);
      file.androidPendingBytes += bytes;
      if (file.androidPendingBytes < ANDROID_BINARY_WRITE_BATCH_BYTES) return;
      await flushAndroidBinaryBuffer(channel);
      return;
    }
    try { if (!await writeAndroidSaveChunk(file.android.token, bufferToBase64(data))) throw new Error("原生保存通道中断"); }
    catch (_) {
      file.androidFailed = true;
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
      createOffer(message.peer, message.room, message.selected, message.receiver).catch(() => toast("无法建立设备直连，请确认双方仍在线后重试"));
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
let nativeAppVersion = "";
function updateButton() { return $("#checkUpdate"); }
function updateButtonLabel(label) { return nativeAppVersion ? `v${nativeAppVersion} · ${label}` : label; }
function showNativeUpdate(raw) {
  const message = readBridgeJson(raw) || raw || {};
  const button = updateButton();
  if (!button) return;
  button.hidden = false;
  const status = message.status;
  if (status === "checking") {
    button.disabled = true;
    button.textContent = updateButtonLabel("检查中…");
  } else if (status === "downloading") {
    button.disabled = true;
    button.textContent = `下载 v${message.version || ""}…`;
    toast("正在下载新版本，下载完成后会打开系统安装确认");
  } else if (status === "ready") {
    button.disabled = false;
    button.textContent = updateButtonLabel("重新检查");
    toast("安装包已准备好，请在系统安装确认中完成更新");
  } else if (status === "latest") {
    button.disabled = false;
    button.textContent = updateButtonLabel("已是最新");
    toast("当前已是最新版本");
  } else {
    button.disabled = false;
    button.textContent = updateButtonLabel("检查更新");
    if (message.message) toast(message.message);
  }
}

window.XingqiaoNative = { onUpdateStatus: showNativeUpdate };

async function setupNativeUpdate() {
  const button = updateButton();
  const bridge = window.AndroidBridge?.checkForUpdate ? window.AndroidBridge : window.XingqiaoDesktop?.checkForUpdate ? window.XingqiaoDesktop : null;
  if (!button || !bridge) return;
  button.hidden = false;
  button.textContent = updateButtonLabel("检查更新");
  button.onclick = async () => {
    try {
      button.disabled = true;
      button.textContent = updateButtonLabel("检查中…");
      await Promise.resolve(bridge.checkForUpdate());
      // Android reports progress through XingqiaoNative. macOS and Windows
      // present a native dialog, so restore this web button once it hands off.
      if (bridge === window.XingqiaoDesktop) {
        button.disabled = false;
        button.textContent = updateButtonLabel("检查更新");
      }
    } catch (_) {
      button.disabled = false;
      button.textContent = updateButtonLabel("检查更新");
      toast("无法检查更新，请稍后重试");
    }
  };
  try {
    const result = await Promise.resolve(bridge.appVersion?.());
    const version = typeof result === "string" ? result : result?.version;
    if (version) {
      nativeAppVersion = String(version).replace(/^[vV]/, "");
      button.textContent = updateButtonLabel("检查更新");
    }
  } catch (_) {}
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
  nativeTransferKeys.clear();
  state.received.forEach(file => { if (file.url) URL.revokeObjectURL(file.url); });
  [...directDragUrls].forEach(url => { discardDirectDragUrl(url); });
  try { nativeSaveBridge()?.setTransferActive?.(false); } catch (_) {}
  peers.forEach(peer => peer.close());
});
setupAndroidBinaryBridge();
setMode("photos"); renderFiles(); importAndroidSharedFiles(); connect();
setupNativeUpdate();
