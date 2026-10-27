/**
 * The parts of `npm run selftest` that decide things, kept free of the network
 * so scripts/test-unit.ts can check them directly.
 */

/** A Worker on this machine, where nobody else can reach the first-run setup page first. */
export function isLocalTarget(base: string): boolean {
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

export type AdminStep = 'setup' | 'login' | 'none' | 'refuse-setup';

/**
 * What to do with the page the admin URL answers. A Worker with no password
 * yet shows the setup page to whoever arrives first, and selftest would make
 * ADMIN_PASSWORD that password. That's fine on localhost, but on a deployed
 * Worker it's the operator's real password, so it takes --allow-setup.
 */
export function adminStep(html: string, opts: { local: boolean; allowSetup: boolean }): AdminStep {
  if (html.includes('Create your password')) return opts.local || opts.allowSetup ? 'setup' : 'refuse-setup';
  if (html.includes('name="password"') && html.includes('Log in')) return 'login';
  return 'none';
}
