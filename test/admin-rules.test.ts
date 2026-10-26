import { describe, expect, it } from 'vitest';
import { KEYWORD_TOO_SHORT_MESSAGE } from '../src/match.ts';
import { meta } from './support/meta.ts';
import { ACCESS_TOKEN, IG_USER, NOW, accountRow, ruleRows, seedAccount, seedRule, sentRows } from './support/seed.ts';
import { adminPath, commentPayload, postWebhook, signedInAdmin } from './support/worker.ts';

/** The escaping hono/html applies, so expectations can name what the page must contain. */
function escaped(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const validRule = {
  ig_user_id: IG_USER,
  label: 'Free guide',
  keywords: 'guide\nfreebie',
  match_mode: 'word',
  media_id: '',
  dm_text: 'Here it is: https://example.com/guide',
  public_reply_text: '',
};

async function adminWithAccount() {
  await seedAccount();
  return signedInAdmin();
}

describe('creating a rule from the admin form', () => {
  it('stores trimmed fields, one keyword per line, and lists the rule', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));

    const res = await admin.submit(adminPath('/rules'), {
      ...validRule,
      label: '  Free guide  ',
      keywords: ' guide \r\n\r\nfree pdf\n',
      dm_text: '  Here it is  ',
      public_reply_text: '   ',
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/rules'));
    expect(await ruleRows()).toMatchObject([
      {
        id: 1,
        ig_user_id: IG_USER,
        label: 'Free guide',
        keywords: '["guide","free pdf"]',
        media_id: null,
        dm_text: 'Here it is',
        public_reply_text: null,
        active: 1,
        created_at: NOW,
      },
    ]);
    const list = await admin.get(adminPath('/rules'));
    expect(list.text).toContain('Free guide');
    expect(list.text).toContain('guide, free pdf');
  });

  it('offers recent posts from Instagram as the "Which posts" options', async () => {
    meta.on('GET', '/me/media', {
      json: {
        data: [
          { id: '18000000000000001', caption: 'My  new\nreel', permalink: 'https://www.instagram.com/reel/abc/', media_product_type: 'REELS' },
          { id: '18000000000000002', caption: '', permalink: 'https://www.instagram.com/p/xyz/', media_product_type: 'FEED' },
        ],
      },
    });
    const admin = await adminWithAccount();
    const page = await admin.get(adminPath('/rules/new'));
    expect(page.text).toContain('value="18000000000000001"');
    expect(page.text).toContain('@creator · Reel · My new reel');
    expect(page.text).toContain('@creator · Post · https://www.instagram.com/p/xyz/');
    expect(meta.callsTo('GET', '/me/media')).toEqual([expect.objectContaining({ authorization: `Bearer ${ACCESS_TOKEN}` })]);
  });

  it('still renders the form when Instagram will not list posts', async () => {
    meta.on('GET', '/me/media', { status: 400, json: { error: { message: 'Invalid OAuth access token' } } });
    const admin = await adminWithAccount();
    const page = await admin.get(adminPath('/rules/new'));
    expect(page.status).toBe(200);
    expect(page.text).toContain('All posts and reels (recommended)');
  });

  it('asks for an account to be connected first when there is none', async () => {
    const admin = await signedInAdmin();
    const page = await admin.get(adminPath('/rules/new'));
    expect(page.text).toContain('Connect an Instagram account first');
  });

  it.each<[string, Partial<typeof validRule>, string]>([
    ['no name', { label: ' ' }, 'Give this rule a name.'],
    ['no keywords', { keywords: '\n \n' }, 'Add at least one keyword, one per line.'],
    ['a keyword under 3 characters', { keywords: 'guide\nAI' }, KEYWORD_TOO_SHORT_MESSAGE],
    ['a keyword under 3 characters once punctuation goes', { keywords: 'guide\nAI!!' }, KEYWORD_TOO_SHORT_MESSAGE],
    ['a keyword under 3 characters in contains mode', { keywords: 'launch\nAI', match_mode: 'contains' }, KEYWORD_TOO_SHORT_MESSAGE],
    ['a keyword with no letters or numbers', { keywords: 'guide\n🔥🔥🔥' }, '“🔥🔥🔥” has no letters or numbers.'],
    ['an unknown match mode', { match_mode: 'regex' }, 'Choose how to look for keywords'],
    ['no DM text', { dm_text: '   ' }, 'Write the private message to send.'],
    ['DM text over 1,000 characters', { dm_text: 'x'.repeat(1001) }, 'The private message must be 1,000 characters or fewer.'],
    ['a post link instead of an id', { media_id: 'https://www.instagram.com/reel/abc/' }, 'That looks like a link, not a post ID.'],
  ])('rejects a rule with %s and keeps what was typed', async (_, fields, message) => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, ...fields });
    expect(res.status).toBe(400);
    expect(res.text).toContain(escaped(message));
    expect(res.text).toContain(escaped(fields.dm_text ?? validRule.dm_text));
    expect(await ruleRows()).toEqual([]);
  });

  it('accepts DM text of exactly 1,000 characters', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, dm_text: 'x'.repeat(1000) });
    expect(res.status).toBe(302);
  });

  it('limits DM text in the browser with maxlength and a plain hint, and says how long a rejected one was', async () => {
    const admin = await adminWithAccount();
    const form = await admin.get(adminPath('/rules/new'));
    expect(form.text).toMatch(/<textarea id="dm_text" name="dm_text" required maxlength="1000">/);
    expect(form.text).toContain('Up to 1,000 characters.');
    const res = await admin.submit(adminPath('/rules'), { ...validRule, dm_text: 'x'.repeat(1234) });
    expect(res.status).toBe(400);
    expect(res.text).toContain('The private message must be 1,000 characters or fewer. This one is 1,234.');
  });

  it('counts a line break as one character, as maxlength does, though the browser sends CRLF', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const lines = Array.from({ length: 11 }, () => 'x'.repeat(90));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, dm_text: lines.join('\r\n') });
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([{ dm_text: lines.join('\n') }]);
  });
});

