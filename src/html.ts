import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

const CSS = `
:root { color: #111; background: #f6f6f4; font: 15px/1.45 system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 44rem; margin: 0 auto; padding: 1.25rem 1rem 4rem; }
header.top { border-bottom: 1px solid #ddd; background: #fff; }
header.top nav { max-width: 44rem; margin: 0 auto; padding: 0.65rem 1rem; display: flex; gap: 0.9rem; align-items: center; flex-wrap: wrap; }
header.top nav a { color: #111; text-decoration: none; }
header.top nav a:hover { text-decoration: underline; }
header.top .brand { font-weight: 650; margin-right: 0.5rem; }
header.top form { margin-left: auto; }
h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
h2 { font-size: 1.05rem; margin: 1.5rem 0 0.5rem; }
p { margin: 0.5rem 0; }
.muted { color: #555; font-size: 0.88rem; }
.banner { background: #fde8e8; border: 1px solid #c23; color: #411; padding: 0.7rem 0.85rem; margin: 0 0 1rem; }
.banner a { color: #411; font-weight: 650; }
.ok { background: #e7f6ea; border: 1px solid #2a6; color: #143; padding: 0.7rem 0.85rem; margin: 0 0 1rem; }
.err { color: #a11; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e4e4e0; }
th, td { text-align: left; padding: 0.4rem 0.55rem; border-bottom: 1px solid #eee; vertical-align: top; font-size: 0.9rem; }
th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; color: #555; background: #fafafa; }
label { display: block; font-weight: 650; margin: 0.85rem 0 0.25rem; }
input[type=text], input[type=password], textarea, select {
  width: 100%; padding: 0.4rem 0.5rem; font: inherit; border: 1px solid #ccc; background: #fff;
}
textarea { min-height: 6rem; }
.row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-top: 0.75rem; }
button, .btn {
  background: #111; color: #fff; border: 0; padding: 0.42rem 0.8rem; font: inherit; cursor: pointer;
  text-decoration: none; display: inline-block;
}
button.secondary, a.btn.secondary { background: #fff; color: #111; border: 1px solid #bbb; }
button.danger { background: #a11; }
.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem; margin: 0.75rem 0 1.25rem; }
.kpi { background: #fff; border: 1px solid #e4e4e0; padding: 0.65rem 0.75rem; }
.kpi b { display: block; font-size: 1.35rem; }
pre.raw { background: #111; color: #eee; padding: 0.6rem 0.7rem; overflow: auto; font-size: 0.78rem; }
.actions form { display: inline; }
code { font-size: 0.88em; }
`;

export function csrfField(token: string) {
  return html`<input type="hidden" name="csrf" value="${token}" />`;
}

export function layout(opts: {
  title: string;
  base?: string;
  csrf?: string;
  body: HtmlEscapedString | Promise<HtmlEscapedString>;
}) {
  const nav = opts.base
    ? html`
        <header class="top">
          <nav>
            <span class="brand">Comment to DM</span>
            <a href="${opts.base}/">Home</a>
            <a href="${opts.base}/rules">Rules</a>
            <a href="${opts.base}/test">Test</a>
            <a href="${opts.base}/accounts">Accounts</a>
            <form method="post" action="${opts.base}/logout">
              ${opts.csrf ? csrfField(opts.csrf) : html``}
              <button class="secondary" type="submit">Log out</button>
            </form>
          </nav>
        </header>
      `
    : html``;
  return html`<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${opts.title}</title>
        <style>
          ${raw(CSS)}
        </style>
      </head>
      <body>
        ${nav}
        <main>${opts.body}</main>
      </body>
    </html>`;
}

export function pageError(plain: string, detail?: string) {
  return html`
    <h1>Something went wrong</h1>
    <p>${plain}</p>
    ${detail ? html`<p class="muted">Technical detail:</p><pre class="raw">${detail}</pre>` : html``}
  `;
}

export function fmtWhen(unix: number): string {
  const d = new Date(unix * 1000);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function daysUntil(expiresAt: number, now: number): number {
  return Math.floor((expiresAt - now) / 86400);
}

export function statusWords(dm: string): string {
  if (dm === 'ok') return 'Sent';
  if (dm === 'failed') return 'Failed';
  if (dm === 'skipped') return 'Skipped';
  if (dm === 'pending') return 'In progress';
  return dm;
}
