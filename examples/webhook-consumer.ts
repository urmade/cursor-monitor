import { createServer } from 'node:http';
import { verifyWebhookSignature } from '@nexus/core';

const secret = process.env.WEBHOOK_SECRET ?? 'whsec_dev';
const port = Number(process.env.PORT ?? 3456);

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const sig = req.headers['x-nexus-signature'];
    if (typeof sig !== 'string') {
      res.writeHead(400);
      res.end('missing signature');
      return;
    }
    const ok = verifyWebhookSignature(secret, raw, sig).ok;
    if (!ok) {
      res.writeHead(401);
      res.end('invalid signature');
      return;
    }
    console.log('verified event', req.headers['x-nexus-event-type'], raw.slice(0, 200));
    res.writeHead(200);
    res.end('ok');
  });
}).listen(port, () => {
  console.log(`webhook consumer listening on :${port}`);
});
