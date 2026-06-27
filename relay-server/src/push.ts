/**
 * Web Push support — lets the phone receive approval notifications even when
 * the PWA is backgrounded or the screen is off (the in-page WebSocket is
 * suspended in that state, so a real Push API subscription is required).
 *
 * Notes:
 *  - Push API only works in a secure context (HTTPS tunnel or localhost). Over
 *    plain-HTTP local WiFi it's unavailable; we degrade gracefully.
 *  - VAPID keys are persisted so existing subscriptions survive relay restarts.
 */
import webpush, { PushSubscription } from 'web-push';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { rlog } from './log';

const VAPID_FILE = path.join(os.homedir(), '.kiro-remote', 'vapid.json');

interface Vapid { publicKey: string; privateKey: string; }

let vapid: Vapid | null = null;
const subscriptions = new Map<string, PushSubscription>(); // endpoint -> subscription

/** Load or generate VAPID keys and configure web-push. Returns the public key. */
export function initPush(): string | null {
  try {
    if (fs.existsSync(VAPID_FILE)) {
      vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')) as Vapid;
    } else {
      const keys = webpush.generateVAPIDKeys();
      vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
      fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
      fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid));
    }
    webpush.setVapidDetails('mailto:kiro-remote@localhost', vapid.publicKey, vapid.privateKey);
    rlog('push', 'Web Push initialized');
    return vapid.publicKey;
  } catch (e) {
    rlog('push', `init failed: ${e}`);
    return null;
  }
}

export function getPublicKey(): string | null {
  return vapid?.publicKey ?? null;
}

export function addSubscription(sub: PushSubscription) {
  if (sub?.endpoint) {
    subscriptions.set(sub.endpoint, sub);
    rlog('push', `Subscription added (total: ${subscriptions.size})`);
  }
}

export function clearSubscriptions() {
  subscriptions.clear();
}

/** Fire a push notification to every registered subscription. */
export async function sendPush(payload: Record<string, unknown>): Promise<void> {
  if (!vapid || subscriptions.size === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    [...subscriptions.entries()].map(async ([endpoint, sub]) => {
      try {
        await webpush.sendNotification(sub, body);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          subscriptions.delete(endpoint); // expired/unsubscribed
        } else {
          rlog('push', `send failed: ${(e as Error).message ?? e}`);
        }
      }
    })
  );
}