describe('choosing how keywords match', () => {
  const checked = (page: string, mode: string) =>
    new RegExp(`name="match_mode" value="${mode}"\\s+checked`).test(page);

  it('offers whole words first, already chosen, on a new rule', async () => {
    const admin = await adminWithAccount();
    const page = (await admin.get(adminPath('/rules/new'))).text;
    expect(checked(page, 'word')).toBe(true);
    expect(checked(page, 'contains')).toBe(false);
    expect(page).toContain('Contains also catches #launch2026, but “art” would match “start”.');
  });

  it('saves contains mode, shows it chosen when editing, and saves a switch back', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    await admin.submit(adminPath('/rules'), { ...validRule, keywords: 'launch', match_mode: 'contains' });
    expect(await ruleRows()).toMatchObject([{ keywords: '["launch"]', match_mode: 'contains' }]);

    const list = (await admin.get(adminPath('/rules'))).text;
    expect(list).toContain('Anywhere in the comment');

    const form = (await admin.get(adminPath('/rules/1/edit'))).text;
    expect(checked(form, 'contains')).toBe(true);
    expect(checked(form, 'word')).toBe(false);

    await admin.submit(adminPath('/rules/1'), { ...validRule, keywords: 'launch', match_mode: 'word' });
    expect(await ruleRows()).toMatchObject([{ match_mode: 'word' }]);
  });

  it('treats a form with no choice as whole words, as every older rule is', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const { match_mode: _, ...noMode } = validRule;
    expect((await admin.submit(adminPath('/rules'), noMode)).status).toBe(302);
    expect(await ruleRows()).toMatchObject([{ match_mode: 'word' }]);
  });

  it('keeps the chosen mode when the form comes back with an error', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, label: '', match_mode: 'contains' });
    expect(res.status).toBe(400);
    expect(checked(res.text, 'contains')).toBe(true);
  });
});

