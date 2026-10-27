import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { DAY, FROZEN_NOW_MS, NOW, ruleRows, seedAccount, systemValue } from './support/seed.ts';
import { FREE_ATTEMPTS, lockSecondsFor } from '../src/throttle.ts';
import { ADMIN_PASSWORD, Browser, adminPath, csrfFrom, request, signedInAdmin } from './support/worker.ts';

const ruleForm = { ig_user_id: '17841400000000001', label: 'Guide', keywords: 'guide', dm_text: 'hello' };

describe('the admin URL secret', () => {
  it.each([
    ['a wrong secret', '/a/not-the-secret/'],
    ['the secret missing its last character', `/a/${env.ADMIN_URL_SECRET.slice(0, -1)}/login`],
    ['no secret at all', '/a/'],
  ])('answers 404 for %s', async (_, path) => {
    const res = await request(path);
    expect(res.status).toBe(404);
    expect(res.setCookies).toEqual([]);
  });

  it('answers 404 to a POST on the wrong path and stores nothing', async () => {
    const res = await request('/a/not-the-secret/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=hunter2hunter2&confirm=hunter2hunter2',
    });
    expect(res.status).toBe(404);
    expect(await systemValue('admin_password_hash')).toBeNull();
  });

  it('marks admin pages uncacheable and locks down the CSP and referrer', async () => {
    const res = await request(adminPath('/setup'));
    expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });
});

