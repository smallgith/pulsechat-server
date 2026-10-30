import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function attachmentHeaders(res, name) {
  const filename = String(name || 'PulseChat-file')
    .replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, '_')
    .slice(0, 180);
  res.attachment(filename);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox allow-downloads");
}

/** Public capability URLs, like /api/files. Only this app's uploaded Cloudinary assets qualify. */
export function installDownloads(app, { cloudName, fetchRemote = fetch }) {
  app.get('/api/download', async (req, res) => {
    let url;
    try {
      url = new URL(req.query.url);
    } catch {
      return res.status(400).json({ error: 'Invalid file URL' });
    }
    const parts = url.pathname.split('/');
    if (
      !cloudName ||
      url.protocol !== 'https:' ||
      url.hostname !== 'res.cloudinary.com' ||
      url.port ||
      url.username ||
      url.password ||
      parts[1] !== cloudName ||
      !['image', 'video', 'raw'].includes(parts[2]) ||
      parts[3] !== 'upload' ||
      !parts.slice(4).join('/') ||
      url.href.length > 4096
    )
      return res.status(400).json({ error: 'Use a file uploaded to this chat server' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const abort = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once('close', abort);
    try {
      // Do not follow redirects to arbitrary hosts. Never forward user credentials.
      const upstream = await fetchRemote(url.href, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: req.headers.range ? { Range: req.headers.range } : {},
      });
      clearTimeout(timer);
      if (![200, 206].includes(upstream.status)) {
        await upstream.body?.cancel();
        return res
          .status([404, 410].includes(upstream.status) ? 404 : 502)
          .json({ error: 'The file host could not provide this attachment' });
      }
      attachmentHeaders(res, req.query.name || decodeURIComponent(parts.at(-1)));
      res.type('application/octet-stream');
      res.set('Cache-Control', 'private, no-store');
      // Fetch transparently decompresses responses, invalidating their original byte length.
      for (const header of ['content-length', 'accept-ranges', 'content-range']) {
        const value = upstream.headers.get(header);
        if (value && !(header === 'content-length' && upstream.headers.get('content-encoding')))
          res.set(header, value);
      }
      res.status(upstream.status);
      if (req.method === 'HEAD') {
        await upstream.body?.cancel();
        res.end();
      } else if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch {
      if (!res.headersSent && !res.destroyed)
        res.status(502).json({ error: 'Could not reach the file host. Try again.' });
      else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timer);
      res.removeListener('close', abort);
    }
  });
}
