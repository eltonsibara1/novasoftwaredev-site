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