describe('first-run password setup', () => {
  it('sends a first visitor to /setup with a short-lived session cookie', async () => {
    const res = await request(adminPath('/'));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/setup'));
    expect(res.setCookies).toEqual([expect.stringMatching(/^igcdm_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/)]);
  });

  it('saves a hashed password and signs the operator in', async () => {
    const browser = new Browser();
    const page = await browser.get(adminPath('/setup'));
    expect(page.text).toContain('Create your password');

    const res = await browser.submit(adminPath('/setup'), { password: ADMIN_PASSWORD, confirm: ADMIN_PASSWORD });

    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/'));
    expect(res.setCookies).toEqual([expect.stringMatching(/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/)]);
    const hash = await systemValue('admin_password_hash');
    expect(hash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(hash).not.toContain(ADMIN_PASSWORD);
    expect(await systemValue('admin_password_salt')).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect((await browser.get(adminPath('/rules'))).status).toBe(200);
  });

  it.each([
    ['shorter than 8 characters', 'short', 'short', 'Use at least 8 characters.'],
    ['not confirmed', 'long enough 1', 'long enough 2', 'Those two passwords did not match.'],
  ])('rejects a password that is %s', async (_, password, confirm, message) => {
    const browser = new Browser();
    await browser.get(adminPath('/setup'));
    const res = await browser.submit(adminPath('/setup'), { password, confirm });
    expect(res.status).toBe(400);
    expect(res.text).toContain(`<p class="err" role="alert">${message}</p>`);
    // The form comes back with the message, so there is no Back button to find.
    expect(res.text).toContain('<input id="password" name="password" type="password"');
    expect(await systemValue('admin_password_hash')).toBeNull();
  });

  it('cannot be used to replace an existing password', async () => {
    await signedInAdmin();
    const before = await systemValue('admin_password_hash');

    const stranger = new Browser();
    const page = await stranger.get(adminPath('/setup'));
    expect(page.status).toBe(302);
    expect(page.location).toBe(adminPath('/login'));
    const login = await stranger.get(adminPath('/login'));
    const res = await stranger.post(adminPath('/setup'), { csrf: csrfFrom(login.text), password: 'attacker-password', confirm: 'attacker-password' });

    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
    expect(await systemValue('admin_password_hash')).toBe(before);
  });
});

describe('login', () => {
  async function loginPage() {
    await signedInAdmin();
    const browser = new Browser();
    const page = await browser.get(adminPath('/login'));
    expect(page.status).toBe(200);
    return { browser, csrf: csrfFrom(page.text) };
  }

  it('signs in with the right password and clears the failure count', async () => {
    const { browser, csrf } = await loginPage();
    await browser.post(adminPath('/login'), { csrf, password: 'wrong password' });
    const res = await browser.post(adminPath('/login'), { csrf, password: ADMIN_PASSWORD });
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/'));
    expect(await systemValue('login_fail_count')).toBe('0');
    expect((await browser.get(adminPath('/rules'))).status).toBe(200);
  });

  it('rejects a wrong password with 401 and counts it', async () => {
    const { browser, csrf } = await loginPage();
    const res = await browser.post(adminPath('/login'), { csrf, password: 'wrong password' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Wrong password.');
    expect(res.setCookies).toEqual([]);
    expect(await systemValue('login_fail_count')).toBe('1');
  });

  it('allows five wrong passwords, then locks for a minute, refusing even the right one', async () => {
    const { browser, csrf } = await loginPage();
    for (let i = 0; i < 5; i++) {
      const res = await browser.post(adminPath('/login'), { csrf, password: `wrong ${i}` });
      expect(res.status).toBe(401);
      expect(res.text).not.toContain('Too many wrong passwords');
    }

    const sixth = await browser.post(adminPath('/login'), { csrf, password: 'wrong 6' });
    expect(sixth.status).toBe(401);
    expect(sixth.text).toContain('Too many wrong passwords. Logging in is paused for 60 seconds');
    // One lock covers the panel, so the page mustn't suggest another browser would get in.
    expect(sixth.text).toContain('on every browser, not just this one');
    expect(await systemValue('login_locked_until')).toBe(String(NOW + 60));

    const locked = await browser.post(adminPath('/login'), { csrf, password: ADMIN_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.setCookies).toEqual([]);
    expect((await browser.get(adminPath('/login'))).text).toContain('Too many wrong passwords');

    vi.setSystemTime(FROZEN_NOW_MS + 61_000);
    const after = await browser.post(adminPath('/login'), { csrf, password: ADMIN_PASSWORD });
    expect(after.status).toBe(302);
  });

  it('counts every wrong password when several arrive at once', async () => {
    await signedInAdmin();
    const guessers = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const browser = new Browser();
        await browser.get(adminPath('/login'));
        return browser;
      }),
    );
    const replies = await Promise.all(guessers.map((b, i) => b.submit(adminPath('/login'), { password: `wrong ${i}` })));
    expect(replies.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(await systemValue('login_fail_count')).toBe('5');
  });

  async function burst(passwords: string[]) {
    await signedInAdmin();
    const guessers = await Promise.all(
      passwords.map(async () => {
        const browser = new Browser();
        await browser.get(adminPath('/login'));
        return browser;
      }),
    );
    return Promise.all(guessers.map((b, i) => b.submit(adminPath('/login'), { password: passwords[i]! })));
  }

  it('checks no more passwords than the free attempts allow when 60 arrive at once', async () => {
    const replies = await burst(Array.from({ length: 60 }, (_, i) => `wrong ${i}`));
    // 401 means the password was hashed and compared; 429 means it never was.
    const checked = replies.filter((r) => r.status === 401).length;
    expect(checked).toBe(FREE_ATTEMPTS + 1);
    expect(replies.filter((r) => r.status === 429)).toHaveLength(60 - checked);
    expect(await systemValue('login_fail_count')).toBe(String(FREE_ATTEMPTS + 1));
    expect(await systemValue('login_locked_until')).toBe(String(NOW + 60));
  });

  it('refuses the right password when it arrives in a burst that already used the free attempts', async () => {
    const replies = await burst([...Array.from({ length: 59 }, (_, i) => `wrong ${i}`), ADMIN_PASSWORD]);
    const last = replies.at(-1)!;
    expect(last.status).toBe(429);
    expect(last.setCookies).toEqual([]);
    expect(replies.filter((r) => r.status === 302)).toEqual([]);
  });

  it('locks for as long as lockSecondsFor says, up to the hour cap', async () => {
    const { browser, csrf } = await loginPage();
    let clock = FROZEN_NOW_MS;
    for (let fails = 1; fails <= FREE_ATTEMPTS + 9; fails++) {
      const res = await browser.post(adminPath('/login'), { csrf, password: `wrong ${fails}` });
      expect(res.status).toBe(401);
      const lock = lockSecondsFor(fails);
      if (lock > 0) expect(await systemValue('login_locked_until')).toBe(String(clock / 1000 + lock));
      clock += (lock + 1) * 1000;
      vi.setSystemTime(clock);
    }
    expect(lockSecondsFor(FREE_ATTEMPTS + 9)).toBe(60 * 60);
  });

  it('doubles the lock on the next wrong password after it expires', async () => {
    const { browser, csrf } = await loginPage();
    for (let i = 0; i < 6; i++) await browser.post(adminPath('/login'), { csrf, password: `wrong ${i}` });
    vi.setSystemTime(FROZEN_NOW_MS + 61_000);
    const seventh = await browser.post(adminPath('/login'), { csrf, password: 'wrong 7' });
    expect(seventh.text).toContain('Logging in is paused for 2 minutes');
    expect(await systemValue('login_locked_until')).toBe(String(NOW + 61 + 120));
  });
});

describe('sessions', () => {
  it('sends an unauthenticated visitor to /login once a password exists', async () => {
    await signedInAdmin();
    const res = await new Browser().get(adminPath('/rules'));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
  });

  it('treats a tampered session cookie as no session', async () => {
    const admin = await signedInAdmin();
    const [, value] = admin.cookieHeader.split('=');
    const forged = new Browser();
    const [payload, mac] = value!.split('.');
    forged.setCookie('igcdm_session', `${payload}.${mac!.startsWith('A') ? 'B' : 'A'}${mac!.slice(1)}`);
    const res = await forged.get(adminPath('/rules'));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
  });

  it('rejects a session cookie signed with another key', async () => {
    const admin = await signedInAdmin();
    const res = await request(adminPath('/rules'), {
      headers: { Cookie: admin.cookieHeader },
      env: { SESSION_SIGNING_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) },
    });
    expect(res.status).toBe(302);
  });

  it('expires an authed session after 30 days', async () => {
    const admin = await signedInAdmin();
    vi.setSystemTime(FROZEN_NOW_MS + 30 * DAY * 1000 + 1000);
    const res = await admin.get(adminPath('/rules'));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
  });

  it('logs out by clearing the cookie, and says it was on every browser', async () => {
    const admin = await signedInAdmin();
    const res = await admin.submit(adminPath('/logout'));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login?out=1'));
    expect(res.setCookies).toEqual([expect.stringContaining('igcdm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')]);
    expect((await admin.get(adminPath('/login?out=1'))).text).toContain('Logged out on every browser and device.');
    expect((await admin.get(adminPath('/rules'))).status).toBe(302);
  });

  function copyOf(browser: Browser): Browser {
    const copy = new Browser();
    copy.setCookie('igcdm_session', browser.cookie('igcdm_session')!);
    return copy;
  }

  it('stops a copied session cookie working once its owner logs out', async () => {
    const admin = await signedInAdmin();
    const copy = copyOf(admin);
    expect((await copy.get(adminPath('/rules'))).status).toBe(200);

    await admin.submit(adminPath('/logout'));

    const res = await copy.get(adminPath('/rules'));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
    expect((await copy.get('/connect/start')).status).toBe(403);
  });

  it('logs out every browser, not just the one that pressed the button', async () => {
    const first = await signedInAdmin();
    const second = new Browser();
    await second.get(adminPath('/login'));
    await second.submit(adminPath('/login'), { password: ADMIN_PASSWORD });
    expect((await second.get(adminPath('/rules'))).status).toBe(200);

    await first.submit(adminPath('/logout'));

    expect((await second.get(adminPath('/rules'))).status).toBe(302);
    // And signing in again afterwards works as normal.
    await second.get(adminPath('/login'));
    expect((await second.submit(adminPath('/login'), { password: ADMIN_PASSWORD })).status).toBe(302);
    expect((await second.get(adminPath('/rules'))).status).toBe(200);
  });

  it('stops an old session cookie working after the documented password reset', async () => {
    const admin = await signedInAdmin();
    const copy = copyOf(admin);

    await env.DB.exec("DELETE FROM system WHERE key IN ('admin_password_hash','admin_password_salt');");
    const operator = new Browser();
    await operator.get(adminPath('/setup'));
    await operator.submit(adminPath('/setup'), { password: 'a brand new password', confirm: 'a brand new password' });
    expect((await operator.get(adminPath('/rules'))).status).toBe(200);

    const res = await copy.get(adminPath('/rules'));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
    expect((await copy.get('/connect/start')).status).toBe(403);
  });

  it('turns away a session cookie signed the way it was before sessions were bound to the password', async () => {
    await signedInAdmin();
    // The old format: an HMAC of the payload alone, with nothing tying it to
    // the current password or logout.
    const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp: NOW + DAY, csrf: 'c'.repeat(32), authed: true })));
    const raw = Uint8Array.from(atob(env.SESSION_SIGNING_KEY), (ch) => ch.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
    const old = new Browser();
    old.setCookie('igcdm_session', `${payload}.${b64url(mac)}`);
    const res = await old.get(adminPath('/rules'));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
  });
});

