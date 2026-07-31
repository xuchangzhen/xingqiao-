const $ = (selector) => document.querySelector(selector);
const state = {
  mode: "photos",
  files: [],
  clipboardImages: [],
  clipboardText: "",
  activeFiles: [],
  device: localStorage.getItem("xingqiao-device") || `${navigator.platform.includes("Mac") ? "Mac" : "我的"}设备`,
  hosted: null,
  rooms: [],
  received: [],
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
const pendingCandidates = new Map();
const receiveFolders = new Map();

function escapeHtml(value) { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; }
function size(bytes) { if (bytes < 1024) return `${bytes} B`; const units = ["KB", "MB", "GB"]; let unit = -1; do { bytes /= 1024; unit++; } while (bytes >= 1024 && unit < 2); return `${bytes.toFixed(bytes < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`; }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2800); }
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function newRoomCode() { return Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(36).padStart(4, "0").slice(-4)).join(""); }
function isImage(file) { return file.type.startsWith("image/"); }
function isVideo(file) { return file.type.startsWith("video/"); }

function transferItems() {
  const items = state.files.map((file, index) => ({ file, source: "files", index }));
  state.clipboardImages.forEach((file, index) => items.push({ file, source: "clipboardImages", index }));
  if (state.clipboardText.trim()) items.push({ file: new File([state.clipboardText], "剪贴板文本.txt", { type: "text/plain;charset=utf-8" }), source: "clipboardText", index: 0 });
  return items;
}

function localPreview(file) {
  if (isImage(file)) return `<img class="file-preview" src="${URL.createObjectURL(file)}" alt="${escapeHtml(file.name)}">`;
  if (isVideo(file)) return `<video class="file-preview" src="${URL.createObjectURL(file)}" muted preload="metadata"></video>`;
  if (file.type.startsWith("text/")) return '<span class="file-badge">TXT</span>';
  return '<span class="file-badge">DOC</span>';
}

function renderFiles() {
  const items = transferItems();
  selected.hidden = items.length === 0;
  selected.innerHTML = items.map((item, position) => `<div class="file-row">${localPreview(item.file)}<span class="file-info"><b>${escapeHtml(item.file.name)}</b><small>${size(item.file.size)}</small></span><button class="remove" data-position="${position}" aria-label="移除">×</button></div>`).join("");
  $("#sendButton").disabled = !items.length || Boolean(state.hosted) || socket?.readyState !== WebSocket.OPEN;
  selected.querySelectorAll(".remove").forEach(button => button.onclick = () => {
    const item = items[Number(button.dataset.position)];
    if (item.source === "clipboardText") { state.clipboardText = ""; $("#clipboardText").value = ""; }
    else state[item.source].splice(item.index, 1);
    renderFiles();
  });
}

function addFiles(files) {
  const allowed = [...files].filter(file => file.size > 0 && file.size <= 4 * 1024 * 1024 * 1024);
  if (allowed.length !== files.length) toast("已忽略空文件或超过 4 GB 的文件");
  state.files.push(...allowed);
  renderFiles();
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
    image.onload = () => {
      const scale = Math.min(1, 280 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(source); resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    image.onerror = () => { URL.revokeObjectURL(source); resolve(null); };
    image.src = source;
  });
}

async function videoThumbnail(file) {
  return new Promise(resolve => {
    const video = document.createElement("video"); const source = URL.createObjectURL(file);
    video.muted = true; video.preload = "metadata";
    const capture = () => {
      try {
        const scale = Math.min(1, 280 / Math.max(video.videoWidth || 1, video.videoHeight || 1));
        const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round((video.videoWidth || 1) * scale)); canvas.height = Math.max(1, Math.round((video.videoHeight || 1) * scale));
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(source); resolve(canvas.toDataURL("image/jpeg", 0.72));
      } catch (_) { URL.revokeObjectURL(source); resolve(null); }
    };
    video.onloadeddata = () => { video.currentTime = Math.min(0.1, Math.max(0, (video.duration || 0) / 2)); };
    video.onseeked = capture;
    video.onerror = () => { URL.revokeObjectURL(source); resolve(null); };
    video.src = source;
  });
}

