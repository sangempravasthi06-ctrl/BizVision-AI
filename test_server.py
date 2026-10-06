import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import server


class QuietHandler(server.BizVisionHandler):
    def log_message(self, format_string, *args):
        pass


class AuthenticationIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = server.DB_PATH
        server.DB_PATH = Path(self.temp_dir.name) / "test.sqlite3"
        server.initialize_database()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]
        self.cookie_a = ""
        self.cookie_b = ""

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def request(self, method, path, payload=None, cookie=""):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body else {}
        if cookie:
            headers["Cookie"] = cookie
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        data = json.loads(raw) if raw else None
        result = (response.status, data, response.getheader("Set-Cookie"))
        connection.close()
        return result

    def register_and_login(self, email, name, business_name):
        status, data, _ = self.request("POST", "/api/register", {
            "name": name,
            "email": email,
            "phone": "+91 98765 43210",
            "password": "correct horse battery",
            "businessName": business_name,
            "businessType": "Retail / Shop",
            "termsAccepted": True,
        })
        self.assertEqual(status, 201, data)
        self.assertTrue(data["success"])
        self.assertIn("Account created successfully", data["message"])
        status, data, set_cookie = self.request("POST", "/api/login", {
            "email": email,
            "password": "correct horse battery",
            "rememberMe": True,
        })
        self.assertEqual(status, 200, data)
        self.assertTrue(data["success"])
        self.assertIn("Login successful", data["message"])
        self.assertEqual(data["user"]["business_name"], business_name)
        self.assertIn("HttpOnly", set_cookie)
        return set_cookie.split(";", 1)[0], data["user"]

    def test_business_data_is_private_and_sales_update_inventory(self):
        self.cookie_a, user_a = self.register_and_login("ravi@example.com", "Ravi", "Ravi Grocery")
        status, created, _ = self.request("POST", "/api/products", {
            "name": "Rice",
            "category": "Grains",
            "purchasePrice": 40,
            "sellingPrice": 55,
            "quantity": 10,
            "reorderLevel": 3,
            "supplier": "A1 Foods",
        }, self.cookie_a)
        self.assertEqual(status, 201, created)
        product_id = created["product"]["id"]

        status, sale, _ = self.request("POST", "/api/sales", {
            "productId": product_id,
            "quantity": 2,
            "date": "2026-10-06",
        }, self.cookie_a)
        self.assertEqual(status, 201, sale)
        self.assertEqual(sale["sale"]["Revenue"], 110)

        self.cookie_b, user_b = self.register_and_login("priya@example.com", "Priya", "Priya Fashion")
        self.assertNotEqual(user_a["id"], user_b["id"])
        status, workspace_a, _ = self.request("GET", "/api/bootstrap", cookie=self.cookie_a)
        self.assertEqual(status, 200)
        self.assertEqual([item["name"] for item in workspace_a["products"]], ["Rice"])
        self.assertEqual(workspace_a["products"][0]["quantity"], 8)
        self.assertEqual(len(workspace_a["sales"]), 1)

        status, workspace_b, _ = self.request("GET", "/api/bootstrap", cookie=self.cookie_b)
        self.assertEqual(status, 200)
        self.assertEqual(workspace_b["products"], [])
        self.assertEqual(workspace_b["sales"], [])
        status, _, _ = self.request("PUT", f"/api/products/{product_id}", {
            "name": "Stolen", "category": "Other", "purchasePrice": 1, "sellingPrice": 2,
            "quantity": 1, "reorderLevel": 0, "supplier": "",
        }, self.cookie_b)
        self.assertEqual(status, 404)
        status, _, _ = self.request("POST", "/api/sales", {
            "productId": product_id, "quantity": 1, "date": "2026-10-06",
        }, self.cookie_b)
        self.assertEqual(status, 404)

        with server.connect() as db:
            row = db.execute("SELECT password_hash FROM users WHERE id = ?", (user_a["id"],)).fetchone()
            history = db.execute(
                "SELECT change_type, old_quantity, new_quantity FROM inventory_history WHERE user_id = ?",
                (user_a["id"],),
            ).fetchall()
        self.assertNotIn("correct horse battery", row["password_hash"])
        self.assertTrue(server.verify_password("correct horse battery", row["password_hash"]))
        self.assertEqual([(entry["change_type"], entry["old_quantity"], entry["new_quantity"]) for entry in history], [
            ("stock_in", 0, 10), ("sale", 10, 8),
        ])

    def test_login_errors_and_logout_revoke_workspace_access(self):
        self.cookie_a, _ = self.register_and_login("owner@example.com", "Owner", "Owner Shop")
        status, data, _ = self.request("POST", "/api/login", {
            "email": "owner@example.com", "password": "wrong password",
        })
        self.assertEqual(status, 401)
        self.assertFalse(data["success"])
        self.assertEqual(data["message"], "Invalid email or password.")
        self.assertEqual(data["error"], "Invalid email or password.")

        status, _, _ = self.request("POST", "/api/logout", {}, self.cookie_a)
        self.assertEqual(status, 200)
        status, _, _ = self.request("GET", "/api/bootstrap", cookie=self.cookie_a)
        self.assertEqual(status, 401)

    def test_dashboard_page_requires_a_session(self):
        status, _, _ = self.request("GET", "/index.html")
        self.assertEqual(status, 302)

    def test_api_errors_are_consistent_json_even_for_empty_request_bodies(self):
        status, data, _ = self.request("POST", "/api/login")
        self.assertEqual(status, 400)
        self.assertEqual(data["success"], False)
        self.assertEqual(data["message"], "Please send a valid request.")
        self.assertEqual(data["error"], data["message"])

    def test_unexpected_api_errors_are_returned_as_json(self):
        with patch.object(server.BizVisionHandler, "login", side_effect=RuntimeError("database unavailable")):
            status, data, _ = self.request("POST", "/api/login", {"email": "owner@example.com", "password": "secret"})
        self.assertEqual(status, 500)
        self.assertEqual(data["success"], False)
        self.assertEqual(data["message"], "The server could not complete your request. Please try again.")
        self.assertNotIn("database unavailable", data["message"])


if __name__ == "__main__":
    unittest.main()
