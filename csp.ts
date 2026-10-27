// One source of truth for the hosted Content-Security-Policy (§14.3).
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types studykit',
  'upgrade-insecure-requests',
];
// frame-ancestors is ignored (with a console warning) in <meta>; the header carries it.
export const META_CSP = CSP.filter(d => !d.startsWith('frame-ancestors')).join('; ');
