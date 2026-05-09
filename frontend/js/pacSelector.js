import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";
import { formatUserError } from "./userFacingText.js";

const userNameEl = document.getElementById("pac-selector-user-name");
const userEmailEl = document.getElementById("pac-selector-user-email");
const authBtn = document.getElementById("pac-selector-auth-btn");
const guestLoginBtn = document.getElementById("pac-selector-guest-login-btn");
const msgEl = document.getElementById("pac-selector-msg");
const guestSection = document.getElementById("pac-selector-guest-section");
const authSection = document.getElementById("pac-selector-auth-content");

const state = {
  checkingAccess: false,
  hasTenantAccess: false,
};

function setMsg(text, isError = false) {
  if (!msgEl) {
    return;
  }
  msgEl.textContent = String(text || "");
  msgEl.classList.toggle("error", isError);
  msgEl.classList.toggle("success", !isError && Boolean(text));
}

function setBusy(button, busy) {
  if (!button) {
    return;
  }
  button.disabled = busy;
}

function normalizeRoute(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function redirectIfNeeded(route) {
  const target = String(route || "").trim();
  if (!target) {
    return false;
  }
  if (normalizeRoute(window.location.pathname) === normalizeRoute(target)) {
    return false;
  }
  window.location.replace(target);
  return true;
}

function resolveSubscriptionRouteFallback(data = {}) {
  const nextRoute = String(data?.nextRoute || "").trim();
  if (nextRoute) {
    return nextRoute;
  }
  const appEnabled = data?.appEnabled === true;
  const tenantId = String(data?.tenantId || "").trim();
  if (appEnabled && tenantId) {
    return "";
  }
  return "/activar-plan.html";
}

function updateGuestView(user, hasAccess) {
  const hasSession = Boolean(user);
  const canUseApp = Boolean(hasSession && hasAccess);
  if (guestSection) {
    guestSection.hidden = canUseApp;
    guestSection.classList.toggle("is-hidden", canUseApp);
  }
  if (authSection) {
    authSection.hidden = !canUseApp;
    authSection.classList.toggle("is-hidden", !canUseApp);
  }
}

function updateHeaderAuthButton(user) {
  if (!authBtn) {
    return;
  }
  if (user) {
    authBtn.textContent = "Cerrar sesion";
    authBtn.dataset.authAction = "logout";
    return;
  }
  authBtn.textContent = "Iniciar sesion con Google";
  authBtn.dataset.authAction = "login";
}

async function signInWithGoogleAccount() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: "select_account",
  });
  await signInWithPopup(auth, provider);
}

async function validateTenantAccessForUser() {
  if (!auth.currentUser) {
    state.hasTenantAccess = false;
    return false;
  }
  state.checkingAccess = true;
  try {
    const callable = httpsCallable(functions, "getSubscriptionStatus");
    const response = await callable({});
    const data = response.data || {};
    const appEnabled = data.appEnabled === true;
    const tenantId = String(data.tenantId || "").trim();
    state.hasTenantAccess = Boolean(appEnabled && tenantId);
    if (!state.hasTenantAccess) {
      const route = resolveSubscriptionRouteFallback(data);
      redirectIfNeeded(route);
    }
    return state.hasTenantAccess;
  } catch (error) {
    console.error("pac selector access check failed", error);
    state.hasTenantAccess = false;
    const detailsCode = String(error?.details?.code || "").trim().toLowerCase();
    if (detailsCode === "user_profile_missing") {
      redirectIfNeeded("/registro.html");
    } else {
      redirectIfNeeded("/activar-plan.html");
    }
    return false;
  } finally {
    state.checkingAccess = false;
  }
}

authBtn?.addEventListener("click", async () => {
  const action = String(authBtn.dataset.authAction || "").trim();
  if (action === "logout" && auth.currentUser) {
    try {
      setBusy(authBtn, true);
      await signOut(auth);
      setMsg("Sesion cerrada.");
    } catch (error) {
      console.error(error);
      setMsg("No se pudo cerrar sesion.", true);
    } finally {
      setBusy(authBtn, false);
    }
    return;
  }

  try {
    setBusy(authBtn, true);
    setMsg("Abriendo Google para iniciar sesion...");
    await signInWithGoogleAccount();
    setMsg("Sesion iniciada.");
  } catch (error) {
    console.error(error);
    setMsg(formatUserError(error, "No se pudo iniciar sesion con Google."), true);
  } finally {
    setBusy(authBtn, false);
  }
});

guestLoginBtn?.addEventListener("click", async () => {
  try {
    setBusy(guestLoginBtn, true);
    setMsg("Abriendo Google para iniciar sesion...");
    await signInWithGoogleAccount();
    setMsg("Sesion iniciada.");
  } catch (error) {
    console.error(error);
    setMsg(formatUserError(error, "No se pudo iniciar sesion con Google."), true);
  } finally {
    setBusy(guestLoginBtn, false);
  }
});

onAuthStateChanged(auth, (user) => {
  updateHeaderAuthButton(user);

  if (!user) {
    userNameEl.textContent = "Sin sesion";
    userEmailEl.textContent = "-";
    state.hasTenantAccess = false;
    updateGuestView(null, false);
    setMsg("Inicia sesion para elegir el metodo de procesamiento PAC.");
    return;
  }

  userNameEl.textContent = user.displayName || user.email || "Usuario";
  userEmailEl.textContent = user.email || "-";
  updateGuestView(user, false);
  setMsg("Validando acceso por suscripcion...");

  void validateTenantAccessForUser().then((hasAccess) => {
    if (String(auth.currentUser?.uid || "") !== String(user?.uid || "")) {
      return;
    }
    updateGuestView(user, hasAccess);
    if (hasAccess) {
      setMsg("Selecciona como deseas trabajar con PAC.");
    }
  });
});