async function fileMeta(file) {
  const meta = { name: file.name, size: file.size, mime: file.type || "application/octet-stream" };
  if (isImage(file)) { const data = await imageThumbnail(file); if (data) meta.preview = { type: "image", data }; }
  else if (file.type.startsWith("text/")) meta.preview = { type: "text", data: (await file.slice(0, 600).text()).trim() };
  else if (isVideo(file)) { const data = await videoThumbnail(file); if (data) meta.preview = { type: "image", data }; }
  return meta;
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

function renderIncoming() {
  const waiting = state.rooms.filter(room => room.room !== state.hosted && !state.dismissedRooms.has(room.room)).map(room => `<article class="transfer" data-transfer="${room.room}"><div class="transfer-top"><span class="avatar">✦</span><div><b>${escapeHtml(room.sender)} 正在分享</b><small>${room.files.length} 个文件 · 点对点直连</small></div><button class="primary accept" data-room="${room.room}">接收</button></div><div class="select-row"><label><input class="select-all" type="checkbox" checked> 全部接收</label><span>可勾选需要的文件</span></div><div class="transfer-files">${room.files.map((file, index) => `<label class="receive-file"><input class="receive-check" type="checkbox" data-index="${index}" checked><div class="download">${rowPreview(file)}<strong>${escapeHtml(file.name)}</strong><span>${size(file.size)}</span></div></label>`).join("")}</div><div class="transfer-actions"><button class="decline" data-decline="${room.room}">不接收</button></div></article>`).join("");
  const completed = state.received.map(file => `<article class="transfer"><div class="transfer-top"><span class="avatar">✓</span><div><b>已接收</b><small>${file.saved ? `已直接保存至“${escapeHtml(file.folder)}”` : "已下载到浏览器默认位置"}</small></div></div>${file.saved ? `<div class="transfer-files"><div class="download"><strong>${escapeHtml(file.name)}</strong><span>已保存 ✓</span></div></div>` : `${preview(file, file)}<div class="transfer-files"><a class="download" draggable="true" data-mime="${escapeHtml(file.mime)}" href="${file.url}" download="${escapeHtml(file.name)}"><strong>${escapeHtml(file.name)}</strong><span>${size(file.size)} ↓</span></a></div>`}</article>`).join("");
  $("#incomingList").innerHTML = waiting || completed ? waiting + completed : '<div class="empty">暂时没有等待接收的内容</div>';
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
    try { folder = await window.showDirectoryPicker({ mode: "readwrite" }); }
    catch (_) { toast("未选择保存位置，尚未开始接收"); return; }
  } else toast("此浏览器不支持选择目录，将保存到浏览器默认下载位置");
  receiveFolders.set(button.dataset.room, folder);
  send({ type: "join", room: button.dataset.room, selected: selectedIndexes });
  button.disabled = true;
  button.textContent = "连接中…";
  toast("正在建立设备直连…");
}

