import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { functions } from "./firebaseClient.js";

const registerForm = document.getElementById("register-form");
const registerMsg = document.getElementById("register-msg");

function setMsg(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError);
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
    usuario: document.getElementById("reg-usuario").value.trim(),
    password: document.getElementById("reg-password").value,
  };

  if (!payload.correo.includes("@")) {
    setMsg(registerMsg, "Correo invalido", true);
    return;
  }

  try {
    setMsg(registerMsg, "Creando cuenta...");
    const registerUser = httpsCallable(functions, "registerUser");
    const result = await registerUser(payload);
    const tenantId = result.data?.tenantId || "(sin tenant)";
    const link = result.data?.verificationLink || "(no generado)";
    setMsg(registerMsg, `Cuenta creada. Tenant: ${tenantId}. Verifica correo con el link generado: ${link}`);
    registerForm.reset();
  } catch (error) {
    console.error(error);
    setMsg(registerMsg, error.message || "No se pudo registrar", true);
  }
});
