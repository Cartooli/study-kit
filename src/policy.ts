// Trusted Types policy "studykit": the only way script URLs (workers, service worker) get created.
// lib.dom has no Trusted Types typings; createScriptURL returns a TrustedScriptURL at runtime.
type Policy = { createScriptURL(url: string): string };
declare global {
  var trustedTypes: { createPolicy(name: string, rules: Policy): Policy } | undefined;
}

const allow = (u: string) => {
  const url = new URL(u, location.href);
  if (url.protocol === 'blob:' || (url.origin === location.origin && location.origin !== 'null')) return u;
  throw new TypeError('Blocked script URL');
};

const policy: Policy = globalThis.trustedTypes?.createPolicy('studykit', { createScriptURL: allow }) ?? { createScriptURL: allow };
export const scriptURL = (u: string) => policy.createScriptURL(u);
