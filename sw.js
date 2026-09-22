// Docly — minimal service worker
// Purpose: let the browser show real OS-level notifications ("Your content is ready")
// even when the Docly tab is in the background (not focused).
//
// Limitation: this alone cannot wake up after the tab/browser is fully closed.
// True delivery after closing the site entirely would require Web Push
// (a push subscription + a server that triggers the push, e.g. a Back4app
// Cloud Code function with VAPID keys) — not included in this build.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
