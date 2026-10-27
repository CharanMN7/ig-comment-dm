import { describe, expect, it } from 'vitest';
import { EXCLUSION_TOO_SHORT_MESSAGE, KEYWORD_TOO_SHORT_MESSAGE } from '../src/match.ts';
import { MATCH_ALL_NEEDS_POST_MESSAGE } from '../src/routes/admin.ts';
import { LINK_MARKER, TEMPLATES, findTemplate } from '../src/templates.ts';
import { meta } from './support/meta.ts';
import { ACCESS_TOKEN, IG_USER, NOW, accountRow, ruleRows, seedAccount, seedRule, sentRows } from './support/seed.ts';
import { Browser, adminPath, commentPayload, postWebhook, signedInAdmin } from './support/worker.ts';

/** The escaping hono/html applies, so expectations can name what the page must contain. */
function escaped(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const validRule = {
  ig_user_id: IG_USER,
  label: 'Free guide',
  keywords: 'guide\nfreebie',
  match_mode: 'word',
  exclude_keywords: '',
  media_id: '',
  dm_text: 'Here it is: https://ana.studio/guide',
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
    expect(res.location).toBe(adminPath('/rules?done=rule-saved'));
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
    ['a one-character Chinese keyword', { keywords: 'guide\n指' }, KEYWORD_TOO_SHORT_MESSAGE],
    ['a two-character keyword mixing Latin and Chinese', { keywords: 'guide\na指' }, KEYWORD_TOO_SHORT_MESSAGE],
    ['a two-code-point Thai keyword', { keywords: 'guide\nดี' }, KEYWORD_TOO_SHORT_MESSAGE],
    ['a keyword with no letters or numbers', { keywords: 'guide\n🔥🔥🔥' }, '“🔥🔥🔥” has no letters or numbers.'],
    ['an unknown match mode', { match_mode: 'regex' }, 'Choose how to look for keywords'],
    ['an exclusion under 3 characters', { exclude_keywords: 'how much\nno' }, EXCLUSION_TOO_SHORT_MESSAGE],
    ['an exclusion with no letters or numbers', { exclude_keywords: '👎👎👎' }, '“👎👎👎” has no letters or numbers.'],
    [
      'an exclusion inside a keyword',
      { keywords: 'free guide\npdf', exclude_keywords: 'guide' },
      'The keyword “free guide” could never get a message, because it contains the exclusion “guide”.',
    ],
    ['no DM text', { dm_text: '   ' }, 'Write the private message to send.'],
    ['DM text over 1,000 characters', { dm_text: 'x'.repeat(1001) }, 'The private message must be 1,000 characters or fewer.'],
    ['a post link instead of an id', { media_id: 'https://www.instagram.com/reel/abc/' }, 'That looks like a link, not a post ID.'],
    [
      'DM text a long username could push past 1,000 characters',
      { dm_text: `${'x'.repeat(981)}{username}` },
      'The private message must be 1,000 characters or fewer. This one is 991, and each {username} can add up to 20 characters for a long name, so it could reach 1,011.',
    ],
    ['DM text that is only {username}', { dm_text: ' {username} ' }, 'The private message needs more than {username}.'],
    ['a public reply over 1,000 characters', { public_reply_text: 'x'.repeat(1001) }, 'The public reply must be 1,000 characters or fewer. This one is 1,001.'],
    [
      'a public reply a long username could push past 1,000 characters',
      { public_reply_text: `${'x'.repeat(971)}{username}{username}` },
      'The public reply must be 1,000 characters or fewer. This one is 991, and each {username} can add up to 20 characters for a long name, so it could reach 1,031.',
    ],
    ['a public reply that is only {username}', { public_reply_text: '@{username}' }, 'The public reply needs more than {username}.'],
    [
      'the template link marker still in the DM',
      { dm_text: `Here it is: ${LINK_MARKER}` },
      `The private message still says ${LINK_MARKER}. Replace it with your own link, or delete it, before saving.`,
    ],
    [
      'a sample link in the DM',
      { dm_text: 'Book here: calendly.com/example' },
      'The private message links to “calendly.com/example”, a sample address that isn’t yours.',
    ],
    [
      'a sample link in the public reply',
      { public_reply_text: 'Also on https://example.org/guide' },
      'The public reply links to “https://example.org/guide”, a sample address that isn’t yours.',
    ],
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

  it('accepts text that fits 1,000 characters with the longest possible username', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const dm = `${'x'.repeat(970)}{username}`;
    const reply = `${'y'.repeat(940)}{Username}{USERNAME}`;
    const res = await admin.submit(adminPath('/rules'), { ...validRule, dm_text: dm, public_reply_text: reply });
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([{ dm_text: dm, public_reply_text: reply }]);
  });

  it('counts a line break as one character in the username allowance too', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    // 979 characters with LF, 988 with CRLF: only the LF count leaves room for a 30-character name.
    const lines = Array.from({ length: 10 }, () => 'x'.repeat(96));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, dm_text: `${lines.join('\r\n')}{username}` });
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([{ dm_text: `${lines.join('\n')}{username}` }]);
  });

  it('documents {username} on the form and caps the public reply in the browser too', async () => {
    const admin = await adminWithAccount();
    const form = await admin.get(adminPath('/rules/new'));
    expect(form.text).toContain('<code>{username}</code> puts in their Instagram name and counts as 30.');
    expect(form.text).toContain('the only placeholder for now');
    expect(form.text).toMatch(/<textarea id="public_reply_text" name="public_reply_text" maxlength="1000">/);
  });

  it('counts a line break as one character, as maxlength does, though the browser sends CRLF', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const lines = Array.from({ length: 11 }, () => 'x'.repeat(90));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, dm_text: lines.join('\r\n') });
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([{ dm_text: lines.join('\n') }]);
  });

  it('saves a two-character Chinese keyword and DMs a comment that has it mid-sentence', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, keywords: '指南' });
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([{ keywords: '["指南"]', match_mode: 'word' }]);

    await postWebhook(commentPayload({ text: '请发指南给我' }));

    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
    expect(await sentRows()).toMatchObject([{ rule_id: 1, dm_status: 'ok' }]);
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

