import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";

const registerForm = document.getElementById("register-form");
const registerMsg = document.getElementById("register-msg");
const registerEmailInput = document.getElementById("reg-correo");

function setMsg(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError);
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
}

onAuthStateChanged(auth, (user) => {
  hydrateCurrentAccountEmail(user);
});
hydrateCurrentAccountEmail(auth.currentUser);

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
    usuario: document.getElementById("reg-usuario").value.trim(),
    password: document.getElementById("reg-password").value,
  };

  if (!payload.correo.includes("@")) {
    setMsg(registerMsg, "Correo inv\u00e1lido", true);
    return;
  }

  let verificationLink = "";
  try {
    setMsg(registerMsg, "Creando cuenta...");
    const registerUser = httpsCallable(functions, "registerUser");
    const startSubscriptionCheckout = httpsCallable(functions, "startSubscriptionCheckout");
    const result = await registerUser(payload);
    verificationLink = String(result.data?.verificationLink || "").trim();
    const planCode = String(document.getElementById("reg-plan-code")?.value || "plan_pro")
      .trim()
      .toLowerCase();

    setMsg(registerMsg, "Cuenta base creada. Iniciando checkout de suscripci\u00f3n...");

    await signInWithEmailAndPassword(auth, payload.correo.toLowerCase(), payload.password);
    const checkoutResult = await startSubscriptionCheckout({ planCode });
    const initPoint = String(checkoutResult.data?.initPoint || "").trim();
    if (!initPoint) {
      throw new Error("No se recibi\u00f3 initPoint para iniciar el checkout");
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
    const baseMsg = error?.message || "No se pudo registrar o iniciar checkout";
    setMsg(registerMsg, `${baseMsg}. ${fallbackMsg}`, true);
  }
});
