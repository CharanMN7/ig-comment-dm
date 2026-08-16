import { Hono } from 'hono';
import { html } from 'hono/html';
import { layout } from '../html.ts';
import type { Env } from '../types.ts';

export const legalRoutes = new Hono<{ Bindings: Env }>();

legalRoutes.get('/privacy', (c) =>
  c.html(
    layout({
      title: 'Privacy Policy',
      body: html`
        <h1>Privacy Policy</h1>
        <p class="muted">Last updated 16 August 2026</p>
        <p>
          This program is a self-hosted Instagram comment-to-DM helper. It runs on the operator’s
          Cloudflare Worker. There is no public signup.
        </p>
        <h2>Data stored</h2>
        <p>
          Encrypted Instagram access tokens, Instagram account ids and usernames, keyword rules,
          comment ids needed to avoid sending twice, delivery status, and a short preview of
          incoming Instagram notifications so failures can be diagnosed.
        </p>
        <h2>How it is used</h2>
        <p>
          Data is used only to match comment keywords and send one official Instagram private
          reply (and an optional public reply) through Meta’s APIs. Instagram passwords are never
          collected. There is no advertising and no sale of data.
        </p>
        <h2>Hosting</h2>
        <p>The Worker and database run on Cloudflare. Meta receives API calls needed to send replies.</p>
        <h2>Contact</h2>
        <p>Questions go to the person who deployed this copy.</p>
      `,
    }),
  ),
);

legalRoutes.get('/terms', (c) =>
  c.html(
    layout({
      title: 'Terms of Service',
      body: html`
        <h1>Terms of Service</h1>
        <p class="muted">Last updated 16 August 2026</p>
        <p>
          This software is provided as-is for the operator who deployed it. Use of Instagram is
          subject to Meta’s terms. Do not use it to spam, scrape, or contact people who have not
          commented with a matching keyword.
        </p>
        <p>
          The operator is responsible for keeping Meta app credentials secret, for the content of
          automated messages, and for complying with Instagram Platform Policy.
        </p>
      `,
    }),
  ),
);

legalRoutes.get('/data-deletion', (c) =>
  c.html(
    layout({
      title: 'Data deletion',
      body: html`
        <h1>Data deletion</h1>
        <p class="muted">Last updated 16 August 2026</p>
        <p>
          To stop Instagram access, open the admin Accounts page and disconnect, or revoke the app
          under Instagram Settings → Apps and websites.
        </p>
        <p>
          To delete stored tokens, rules, and send logs, the operator can wipe the Cloudflare D1
          database for this Worker. There is no shared multi-tenant store.
        </p>
      `,
    }),
  ),
);
