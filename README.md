# BizVision AI

BizVision AI is a private business dashboard for sales, inventory, analytics, reporting, and data-grounded recommendations. Its HTML, CSS, and JavaScript frontend is served by a small Python standard-library backend that stores accounts and business records in SQLite.

## Run the application

1. Install Python 3.9 or newer.
2. From this folder, run `python server.py` (on Windows, `py server.py` also works).
3. Open <http://127.0.0.1:8000>. Create an account, then sign in.

SQLite creates `bizvision.sqlite3` in this folder the first time the server starts. Set `BIZVISION_DB_PATH` to choose a different database location, or set `PORT` to change the default port. Keep the database file private and include it in your backup plan; it contains account and business data.

The application is intended to run behind HTTPS when exposed beyond a trusted local machine. The session cookie is HttpOnly and SameSite=Lax; when TLS terminates at a reverse proxy, set `BIZVISION_SECURE_COOKIE=1` so the cookie also uses the Secure attribute. Login credentials are never stored in browser storage, and passwords are stored as salted PBKDF2-HMAC-SHA256 hashes. Login uses a generic error for invalid credentials, and password reset and Google OAuth are unavailable until delivery/provider services are configured.

API requests return JSON envelopes containing `success` and `message`; the browser validates response bodies before parsing them and displays a friendly connection error for unavailable or malformed API responses. The Overview uses only the signed-in user's database records; brand-new accounts see zero-valued real metrics alongside the guided business setup, never shared demo figures.

## Features

- **Account access:** SQLite-backed registration, login, persistent sessions, remember-me, profile editing, and logout.
- **Private workspace:** every product, sale, and inventory-history record is associated with its owner's unique user ID. Server-side reads and writes scope business records to the authenticated account.
- **Overview:** revenue, estimated gross profit, units sold, stock alerts, sales history, best sellers, and revenue charts.
- **Sales:** record product sales; stock is reduced and inventory history is written in the same database transaction.
- **Inventory:** create, update, delete, search, filter, import, and export products.
- **Analytics and reports:** revenue trends, category and product performance, profit estimates, and CSV downloads.
- **Forecast and AI assistant:** local data-driven sales forecasts, stock recommendations, and question-specific summaries. The assistant is a transparent built-in rules-based helper, not a connected external AI service.
- **First-time setup:** new accounts see onboarding rather than demo or shared business data.
- **Responsive interface:** desktop, tablet, and mobile layouts.

## Importing sales

Use `data/sample_business_data.csv` as the CSV template. Required headers are `Date`, `Product`, `Category`, `Quantity`, `CostPrice`, and `SellingPrice`. Dates must use `YYYY-MM-DD`; `Revenue` is optional and is calculated from quantity and selling price when omitted. Sales imports replace the signed-in account's sales history; they do not import data into another account.

## Project files

- `server.py` — HTTP API, session handling, password hashing, and SQLite persistence
- `auth.html`, `auth.js` — login and registration
- `index.html` — authenticated application shell
- `app.js` — dashboard, business calculations, charts, and authenticated API calls
- `styles.css` — responsive visual system
- `landing.html` — product overview, served only to signed-in users
- `data/sample_business_data.csv` — example sales import

## Tests

Run `python -m unittest test_server.py` to exercise registration, authentication, account isolation, sales/inventory updates, logout, and JSON error responses.
