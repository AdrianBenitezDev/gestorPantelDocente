import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";
import { formatUserError } from "./userFacingText.js";

const userNameEl = document.getElementById("admin-user-name");
const userEmailEl = document.getElementById("admin-user-email");
const logoutBtn = document.getElementById("admin-logout-btn");
const statusMsgEl = document.getElementById("admin-status-msg");
const summaryEl = document.getElementById("admin-users-summary");
const tableBodyEl = document.getElementById("admin-users-body");
const panelEl = document.getElementById("admin-panel");

function setMsg(el, text, isError = false) {
  if (!el) {
    return;
  }
  el.textContent = String(text || "");
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError);
}

function redirectToIndex() {
  window.location.replace("/index.html");
}

function isAdminForbiddenError(error) {
  const code = String(error?.code || "").trim().toLowerCase();
  const detailsCode = String(error?.details?.code || "").trim().toLowerCase();
  return code.includes("permission-denied") || detailsCode === "admin_forbidden";
}

function formatDateTime(valueMs) {
  const value = Number(valueMs);
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }
  try {
    return new Intl.DateTimeFormat("es-AR", {
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date(value));
  } catch (_error) {
    return "-";
  }
}

function appendCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = String(text || "-");
  if (className) {
    cell.className = className;
  }
  row.appendChild(cell);
}

function renderUsersTable(users = []) {
  if (!tableBodyEl) {
    return;
  }
  tableBodyEl.textContent = "";
  const list = Array.isArray(users) ? users : [];

  if (!list.length) {
    const emptyRow = document.createElement("tr");
    const emptyCell = document.createElement("td");
    emptyCell.colSpan = 13;
    emptyCell.textContent = "No se encontraron usuarios.";
    emptyRow.appendChild(emptyCell);
    tableBodyEl.appendChild(emptyRow);
    return;
  }

  list.forEach((user, index) => {
    const row = document.createElement("tr");
    appendCell(row, index + 1);
    appendCell(row, user.nombre || "-");
    appendCell(row, user.correo || "-");
    appendCell(row, user.distrito || "-");
    appendCell(row, user.nivel || "-");
    appendCell(row, user.escuela || "-");
    appendCell(row, user.planCode || "-");
    appendCell(row, user.billingStatus || "-");
    appendCell(row, user.appEnabled ? "SI" : "NO", user.appEnabled ? "admin-flag-ok" : "admin-flag-off");
    appendCell(row, user.tenantId || "-");
    appendCell(row, formatDateTime(user.createdAtMs));
    appendCell(row, formatDateTime(user.updatedAtMs));
    appendCell(row, user.uid || "-");
    tableBodyEl.appendChild(row);
  });
}

async function loadAdminUsers() {
  setMsg(statusMsgEl, "Verificando acceso admin y cargando usuarios...");
  const callable = httpsCallable(functions, "getAdminUsers");
  const response = await callable({});
  const data = response.data || {};
  const users = Array.isArray(data.users) ? data.users : [];
  renderUsersTable(users);
  if (summaryEl) {
    summaryEl.textContent = `Total usuarios: ${users.length}`;
  }
  setMsg(statusMsgEl, `Acceso admin validado para ${String(data.adminEmail || "-")}.`);
  if (panelEl) {
    panelEl.hidden = false;
  }
}

logoutBtn?.addEventListener("click", async () => {
  try {
    await signOut(auth);
    redirectToIndex();
  } catch (error) {
    console.error(error);
    setMsg(statusMsgEl, "No se pudo cerrar sesion.", true);
  }
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    redirectToIndex();
    return;
  }

  userNameEl.textContent = user.displayName || user.email || "Usuario";
  userEmailEl.textContent = user.email || "-";

  void loadAdminUsers().catch((error) => {
    console.error(error);
    if (isAdminForbiddenError(error)) {
      redirectToIndex();
      return;
    }
    setMsg(statusMsgEl, formatUserError(error, "No se pudieron cargar los usuarios."), true);
  });
});
