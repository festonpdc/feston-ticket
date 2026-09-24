import assert from 'node:assert/strict';
// Run against `pnpm build` + `pnpm start`, not the development server.
for (const path of ['/', '/does-not-exist']) {
  const response = await fetch(`http://localhost:3000${path}`);
  assert.equal(response.status, path === '/' ? 200 : 404);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp?.includes("frame-ancestors 'none'"));
  assert.ok(!csp.includes('unsafe-eval') && !csp.includes('unsafe-inline'));
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  const html = await response.text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scripts.length > 0);
  assert.ok(scripts.every(script => script.includes(`nonce="${nonce}"`)));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(response.headers.get('strict-transport-security')?.includes('31536000'));
  assert.equal(response.headers.get('x-powered-by'), null);
  const next = await fetch(`http://localhost:3000${path}`);
  assert.notEqual(csp, next.headers.get('content-security-policy'));
}
console.log('PASS: 200/404, unique CSP nonces matching every script, production security headers.');
