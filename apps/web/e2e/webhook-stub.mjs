import http from 'node:http';

const port = Number(process.env.E2E_WEBHOOK_PORT ?? 18765);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    process.stdout.write(`e2e webhook stub already listening on ${port}\n`);
    return;
  }
  throw err;
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`e2e webhook stub on ${port}\n`);
});