describe('editing, pausing and deleting rules', () => {
  it('shows the saved rule in the edit form and saves changes', async () => {
    const admin = await adminWithAccount();
    const id = await seedRule({ label: 'Old', keywords: ['guide', 'free pdf'], publicReply: 'Check DMs' });

    const form = await admin.get(adminPath(`/rules/${id}/edit`));
    expect(form.text).toContain('value="Old"');
    expect(form.text).toContain('>guide\nfree pdf</textarea>');

    const res = await admin.submit(adminPath(`/rules/${id}`), { ...validRule, label: 'New', keywords: 'recipe', media_id: '18000000000000777' });
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([
      expect.objectContaining({ id, label: 'New', keywords: '["recipe"]', media_id: '18000000000000777', public_reply_text: null }),
    ]);
  });

  it('validates edits the same way as new rules', async () => {
    const admin = await adminWithAccount();
    const id = await seedRule({ label: 'Old' });
    await admin.get(adminPath(`/rules/${id}/edit`));
    const res = await admin.submit(adminPath(`/rules/${id}`), { ...validRule, keywords: 'ok' });
    expect(res.status).toBe(400);
    expect(await ruleRows()).toEqual([expect.objectContaining({ label: 'Old' })]);
  });

  it('answers 404 for a rule that does not exist', async () => {
    const admin = await adminWithAccount();
    expect((await admin.get(adminPath('/rules/999/edit'))).status).toBe(404);
    expect((await admin.submit(adminPath('/rules/999'), validRule)).status).toBe(404);
  });

  it('pauses and resumes a rule', async () => {
    const admin = await adminWithAccount();
    const id = await seedRule();
    await admin.submit(adminPath(`/rules/${id}/toggle`));
    expect(await ruleRows()).toEqual([expect.objectContaining({ active: 0 })]);
    const list = await admin.get(adminPath('/rules'));
    expect(list.text).toContain('Resume');
    await admin.submit(adminPath(`/rules/${id}/toggle`));
    expect(await ruleRows()).toEqual([expect.objectContaining({ active: 1 })]);
  });

  it('deletes a rule only after a confirmation page, with no script involved', async () => {
    const admin = await adminWithAccount();
    const keep = await seedRule({ label: 'Keep' });
    const drop = await seedRule({ label: 'Drop', keywords: ['recipe', 'menu'] });

    const list = await admin.get(adminPath('/rules'));
    expect(list.text).toContain(`<a class="btn danger" href="${adminPath(`/rules/${drop}/delete`)}">Delete</a>`);
    expect(list.text).not.toContain(`action="${adminPath(`/rules/${drop}/delete`)}"`);

    const confirm = await admin.get(adminPath(`/rules/${drop}/delete`));
    expect(confirm.status).toBe(200);
    expect(confirm.text).toContain('Delete this rule?');
    expect(confirm.text).toContain('Drop');
    expect(confirm.text).toContain('recipe, menu');
    expect(confirm.text).toContain(`<form method="post" action="${adminPath(`/rules/${drop}/delete`)}">`);
    expect(confirm.text).toContain(`href="${adminPath('/rules')}">Keep it</a>`);
    expect(await ruleRows()).toHaveLength(2);

    const res = await admin.submit(adminPath(`/rules/${drop}/delete`));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/rules'));
    expect((await ruleRows()).map((r) => r.id)).toEqual([keep]);
  });

  it('answers 404 when asked to confirm deleting a rule that does not exist', async () => {
    const admin = await adminWithAccount();
    expect((await admin.get(adminPath('/rules/999/delete'))).status).toBe(404);
  });

  it('refuses a delete without the CSRF token', async () => {
    const admin = await adminWithAccount();
    const id = await seedRule();
    const res = await admin.post(adminPath(`/rules/${id}/delete`), {});
    expect(res.status).toBe(403);
    expect(await ruleRows()).toHaveLength(1);
  });
});

describe('HTML escaping of operator-supplied rule text', () => {
  const hostile = {
    label: '<script>alert("label")</script>',
    keywords: 'guide\n<img src=x onerror=alert(1)>',
    dm_text: "</textarea><script>alert('dm')</script>",
    public_reply_text: '"><svg onload=alert(1)>',
  };

  async function adminWithHostileRule() {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, ...hostile });
    expect(res.status).toBe(302);
    return admin;
  }

  it('escapes the rule list', async () => {
    const admin = await adminWithHostileRule();
    const page = (await admin.get(adminPath('/rules'))).text;
    expect(page).toContain(escaped(hostile.label));
    expect(page).toContain(escaped('guide, <img src=x onerror=alert(1)>'));
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('<img');
  });

  it('escapes the edit form, including text that tries to close the textarea', async () => {
    const admin = await adminWithHostileRule();
    const page = (await admin.get(adminPath('/rules/1/edit'))).text;
    expect(page).toContain(`value="${escaped(hostile.label)}"`);
    expect(page).toContain(`>${escaped(hostile.dm_text)}</textarea>`);
    expect(page).toContain(`>${escaped(hostile.public_reply_text)}</textarea>`);
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('<svg');
  });

  it('escapes the dry-run result', async () => {
    const admin = await adminWithHostileRule();
    await admin.get(adminPath('/test'));
    const page = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'guide please', media_id: '' })).text;
    expect(page).toContain(`This would match the rule <b>${escaped(hostile.label)}</b>`);
    expect(page).toContain(escaped(hostile.dm_text));
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('<svg');
  });
});

