import http from 'node:http';

export function startHealthServer({ port, getStatus, logger }) {
  const server = http.createServer((req, res) => {
    logger.debug('Health server request', { method: req.method, url: req.url });
    if (req.url === '/' || req.url === '') {
      const payload = {
        ok: true,
        endpoint: '/healthz',
        message: 'YT Cast Audio Bridge has no web UI. Use /healthz for status.'
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.url !== '/healthz') {
      res.statusCode = 404;
      res.end('not found');
      logger.debug('Health server 404 response', { url: req.url });
      return;
    }
    const payload = { ok: true, timestamp: new Date().toISOString(), ...getStatus() };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  server.listen(port, () => logger.info(`Health endpoint listening on :${port}/healthz`));
  return server;
}
