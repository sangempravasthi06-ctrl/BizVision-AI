"use strict";

const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const notice = document.getElementById("auth-notice");
const loginHeading = document.getElementById("login-heading");
const registerHeading = document.getElementById("register-heading");

function setNotice(message, kind = "error") {
  notice.textContent = message;
  notice.className = `auth-notice ${kind}`;
  notice.hidden = !message;
}

function showForm(name) {
  const isRegister = name === "register";
  loginForm.hidden = isRegister;
  registerForm.hidden = !isRegister;
  loginHeading.hidden = isRegister;
  registerHeading.hidden = !isRegister;
  setNotice("");
  history.replaceState(null, "", isRegister ? "/register" : "/login");
  document.title = isRegister ? "Create your account · BizVision AI" : "Sign in · BizVision AI";
}

async function api(path, payload) {
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(payload)
    });
  } catch {
    throw new Error("Unable to connect to the server. Please try again.");
  }

  let result;
  try {
    const text = await response.text();
    if (!text.trim()) throw new Error("Empty API response.");
    result = JSON.parse(text);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid API response.");
  } catch {
    throw new Error("Unable to connect to the server. Please try again.");
  }
  if (!response.ok || result.success === false) {
    throw new Error(result.message || result.error || "Something went wrong. Please try again.");
  }
  return result;
}

document.querySelectorAll("[data-show]").forEach((button) => {
  button.addEventListener("click", () => showForm(button.dataset.show));
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector(".auth-submit");
  button.disabled = true;
  setNotice("");
  const data = new FormData(loginForm);
  try {
    const result = await api("/api/login", {
      email: data.get("email"),
      password: data.get("password"),
      rememberMe: data.get("rememberMe") === "on"
    });
    setNotice(result.message, "success");
    window.location.replace("/index.html#overview");
  } catch (error) {
    setNotice(error.message);
  } finally {
    button.disabled = false;
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(registerForm);
  if (data.get("password") !== data.get("confirmPassword")) {
    setNotice("Your passwords do not match.");
    registerForm.elements.confirmPassword.focus();
    return;
  }
  const button = registerForm.querySelector(".auth-submit");
  button.disabled = true;
  setNotice("");
  const businessType = String(data.get("businessType")).replace(/^[^\s]+\s/, "");
  try {
    const result = await api("/api/register", {
      name: data.get("name"),
      email: data.get("email"),
      phone: data.get("phone"),
      password: data.get("password"),
      businessName: data.get("businessName"),
      businessType,
      termsAccepted: data.get("termsAccepted") === "on"
    });
    const email = data.get("email");
    setNotice(result.message, "success");
    registerForm.reset();
    showForm("login");
    loginForm.elements.email.value = email;
    setNotice(result.message, "success");
    loginForm.elements.password.focus();
  } catch (error) {
    setNotice(error.message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("forgot-password").addEventListener("click", () => {
  setNotice("Password reset email delivery is not configured yet. Please contact your BizVision AI administrator for help.", "info");
});

document.getElementById("terms-link").addEventListener("click", (event) => {
  event.preventDefault();
  setNotice("By creating an account, you agree to use BizVision AI responsibly and keep your login details private.", "info");
});

if (location.pathname === "/register") showForm("register");