describe('messages after a rule changes', () => {
  const note = (text: string) => `<div class="ok" role="status">${text}`;

  it('says a new or edited rule was saved, with a link to try it, and only right after saving', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const created = await admin.submit(adminPath('/rules'), validRule);
    const list = (await admin.get(created.location!)).text;
    expect(list).toContain(note(`Rule saved. <a href="${adminPath('/test')}">Try it with a sample comment</a>.`));
    expect((await admin.get(adminPath('/rules'))).text).not.toContain('class="ok"');

    await admin.get(adminPath('/rules/1/edit'));
    const edited = await admin.submit(adminPath('/rules/1'), { ...validRule, label: 'Renamed' });
    expect(edited.location).toBe(adminPath('/rules?done=rule-saved'));
  });

  it('says whether Pause or Resume just happened', async () => {
    const admin = await adminWithAccount();
    const id = await seedRule();
    await admin.get(adminPath('/rules'));
    const paused = await admin.submit(adminPath(`/rules/${id}/toggle`));
    expect(paused.location).toBe(adminPath('/rules?done=rule-paused'));
    expect((await admin.get(paused.location!)).text).toContain(note('Rule paused.'));
    const resumed = await admin.submit(adminPath(`/rules/${id}/toggle`));
    expect(resumed.location).toBe(adminPath('/rules?done=rule-resumed'));
    expect((await admin.get(resumed.location!)).text).toContain(note('Rule resumed.'));
  });

  it('says a deleted rule is gone', async () => {
    const admin = await adminWithAccount();
    const id = await seedRule();
    await admin.get(adminPath(`/rules/${id}/delete`));
    const res = await admin.submit(adminPath(`/rules/${id}/delete`));
    expect((await admin.get(res.location!)).text).toContain(note('Rule deleted.'));
  });

  it('shows nothing for a code it does not know, so a link cannot put words on the page', async () => {
    const admin = await adminWithAccount();
    const page = (await admin.get(adminPath('/rules?done=%3Cb%3Ehi%3C%2Fb%3E'))).text;
    expect(page).not.toContain('class="ok"');
    expect(page).not.toContain('<b>hi</b>');
    expect((await admin.get(adminPath('/rules?done=constructor'))).text).not.toContain('class="ok"');
  });
});

