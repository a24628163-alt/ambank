# AmBank: complete project (simulated funds only)

## Quick start

Pick **one** database setup path — not both.

**Path A — fresh project (recommended)**
1. Create a Supabase project. In the SQL editor, run **`supabase/setup_all.sql`** once. It contains every phase in order.
2. Deploy the Edge Functions:
   - `npx supabase functions deploy login` — must have `verify_jwt = false` (set in `supabase/config.toml`); otherwise every sign-in is rejected at the gateway.
   - `npx supabase functions deploy rates` — `verify_jwt = true`.
3. Put your project URL and anon key in `js/config.js`, then run `npx serve` in this folder and open `login.html`.
4. Make yourself staff (see section 1, step 4), then open `admin.html`.
5. Deploy to Netlify using sections 3 and 4 below.

**Path B — running phases individually (for development / re-running individual phases)**
1. Create a Supabase project. In the SQL editor, run **in this exact order**:
   `supabase/schema.sql`, `supabase/phase2.sql`, `supabase/phase3.sql`, `supabase/phase4.sql`, `supabase/phase5.sql`, `supabase/phase6.sql`, `supabase/phase7.sql`.
2. **Do NOT also run `setup_all.sql`** — it repeats all of the above and will fail with "already exists" errors.
3. Continue from step 2 of Path A (deploy functions, then client config).

**Which path should I use?**
- First-time setup → **Path A** (`setup_all.sql`). One paste, done.
- Already have a database from a previous version, or re-running a single phase → **Path B**.

Folder map: customer pages (`login`, `register`, `reset`, `dashboard`, `transactions`, `support`), staff console (`admin.html`), `css/`, `js/`, `assets/`, `supabase/` (SQL + functions), `scripts/build.js`, `tests/`, `netlify.toml`.

---

Static site (HTML/CSS/vanilla JS) + Supabase (Auth, Postgres with RLS, Edge Functions). No real money moves.

## 0. Database setup at a glance

| Situation | Run this | Never run simultaneously |
|---|---|---|
| Fresh Supabase project | `supabase/setup_all.sql` (once) | the individual phase files |
| Re-applying one phase to an existing DB | that specific `phaseN.sql` | `setup_all.sql` |
| Upgrading an existing project | the new phase files in order, starting from the last one applied | `setup_all.sql` |

`setup_all.sql` is a **convenience bundle** of `schema.sql` + `phase2.sql` … `phase7.sql`. Running both paths on the same database will fail with `relation "..." already exists` — that is expected, not a bug.

## 1. Supabase (create one project per environment: dev, prod)

**Database setup — choose ONE:**
- **First-time install:** run `supabase/setup_all.sql` once. It contains every phase in order.
- **Individual phases** (only if you already have some phases applied and want to re-run a specific one): run `schema.sql`, then `phase2.sql` … `phase7.sql` in order. Do **not** mix this with `setup_all.sql`.

Then continue with:

2. Deploy functions (each lives in `supabase/functions/<name>/index.ts`):
   - `npx supabase functions deploy login` — called **before** authentication; requires `verify_jwt = false` in `supabase/config.toml`, otherwise every login is rejected at the gateway. Verify in Dashboard → Functions → `login` → Settings that "Verify JWT" is **off**.
   - `npx supabase functions deploy rates` — called by authenticated users only; `verify_jwt = true`.
3. Authentication > URL Configuration: Site URL = your domain; Redirect URLs = `http://localhost:3000/**` and `https://YOUR-DOMAIN/**` (needed for email confirmation and `reset.html`).
4. First staff user: register normally, then run
   `insert into admin_users(user_id, role) select id, 'admin' from auth.users where email = 'you@example.com';`

   - **`admin`** can view customers (including balances and transaction history), adjust balances, change account status, reset PINs, and manage staff.
   - **`support`** can view customers (including balances and transaction history — needed for ticket triage), answer tickets, and handle live chats — but **cannot** adjust balances, change status, reset PINs, or manage staff. All write actions require the `admin` role **and** two-step verification.
5. Run `phase5.sql`. In the dev project leave `dev_mode` = true (test funds, open deposits). To go live: `update public.app_settings set value = 'false' where key = 'dev_mode';`
6. Staff sign-in requires TOTP two-step verification (first sign-in shows a QR code to enrol). The database rejects staff actions without it.

## 2. Local development

Put your dev project's URL and anon key in `js/config.js`, then `npx serve` in this folder (a server is required for JS modules).

The Supabase CLI is available via `npx supabase …` (installed as a dev dependency in `package.json`) or globally via Scoop/Homebrew. No global install is required.

## 3. Netlify

- Connect the repo. Build command and publish directory come from `netlify.toml`.
- Site configuration > Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (use different values per deploy context for dev vs production).
- Domain management: add your custom domain; HTTPS certificates are issued automatically.
- `netlify.toml` sets security headers including a Content-Security-Policy. If you add a script or font host, update it.

## 4. File guide

`js/app.js` client + helpers · `auth.js` sign-in/register/recovery · `dashboard.js` accounts · `transactions.js` modals (deposit, transfer, convert, details) · `history.js` history page · `support.js` + `tickets.js` tickets · `admin.js` staff console · `supabase/*.sql` schema and server-side rules · `supabase/functions` Edge Functions.

## 5. Smoke tests

Register two users; sign in by email and by account number; reset a password; deposit; move funds; transfer with right and wrong PINs (5 wrong = lockout); freeze a user in admin and confirm transfers fail but history loads; credit/debit in admin and confirm audit rows; open a ticket and reply as staff; confirm a customer cannot open `admin.html` features.

## 6. Automated checks

`cd tests && npm i && SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... npm test` runs `smoke.mjs` against a DEV project only (turn off "Confirm email" there). It covers RLS isolation, blocked direct balance writes, deposits, PIN lockout, replay and overdraft rejection, frozen accounts, and admin-function denial.

## 7. Phase 6 additions

Run `supabase/phase6.sql`. Customers get a notification bell (money received, staff adjustments, status changes, support replies) created by database triggers. The transactions page exports CSV and prints a statement. Admins manage staff under the Staff tab (a person must register first; changes are audit-logged and need two-step verification). Balance *reads* by staff are not audit-logged; every balance *write*, status change, PIN reset, and staff-role change is.

## 8. Live chat (Phase 7)

Run `supabase/phase7.sql`. Customers get a floating "Chat with support" button on the dashboard and support page; staff handle chats under Live chats (claim, reply, close, or convert to a ticket). Staff count as online while the admin console is open (heartbeat every 30s, online if seen in the last 90s); when nobody is online, customers are pointed to tickets. Messages arrive via Supabase Realtime with a 4-second polling fallback, so chat still works if Realtime isn't enabled for the two chat tables.