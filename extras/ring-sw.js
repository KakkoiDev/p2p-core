/*
 * Ringing, service worker side: show the notification for each push and open the app when
 * it is clicked. Load it from your service worker (a classic script, so it works in every
 * browser):
 *
 *   importScripts('/vendor/p2p-core/extras/ring-sw.js');
 *
 * Messages are JSON from server/push.js: { kind, title, body, url, tag }. kind 'call' rings:
 * the notification stays until answered, vibrates, and has Join / Dismiss. Optional
 * settings before the importScripts line: self.P2P_RING = { icon: '/icon-192.png' }.
 */
(() => {
  const settings = () => self.P2P_RING || {};
  self.addEventListener('push', (e) => {
    let n = {};
    try { n = e.data ? e.data.json() : {}; } catch { n = { title: 'Notification', body: e.data && e.data.text() }; }
    const ringing = n.kind === 'call';
    const icon = settings().icon;
    e.waitUntil(self.registration.showNotification(String(n.title || 'Notification').slice(0, 200), {
      body: String(n.body || '').slice(0, 500),
      tag: n.tag || (ringing ? 'call' : 'note'),
      renotify: true,
      requireInteraction: ringing,
      icon, badge: icon,
      vibrate: ringing ? [400, 200, 400, 200, 400] : undefined,
      data: { url: typeof n.url === 'string' ? n.url : '/' },
      actions: ringing ? [{ action: 'join', title: 'Join' }, { action: 'dismiss', title: 'Dismiss' }] : [],
    }));
  });
  self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    if (e.action === 'dismiss') return;
    // Only this site's own pages: a message cannot send the person elsewhere.
    const target = new URL(e.notification.data?.url || '/', self.location.origin);
    const url = target.origin === self.location.origin ? target.href : self.location.origin + '/';
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const w of list) if (w.url === url && 'focus' in w) return w.focus();
      return self.clients.openWindow(url);
    }));
  });
})();
