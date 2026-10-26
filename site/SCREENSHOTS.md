# Screenshot shot list

The setup docs have a placeholder frame wherever a screenshot helps. Each one
renders as "Screenshot coming" with the file name it expects. Record them
during a real setup, save them to `site/public/screenshots/` under the names
below, and swap each placeholder for the image.

## Swapping one in

Replace the placeholder `<div>` inside the `<Frame>` and keep the caption:

```mdx
<Frame caption="Create app: use case Other, app type Business.">
  <img src="/screenshots/meta-01-create-app.png" alt="Meta's Create app dialog with Other and Business selected." />
</Frame>
```

Write the `src` from the site root as above; the build adds the base path
(`/ig-comment-dm/`). Give every image real alt text that says what the reader
should notice.

## Recording

- One browser at about 1280px wide, light mode, zoom 100%. Crop to the panel
  that matters rather than the whole window.
- PNG, ideally under 300 KB each. Run them through `oxipng` or similar.
- Blur with a solid block, not a light blur: a light blur on text can be
  reversed. Check the browser's address bar and tab titles too.
- Never click **Show** on an app secret while recording, and never record a
  generated access token.

## The list

| # | File | Page → section | Capture | Blur |
|---|---|---|---|---|
| 1 | `meta-01-create-app.png` | Self-setup → 1. Create the Meta app | developers.facebook.com/apps → **Create app**, with use case **Other** and app type **Business** selected | Your name and business portfolio name, if shown |
| 2 | `meta-02-business-login-settings.png` | Self-setup → Copy three values | **Instagram → API setup with Instagram login → Business login settings**, showing where **Instagram App ID** and **Instagram App Secret** (still hidden) are. If it fits, include the different Facebook App ID at the top of the dashboard so the difference is visible. | The app IDs if you prefer (they're public by design). The secret must stay hidden: don't click **Show**. |
| 3 | `meta-03-basic-settings.png` | Self-setup → Copy three values | **App settings → Basic**, with the **App secret** field (hidden) and its **Show** button | Contact email, app domains. Keep the secret hidden. |
| 4 | `meta-04-add-instagram-tester.png` | Self-setup → 2. Invite each account as a tester | **App roles → Roles → Add people**, with **Instagram Tester** selected and a username typed in | Other people's names and usernames in the roles list |
| 5 | `ig-05-accept-tester-invite.png` | Self-setup → 2. Invite each account as a tester | instagram.com/accounts/manage_access → **Tester invites**, with the **Accept** button | Your username and profile photo, if you like |
| 6 | `cli-06-npm-run-setup.png` | Self-setup → 3. Deploy | The terminal at the end of `npm run setup`: the "Done. Your copy is live." line and the values to paste into Meta | **The admin URL secret (critical)**, the verify token, your Cloudflare email, and your workers.dev subdomain if you'd rather |
| 7 | `meta-07-redirect-uris.png` | Self-setup → Login return address | **Business login settings → OAuth redirect URIs** with both lines entered (with and without the trailing slash) | Your workers.dev subdomain, optional |
| 8 | `meta-08-webhook.png` | Self-setup → Webhook | **Configure webhooks**: callback URL, verify token field, and the **comments** field subscribed with **Include values** on | **The verify token**; subdomain optional |
| 9 | `meta-09-webhook-subscription.png` | Self-setup → Turn on the webhook for each account | **Generate access tokens**, an account row with **Webhook subscription** switched **On** | Other accounts' usernames. Never show a generated token. |
| 10 | `meta-10-publish.png` | Self-setup → 5. Publish the app | **Publish** page with the three legal URLs filled in and the **Publish** button | Subdomain optional |
| 11 | `admin-11-connect.png` | Self-setup → 6. Connect and send your first DM | Admin **Accounts** page with **Connect a new account** | **The address bar (contains the admin URL secret)**, connected usernames if you like |
| 12 | `admin-12-new-rule.png` | Using it → Write a rule | **Rules → New rule** filled in with the `Free guide` example: keyword `guide`, a DM with a link, **All posts and reels** | **The address bar** |
| 13 | `admin-13-test.png` | Using it → Test a rule | **Test** page with a sample comment ("guide please") and the matching rule shown | **The address bar** |
| 14 | `admin-14-home.png` | Using it → Read the Home page | **Home** with rows under **Did Instagram reach us?** and **Last 20 sends** | **The address bar**, commenters' usernames and IDs |
| 15 | `agent-15-chrome-permission.png` | Agent setup → Approving actions | Claude Code's **Claude in Chrome wants to** prompt for developers.facebook.com | Local file paths in the terminal, if they show your name |

The landing page needs no screenshots: its comment-to-DM demo is HTML and CSS.
