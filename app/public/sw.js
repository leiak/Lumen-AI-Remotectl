/* eslint-disable no-restricted-globals */
// Service worker for Web Push. Lives at /sw.js so the browser can register it
// with `serviceWorker.register('/sw.js')`. Must be at the site root for the
// scope to cover the whole app.

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'RemoteCTL', body: event.data.text() };
  }
  const title = payload.title || 'RemoteCTL';
  const options = {
    body: payload.body || '',
    // `data` is preserved on `notificationclick` so the click handler can
    // route back to the right issue.
    data: payload.data || {},
    icon: '/icon.svg',
    badge: '/icon.svg',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let data = {};
  try {
    data = typeof event.notification.data === 'string'
      ? JSON.parse(event.notification.data)
      : event.notification.data || {};
  } catch {
    data = {};
  }
  const issueId = data?.issueId;
  // Open the app, focusing an existing window if any, then navigate to the
  // issue detail page when the window has loaded.
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const targetUrl = issueId ? `/issues/${issueId}` : '/';
    for (const client of allClients) {
      // Best-effort: if a window is already open, focus it and tell it to
      // navigate. `postMessage` is delivered into the page; the page can
      // listen for { type: 'push-navigate', url } and react.
      try {
        client.postMessage({ type: 'push-navigate', url: targetUrl });
        return client.focus();
      } catch {
        // fall through to opening a new window
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});