describe('CSRF protection on admin forms', () => {
  it.each([
    ['a wrong token', { csrf: 'not-the-token' }],
    ['no token', {}],
  ])('rejects a mutating POST with %s', async (_, extra) => {
    await seedAccount();
    const admin = await signedInAdmin();
    const res = await admin.post(adminPath('/rules'), { ...ruleForm, ...extra });
    expect(res.status).toBe(403);
    expect(res.text).toContain('That form expired');
    expect(await ruleRows()).toEqual([]);
  });

  it('rejects logout without the token, so a cross-site form cannot sign the operator out', async () => {
    const admin = await signedInAdmin();
    const res = await admin.post(adminPath('/logout'), {});
    expect(res.status).toBe(403);
    expect(res.setCookies).toEqual([]);
  });

  it('rejects a token from a different session', async () => {
    await seedAccount();
    const admin = await signedInAdmin();
    const other = await new Browser().get(adminPath('/login'));
    const res = await admin.post(adminPath('/rules'), { ...ruleForm, csrf: csrfFrom(other.text) });
    expect(res.status).toBe(403);
  });

  it('sends a POST with no session cookie to /login without acting on it', async () => {
    await seedAccount();
    await signedInAdmin();
    const res = await new Browser().post(adminPath('/rules'), ruleForm);
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
    expect(await ruleRows()).toEqual([]);
  });

  it('does not let a valid but unauthenticated session act', async () => {
    await seedAccount();
    await signedInAdmin();
    const guest = new Browser();
    const page = await guest.get(adminPath('/login'));
    const res = await guest.post(adminPath('/rules'), { ...ruleForm, csrf: csrfFrom(page.text) });
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
    expect(await ruleRows()).toEqual([]);
  });
});
