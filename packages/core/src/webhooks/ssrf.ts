import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.0\.0\./, // 192.0.0.0/24
  /^192\.168\./,
  /^198\.(1[89])\./, // 198.18.0.0/15 benchmarking
  /^0\./,
];

function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
    return true;
  }
  if (isIP(ip) === 4) {
    return PRIVATE_IPV4.some((re) => re.test(ip));
  }
  return false;
}

export type WebhookUrlCheckOptions = {
  allowLoopback?: boolean;
};

export async function assertPublicWebhookUrl(
  urlString: string,
  options?: WebhookUrlCheckOptions,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid webhook URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Webhook URL must be http(s)');
  }
  if (url.username || url.password) {
    throw new Error('Webhook URL must not embed credentials');
  }
  const host = url.hostname;
  if (options?.allowLoopback && (host === '127.0.0.1' || host === 'localhost')) {
    return;
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Webhook URL must not target a private address');
    return;
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Webhook URL must not target localhost or internal hostnames');
  }
  const records = await lookup(host, { all: true });
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new Error('Webhook URL resolves to a private address');
    }
  }
}
