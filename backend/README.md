# Accounts backend — deploy to Railway

This is the small API that gives your app **real signups**: people create accounts,
log in, and their competitors save to their account (not just their browser).

It needs two things on Railway: a **PostgreSQL** database and this **service**.

---

## Deploy (all in the Railway dashboard — no Terminal)

1. **Add a database**
   - In your Railway project: **New → Database → Add PostgreSQL**. Done — Railway
     creates it and a `DATABASE_URL` variable automatically.

2. **Add this backend as a service**
   - Put this `backend/` folder in a GitHub repo (it can live in your existing
     `competitor-intelligence` repo).
   - In Railway: **New → GitHub Repo →** pick the repo.
   - In the service's **Settings → Root Directory**, set it to `backend`.
   - Railway auto-detects Node and runs `npm install` then `npm start`.

3. **Connect the database to the service**
   - In the service → **Variables → Add Reference → DATABASE_URL** (from the
     Postgres service). This wires the DB in.

4. **Set two variables** (service → Variables):
   - `JWT_SECRET` = any long random string (sign-in secret)
   - `ALLOWED_ORIGIN` = your site's URL, e.g. `https://marinbando-afk.github.io`

5. **Get the public URL**
   - Service → **Settings → Networking → Generate Domain**. You'll get something
     like `https://your-backend.up.railway.app`. Send me that — I'll point the app at it.

---

## Check it's alive
Open `https://your-backend.up.railway.app/api/health` — it should return `{"ok":true}`.

## What it does
- `POST /api/signup`, `POST /api/login` — accounts (bcrypt-hashed passwords, JWT sessions)
- `GET/POST/DELETE /api/competitors` — each user's competitor list, scoped to their account

## What's next (after signups work)
The monitoring engine (in `../competitor-monitor`) runs on Railway too — on a daily
schedule — and writes real reports into this same database. That's when the demo data
becomes live data.
