import {
  onAuthStateChanged,
  signInWithCustomToken,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";
import { formatUserError } from "./userFacingText.js";

const registerForm = document.getElementById("register-form");
const registerMsg = document.getElementById("register-msg");
const registerEmailInput = document.getElementById("reg-correo");
const registerSubmitBtn = registerForm?.querySelector("button[type='submit']") || null;
const CHECK_EMAIL_DEBOUNCE_MS = 450;
const EMAIL_FORMAT_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

let checkEmailTimer = null;
let checkEmailSeq = 0;
let latestEmailStatus = {
  correo: "",
  checked: false,
  exists: false,
  hasProfile: false,
  nextRoute: "/activar-plan.html",
};

function setMsg(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError);
}

function setRegisterSubmitEnabled(enabled) {
  if (!registerSubmitBtn) {
    return;
  }
  registerSubmitBtn.disabled = !enabled;
}

function normalizeEmailValue(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmailFormat(value) {
  const normalized = normalizeEmailValue(value);
  return EMAIL_FORMAT_PATTERN.test(normalized);
}

function formatExistingEmailMessage(status = {}) {
  const route = String(status.nextRoute || "/activar-plan.html").trim() || "/activar-plan.html";
  const email = normalizeEmailValue(status.correo || "");
  const currentSessionEmail = normalizeEmailValue(auth.currentUser?.email || "");
  if (email && currentSessionEmail && email === currentSessionEmail) {
    return `Este correo ya esta registrado para tu sesion actual. Continua desde ${route}.`;
  }
  return `Este correo ya esta registrado. Inicia sesion y continua desde ${route}.`;
}

function clearExistingEmailMessageIfNeeded() {
  const current = String(registerMsg?.textContent || "").trim();
  if (!current) {
    return;
  }
  if (
    current.startsWith("Este correo ya esta registrado") ||
    current.startsWith("Este correo ya existe en Google Auth")
  ) {
    setMsg(registerMsg, "");
  }
}

async function checkRegisterEmailStatus(rawEmail, options = {}) {
  const silent = options.silent === true;
  const correo = normalizeEmailValue(rawEmail);
  if (!correo || !isValidEmailFormat(correo)) {
    return {
      correo,
      checked: false,
      exists: false,
      hasProfile: false,
      nextRoute: "/activar-plan.html",
    };
  }

  if (latestEmailStatus.checked && latestEmailStatus.correo === correo) {
    return latestEmailStatus;
  }

  const seq = ++checkEmailSeq;
  try {
    const callable = httpsCallable(functions, "checkRegisterEmailStatus");
    const response = await callable({ correo });
    if (seq !== checkEmailSeq) {
      return latestEmailStatus;
    }
    const data = response.data || {};
    latestEmailStatus = {
      correo,
      checked: true,
      exists: data.exists === true,
      hasProfile: data.hasProfile === true,
      nextRoute: String(data.nextRoute || "/activar-plan.html").trim() || "/activar-plan.html",
    };
    return latestEmailStatus;
  } catch (error) {
    console.error("checkRegisterEmailStatus error", error);
    if (!silent) {
      setMsg(registerMsg, formatUserError(error, "No pudimos validar el correo ingresado."), true);
    }
    return {
      correo,
      checked: false,
      exists: false,
      hasProfile: false,
      nextRoute: "/activar-plan.html",
    };
  }
}

async function runRegisterEmailPrecheck(options = {}) {
  const silent = options.silent === true;
  const correo = normalizeEmailValue(registerEmailInput?.value || "");
  if (!correo || !isValidEmailFormat(correo)) {
    latestEmailStatus = {
      correo,
      checked: false,
      exists: false,
      hasProfile: false,
      nextRoute: "/activar-plan.html",
    };
    setRegisterSubmitEnabled(true);
    if (!silent) {
      clearExistingEmailMessageIfNeeded();
    }
    return latestEmailStatus;
  }

  const status = await checkRegisterEmailStatus(correo, { silent });
  if (normalizeEmailValue(registerEmailInput?.value || "") !== status.correo) {
    return status;
  }

  if (status.exists && status.hasProfile) {
    setRegisterSubmitEnabled(false);
    if (!silent) {
      setMsg(registerMsg, formatExistingEmailMessage(status), true);
    }
    return status;
  }

  let keepInfoMessage = false;
  if (status.exists && !status.hasProfile && !silent) {
    setMsg(
      registerMsg,
      "Este correo ya existe en Google Auth, pero aun no tiene perfil completo. Puedes continuar con este registro.",
      false
    );
    keepInfoMessage = true;
  }

  setRegisterSubmitEnabled(true);
  if (!silent && !keepInfoMessage) {
    clearExistingEmailMessageIfNeeded();
  }
  return status;
}

function scheduleRegisterEmailPrecheck() {
  if (checkEmailTimer) {
    clearTimeout(checkEmailTimer);
  }
  checkEmailTimer = setTimeout(() => {
    void runRegisterEmailPrecheck();
  }, CHECK_EMAIL_DEBOUNCE_MS);
}

function hydrateCurrentAccountEmail(user) {
  if (!registerEmailInput) {
    return;
  }
  const currentValue = String(registerEmailInput.value || "").trim();
  if (currentValue) {
    return;
  }
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) {
    return;
  }
  registerEmailInput.value = email;
  scheduleRegisterEmailPrecheck();
}

