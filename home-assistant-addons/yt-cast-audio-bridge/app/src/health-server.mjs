import http from 'node:http';

export function startHealthServer({ port, getStatus, logger }) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const payload = { ok: true, timestamp: new Date().toISOString(), ...getStatus() };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  server.listen(port, () => logger.info(`Health endpoint listening on :${port}/healthz`));
  return server;
}