describe('exclusions on the rule form', () => {
  it('saves one exclusion per line, shows them when editing and in the list, and clears them', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, exclude_keywords: ' how much \r\n\r\nalready have it\n' });
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([{ exclude_keywords: '["how much","already have it"]' }]);

    expect((await admin.get(adminPath('/rules'))).text).toContain('Exclusions: how much, already have it');
    expect((await admin.get(adminPath('/rules/1/edit'))).text).toContain('>how much\nalready have it</textarea>');

    await admin.submit(adminPath('/rules/1'), { ...validRule, exclude_keywords: '  ' });
    expect(await ruleRows()).toMatchObject([{ exclude_keywords: '[]' }]);
  });

  it('stores an empty list when the field is left out', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const { exclude_keywords: _, ...noExclusions } = validRule;
    expect((await admin.submit(adminPath('/rules'), noExclusions)).status).toBe(302);
    expect(await ruleRows()).toMatchObject([{ exclude_keywords: '[]' }]);
  });

  it('keeps typed exclusions when the form comes back with an error', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), { ...validRule, label: '', exclude_keywords: 'how much' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('>how much</textarea>');
  });

  it('escapes exclusions in the list and the edit form', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    await admin.submit(adminPath('/rules'), { ...validRule, exclude_keywords: '<b>price</b>' });
    expect((await admin.get(adminPath('/rules'))).text).toContain('Exclusions: &lt;b&gt;price&lt;/b&gt;');
    expect((await admin.get(adminPath('/rules/1/edit'))).text).toContain('>&lt;b&gt;price&lt;/b&gt;</textarea>');
  });
});

describe('replying to every comment on a post', () => {
  const giveaway = { ...validRule, label: 'Giveaway', keywords: '', media_id: '18000000000000777', match_all: '1' };

  it('offers the box, keeps the all-posts option and its help, and leaves keywords optional in the browser', async () => {
    const admin = await adminWithAccount();
    const page = (await admin.get(adminPath('/rules/new'))).text;
    expect(page).toContain('Reply to every comment on this post');
    expect(page).toMatch(/<input type="checkbox" id="match_all" name="match_all" value="1"\s*\/>/);
    expect(page).toContain('All posts and reels (recommended)');
    expect(page).toContain('Leave this on <b>All posts and reels</b> unless you want one reel only.');
    // Hidden by CSS when the box is ticked; a required field there would block the form.
    expect(page).toMatch(/<textarea id="keywords" name="keywords" placeholder/);
    expect(page).toContain('25 newest comments from the last 3 days');
    expect(page).toContain('up to 10 messages per check');
  });

  it('saves without keywords, shows the box ticked when editing, and lists the rule as every comment', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), { ...giveaway, keywords: 'leftover\nAI', match_mode: 'contains', exclude_keywords: 'already entered' });
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([
      { match_all: 1, media_id: '18000000000000777', keywords: '[]', match_mode: 'word', exclude_keywords: '["already entered"]' },
    ]);

    expect((await admin.get(adminPath('/rules'))).text).toContain('Every comment on its post');
    const form = (await admin.get(adminPath('/rules/1/edit'))).text;
    expect(form).toMatch(/name="match_all" value="1"\s+checked/);

    await admin.submit(adminPath('/rules/1'), { ...giveaway, match_all: '', keywords: 'guide' });
    expect(await ruleRows()).toMatchObject([{ match_all: 0, keywords: '["guide"]' }]);
  });

  it('refuses one on all posts, says why, and keeps what was typed', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), { ...giveaway, media_id: '' });
    expect(res.status).toBe(400);
    expect(res.text).toContain(escaped('“Reply to every comment” needs one post.'));
    expect(res.text).toMatch(/name="match_all" value="1"\s+checked/);
    expect(res.text).toContain(escaped(giveaway.dm_text));
    expect(await ruleRows()).toEqual([]);
  });

  it('refuses one on all posts when editing too', async () => {
    const admin = await adminWithAccount();
    const id = await seedRule({ label: 'Old' });
    await admin.get(adminPath(`/rules/${id}/edit`));
    const res = await admin.submit(adminPath(`/rules/${id}`), { ...giveaway, media_id: '' });
    expect(res.status).toBe(400);
    expect(await ruleRows()).toMatchObject([{ label: 'Old', match_all: 0 }]);
  });
});

