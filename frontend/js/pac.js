import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";

const connectBtn = document.getElementById("pac-connect-btn");
const logoutBtn = document.getElementById("pac-logout-btn");
const previewBtn = document.getElementById("pac-preview-btn");
const runBtn = document.getElementById("pac-run-btn");
const authMsg = document.getElementById("pac-auth-msg");
const runMsg = document.getElementById("pac-run-msg");
const summaryMsg = document.getElementById("pac-summary-msg");
const errorsMsg = document.getElementById("pac-errors-msg");
const userNameEl = document.getElementById("pac-user-name");
const userEmailEl = document.getElementById("pac-user-email");
const resultsBody = document.getElementById("pac-results-body");

const modeInput = document.getElementById("pac-mode");
const queryInput = document.getElementById("pac-gmail-query");
const maxResultsInput = document.getElementById("pac-max-results");
const sheetUrlInput = document.getElementById("pac-sheet-url");
const sheetNameInput = document.getElementById("pac-sheet-name");
const startRowInput = document.getElementById("pac-start-row");

const state = {
  accessToken: "",
  rows: [],
  busy: false,
};

function setMsg(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError && Boolean(text));
}

function setBusy(btn, busy) {
  btn.disabled = busy;
  if (busy) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = "Procesando...";
  } else if (btn.dataset.originalText) {
    btn.textContent = btn.dataset.originalText;
  }
}

function sanitize(value) {
  return String(value || "").replace(/[<>&]/g, "");
}

function renderRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) {
    resultsBody.innerHTML = `<tr><td colspan="9">Sin datos</td></tr>`;
    return;
  }

  const html = safeRows
    .slice(0, 200)
    .map((row) => {
      const missing = Array.isArray(row.missingFields) && row.missingFields.length
        ? ` (faltan: ${row.missingFields.join(", ")})`
        : "";
      return `<tr>
        <td>${sanitize(row.cupof)}</td>
        <td>${sanitize(row.dni)}</td>
        <td>${sanitize(row.fechaNacimiento)}</td>
        <td>${sanitize(row.apellidoNombre)}</td>
        <td>${sanitize(row.pid)}</td>
        <td>${sanitize(row.cargoModulosHoras)}</td>
        <td>${sanitize(row.curso)}</td>
        <td>${sanitize(row.division)}</td>
        <td title="${sanitize(row.messageId)}">${sanitize(row.subject)}${sanitize(missing)}</td>
      </tr>`;
    })
    .join("");

  resultsBody.innerHTML = html;
}

function buildPayload(previewOnly) {
  const maxResults = Number(maxResultsInput.value || 30);
  const startRow = Number(startRowInput.value || 14);
  return {
    mode: String(modeInput.value || "interinos_docx"),
    gmailQuery: String(queryInput.value || "").trim(),
    maxResults: Number.isFinite(maxResults) ? maxResults : 30,
    sheetUrl: String(sheetUrlInput.value || "").trim(),
    sheetName: String(sheetNameInput.value || "").trim(),
    startRow: Number.isFinite(startRow) ? startRow : 14,
    previewOnly: Boolean(previewOnly),
    accessToken: state.accessToken,
  };
}

function formatSummary(result, previewOnly) {
  const parts = [
    `Mails encontrados: ${Number(result.totalMessages || 0)}`,
    `Filas extraidas: ${Number(result.rowsExtracted || 0)}`,
    `Errores: ${Number(result.errorsCount || 0)}`,
  ];
  if (!previewOnly && result.writeSummary) {
    parts.push(`Filas escritas: ${Number(result.writeSummary.rowsWritten || 0)}`);
    parts.push(`Rango: ${String(result.writeSummary.range || "-")}`);
  }
  return parts.join(" | ");
}

function formatCallableError(error) {
  const base = String(error?.message || "No se pudo ejecutar el proceso PAC");
  const details = error?.details && typeof error.details === "object" ? error.details : null;
  if (!details) {
    return base;
  }

  const lines = [];
  if (details.errorType) {
    lines.push(`Tipo: ${String(details.errorType)}`);
  }
  if (Array.isArray(details.missingScopes) && details.missingScopes.length) {
    lines.push(`Scopes faltantes: ${details.missingScopes.join(", ")}`);
  }
  if (Array.isArray(details.grantedScopes) && details.grantedScopes.length) {
    lines.push(`Scopes del token: ${details.grantedScopes.join(", ")}`);
  }
  if (details.apiContext) {
    lines.push(`API: ${String(details.apiContext)}`);
  }
  if (details.status) {
    lines.push(`HTTP status: ${String(details.status)}`);
  }
  if (details.googleReason) {
    lines.push(`Google reason: ${String(details.googleReason)}`);
  }
  if (details.googleErrorMessage) {
    lines.push(`Google message: ${String(details.googleErrorMessage)}`);
  }

  return lines.length ? `${base}\n${lines.join("\n")}` : base;
}

