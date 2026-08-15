/**
 * Run against a deployed (or wrangler dev) URL:
 *
 *   ADMIN_URL_SECRET=... WEBHOOK_VERIFY_TOKEN=... META_APP_SECRET=... \
 *   ADMIN_PASSWORD=... node --experimental-strip-types scripts/selftest.ts https://YOUR.workers.dev
 */
import { hmacSha256Hex, nowSeconds } from '../src/crypto.ts';

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const VERIFY = required('WEBHOOK_VERIFY_TOKEN');
const APP_SECRET = required('META_APP_SECRET');
const ADMIN_SECRET = required('ADMIN_URL_SECRET');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'selftest-password-change-me';

const ADMIN = `${BASE}/a/${ADMIN_SECRET}`;
const IG_USER = 'selftest_ig_user';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return v;
}

class CookieJar {
  private map = new Map<string, string>();
  header(): string {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  eat(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0];
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq > 0) this.map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

const jar = new CookieJar();
let fails = 0;

function report(ok: boolean, name: string, detail = ''): void {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function req(url: string, init: RequestInit = {}, cookies = jar): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = cookies.header();
  if (cookie) headers.set('Cookie', cookie);
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  cookies.eat(res);
  return res;
}

function csrfFrom(html: string): string {
  const m = html.match(/name="csrf"\s+value="([^"]+)"/);
  if (!m) throw new Error('no csrf token on page');
  return m[1]!;
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  cookies = jar,
): Promise<Response> {
  return req(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    },
    cookies,
  );
}

async function signedPost(payload: unknown): Promise<Response> {
  const raw = JSON.stringify(payload);
  const hex = await hmacSha256Hex(APP_SECRET, raw);
  return fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${hex}`,
    },
    body: raw,
  });
}

function commentPayload(commentId: string, fromId: string, text = 'hello there'): unknown {
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_USER,
        time: nowSeconds(),
        changes: [
          {
            field: 'comments',
            value: {
              id: commentId,
              text,
              from: { id: fromId, username: 'tester' },
              media: { id: 'media_selftest' },
            },
          },
        ],
      },
    ],
  };
}

async function pollSent(
  commentId: string,
  wantCount: number,
  attempts = 20,
): Promise<number> {
  let last = -1;
  for (let i = 0; i < attempts; i++) {
    const res = await req(`${ADMIN}/selftest/status?comment_id=${encodeURIComponent(commentId)}`);
    if (res.status === 200) {
      const json = (await res.json()) as { count: number };
      last = json.count;
      if (json.count === wantCount) return json.count;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

async function follow(res: Response, cookies = jar): Promise<Response> {
  for (let i = 0; i < 5 && res.status === 302; i++) {
    const loc = res.headers.get('Location') || `${ADMIN}/`;
    const url = loc.startsWith('http') ? loc : `${BASE}${loc}`;
    res = await req(url, {}, cookies);
  }
  return res;
}

async function loginOrSetup(): Promise<void> {
  let page = await follow(await req(`${ADMIN}/`));
  let html = await page.text();
  if (html.includes('Create your password')) {
    page = await follow(
      await postForm(`${ADMIN}/setup`, {
        csrf: csrfFrom(html),
        password: ADMIN_PASSWORD,
        confirm: ADMIN_PASSWORD,
      }),
    );
    return;
  }
  if (html.includes('name="password"') && html.includes('Log in')) {
    await follow(await postForm(`${ADMIN}/login`, { csrf: csrfFrom(html), password: ADMIN_PASSWORD }));
  }
}

async function main() {
  console.log(`selftest → ${BASE}\n`);

  const challenge = `chal_${Date.now()}`;
  const hs = await fetch(
    `${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY)}&hub.challenge=${encodeURIComponent(challenge)}`,
  );
  report(hs.status === 200 && (await hs.text()) === challenge, 'GET /webhook handshake with the right token returns the challenge');

  const badHs = await fetch(
    `${BASE}/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=${encodeURIComponent(challenge)}`,
  );
  report(badHs.status === 403, 'GET /webhook with a wrong token returns 403');

  const badSig = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${'00'.repeat(32)}` },
    body: '{"object":"instagram","entry":[]}',
  });
  report(badSig.status === 401, 'POST /webhook with a bad signature returns 401');

  await loginOrSetup();

  const guest = new CookieJar();
  const loginPage = await req(`${ADMIN}/login`, {}, guest);
  const loginHtml = await loginPage.text();
  report(
    loginPage.status === 200 && /name="password"/.test(loginHtml),
    'the admin URL returns a login page',
  );
  if (/name="password"/.test(loginHtml)) {
    const wrong = await postForm(
      `${ADMIN}/login`,
      { csrf: csrfFrom(loginHtml), password: 'definitely-wrong-password' },
      guest,
    );
    const wrongText = await wrong.text();
    report(wrong.status === 401 && wrongText.includes('Wrong password'), 'a wrong password is rejected');
  } else {
    report(false, 'a wrong password is rejected', 'could not load login form (already signed in on this cookie jar?)');
  }

  const home = await follow(await req(`${ADMIN}/`));
  const homeHtml = await home.text();
  const seed = await postForm(`${ADMIN}/selftest/seed`, { csrf: csrfFrom(homeHtml) });
  report(seed.status === 200, 'selftest seed account', seed.status === 200 ? '' : `HTTP ${seed.status}`);

  const commentId = `cmt_${Date.now()}`;
  const payload = commentPayload(commentId, 'someone_else');
  const post1 = await signedPost(payload);
  report(post1.status === 200, 'POST /webhook with a valid signature and a synthetic comment returns 200');
  const count1 = await pollSent(commentId, 1);
  report(count1 === 1, 'that payload creates exactly one sent row', `count=${count1}`);

  const post2 = await signedPost(payload);
  report(post2.status === 200, 'the same payload posted twice still returns 200');
  const count2 = await pollSent(commentId, 1);
  report(count2 === 1, 'the duplicate delivery creates exactly ONE sent row', `count=${count2}`);

  const selfId = `cmt_self_${Date.now()}`;
  const selfPost = await signedPost(commentPayload(selfId, IG_USER));
  report(selfPost.status === 200, 'self-comment payload returns 200');
  const countSelf = await pollSent(selfId, 0);
  report(countSelf === 0, 'a payload where from.id equals the account id creates NO send', `count=${countSelf}`);

  const cronHome = await follow(await req(`${ADMIN}/`));
  const cronRes = await follow(await postForm(`${ADMIN}/run-cron`, { csrf: csrfFrom(await cronHome.text()) }));
  void cronRes;
  const status = (await (await req(`${ADMIN}/selftest/status`)).json()) as { last_cron_ok_at: string | null };
  const cronN = status.last_cron_ok_at ? parseInt(status.last_cron_ok_at, 10) : NaN;
  report(
    Number.isFinite(cronN) && Math.abs(nowSeconds() - cronN) < 180,
    'the scheduled handler runs without error and writes last_cron_ok_at',
    String(status.last_cron_ok_at),
  );

  console.log('');
  if (fails) {
    console.log(`${fails} failed`);
    process.exit(1);
  }
  console.log('all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
