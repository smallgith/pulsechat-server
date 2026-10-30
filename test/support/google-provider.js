// Explicit Node --import preload for tests only. app.js never imports this module.
// Exercise the real RSA/claims verifier with a local identity-provider fixture.
import { googleTestKeys } from './google-fixture.js';
const networkFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs')
    return Promise.resolve(Response.json({ keys: googleTestKeys }));
  return networkFetch(input, options);
};
