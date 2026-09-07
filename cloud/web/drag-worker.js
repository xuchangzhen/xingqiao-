// Provides short-lived, same-origin URLs for Chromium's DownloadURL drag-out
// mechanism. The page puts received WebRTC Files into this cache; no transfer
// payload is ever sent to the signalling server.
const DIRECT_DRAG_CACHE = "xingqiao-direct-drag-v1";
const DIRECT_DRAG_PATH = "/_xingqiao_drag/";

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(DIRECT_DRAG_PATH)) return;
  event.respondWith((async () => {
    const response = await (await caches.open(DIRECT_DRAG_CACHE)).match(event.request);
    return response || new Response("拖拽文件已过期，请回到星桥重新接收。", {
      status: 410,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  })());
});