describe('the dry-run test page', () => {
  it('shows which rule would fire and sends nothing', async () => {
    const admin = await adminWithAccount();
    await seedRule({ label: 'Guide rule', dmText: 'Here you go', publicReply: 'Sent!' });
    await admin.get(adminPath('/test'));
    meta.clearCalls();
    const page = await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'Guide please!', media_id: '' });
    expect(page.text).toContain('This would match the rule <b>Guide rule</b>');
    expect(page.text).toContain('Here you go');
    expect(page.text).toContain('Sent!');
    expect(meta.calls).toEqual([]);
  });

  it('ignores paused rules', async () => {
    const admin = await adminWithAccount();
    await seedRule({ active: false });
    await admin.get(adminPath('/test'));
    const page = await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'guide', media_id: '' });
    expect(page.text).toContain('No rule would match this comment.');
  });

  it('shows the keyword it found and how the rule looks for it', async () => {
    const admin = await adminWithAccount();
    await seedRule({ label: 'Launch', keywords: ['guide', 'Launch'], matchMode: 'contains' });
    await admin.get(adminPath('/test'));
    const page = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'So ready for #LAUNCH2026!', media_id: '' })).text;
    expect(page).toContain('This would match the rule <b>Launch</b>');
    expect(page).toContain('<th>Keyword found</th><td>Launch</td>');
    expect(page).toContain('<th>Matching</th><td>Anywhere in the comment</td>');
    expect(page).toContain('<td>so ready for launch2026</td>');
  });

  it('says a whole-word rule would not fire inside a hashtag', async () => {
    const admin = await adminWithAccount();
    await seedRule({ label: 'Launch', keywords: ['launch'] });
    await admin.get(adminPath('/test'));
    const page = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: '#launch2026', media_id: '' })).text;
    expect(page).toContain('No rule would match this comment.');
    expect(page).toContain('<td>launch2026</td>');
    expect(page).toContain('<b>Whole words only</b> skip keywords inside longer words and hashtags');
  });

  it('names the same rule a real comment fires when two rules match', async () => {
    const admin = await adminWithAccount();
    const first = await seedRule({ label: 'First rule', keywords: ['guide'] });
    await seedRule({ label: 'Second rule', keywords: ['guide', 'pdf'] });

    await postWebhook(commentPayload({ text: 'guide pdf please' }));
    const [sent] = await sentRows();
    expect(sent).toMatchObject({ dm_status: 'ok', rule_id: first });

    await admin.get(adminPath('/test'));
    const page = await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'guide pdf please', media_id: '' });
    expect(page.text).toContain('This would match the rule <b>First rule</b>');
    expect(page.text).not.toContain('Second rule');
  });
});

describe('the accounts page', () => {
  it('shows the OAuth redirect URIs for this host', async () => {
    const admin = await adminWithAccount();
    const page = await admin.get(adminPath('/accounts'));
    expect(page.text).toContain('https://ig-comment-dm.example.workers.dev/connect/callback\nhttps://ig-comment-dm.example.workers.dev/connect/callback/');
    expect(page.text).toContain('@creator');
  });

  it('pauses and resumes an account', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/accounts'));
    await admin.submit(adminPath(`/accounts/${IG_USER}/deactivate`));
    expect(await accountRow()).toMatchObject({ active: 0 });
    await admin.get(adminPath('/accounts'));
    await admin.submit(adminPath(`/accounts/${IG_USER}/activate`));
    expect(await accountRow()).toMatchObject({ active: 1 });
  });
});
