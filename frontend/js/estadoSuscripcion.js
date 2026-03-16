import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";

const userName = document.getElementById("estado-user-name");
const userEmail = document.getElementById("estado-user-email");
const logoutBtn = document.getElementById("estado-logout-btn");
const retryBtn = document.getElementById("estado-retry-btn");
const syncBtn = document.getElementById("estado-sync-btn");
const statusText = document.getElementById("estado-current-status");
const reasonText = document.getElementById("estado-current-reason");
const feedbackMsg = document.getElementById("estado-feedback-msg");

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

function formatStatus(value) {
  const status = String(value ?? "null").trim().toLowerCase();
  if (status === "pending_confirmation") return "pendiente de confirmacion";
  if (status === "pending_checkout") return "checkout iniciado";
  if (status === "active") return "activa";
  if (status === "paused") return "pausada";
  if (status === "cancelled") return "cancelada";
  if (status === "rejected") return "rechazada";
  if (status === "expired") return "expirada";
  if (status === "error") return "error";
  return "sin iniciar";
}

async function fetchStatus() {
  const getSubscriptionStatus = httpsCallable(functions, "getSubscriptionStatus");
  const response = await getSubscriptionStatus();
  const status = response.data || {};
  const billingStatus = status.billingStatus ?? null;
  const appEnabled = status.appEnabled === true;
  const tenantId = String(status.tenantId || "").trim();
  const nextRoute = String(status.nextRoute || "").trim();

  setMsg(statusText, `Estado: ${formatStatus(billingStatus)}`);
  setMsg(reasonText, `Motivo: ${String(status.reason || "payment_required")}`);

  if (appEnabled && tenantId) {
    redirectIfNeeded("/horarios.html");
    return status;
  }

  if (nextRoute && normalizeRoute(nextRoute) !== normalizeRoute("/estado-suscripcion.html")) {
    redirectIfNeeded(nextRoute);
    return status;
  }

  return status;
}

retryBtn?.addEventListener("click", async () => {
  setBusy(retryBtn, true);
  try {
    setMsg(feedbackMsg, "Reintentando checkout...");
    const startSubscriptionCheckout = httpsCallable(functions, "startSubscriptionCheckout");
    const result = await startSubscriptionCheckout({ planCode: "plan_pro" });
    const initPoint = String(result.data?.initPoint || "").trim();
    if (!initPoint) {
      throw new Error("No se recibio initPoint para continuar");
    }
    window.location.assign(initPoint);
  } catch (error) {
    console.error(error);
    setMsg(feedbackMsg, error?.message || "No se pudo iniciar reintento de pago", true);
  } finally {
    setBusy(retryBtn, false);
  }
});

syncBtn?.addEventListener("click", async () => {
  setBusy(syncBtn, true);
  try {
    setMsg(feedbackMsg, "Sincronizando estado con Mercado Pago...");
    const syncSubscriptionStatus = httpsCallable(functions, "syncSubscriptionStatus");
    const response = await syncSubscriptionStatus();
    const data = response.data || {};
    setMsg(feedbackMsg, `Estado sincronizado: ${formatStatus(data.billingStatus)}`);
    await fetchStatus();
  } catch (error) {
    console.error(error);
    setMsg(feedbackMsg, error?.message || "No se pudo sincronizar estado", true);
  } finally {
    setBusy(syncBtn, false);
  }
});

logoutBtn?.addEventListener("click", async () => {
  try {
    await signOut(auth);
    window.location.replace("/horarios.html");
  } catch (error) {
    console.error(error);
    setMsg(feedbackMsg, "No se pudo cerrar sesion", true);
  }
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("/horarios.html");
    return;
  }
  userName.textContent = user.displayName || user.email || "Usuario";
  userEmail.textContent = user.email || "-";
  void fetchStatus().catch((error) => {
    console.error(error);
    setMsg(feedbackMsg, "No se pudo consultar estado de suscripcion", true);
  });
});
