// Family Hub service worker: shows push notifications and opens the right
// section when one is tapped. It caches nothing, so the app always loads fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Family Hub', {
    body: data.body || '', tag: data.tag, renotify: !!data.tag, lang: 'it',
    // The badge is the logo's white silhouette on transparency: Android tints it
    // in the status bar, while the full-colour logo is the notification's icon.
    icon: '/family-hub-192.png', badge: '/family-hub-badge.png', data: { url: data.url || '' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const hash = String(event.notification.data?.url || '');
  const target = new URL(`/${hash.startsWith('#') ? hash : ''}`, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (open) { await open.focus(); return open.navigate(target).catch(() => undefined); }
    return self.clients.openWindow(target);
  })());
});
