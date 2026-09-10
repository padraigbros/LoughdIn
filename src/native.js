import {Capacitor} from '@capacitor/core';
import {App} from '@capacitor/app';
import {LocalNotifications} from '@capacitor/local-notifications';

const NATIVE = Capacitor.isNativePlatform();
const NOTIFICATION_ID = 42801;

export function isNativeApp() {
  return NATIVE;
}

/**
 * Android can stop the WebView while a timer is running. The timer remains
 * authoritative in IndexedDB (including its deadlineAt), so the web app must
 * reconcile state when the activity resumes instead of trusting elapsed JS
 * callbacks. Browser lifecycle events continue to be handled by app.js.
 */
export async function registerNativeLifecycle({onResume} = {}) {
  if (!NATIVE) return {remove: async () => {}};
  return App.addListener('appStateChange', ({isActive}) => {
    if (isActive) onResume?.();
  });
}

/**
 * Ask for notification permission only from a user gesture. Calling this at
 * startup would show an unexpected Android prompt. Android 12 and below return
 * granted without showing a prompt; Android 13+ uses POST_NOTIFICATIONS.
 */
export async function requestLocalNotificationPermission() {
  if (!NATIVE) return false;
  const current = await LocalNotifications.checkPermissions();
  if (current.display === 'granted') return true;
  if (current.display !== 'prompt' && current.display !== 'prompt-with-rationale') return false;
  const next = await LocalNotifications.requestPermissions();
  return next.display === 'granted';
}

/**
 * Schedule the OS notification after permission has been granted explicitly.
 * The native alarm is best-effort delivery; app.js still reconciles the exact
 * deadline on resume and owns completion/session persistence.
 */
export async function scheduleSessionNotification(deadlineAt) {
  if (!NATIVE || !Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) return false;
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') return false;
  await LocalNotifications.createChannel({id: 'session-complete', name: 'Session complete', description: 'Timer session completion alerts', importance: 4, visibility: 1});
  await LocalNotifications.cancel({notifications: [{id: NOTIFICATION_ID}]});
  await LocalNotifications.schedule({notifications: [{
    id: NOTIFICATION_ID,
    title: "Lough'd In",
    body: 'Your session has finished. Take a breath.',
    schedule: {at: new Date(deadlineAt), allowWhileIdle: true},
    channelId: 'session-complete',
    autoCancel: true,
    extra: {kind: 'session-complete'}
  }]});
  return true;
}

export async function cancelSessionNotification() {
  if (!NATIVE) return;
  await LocalNotifications.cancel({notifications: [{id: NOTIFICATION_ID}]});
}