function normalizeUsernameSeed(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 28);
}

function buildAutoUsername(payload = {}) {
  const emailLocal = String(payload.correo || "").split("@")[0] || "";
  const nameSeed = String(payload.nombre || "").split(" ")[0] || "";
  const base = normalizeUsernameSeed(emailLocal) || normalizeUsernameSeed(nameSeed) || "usuario";
  const suffix = Math.random().toString(36).slice(2, 8);
  const combined = `${base}_${suffix}`.slice(0, 40);
  if (combined.length >= 3) {
    return combined;
  }
  return `${combined}123`.slice(0, 3);
}

function buildGeneratedPassword() {
  const randomPart = Math.random().toString(36).slice(2, 12);
  const fallbackPart = Date.now().toString(36).slice(-6);
  return `Pd_${randomPart}${fallbackPart}_A1!`;
}

onAuthStateChanged(auth, (user) => {
  hydrateCurrentAccountEmail(user);
});
hydrateCurrentAccountEmail(auth.currentUser);

if (registerEmailInput) {
  registerEmailInput.addEventListener("input", () => {
    latestEmailStatus = {
      correo: "",
      checked: false,
      exists: false,
      hasProfile: false,
      nextRoute: "/activar-plan.html",
    };
    scheduleRegisterEmailPrecheck();
  });
  registerEmailInput.addEventListener("blur", () => {
    void runRegisterEmailPrecheck();
  });
}

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    distrito: document.getElementById("reg-distrito").value.trim(),
    nivel: document.getElementById("reg-nivel").value.trim(),
    escuela: document.getElementById("reg-escuela").value.trim(),
    nombre: document.getElementById("reg-nombre").value.trim(),
    contacto: document.getElementById("reg-contacto").value.trim(),
    correo: document.getElementById("reg-correo").value.trim(),
    correoAlt: document.getElementById("reg-correo-alt").value.trim(),
  };

  if (!payload.correo.includes("@")) {
    setMsg(registerMsg, "Correo inv\u00e1lido", true);
    return;
  }

  const precheck = await runRegisterEmailPrecheck({ silent: true });
  if (precheck.exists && precheck.hasProfile) {
    setMsg(registerMsg, formatExistingEmailMessage(precheck), true);
    return;
  }

  const generatedPassword = buildGeneratedPassword();
  const registerPayload = {
    ...payload,
    usuario: buildAutoUsername(payload),
    password: generatedPassword,
  };

  let verificationLink = "";
  try {
    setMsg(registerMsg, "Creando cuenta...");
    const registerUser = httpsCallable(functions, "registerUser");
    const startSubscriptionCheckout = httpsCallable(functions, "startSubscriptionCheckout");
    const result = await registerUser(registerPayload);
    verificationLink = String(result.data?.verificationLink || "").trim();
    const customAuthToken = String(result.data?.customAuthToken || "").trim();
    const planCode = String(document.getElementById("reg-plan-code")?.value || "plan_pro")
      .trim()
      .toLowerCase();

    setMsg(registerMsg, "Cuenta creada. Preparando el pago de la suscripcion...");

    if (!customAuthToken) {
      throw new Error("No se pudo iniciar sesion automaticamente luego del registro.");
    }
    await signInWithCustomToken(auth, customAuthToken);
    const checkoutResult = await startSubscriptionCheckout({ planCode });
    const initPoint = String(checkoutResult.data?.initPoint || "").trim();
    if (!initPoint) {
      throw new Error("No pudimos iniciar el pago. Intenta nuevamente.");
    }

    window.location.assign(initPoint);
    return;
  } catch (error) {
    console.error(error);
    const verificationHint =
      verificationLink
        ? ` Verifica correo con el link generado: ${verificationLink}`
        : "";
    const fallbackMsg =
      `La cuenta base queda recuperable. Puedes continuar luego desde /activar-plan.html.${verificationHint}`;
    const baseMsg = formatUserError(error, "No pudimos completar el registro y el inicio del pago.");
    setMsg(registerMsg, `${baseMsg}. ${fallbackMsg}`, true);
  }
});