async function runPacProcess(previewOnly) {
  if (state.busy) {
    return;
  }
  if (!auth.currentUser) {
    setMsg(runMsg, "Inicia sesion con Google antes de ejecutar el proceso", true);
    return;
  }
  if (!state.accessToken) {
    setMsg(runMsg, "Primero presiona 'Conectar Gmail + Sheets' para autorizar permisos", true);
    return;
  }

  if (!previewOnly) {
    const sheetUrl = String(sheetUrlInput.value || "").trim();
    if (!sheetUrl) {
      setMsg(runMsg, "Para crear PAC debes completar la URL de plantilla", true);
      return;
    }
  }

  state.busy = true;
  setBusy(previewBtn, true);
  setBusy(runBtn, true);
  setMsg(runMsg, previewOnly ? "Ejecutando prueba..." : "Creando PAC...");
  setMsg(summaryMsg, "");
  setMsg(errorsMsg, "");

  const callable = httpsCallable(functions, "runPacProcess");
  try {
    const payload = buildPayload(previewOnly);
    const response = await callable(payload);
    const result = response.data || {};
    state.rows = Array.isArray(result.rows) ? result.rows : [];
    renderRows(state.rows);
    let summaryText = formatSummary(result, previewOnly);
    if (result?.diagnostics?.tokenEmail) {
      summaryText += ` | Token: ${String(result.diagnostics.tokenEmail)}`;
    }
    if (Array.isArray(result?.diagnostics?.missingScopes) && result.diagnostics.missingScopes.length) {
      summaryText += ` | Scopes faltantes: ${result.diagnostics.missingScopes.join(", ")}`;
    }
    setMsg(summaryMsg, summaryText);

    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (errors.length) {
      const lines = errors.slice(0, 25).map((item) => {
        const id = String(item.messageId || "-");
        const reason = String(item.reason || "Sin detalle");
        return `- ${id}: ${reason}`;
      });
      setMsg(errorsMsg, `Errores detectados:\n${lines.join("\n")}`, true);
    } else {
      setMsg(errorsMsg, "Sin errores.");
    }

    setMsg(runMsg, previewOnly ? "Prueba finalizada" : "PAC generado correctamente");
  } catch (error) {
    console.error("PAC callable error", {
      code: error?.code || "",
      message: error?.message || "",
      details: error?.details || null,
      customData: error?.customData || null,
    });
    setMsg(runMsg, formatCallableError(error), true);
  } finally {
    state.busy = false;
    setBusy(previewBtn, false);
    setBusy(runBtn, false);
  }
}

connectBtn.addEventListener("click", async () => {
  try {
    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/gmail.readonly");
    provider.addScope("https://www.googleapis.com/auth/spreadsheets");
    provider.setCustomParameters({
      prompt: "consent",
      include_granted_scopes: "true",
    });

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken || "";
    if (!accessToken) {
      throw new Error("No se obtuvo accessToken para Gmail/Sheets");
    }
    state.accessToken = accessToken;
    setMsg(authMsg, "Permisos Gmail + Sheets autorizados.");
  } catch (error) {
    console.error(error);
    setMsg(authMsg, error.message || "No se pudo autorizar Gmail + Sheets", true);
  }
});

previewBtn.addEventListener("click", () => {
  runPacProcess(true);
});

runBtn.addEventListener("click", () => {
  runPacProcess(false);
});

logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
    state.accessToken = "";
    state.rows = [];
    renderRows([]);
    setMsg(authMsg, "Sesion cerrada");
    setMsg(runMsg, "");
    setMsg(summaryMsg, "");
    setMsg(errorsMsg, "");
  } catch (error) {
    console.error(error);
    setMsg(authMsg, "No se pudo cerrar sesion", true);
  }
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    userNameEl.textContent = "Sin sesion";
    userEmailEl.textContent = "-";
    if (!state.accessToken) {
      setMsg(authMsg, "Inicia sesion con Google y luego autoriza Gmail + Sheets.");
    }
    return;
  }

  userNameEl.textContent = user.displayName || user.email || "Usuario";
  userEmailEl.textContent = user.email || "-";
  if (!state.accessToken) {
    setMsg(authMsg, "Sesion iniciada. Falta autorizar Gmail + Sheets.");
  }
});

renderRows([]);
