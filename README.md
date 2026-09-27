# JaipurEst — jaipurest.com

Frontend for **JaipurEst**, a Jaipur property portal (buy / sell — plots, flats,
villas, farmhouses, commercial). Brand: JaipurEst · logo **JE**.

## Deploy

- **Cloudflare Pages** → project → Framework *None*, build output directory `web`.
- Custom domain `jaipurest.com` → Pages → Custom domains → add apex + `www`.

## Layout

```
web/
  index.html      # portal shell (filters, sidebar, modal)
  style.css       # housing.com-style light theme, orange #f45b24, no framework
  app.js          # client-side filtering, badges, booking form, WhatsApp/Call CTAs
  data/           # inventory files, auto-refreshed hourly — do not edit by hand
```

## Local preview

```bash
python -m http.server 8000 -d web
```

`web/data/*.json` is refreshed automatically every hour by the site's backend
service; the repository itself is the published artifact Cloudflare Pages
builds from.