async function host() {
  const items = transferItems();
  if (!items.length || state.hosted) return;
  state.activeFiles = items.map(item => item.file);
  const room = newRoomCode();
  state.hosted = room;
  $("#sendButton").innerHTML = "准备预览…";
  renderFiles();
  const files = await Promise.all(state.activeFiles.map(fileMeta));
  send({ type: "host", room, meta: { sender: state.device, mode: state.mode, files } });
  $("#sendButton").innerHTML = "等待接收 <i>●</i>";
  $("#privacy").textContent = "保持此页打开；关闭页面会中断传输";
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
  channel.selectedIndexes = selectedIndexes;
  channel.folder = receiveFolders.get(room) || null;
  channel.onopen = () => { if (state.hosted) sendFiles(channel); };
  channel.writeQueue = Promise.resolve();
  channel.onmessage = event => { channel.writeQueue = channel.writeQueue.then(() => receive(channel, event.data)); };
  channel.onclose = () => toast("设备连接已关闭");
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

async function sendFiles(channel) {
  const files = channel.selectedIndexes ? state.activeFiles.filter((_, index) => channel.selectedIndexes.includes(index)) : state.activeFiles;
  for (const file of files) {
    channel.send(JSON.stringify({ type: "file-start", name: file.name, size: file.size, mime: file.type || "application/octet-stream" }));
    for (let offset = 0; offset < file.size; offset += 16 * 1024) {
      while (channel.bufferedAmount > 4 * 1024 * 1024) await new Promise(resolve => setTimeout(resolve, 25));
      channel.send(await file.slice(offset, offset + 16 * 1024).arrayBuffer());
    }
    channel.send(JSON.stringify({ type: "file-end" }));
  }
  channel.send(JSON.stringify({ type: "complete" }));
  toast("内容已通过点对点连接发送");
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
    if (message.type === "file-start") {
      channel.currentFile = { name: message.name, size: message.size, mime: message.mime, chunks: [] };
      if (channel.folder) {
        const name = await nextAvailableName(channel.folder, message.name);
        const handle = await channel.folder.getFileHandle(name, { create: true });
        channel.currentFile.writer = await handle.createWritable();
        channel.currentFile.savedName = name;
      } else {
        channel.currentFile.android = startAndroidSave(message.name, message.mime);
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
      renderIncoming();
    }
    return;
  }
  if (channel.currentFile?.writer) await channel.currentFile.writer.write(data);
  else if (channel.currentFile?.android && !channel.currentFile.androidFailed) {
    if (!window.AndroidBridge.writeReceiveChunk(channel.currentFile.android.token, bufferToBase64(data))) {
      window.AndroidBridge.abortReceiveFile(channel.currentFile.android.token);
      channel.currentFile.androidFailed = true;
      toast("安卓保存通道中断，请重新接收此文件");
    }
  } else if (channel.currentFile && !channel.currentFile.android) channel.currentFile.chunks.push(data);
}

async function connect() {
  try { iceServers = (await fetch("/api/config", { cache: "no-store" }).then(response => response.json())).iceServers || []; } catch (_) {}
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/signal`);
  socket.onopen = () => { $("#privacy").textContent = "已连接：文件将点对点传输"; renderFiles(); send({ type: "list" }); };
  socket.onmessage = async event => {
    const message = JSON.parse(event.data);
    if (message.type === "rooms") { state.rooms = message.rooms; renderIncoming(); }
    if (message.type === "peer-joined" && state.hosted === message.room) createOffer(message.peer, message.room, message.selected);
    if (message.type === "signal") await handleSignal(message.from, message.room, message.payload);
  };
  socket.onclose = () => { if (state.hosted) { state.hosted = null; toast("发送会话已因连接中断而结束"); } $("#privacy").textContent = "连接已断开，正在重试…"; renderFiles(); setTimeout(connect, 2000); };
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
async function importAndroidSharedFiles() {
  if (!window.AndroidBridge?.hasPendingSocial?.() || !window.AndroidBridge?.pendingSocialManifest || !window.AndroidBridge?.readPendingSocialChunk) return;
  const manifest = readBridgeJson(window.AndroidBridge.pendingSocialManifest());
  if (!manifest?.files?.length) return;
  try {
    setMode("social");
    for (let index = 0; index < manifest.files.length; index++) {
      const item = manifest.files[index]; const chunks = [];
      for (let offset = 0; offset < item.size; offset += 96 * 1024) {
        const chunk = window.AndroidBridge.readPendingSocialChunk(index, offset, Math.min(96 * 1024, item.size - offset));
        if (!chunk) throw new Error(`无法读取 ${item.name}`);
        chunks.push(base64ToBytes(chunk));
      }
      state.files.push(new File(chunks, item.name, { type: item.mime }));
    }
    window.AndroidBridge.clearPendingSocial();
    renderFiles();
    toast("已从社交应用导入，可开始发送");
  } catch (error) { toast(error.message || "社交文件导入失败"); }
}
$("#clipboardText").oninput = event => { state.clipboardText = event.target.value; renderFiles(); };
$("#clipboardText").onpaste = event => {
  event.preventDefault();
  if (pasteClipboardData(event.clipboardData, true)) renderFiles();
};
document.addEventListener("paste", event => {
  if (state.mode !== "clipboard" || event.target === $("#clipboardText")) return;
  if (pasteClipboardData(event.clipboardData, false)) { event.preventDefault(); renderFiles(); toast("已粘贴剪贴板内容"); }
});
$("#sendButton").onclick = host;
$("#refreshButton").onclick = () => send({ type: "list" });
window.addEventListener("pagehide", () => { if (state.hosted) send({ type: "leave", room: state.hosted }); peers.forEach(peer => peer.close()); });
setMode("photos"); renderFiles(); importAndroidSharedFiles(); connect();