describe('public reply variations on the rule form', () => {
  const noVariations = { public_reply_text_2: '', public_reply_text_3: '', public_reply_text_4: '', public_reply_text_5: '' };

  it('offers four optional variation fields, folded away, with a one-line explanation', async () => {
    const admin = await adminWithAccount();
    const form = (await admin.get(adminPath('/rules/new'))).text;
    expect(form).toContain('<details >');
    expect(form).toContain('<summary>Add variations (optional)</summary>');
    expect(form).toContain('Each comment gets one of your replies, picked at random');
    for (const n of [2, 3, 4, 5]) {
      expect(form).toContain(`<textarea id="public_reply_text_${n}" name="public_reply_text_${n}" class="short" maxlength="1000"></textarea>`);
    }
    expect(form).not.toContain('public_reply_text_6');
  });

  it('stores several replies as a list, ignoring blank fields, and shows each back in its own field', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const res = await admin.submit(adminPath('/rules'), {
      ...validRule,
      ...noVariations,
      public_reply_text: 'Sent you a DM!',
      public_reply_text_2: '  Check your inbox\r\nand requests ',
      public_reply_text_4: 'On its way, {username}',
    });
    expect(res.status).toBe(302);
    const [rule] = await ruleRows();
    expect(rule).toMatchObject({ public_reply_text: '["Sent you a DM!","Check your inbox\\nand requests","On its way, {username}"]' });

    const form = (await admin.get(adminPath(`/rules/${rule!.id}/edit`))).text;
    expect(form).toContain('<details open>');
    expect(form).toContain('maxlength="1000">Sent you a DM!</textarea>');
    expect(form).toContain('name="public_reply_text_2" class="short" maxlength="1000">Check your inbox\nand requests</textarea>');
    expect(form).toContain('name="public_reply_text_3" class="short" maxlength="1000">On its way, {username}</textarea>');
    expect(form).toContain('name="public_reply_text_4" class="short" maxlength="1000"></textarea>');
  });

  it('stores a single reply as plain text, even one typed in a variation field', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    await admin.submit(adminPath('/rules'), { ...validRule, ...noVariations, public_reply_text: ' ', public_reply_text_3: 'Only this one' });
    expect(await ruleRows()).toMatchObject([{ public_reply_text: 'Only this one' }]);
  });

  it('shows a legacy multi-line reply whole in the main field and saves it back unchanged', async () => {
    const admin = await adminWithAccount();
    const legacy = 'Sent you a DM!\nCheck your message requests too.';
    const id = await seedRule({ publicReply: legacy });

    const form = (await admin.get(adminPath(`/rules/${id}/edit`))).text;
    expect(form).toContain(`maxlength="1000">${legacy}</textarea>`);
    expect(form).toContain('<details >');

    const res = await admin.submit(adminPath(`/rules/${id}`), { ...validRule, ...noVariations, public_reply_text: legacy.replace('\n', '\r\n') });
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([{ public_reply_text: legacy }]);
  });

  it('checks each variation against the limit, counting {username}, and keeps every field as typed', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/rules/new'));
    const long = `${'x'.repeat(981)}{username}`;
    const res = await admin.submit(adminPath('/rules'), {
      ...validRule,
      ...noVariations,
      public_reply_text: 'Sent!',
      public_reply_text_2: 'Check DMs',
      public_reply_text_3: long,
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain(
      'Reply 3 must be 1,000 characters or fewer. This one is 991, and each {username} can add up to 20 characters for a long name, so it could reach 1,011.',
    );
    expect(res.text).toContain('maxlength="1000">Sent!</textarea>');
    expect(res.text).toContain('name="public_reply_text_2" class="short" maxlength="1000">Check DMs</textarea>');
    expect(res.text).toContain(`name="public_reply_text_3" class="short" maxlength="1000">${long}</textarea>`);
    expect(await ruleRows()).toEqual([]);
  });

  it('refuses a variation that is only {username}', async () => {
    const admin = await adminWithAccount();
    const id = await seedRule({ publicReply: 'Sent!' });
    await admin.get(adminPath(`/rules/${id}/edit`));
    const res = await admin.submit(adminPath(`/rules/${id}`), { ...validRule, ...noVariations, public_reply_text: 'Sent!', public_reply_text_5: '@{username}' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Reply 5 needs more than {username}.');
    expect(await ruleRows()).toMatchObject([{ public_reply_text: 'Sent!' }]);
  });
});

/** Unescapes what hono/html escaped, so a value read off the page is what a browser would submit. */
function unescaped(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The rule form's fields as a browser would submit them: an unticked checkbox is left out. */
function formFields(page: string): Record<string, string> {
  const field = (re: RegExp) => unescaped(page.match(re)?.[1] ?? '');
  const textarea = (name: string) => field(new RegExp(`<textarea id="${name}" name="${name}"[^>]*>([\\s\\S]*?)</textarea>`));
  const selected = (name: string) => field(new RegExp(`<select id="${name}" name="${name}"[^>]*>[\\s\\S]*?<option value="([^"]*)" selected>`));
  const fields: Record<string, string> = {
    ig_user_id: selected('ig_user_id'),
    label: field(/<input id="label" name="label" type="text" required value="([^"]*)"/),
    media_id: selected('media_id'),
    keywords: textarea('keywords'),
    match_mode: field(/name="match_mode" value="(\w+)"\s+checked/),
    exclude_keywords: textarea('exclude_keywords'),
    dm_text: textarea('dm_text'),
    public_reply_text: textarea('public_reply_text'),
  };
  for (const n of [2, 3, 4, 5]) fields[`public_reply_text_${n}`] = textarea(`public_reply_text_${n}`);
  if (/name="match_all" value="1"\s+checked/.test(page)) fields.match_all = '1';
  return fields;
}

describe('starting a rule from a template', () => {
  const LINK = 'https://ana.studio/start';
  const withLink = (fields: Record<string, string>) =>
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.replaceAll(LINK_MARKER, LINK)]));

  it('shows the gallery on an empty Rules page, with a link to each template', async () => {
    const admin = await adminWithAccount();
    const page = (await admin.get(adminPath('/rules'))).text;
    expect(page).toContain('No rules yet. Start from a template below, or press New rule for a blank form.');
    expect(page).toContain('<h2 id="templates">Start from a template</h2>');
    expect(page).not.toContain('<table>');
    for (const t of TEMPLATES) {
      expect(page).toContain(`<a href="${adminPath(`/rules/new?template=${t.id}`)}"><b>${t.name}</b><span class="muted">${escaped(t.forWhom)}</span></a>`);
    }
  });

  it('keeps the gallery under the rules once there are some, with a link to it at the top', async () => {
    const admin = await adminWithAccount();
    await seedRule({ label: 'My guide rule' });
    const page = (await admin.get(adminPath('/rules'))).text;
    expect(page).toContain('<a class="btn secondary" href="#templates">Start from a template</a>');
    expect(page).toContain('My guide rule');
    expect(page).not.toContain('No rules yet');
    expect(page.indexOf('</table>')).toBeLessThan(page.indexOf('<h2 id="templates">'));
    for (const t of TEMPLATES) expect(page).toContain(`href="${adminPath(`/rules/new?template=${t.id}`)}"`);
  });

  it('links to the gallery from a blank new-rule page', async () => {
    const admin = await adminWithAccount();
    const page = (await admin.get(adminPath('/rules/new'))).text;
    expect(page).toContain(`<a href="${adminPath('/rules')}#templates">start from a template</a>`);
    expect(page).not.toContain('Filled in from');
  });

  it('fills in every field from a template, says what to change, and saves nothing', async () => {
    const admin = await adminWithAccount();
    const t = findTemplate('guide')!;
    const page = await admin.get(adminPath('/rules/new?template=guide'));
    expect(page.status).toBe(200);
    expect(formFields(page.text)).toEqual({
      ig_user_id: IG_USER,
      label: 'Free guide',
      media_id: '',
      keywords: 'guide\nguía\nगाइड',
      match_mode: 'word',
      exclude_keywords: '',
      dm_text: t.dm,
      public_reply_text: t.publicReplies[0],
      public_reply_text_2: t.publicReplies[1],
      public_reply_text_3: t.publicReplies[2],
      public_reply_text_4: '',
      public_reply_text_5: '',
    });
    expect(page.text).toContain('<details open>');
    expect(page.text).toContain('Filled in from <b>Free guide</b>. Nothing is saved until you press Save rule.');
    expect(page.text).toContain(`Replace <code>${LINK_MARKER}</code> with your own link.`);
    expect(page.text).toContain(`<a href="${adminPath('/rules')}#templates">Pick a different template</a>`);
    expect(await ruleRows()).toEqual([]);
  });

  it.each(TEMPLATES.map((t) => [t.id, t] as const))('saves %s as filled in, once the link is put in', async (_, t) => {
    meta.on('GET', '/me/media', {
      json: { data: [{ id: '18000000000000777', caption: 'Win a set', permalink: 'https://www.instagram.com/p/xyz/', media_product_type: 'FEED' }] },
    });
    const admin = await adminWithAccount();
    const fields = withLink(formFields((await admin.get(adminPath(`/rules/new?template=${t.id}`))).text));
    const res = await admin.submit(adminPath('/rules'), t.matchAll ? { ...fields, media_id: '18000000000000777' } : fields);
    expect(res.status).toBe(302);
    expect(await ruleRows()).toMatchObject([
      {
        label: t.name,
        keywords: JSON.stringify(t.keywords),
        match_mode: 'word',
        exclude_keywords: JSON.stringify(t.exclusions),
        match_all: t.matchAll ? 1 : 0,
        media_id: t.matchAll ? '18000000000000777' : null,
        dm_text: t.dm.replaceAll(LINK_MARKER, LINK),
        public_reply_text: JSON.stringify(t.publicReplies),
      },
    ]);
  });

  it('refuses to save a template with the link marker still in it, and keeps the form filled in', async () => {
    const admin = await adminWithAccount();
    const fields = formFields((await admin.get(adminPath('/rules/new?template=prices'))).text);
    const res = await admin.submit(adminPath('/rules'), fields);
    expect(res.status).toBe(400);
    expect(res.text).toContain(`The private message still says ${LINK_MARKER}. Replace it with your own link, or delete it, before saving.`);
    expect(formFields(res.text)).toEqual(fields);
    expect(await ruleRows()).toEqual([]);
  });

  it('opens the giveaway with every comment ticked, asks for its post, and will not save without one', async () => {
    const admin = await adminWithAccount();
    const page = (await admin.get(adminPath('/rules/new?template=giveaway'))).text;
    const fields = formFields(page);
    expect(fields).toMatchObject({ match_all: '1', media_id: '', keywords: '' });
    expect(page).toContain(escaped(findTemplate('giveaway')!.note!));

    const res = await admin.submit(adminPath('/rules'), withLink(fields));
    expect(res.status).toBe(400);
    expect(res.text).toContain(escaped(MATCH_ALL_NEEDS_POST_MESSAGE));
    expect(await ruleRows()).toEqual([]);
  });

  it('shows a blank form for a template that does not exist', async () => {
    const admin = await adminWithAccount();
    const page = await admin.get(adminPath('/rules/new?template=nope'));
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('Filled in from');
    expect(formFields(page.text)).toMatchObject({ label: '', keywords: '', dm_text: '' });
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

  it('answers 404 for a rule that does not exist, inside the panel with a way back', async () => {
    const admin = await adminWithAccount();
    const page = await admin.get(adminPath('/rules/999/edit'));
    expect(page.status).toBe(404);
    expect(page.text).toContain('That rule doesn’t exist. It may have been deleted.');
    expect(page.text).toContain(`<a class="btn secondary" href="${adminPath('/rules')}">Back to rules</a>`);
    expect((await admin.submit(adminPath('/rules/999'), validRule)).status).toBe(404);
  });

  it('answers an unknown admin page with the panel 404 once logged in, and the login page before', async () => {
    const admin = await adminWithAccount();
    const page = await admin.get(adminPath('/no-such-page'));
    expect(page.status).toBe(404);
    expect(page.text).toContain('There’s no page at this address.');
    const stranger = await new Browser().get(adminPath('/no-such-page'));
    expect(stranger.status).toBe(302);
    expect(stranger.location).toBe(adminPath('/login'));
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
    expect(res.location).toBe(adminPath('/rules?done=rule-deleted'));
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

  it('fills in {username} with a sample name and says so', async () => {
    const admin = await adminWithAccount();
    await seedRule({ dmText: 'Hey {username}, here you go\n\nhttps://example.com/g', publicReply: 'Check your DMs @{username}' });
    await admin.get(adminPath('/test'));
    const page = await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'guide', media_id: '' });
    expect(page.text).toContain('<p class="message">Hey sample_user, here you go\n\nhttps://example.com/g</p>');
    expect(page.text).toContain('<p class="message">Check your DMs @sample_user</p>');
    expect(page.text).toContain('<b>sample_user</b>, a sample name');
    expect(page.text).not.toContain('{username}</p>');
  });

  it('lists every public reply variation, with the sample name filled in', async () => {
    const admin = await adminWithAccount();
    await seedRule({ publicReply: JSON.stringify(['Sent, {username}!', 'Check your DMs\nand requests']) });
    await admin.get(adminPath('/test'));
    const page = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'guide', media_id: '' })).text;
    expect(page).toContain('One of these 2, picked at random for each comment:');
    expect(page).toContain('<li class="message">Sent, sample_user!</li>');
    expect(page).toContain('<li class="message">Check your DMs\nand requests</li>');
  });

  it('does not mention a sample name when the rule has no {username}', async () => {
    const admin = await adminWithAccount();
    await seedRule({ dmText: 'Here you go' });
    await admin.get(adminPath('/test'));
    const page = await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'guide', media_id: '' });
    expect(page.text).toContain('<p class="message">Here you go</p>');
    expect(page.text).not.toContain('sample');
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

  it('shows which exclusion stopped a rule, and the keyword it found', async () => {
    const admin = await adminWithAccount();
    await seedRule({ label: 'Free guide', keywords: ['guide'], excludeKeywords: ['how much'] });
    await admin.get(adminPath('/test'));
    meta.clearCalls();
    const page = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'How much is the guide?', media_id: '' })).text;
    expect(page).toContain('Nothing would be sent.');
    expect(page).toContain('Skipped because of an exclusion');
    expect(page).toContain('<tr><td>Free guide</td><td>guide</td><td>how much</td></tr>');
    expect(page).not.toContain('This would match the rule');
    expect(meta.calls).toEqual([]);
  });

  it('shows the rule that replies instead when another rule excluded the comment', async () => {
    const admin = await adminWithAccount();
    await seedRule({ label: 'Strict guide', keywords: ['guide'], excludeKeywords: ['how much'] });
    await seedRule({ label: 'Any guide', keywords: ['guide'] });
    await admin.get(adminPath('/test'));
    const page = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'how much is the guide', media_id: '' })).text;
    expect(page).toContain('This would match the rule <b>Any guide</b>');
    expect(page).toContain('Passed over first');
    expect(page).toContain('<tr><td>Strict guide</td><td>guide</td><td>how much</td></tr>');
  });

  it('shows a match-all hit on its own post, and nothing on all posts', async () => {
    const admin = await adminWithAccount();
    await seedRule({ label: 'Giveaway', keywords: [], matchAll: true, mediaId: 'reel-1', dmText: 'You are in!' });
    await admin.get(adminPath('/test'));
    const hit = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'so cool', media_id: 'reel-1' })).text;
    expect(hit).toContain('This would match the rule <b>Giveaway</b>');
    expect(hit).toContain('<th>Matched because</th><td>This rule replies to every comment on this post.</td>');
    expect(hit).toContain('You are in!');
    expect(hit).not.toContain('Keyword found');

    const elsewhere = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'so cool', media_id: '' })).text;
    expect(elsewhere).toContain('No rule would match this comment.');
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

  it('pauses and resumes an account, and says so after each', async () => {
    const admin = await adminWithAccount();
    await admin.get(adminPath('/accounts'));
    const paused = await admin.submit(adminPath(`/accounts/${IG_USER}/deactivate`));
    expect(await accountRow()).toMatchObject({ active: 0 });
    expect(paused.location).toBe(adminPath('/accounts?done=account-paused'));
    expect((await admin.get(paused.location!)).text).toContain('Account paused. None of its rules reply until you resume it.');
    const resumed = await admin.submit(adminPath(`/accounts/${IG_USER}/activate`));
    expect(await accountRow()).toMatchObject({ active: 1 });
    expect((await admin.get(resumed.location!)).text).toContain('Account resumed.');
  });

  it('folds the Meta addresses away once an account is connected', async () => {
    const admin = await signedInAdmin();
    expect((await admin.get(adminPath('/accounts'))).text).toContain('<details open>');
    await seedAccount();
    const page = (await admin.get(adminPath('/accounts'))).text;
    expect(page).toContain('<details >');
    expect(page).toContain('<summary>Addresses to save in Meta first</summary>');
  });
});
