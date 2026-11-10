# novasoftwaredev.co.za

Elton Sibara's website (Nova Software Dev) and the home of Nestify.

- `index.html` - the whole site. Edit it on the site itself: open `https://novasoftwaredev.co.za/edit`,
  press **Edit site**, then **Publish changes** (saves here; GitHub Pages puts it live in about a minute).
- Each app has its own card on the home page; its page (`#app/<name>`) holds the overview, pictures and videos,
  the user guide and how to get it. In edit mode every app page has Edit app, + Add picture or video and
  Update the guide.
- `media/` - pictures used on the app pages (pictures added in edit mode go inside index.html).
- `Nestify_User_Guide.pdf` - the guide behind "Download PDF".
- `nestify-version.json` - Nestify's update check reads this. Raise `version` when a new Nestify is out.
- `CNAME` - the site's own domain for GitHub Pages.
- `edit/index.html` - makes novasoftwaredev.co.za/edit open the editor.
- `netlify.toml` - only used while the site was on Netlify.

## Selling Nestify (Capitec Pay through Ozow)

The Buy part of Nestify's "Get Nestify" page (`#app/nestify/get`) takes the Computer ID, the plan and month or
year, and sends the buyer to Ozow: **Capitec Pay** goes straight to Capitec (approve in the Capitec app), **Another
bank** shows Ozow's list. When it is paid, the code shows on the page, and Nestify fetches it by itself.

The money side is the Worker `worker/nestify-shop.js` (its own Worker, not the visitor counter). Set it up once:
1. Open an Ozow merchant account (ozow.com), with your Capitec Business account for the payouts.
2. Cloudflare > Workers > Create > paste `worker/nestify-shop.js` > Deploy. Note its address
   (like `https://nestify-shop.you.workers.dev`).
3. Worker > Settings > Bindings: add the D1 database as `DB`. Under Variables and Secrets add `OZOW_SITE_CODE`,
   `OZOW_PRIVATE_KEY` (secret), `OZOW_API_KEY` (secret), `OZOW_TEST` = `true`, `UNLOCK_KEY` (secret: the KEY from
   your private `tools/unlock_phone.html`) and `OWNER_KEY` (secret, your password for `/orders`).
4. In Ozow's merchant admin set the notify address to `<worker address>/ozow/notify`.
5. Put the Worker's address as `"shop"` in `nestify-version.json` (the site and Nestify both read it).
6. Test with `OZOW_TEST` = `true` (Ozow lets you choose a paid or failed result; no money moves), then set it to
   `false`.
Prices are in the Worker (`PRICES`) and on the page (`SHOP_PLANS`); change both together. Sales:
`<worker address>/orders?key=<OWNER_KEY>`.
