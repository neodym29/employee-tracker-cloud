export const MESSAGE_ALERTS_KEY = 'neo-nexus:message-alerts';
const LAST_ALERT_KEY = 'neo-nexus:last-message-alert';

let audioContext: AudioContext | null = null;

export function armAlertAudio() {
  if (!alertsEnabled()) return;
  try {
    const Audio = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Audio) {
      audioContext ||= new Audio();
      if (audioContext.state === 'suspended') void audioContext.resume();
    }
  } catch { /* The browser may not permit custom sound. */ }
}

export function alertsEnabled() {
  try { return window.localStorage.getItem(MESSAGE_ALERTS_KEY) === 'on'; }
  catch { return false; }
}

export async function enableAlerts(): Promise<'enabled' | 'blocked' | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'blocked';
  try { window.localStorage.setItem(MESSAGE_ALERTS_KEY, 'on'); }
  catch { return 'blocked'; }
  armAlertAudio();
  return 'enabled';
}

export function disableAlerts() {
  try { window.localStorage.removeItem(MESSAGE_ALERTS_KEY); }
  catch { /* Storage may be unavailable in a private browser session. */ }
}

function playTone() {
  try {
    if (!audioContext) return;
    if (audioContext.state === 'suspended') {
      void audioContext.resume().then(() => { if (audioContext?.state === 'running') playTone(); }).catch(() => {});
      return;
    }
    if (audioContext.state !== 'running') return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(740, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(988, audioContext.currentTime + 0.09);
    gain.gain.setValueAtTime(0.035, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.19);
    oscillator.connect(gain); gain.connect(audioContext.destination);
    oscillator.start(); oscillator.stop(audioContext.currentTime + 0.2);
  } catch { /* A silent alert is preferable to failing the notification. */ }
}

function notify(marker: string, title: string, path: string) {
  if (!alertsEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    if (window.localStorage.getItem(LAST_ALERT_KEY) === marker) return;
    window.localStorage.setItem(LAST_ALERT_KEY, marker);
  } catch { /* Continue with an alert when storage is unavailable. */ }
  playTone();
  if (document.visibilityState === 'visible' && window.location.pathname === path.split('?')[0]) return;
  try {
    const notification = new Notification(title, {
      body: 'Open Neo-Nexus to view.',
      tag: marker,
    });
    notification.onclick = () => {
      window.focus();
      window.location.assign(path);
      notification.close();
    };
  } catch { /* Notifications can be blocked by browser or system settings. */ }
}

export function notifyNewMessage(conversation: { id: string; name: string; latestAt: string }) {
  notify(`chat:${conversation.id}:${conversation.latestAt}`, `New message · ${conversation.name}`, `/chats?conversation=${encodeURIComponent(conversation.id)}`);
}

export function notifyNewClientRequest(request: { id: string; projectId: string; summary: string; createdAt: string }) {
  notify(`request:${request.id}:${request.createdAt}`, 'New project request', `/projects/${encodeURIComponent(request.projectId)}`);
}
