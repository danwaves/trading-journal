// Danwaves Notifications — Phase 2 service worker.
//
// Place this file at the ROOT of your deployed site (same level as
// app.html / index.html — e.g. alongside your other top-level files in
// the GitHub repo Vercel builds from), so it registers with scope '/'
// and can catch pushes for the whole app.
//
// This file only handles RECEIVING a push and showing the OS notification.
// Tapping the notification just focuses/opens the app for now — jumping
// straight to the specific item it's about is Phase 5, once notifications
// carry a deep-link target the app can read on load.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: 'Danwaves', body: event.data ? event.data.text() : 'You have a new update.' };
  }

  const title = data.title || 'Danwaves';
  const options = {
    body: data.body || 'You have a new update.',
    icon: data.icon || '/icon-192.png',   // adjust to wherever your app icon actually lives
    badge: data.badge || '/icon-192.png',
    data: { deepLink: data.deepLink || null }, // Phase 5 will read this on click
    tag: data.tag || undefined,             // optional: collapse repeat notifications about the same item
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Phase 5 will extend this to navigate straight to event.notification.data.deepLink
  // once app.html knows how to read and act on a launch target. For now, it just
  // opens the app (or focuses an already-open tab) on a plain tap.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
