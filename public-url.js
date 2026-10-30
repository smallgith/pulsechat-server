export function publicServerUrl(req, configured = process.env.PUBLIC_SERVER_URL) {
  const url = new URL(configured || `${req.protocol}://${req.get('host')}`);
  // Render terminates TLS before forwarding HTTP to Node. Public links must stay HTTPS.
  if (req.secure || process.env.NODE_ENV === 'production' || url.hostname.endsWith('.onrender.com'))
    url.protocol = 'https:';
  return url.href.replace(/\/+$/, '');
}

export const localFileUrl = (req, id) => `${publicServerUrl(req)}/api/files/${id}`;
