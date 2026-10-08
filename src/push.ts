// Web push on this device: support, permission and the browser subscription.
export type PushSupport = 'ready' | 'unsupported' | 'install' | 'denied';

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  // On iPhone and iPad notifications work only from the app added to the Home screen.
  if (isIos() && !standalone()) return 'install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ready';
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

function applicationServerKey(publicKey: string) {
  const padded = `${publicKey}${'='.repeat((4 - publicKey.length % 4) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

export async function currentSubscription() {
  if (pushSupport() !== 'ready') return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription()) || null;
}

export async function subscribe(publicKey: string) {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permesso negato: abilita le notifiche per Family Hub nelle impostazioni del browser o del telefono.');
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  // A subscription made with other keys is replaced.
  if (existing && existing.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(existing.options.applicationServerKey))) !== btoa(String.fromCharCode(...applicationServerKey(publicKey)))) await existing.unsubscribe();
  return (await registration.pushManager.getSubscription()) || registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
}
