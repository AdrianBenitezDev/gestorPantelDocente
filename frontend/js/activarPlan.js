import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";

const userName = document.getElementById("activar-user-name");
const userEmail = document.getElementById("activar-user-email");
const logoutBtn = document.getElementById("activar-logout-btn");
const subscribeBtn = document.getElementById("activar-subscribe-btn");
const statusMsg = document.getElementById("activar-status-msg");

function setMsg(el, text, isError = false) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError);
}

function setBusy(button, isBusy) {
  if (!button) return;
  button.disabled = isBusy;
}

function normalizeRoute(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function redirectIfNeeded(route) {
  const target = String(route || "").trim();
  if (!target) {
    return;
  }
  if (normalizeRoute(window.location.pathname) === normalizeRoute(target)) {
    return;
  }
  window.location.replace(target);
}

async function loadSubscriptionStatus() {
  const getSubscriptionStatus = httpsCallable(functions, "getSubscriptionStatus");
  const response = await getSubscriptionStatus();
  const status = response.data || {};
  const billingStatus = status.billingStatus ?? "null";
  const appEnabled = status.appEnabled === true;
  const tenantId = String(status.tenantId || "").trim();
  const nextRoute = String(status.nextRoute || "").trim();

  setMsg(statusMsg, `Estado actual: ${billingStatus}`);
  if (appEnabled && tenantId) {
    redirectIfNeeded("/horarios.html");
    return;
  }
  if (nextRoute && normalizeRoute(nextRoute) !== normalizeRoute("/activar-plan.html")) {
    redirectIfNeeded(nextRoute);
  }
}

subscribeBtn?.addEventListener("click", async () => {
  setBusy(subscribeBtn, true);
  try {
    setMsg(statusMsg, "Iniciando checkout de suscripcion...");
    const startSubscriptionCheckout = httpsCallable(functions, "startSubscriptionCheckout");
    const result = await startSubscriptionCheckout({ planCode: "plan_pro" });
    const initPoint = String(result.data?.initPoint || "").trim();
    if (!initPoint) {
      throw new Error("No se recibio initPoint para continuar");
    }
    window.location.assign(initPoint);
  } catch (error) {
    console.error(error);
    setMsg(statusMsg, error?.message || "No se pudo iniciar checkout", true);
  } finally {
    setBusy(subscribeBtn, false);
  }
});

logoutBtn?.addEventListener("click", async () => {
  try {
    await signOut(auth);
    window.location.replace("/horarios.html");
  } catch (error) {
    console.error(error);
    setMsg(statusMsg, "No se pudo cerrar sesion", true);
  }
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("/horarios.html");
    return;
  }
  userName.textContent = user.displayName || user.email || "Usuario";
  userEmail.textContent = user.email || "-";
  void loadSubscriptionStatus().catch((error) => {
    console.error(error);
    setMsg(statusMsg, "No se pudo consultar el estado de suscripcion", true);
  });
});
