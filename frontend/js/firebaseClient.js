import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";

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
const functions = getFunctions(app, "us-central1");

export { app, auth, functions };
