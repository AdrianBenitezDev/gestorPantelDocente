import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyA5C8KGrPO5gFnWu65XPuqZvfdQkX0Y7XU",
  authDomain: "horario-escuelas.firebaseapp.com",
  projectId: "horario-escuelas",
  storageBucket: "horario-escuelas.firebasestorage.app",
  messagingSenderId: "564487094591",
  appId: "1:564487094591:web:02f8a45e61cc2fa604138a",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app);

const registerForm = document.getElementById("register-form");
const loginForm = document.getElementById("login-form");
const registerMsg = document.getElementById("register-msg");
const loginMsg = document.getElementById("login-msg");
const sessionStatus = document.getElementById("session-status");
const logoutBtn = document.getElementById("logout-btn");
const googleLoginBtn = document.getElementById("google-login-btn");

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
    const link = result.data?.verificationLink || "(no generado)";
    setMsg(registerMsg, `Cuenta creada. Verifica correo con el link generado: ${link}`);
    registerForm.reset();
  } catch (error) {
    console.error(error);
    setMsg(registerMsg, error.message || "No se pudo registrar", true);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  try {
    await signInWithEmailAndPassword(auth, email, password);
    setMsg(loginMsg, "Login correcto");
    loginForm.reset();
  } catch (error) {
    console.error(error);
    setMsg(loginMsg, "Credenciales invalidas", true);
  }
});

googleLoginBtn.addEventListener("click", async () => {
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
    setMsg(loginMsg, "Login con Google correcto");
  } catch (error) {
    console.error(error);
    setMsg(loginMsg, "No se pudo iniciar con Google", true);
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
    setMsg(loginMsg, "Sesion cerrada");
  } catch (error) {
    console.error(error);
    setMsg(loginMsg, "No se pudo cerrar sesion", true);
  }
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    sessionStatus.textContent = "Sin sesion";
    return;
  }
  sessionStatus.textContent = `UID: ${user.uid} | Email: ${user.email} | Verificado: ${user.emailVerified}`;
});


