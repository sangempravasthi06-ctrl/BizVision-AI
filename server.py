import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import ssl
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("BIZVISION_DB_PATH", ROOT / "bizvision.sqlite3"))
SESSION_COOKIE = "bizvision_session"
SESSION_DAYS = 30
PASSWORD_ITERATIONS = 310_000
BUSINESS_TYPES = {
    "Retail / Shop", "Shopping Mall", "Real Estate", "Restaurant / Café",
    "Hotel", "Salon / Beauty", "Pharmacy", "Automobile", "Manufacturing",
    "Wholesale / Distribution", "E-Commerce", "Education",
    "Technology / Startup", "Professional Services", "Other",
}
STATIC_FILES = {
    "/": "auth.html",
    "/login": "auth.html",
    "/register": "auth.html",
    "/auth.html": "auth.html",
    "/index.html": "index.html",
    "/landing.html": "landing.html",
    "/app.js": "app.js",
    "/auth.js": "auth.js",
    "/styles.css": "styles.css",
}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                phone TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                business_name TEXT NOT NULL,
                business_type TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                product_name TEXT NOT NULL,
                category TEXT NOT NULL,
                purchase_price REAL NOT NULL CHECK (purchase_price >= 0),
                selling_price REAL NOT NULL CHECK (selling_price >= 0),
                quantity INTEGER NOT NULL CHECK (quantity >= 0),
                reorder_level INTEGER NOT NULL CHECK (reorder_level >= 0),
                supplier TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS products_by_user ON products(user_id);
            CREATE TABLE IF NOT EXISTS sales (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
                product_name TEXT NOT NULL,
                category TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                purchase_price REAL NOT NULL CHECK (purchase_price >= 0),
                sale_price REAL NOT NULL CHECK (sale_price >= 0),
                total_amount REAL NOT NULL CHECK (total_amount >= 0),
                sale_date TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sales_by_user_date ON sales(user_id, sale_date);
            CREATE TABLE IF NOT EXISTS inventory_history (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
                old_quantity INTEGER NOT NULL,
                new_quantity INTEGER NOT NULL,
                change_type TEXT NOT NULL,
                date TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS inventory_history_by_user ON inventory_history(user_id, date);
        """)


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password, encoded):
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(actual.hex(), expected)
    except (ValueError, TypeError):
        return False


def user_payload(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "phone": row["phone"],
        "business_name": row["business_name"],
        "business_type": row["business_type"],
        "businessName": row["business_name"],
        "businessType": row["business_type"],
    }


class BizVisionHandler(BaseHTTPRequestHandler):
    server_version = "BizVisionAI/1.0"

    def log_message(self, format_string, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), format_string % args))

    def send_json(self, status, payload, headers=None):
        payload = dict(payload)
        success = status < HTTPStatus.BAD_REQUEST
        payload["success"] = success
        message = payload.get("message") or payload.get("error")
        if message:
            payload["message"] = message
        elif success:
            payload["message"] = "Request completed."
        else:
            payload["message"] = HTTPStatus(status).phrase
        if not success:
            payload.setdefault("error", payload["message"])
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        if urlparse(self.path).path.startswith("/api/"):
            self.send_json(code, {"message": message or HTTPStatus(code).phrase})
            return
        super().send_error(code, message, explain)

    def handle_api_exception(self, error):
        sys.stderr.write(f"Unhandled API error for {self.path}: {error!r}\n")
        self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {
            "message": "The server could not complete your request. Please try again."
        })

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 2_000_000:
                raise ValueError("Request body is empty or too large.")
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                raise ValueError("Request body must be a JSON object.")
            return value
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("Please send a valid request.") from error

    def current_user(self):
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get(SESSION_COOKIE)
        if not morsel:
            return None
        token_hash = hashlib.sha256(morsel.value.encode("ascii", errors="ignore")).hexdigest()
        with connect() as db:
            row = db.execute("""
                SELECT users.* FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.is_active = 1
            """, (token_hash, utc_now())).fetchone()
        return row

    def require_user(self):
        user = self.current_user()
        if not user:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Please log in to continue."})
            return None
        return user

    def do_GET(self):
        try:
            self._do_GET()
        except Exception as error:
            if urlparse(self.path).path.startswith("/api/"):
                self.handle_api_exception(error)
            else:
                sys.stderr.write(f"Unhandled request error for {self.path}: {error!r}\n")
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR)

    def _do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/login", "/register") and self.current_user():
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/index.html#overview")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if path.startswith("/api/"):
            if path == "/api/me":
                user = self.current_user()
                if not user:
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Not signed in."})
                    return
                self.send_json(HTTPStatus.OK, {"user": user_payload(user)})
                return
            if path == "/api/bootstrap":
                user = self.require_user()
                if not user:
                    return
                with connect() as db:
                    products = db.execute(
                        "SELECT * FROM products WHERE user_id = ? ORDER BY created_at DESC",
                        (user["id"],),
                    ).fetchall()
                    sales = db.execute(
                        "SELECT * FROM sales WHERE user_id = ? ORDER BY sale_date DESC, rowid DESC",
                        (user["id"],),
                    ).fetchall()
                self.send_json(HTTPStatus.OK, {
                    "user": user_payload(user),
                    "products": [self.product_payload(row) for row in products],
                    "sales": [self.sale_payload(row) for row in sales],
                })
                return
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "API endpoint not found."})
            return

        if path in ("/index.html", "/landing.html"):
            user = self.current_user()
            if not user:
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Location", "/login")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
        filename = STATIC_FILES.get(path)
        if filename:
            content = (ROOT / filename).read_bytes()
            content_type = "text/css; charset=utf-8" if filename.endswith(".css") else (
                "text/javascript; charset=utf-8" if filename.endswith(".js") else "text/html; charset=utf-8"
            )
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store" if filename in ("index.html", "auth.html") else "no-cache")
            self.end_headers()
            self.wfile.write(content)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        try:
            self._do_POST()
        except Exception as error:
            if urlparse(self.path).path.startswith("/api/"):
                self.handle_api_exception(error)
            else:
                sys.stderr.write(f"Unhandled request error for {self.path}: {error!r}\n")
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR)

    def _do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self.read_json()
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        if path == "/api/register":
            self.register(body)
        elif path == "/api/login":
            self.login(body)
        elif path == "/api/logout":
            self.logout()
        elif path == "/api/products":
            self.create_product(body)
        elif path == "/api/sales":
            self.create_sale(body)
        elif path == "/api/sales/import":
            self.import_sales(body)
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "API endpoint not found."})

    def do_PUT(self):
        try:
            self._do_PUT()
        except Exception as error:
            if urlparse(self.path).path.startswith("/api/"):
                self.handle_api_exception(error)
            else:
                sys.stderr.write(f"Unhandled request error for {self.path}: {error!r}\n")
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR)

    def _do_PUT(self):
        path = urlparse(self.path).path
        try:
            body = self.read_json()
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        if path == "/api/profile":
            self.update_profile(body)
            return
        match = re.fullmatch(r"/api/products/([A-Za-z0-9_-]+)", path)
        if match:
            self.update_product(match.group(1), body)
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "API endpoint not found."})

    def do_DELETE(self):
        try:
            self._do_DELETE()
        except Exception as error:
            if urlparse(self.path).path.startswith("/api/"):
                self.handle_api_exception(error)
            else:
                sys.stderr.write(f"Unhandled request error for {self.path}: {error!r}\n")
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR)

    def _do_DELETE(self):
        path = urlparse(self.path).path
        match = re.fullmatch(r"/api/products/([A-Za-z0-9_-]+)", path)
        if not match:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "API endpoint not found."})
            return
        user = self.require_user()
        if not user:
            return
        with connect() as db:
            cursor = db.execute(
                "DELETE FROM products WHERE id = ? AND user_id = ?",
                (match.group(1), user["id"]),
            )
        if cursor.rowcount == 0:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Product not found."})
            return
        self.send_json(HTTPStatus.OK, {"ok": True})

    def register(self, body):
        name = self.clean_text(body.get("name"), 100)
        email = self.clean_text(body.get("email"), 254).lower()
        phone = self.clean_text(body.get("phone"), 30)
        password = body.get("password")
        business_name = self.clean_text(body.get("businessName"), 120)
        business_type = self.clean_text(body.get("businessType"), 60)
        if not name or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Enter your name and a valid email address."})
            return
        if len(phone) < 7 or not re.fullmatch(r"[0-9+() .-]{7,30}", phone):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Enter a valid mobile number."})
            return
        if not isinstance(password, str) or len(password) < 8 or len(password) > 256:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Password must contain at least 8 characters."})
            return
        if not business_name or business_type not in BUSINESS_TYPES:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Enter your business name and choose a business type."})
            return
        if body.get("termsAccepted") is not True:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Please accept the Terms and Conditions."})
            return
        try:
            with connect() as db:
                db.execute(
                    """INSERT INTO users
                       (id, name, email, phone, password_hash, business_name, business_type, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (secrets.token_urlsafe(18), name, email, phone, hash_password(password),
                     business_name, business_type, utc_now()),
                )
        except sqlite3.IntegrityError:
            self.send_json(HTTPStatus.CONFLICT, {"error": "An account with that email already exists."})
            return
        self.send_json(HTTPStatus.CREATED, {"message": "Account created successfully! Welcome to BizVision AI 🎉"})

    def login(self, body):
        email = self.clean_text(body.get("email"), 254).lower()
        password = body.get("password")
        with connect() as db:
            user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not user or not user["is_active"] or not isinstance(password, str) or not verify_password(password, user["password_hash"]):
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Invalid email or password."})
            return
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS if body.get("rememberMe") else 1)
        with connect() as db:
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (utc_now(),))
            db.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (token_hash, user["id"], expires.isoformat(timespec="seconds"), utc_now()),
            )
        cookie = f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax"
        if body.get("rememberMe"):
            cookie += f"; Max-Age={SESSION_DAYS * 86400}"
        if self.is_secure_request():
            cookie += "; Secure"
        self.send_json(HTTPStatus.OK, {"message": "Login successful. Welcome back!", "user": user_payload(user)}, {"Set-Cookie": cookie})

    def logout(self):
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get(SESSION_COOKIE)
        if morsel:
            token_hash = hashlib.sha256(morsel.value.encode("ascii", errors="ignore")).hexdigest()
            with connect() as db:
                db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        self.send_json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"})

    def create_product(self, body):
        user = self.require_user()
        if not user:
            return
        product = self.validate_product(body)
        if isinstance(product, str):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": product})
            return
        product_id = secrets.token_urlsafe(15)
        with connect() as db:
            db.execute(
                """INSERT INTO products
                   (id, user_id, product_name, category, purchase_price, selling_price, quantity, reorder_level, supplier, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (product_id, user["id"], product["name"], product["category"], product["purchasePrice"],
                 product["sellingPrice"], product["quantity"], product["reorderLevel"], product["supplier"], utc_now()),
            )
            if product["quantity"]:
                self.add_inventory_history(db, user["id"], product_id, 0, product["quantity"], "stock_in")
        self.send_json(HTTPStatus.CREATED, {"product": {"id": product_id, **product}})

    def update_product(self, product_id, body):
        user = self.require_user()
        if not user:
            return
        product = self.validate_product(body)
        if isinstance(product, str):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": product})
            return
        with connect() as db:
            old = db.execute(
                "SELECT quantity FROM products WHERE id = ? AND user_id = ?",
                (product_id, user["id"]),
            ).fetchone()
            if not old:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Product not found."})
                return
            db.execute(
                """UPDATE products SET product_name = ?, category = ?, purchase_price = ?, selling_price = ?,
                   quantity = ?, reorder_level = ?, supplier = ? WHERE id = ? AND user_id = ?""",
                (product["name"], product["category"], product["purchasePrice"], product["sellingPrice"],
                 product["quantity"], product["reorderLevel"], product["supplier"], product_id, user["id"]),
            )
            if old["quantity"] != product["quantity"]:
                change = "stock_in" if product["quantity"] > old["quantity"] else "adjustment"
                self.add_inventory_history(db, user["id"], product_id, old["quantity"], product["quantity"], change)
        self.send_json(HTTPStatus.OK, {"product": {"id": product_id, **product}})

    def create_sale(self, body):
        user = self.require_user()
        if not user:
            return
        product_id = self.clean_text(body.get("productId"), 100)
        quantity = body.get("quantity")
        sale_date = body.get("date", datetime.now().date().isoformat())
        if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity < 1:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Sale quantity must be a positive whole number."})
            return
        if not self.valid_date(sale_date):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Sale date must use YYYY-MM-DD."})
            return
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            product = db.execute(
                "SELECT * FROM products WHERE id = ? AND user_id = ?",
                (product_id, user["id"]),
            ).fetchone()
            if not product:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Product not found in your inventory."})
                return
            if product["quantity"] < quantity:
                self.send_json(HTTPStatus.CONFLICT, {"error": f"Only {product['quantity']} units of {product['product_name']} are in stock."})
                return
            sale_id = secrets.token_urlsafe(15)
            new_quantity = product["quantity"] - quantity
            total = quantity * product["selling_price"]
            db.execute(
                """INSERT INTO sales
                   (id, user_id, product_id, product_name, category, quantity, purchase_price, sale_price, total_amount, sale_date)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (sale_id, user["id"], product_id, product["product_name"], product["category"], quantity,
                 product["purchase_price"], product["selling_price"], total, sale_date),
            )
            db.execute("UPDATE products SET quantity = ? WHERE id = ? AND user_id = ?", (new_quantity, product_id, user["id"]))
            self.add_inventory_history(db, user["id"], product_id, product["quantity"], new_quantity, "sale")
            sale = db.execute("SELECT * FROM sales WHERE id = ? AND user_id = ?", (sale_id, user["id"])).fetchone()
        self.send_json(HTTPStatus.CREATED, {"sale": self.sale_payload(sale)})

    def import_sales(self, body):
        user = self.require_user()
        if not user:
            return
        rows = body.get("sales")
        if not isinstance(rows, list) or not rows or len(rows) > 10000:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Choose a CSV file containing valid sales rows."})
            return
        normalized = []
        for index, row in enumerate(rows, start=1):
            if not isinstance(row, dict):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"Sales row {index} is invalid."})
                return
            date, name, category = row.get("Date"), self.clean_text(row.get("Product"), 120), self.clean_text(row.get("Category") or "Other", 80)
            quantity, cost, price, total = row.get("Quantity"), row.get("CostPrice"), row.get("SellingPrice"), row.get("Revenue")
            if (not self.valid_date(date) or not name or not isinstance(quantity, int) or isinstance(quantity, bool)
                    or quantity < 1 or not self.nonnegative_number(cost) or not self.nonnegative_number(price)
                    or not self.nonnegative_number(total)):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"Sales row {index} contains invalid data."})
                return
            normalized.append((date, name, category, quantity, float(cost), float(price), float(total)))
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM sales WHERE user_id = ?", (user["id"],))
            for date, name, category, quantity, cost, price, total in normalized:
                product = db.execute(
                    "SELECT id FROM products WHERE user_id = ? AND product_name = ? COLLATE NOCASE",
                    (user["id"], name),
                ).fetchone()
                db.execute(
                    """INSERT INTO sales
                       (id, user_id, product_id, product_name, category, quantity, purchase_price, sale_price, total_amount, sale_date)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (secrets.token_urlsafe(15), user["id"], product["id"] if product else None,
                     name, category, quantity, cost, price, total, date),
                )
        self.send_json(HTTPStatus.OK, {"imported": len(normalized)})

    def update_profile(self, body):
        user = self.require_user()
        if not user:
            return
        name = self.clean_text(body.get("name"), 100)
        email = self.clean_text(body.get("email"), 254).lower()
        phone = self.clean_text(body.get("phone"), 30)
        business_name = self.clean_text(body.get("businessName"), 120)
        business_type = self.clean_text(body.get("businessType"), 60)
        if not name or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Enter your name and a valid email address."})
            return
        if len(phone) < 7 or not re.fullmatch(r"[0-9+() .-]{7,30}", phone):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Enter a valid mobile number."})
            return
        if not business_name or business_type not in BUSINESS_TYPES:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Enter a business name and choose a business type."})
            return
        try:
            with connect() as db:
                db.execute(
                    """UPDATE users SET name = ?, email = ?, phone = ?, business_name = ?, business_type = ?
                       WHERE id = ? AND is_active = 1""",
                    (name, email, phone, business_name, business_type, user["id"]),
                )
                updated = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
        except sqlite3.IntegrityError:
            self.send_json(HTTPStatus.CONFLICT, {"error": "That email address is already in use."})
            return
        self.send_json(HTTPStatus.OK, {"user": user_payload(updated)})

    @staticmethod
    def clean_text(value, limit):
        return value.strip()[:limit] if isinstance(value, str) else ""

    @staticmethod
    def nonnegative_number(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value < 1_000_000_000

    @classmethod
    def validate_product(cls, body):
        name = cls.clean_text(body.get("name"), 120)
        category = cls.clean_text(body.get("category"), 80) or "General"
        supplier = cls.clean_text(body.get("supplier"), 120)
        price = body.get("purchasePrice")
        selling = body.get("sellingPrice")
        quantity = body.get("quantity")
        reorder = body.get("reorderLevel")
        if not name:
            return "Product name is required."
        if not cls.nonnegative_number(price) or not cls.nonnegative_number(selling):
            return "Prices must be valid non-negative numbers."
        if selling <= price:
            return "Selling price must be higher than purchase price."
        if (not isinstance(quantity, int) or isinstance(quantity, bool) or quantity < 0
                or not isinstance(reorder, int) or isinstance(reorder, bool) or reorder < 0):
            return "Quantity and reorder level must be non-negative whole numbers."
        if quantity > 2_000_000_000 or reorder > 2_000_000_000:
            return "Quantity and reorder level are too large."
        return {
            "name": name, "category": category, "purchasePrice": float(price),
            "sellingPrice": float(selling), "quantity": quantity,
            "reorderLevel": reorder, "supplier": supplier,
        }

    @staticmethod
    def valid_date(value):
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return False
        try:
            datetime.strptime(value, "%Y-%m-%d")
            return True
        except ValueError:
            return False

    def is_secure_request(self):
        return isinstance(self.connection, ssl.SSLSocket) or os.environ.get("BIZVISION_SECURE_COOKIE") == "1"

    @staticmethod
    def add_inventory_history(db, user_id, product_id, old, new, change_type):
        db.execute(
            """INSERT INTO inventory_history (id, user_id, product_id, old_quantity, new_quantity, change_type, date)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (secrets.token_urlsafe(15), user_id, product_id, old, new, change_type, utc_now()),
        )

    @staticmethod
    def product_payload(row):
        return {
            "id": row["id"], "name": row["product_name"], "category": row["category"],
            "purchasePrice": row["purchase_price"], "sellingPrice": row["selling_price"],
            "quantity": row["quantity"], "reorderLevel": row["reorder_level"], "supplier": row["supplier"],
        }

    @staticmethod
    def sale_payload(row):
        return {
            "id": row["id"], "Date": row["sale_date"], "Product": row["product_name"],
            "Category": row["category"], "Quantity": row["quantity"],
            "CostPrice": row["purchase_price"], "SellingPrice": row["sale_price"],
            "Revenue": row["total_amount"],
        }


def main():
    initialize_database()
    host = os.environ.get("BIZVISION_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), BizVisionHandler)
    print(f"BizVision AI is running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down BizVision AI.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
