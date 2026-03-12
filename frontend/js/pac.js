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

const selectAllBtn = document.getElementById("pac-select-all-btn");
const selectAllCheckbox = document.getElementById("pac-select-all-checkbox");
const selectedCountEl = document.getElementById("pac-selected-count");

const floatingActions = document.getElementById("pac-floating-actions");
const floatCancelBtn = document.getElementById("pac-float-cancel-btn");
const floatDownloadBtn = document.getElementById("pac-float-download-btn");
const floatSaveBtn = document.getElementById("pac-float-save-btn");
const floatPreviewBtn = document.getElementById("pac-float-preview-btn");

const state = {
  accessToken: "",
  rows: [],
  selectedRowIds: new Set(),
  busy: false,
  savedFile: null,
};

function setMsg(el, text, isError = false) {
  if (!el) {
    return;
  }
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError && Boolean(text));
}

function setBusy(btn, busy) {
  if (!btn) {
    return;
  }
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

function formatListAsText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean).join("; ");
  }
  return String(value || "").trim();
}

function safeRowId(index, row) {
  const messageId = String(row?.messageId || "").trim() || "row";
  return `${messageId}-${index}`;
}

function decorateRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row, index) => ({
    ...row,
    __rowId: safeRowId(index, row),
  }));
}

function getSelectedRows() {
  return state.rows.filter((row) => state.selectedRowIds.has(row.__rowId));
}

function setFloatingVisible(visible) {
  if (!floatingActions) {
    return;
  }
  floatingActions.hidden = !visible;
}

function updateSelectionUI() {
  const total = state.rows.length;
  const selected = getSelectedRows().length;

  if (selectedCountEl) {
    selectedCountEl.textContent = `Filas seleccionadas: ${selected}/${total}`;
  }

  const allChecked = total > 0 && selected === total;
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = allChecked;
    selectAllCheckbox.indeterminate = selected > 0 && selected < total;
  }

  if (selectAllBtn) {
    selectAllBtn.textContent = allChecked ? "Deseleccionar todo" : "Seleccionar todo";
    selectAllBtn.disabled = total === 0;
  }

  const hasRows = total > 0;
  setFloatingVisible(hasRows);
  if (floatSaveBtn) {
    floatSaveBtn.disabled = !hasRows || selected === 0;
  }
  if (floatDownloadBtn) {
    floatDownloadBtn.disabled = !hasRows || selected === 0;
  }
  if (floatPreviewBtn) {
    floatPreviewBtn.disabled = !hasRows || selected === 0;
  }
}

function renderRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) {
    resultsBody.innerHTML = `<tr><td colspan="10">Sin datos</td></tr>`;
    updateSelectionUI();
    return;
  }

  const html = safeRows
    .slice(0, 500)
    .map((row) => {
      const missing = Array.isArray(row.missingFields) && row.missingFields.length
        ? ` (faltan: ${row.missingFields.join(", ")})`
        : "";
      const checked = state.selectedRowIds.has(row.__rowId) ? "checked" : "";
      return `<tr>
        <td><input class="pac-row-checkbox" type="checkbox" data-row-id="${sanitize(row.__rowId)}" ${checked} /></td>
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
  updateSelectionUI();
}

function toggleSelectAll(forceValue = null) {
  const shouldSelect = typeof forceValue === "boolean"
    ? forceValue
    : getSelectedRows().length !== state.rows.length;

  if (shouldSelect) {
    state.selectedRowIds = new Set(state.rows.map((row) => row.__rowId));
  } else {
    state.selectedRowIds.clear();
  }
  renderRows(state.rows);
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

function buildSavePayload(rows) {
  const startRow = Number(startRowInput.value || 14);
  return {
    mode: String(modeInput.value || "interinos_docx"),
    sheetUrl: String(sheetUrlInput.value || "").trim(),
    sheetName: String(sheetNameInput.value || "").trim(),
    startRow: Number.isFinite(startRow) ? startRow : 14,
    accessToken: state.accessToken,
    outputTitle: "",
    rows,
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

function buildErrorsText(errors) {
  const safeErrors = Array.isArray(errors) ? errors : [];
  if (!safeErrors.length) {
    return "Sin errores.";
  }
  const lines = safeErrors.slice(0, 25).map((item) => {
    const id = String(item.messageId || "-");
    const reason = String(item.reason || "Sin detalle");
    const subject = String(item.subject || "(sin asunto)");
    const from = String(item.from || "(sin remitente)");
    const date = String(item.date || "(sin fecha)");
    const attachments = String(item.attachmentsSummary || "");
    const driveLinks = String(item.driveLinksSummary || "");
    const sourceErrors = formatListAsText(item.sourceErrors || "");
    const base = `- ${id} | ${subject} | ${from} | ${date}`;
    const extraLines = [];
    if (attachments) {
      extraLines.push(`Adjuntos detectados: ${attachments}`);
    }
    if (driveLinks) {
      extraLines.push(`Links Drive detectados: ${driveLinks}`);
    }
    if (sourceErrors) {
      extraLines.push(`Detalle fuente: ${sourceErrors}`);
    }
    const extra = extraLines.length ? `\n  ${extraLines.join("\n  ")}` : "";
    return `${base}\n  Motivo: ${reason}${extra}`;
  });
  return `Errores detectados:\n${lines.join("\n")}`;
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
    setMsg(runMsg, "Primero presiona 'Conectar Gmail + Sheets + Drive' para autorizar permisos", true);
    return;
  }

  state.busy = true;
  setBusy(previewBtn, true);
  setBusy(runBtn, true);
  setMsg(runMsg, previewOnly ? "Ejecutando prueba..." : "Procesando...");
  setMsg(summaryMsg, "");
  setMsg(errorsMsg, "");

  const callable = httpsCallable(functions, "runPacProcess");
  try {
    const payload = buildPayload(previewOnly);
    const response = await callable(payload);
    const result = response.data || {};
    const rows = decorateRows(Array.isArray(result.rows) ? result.rows : []);

    state.rows = rows;
    state.savedFile = null;
    state.selectedRowIds = new Set(rows.map((row) => row.__rowId));
    renderRows(state.rows);

    let summaryText = formatSummary(result, previewOnly);
    if (result?.diagnostics?.tokenEmail) {
      summaryText += ` | Token: ${String(result.diagnostics.tokenEmail)}`;
    }
    if (Array.isArray(result?.diagnostics?.missingScopes) && result.diagnostics.missingScopes.length) {
      summaryText += ` | Scopes faltantes: ${result.diagnostics.missingScopes.join(", ")}`;
    }
    setMsg(summaryMsg, summaryText);
    setMsg(errorsMsg, buildErrorsText(result.errors), Array.isArray(result.errors) && result.errors.length > 0);

    setMsg(runMsg, previewOnly ? "Prueba finalizada" : "Proceso completado");
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

function downloadCsv(rows, filename = "pac-seleccion.csv") {
  const header = ["CUPOF", "DNI", "Fecha Nac", "Apellido y Nombre", "PID", "Cargo/Modulos/Horas", "Curso", "Division", "Asunto"];
  const dataRows = (Array.isArray(rows) ? rows : []).map((row) => [
    String(row.cupof || ""),
    String(row.dni || ""),
    String(row.fechaNacimiento || ""),
    String(row.apellidoNombre || ""),
    String(row.pid || ""),
    String(row.cargoModulosHoras || ""),
    String(row.curso || ""),
    String(row.division || ""),
    String(row.subject || ""),
  ]);

  const csv = [header, ...dataRows]
    .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function saveSelectedRowsToDrive() {
  if (state.busy) {
    return null;
  }

  const selectedRows = getSelectedRows();
  if (!selectedRows.length) {
    setMsg(runMsg, "Selecciona al menos una fila antes de guardar en Drive", true);
    return null;
  }

  const sheetUrl = String(sheetUrlInput.value || "").trim();
  if (!sheetUrl) {
    setMsg(runMsg, "Debes completar la URL de plantilla", true);
    return null;
  }

  state.busy = true;
  setBusy(previewBtn, true);
  setBusy(runBtn, true);
  if (floatSaveBtn) {
    setBusy(floatSaveBtn, true);
  }
  setMsg(runMsg, "Guardando archivo en Drive...");

  const callable = httpsCallable(functions, "savePacRowsToDrive");
  try {
    const payload = buildSavePayload(selectedRows);
    const response = await callable(payload);
    const result = response.data || {};
    state.savedFile = result;

    const written = Number(result.rowsWritten || 0);
    const sheetUrlResult = String(result.sheetUrl || "");
    setMsg(runMsg, `Archivo guardado en Drive. Filas escritas: ${written}. ${sheetUrlResult}`);
    return result;
  } catch (error) {
    console.error("savePacRowsToDrive error", error);
    setMsg(runMsg, formatCallableError(error), true);
    return null;
  } finally {
    state.busy = false;
    setBusy(previewBtn, false);
    setBusy(runBtn, false);
    if (floatSaveBtn) {
      setBusy(floatSaveBtn, false);
    }
  }
}

function openPreviewTab() {
  const selectedRows = getSelectedRows();
  if (!selectedRows.length) {
    setMsg(runMsg, "Selecciona al menos una fila para abrir la vista previa", true);
    return;
  }

  const previewPayload = {
    rows: selectedRows,
    mode: String(modeInput.value || "interinos_docx"),
    sheetUrl: String(sheetUrlInput.value || "").trim(),
    sheetName: String(sheetNameInput.value || "").trim(),
    startRow: Number(startRowInput.value || 14),
    accessToken: state.accessToken,
    savedFile: state.savedFile || null,
  };

  localStorage.setItem("pacPreviewPayload", JSON.stringify(previewPayload));
  window.open("/pac-preview.html", "_blank", "noopener");
}

function cancelSelectionFlow() {
  state.rows = [];
  state.selectedRowIds.clear();
  state.savedFile = null;
  renderRows([]);
  setMsg(summaryMsg, "");
  setMsg(errorsMsg, "");
  setMsg(runMsg, "Operacion cancelada");
}

connectBtn.addEventListener("click", async () => {
  try {
    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/gmail.readonly");
    provider.addScope("https://www.googleapis.com/auth/spreadsheets");
    provider.addScope("https://www.googleapis.com/auth/drive.readonly");
    provider.addScope("https://www.googleapis.com/auth/drive");
    provider.setCustomParameters({
      prompt: "consent",
      include_granted_scopes: "true",
    });

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken || "";
    if (!accessToken) {
      throw new Error("No se obtuvo accessToken para Gmail/Sheets/Drive");
    }
    state.accessToken = accessToken;
    setMsg(authMsg, "Permisos Gmail + Sheets + Drive autorizados.");
  } catch (error) {
    console.error(error);
    setMsg(authMsg, error.message || "No se pudo autorizar Gmail + Sheets + Drive", true);
  }
});

previewBtn.addEventListener("click", () => {
  runPacProcess(true);
});

runBtn.addEventListener("click", async () => {
  await saveSelectedRowsToDrive();
});

resultsBody.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains("pac-row-checkbox")) {
    return;
  }
  const rowId = String(target.dataset.rowId || "");
  if (!rowId) {
    return;
  }
  if (target.checked) {
    state.selectedRowIds.add(rowId);
  } else {
    state.selectedRowIds.delete(rowId);
  }
  updateSelectionUI();
});

if (selectAllBtn) {
  selectAllBtn.addEventListener("click", () => {
    toggleSelectAll();
  });
}

if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener("change", () => {
    toggleSelectAll(selectAllCheckbox.checked);
  });
}

if (floatCancelBtn) {
  floatCancelBtn.addEventListener("click", () => {
    cancelSelectionFlow();
  });
}

if (floatPreviewBtn) {
  floatPreviewBtn.addEventListener("click", () => {
    openPreviewTab();
  });
}

if (floatDownloadBtn) {
  floatDownloadBtn.addEventListener("click", () => {
    const selectedRows = getSelectedRows();
    if (!selectedRows.length) {
      setMsg(runMsg, "Selecciona al menos una fila para descargar", true);
      return;
    }
    if (state.savedFile?.downloadXlsxUrl) {
      window.open(String(state.savedFile.downloadXlsxUrl), "_blank", "noopener");
      return;
    }
    downloadCsv(selectedRows, "pac-seleccion.csv");
  });
}

if (floatSaveBtn) {
  floatSaveBtn.addEventListener("click", async () => {
    await saveSelectedRowsToDrive();
  });
}

logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
    state.accessToken = "";
    cancelSelectionFlow();
    setMsg(authMsg, "Sesion cerrada");
    setMsg(runMsg, "");
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
      setMsg(authMsg, "Inicia sesion con Google y luego autoriza Gmail + Sheets + Drive.");
    }
    return;
  }

  userNameEl.textContent = user.displayName || user.email || "Usuario";
  userEmailEl.textContent = user.email || "-";
  if (!state.accessToken) {
    setMsg(authMsg, "Sesion iniciada. Falta autorizar Gmail + Sheets + Drive.");
  }
});

renderRows([]);
setFloatingVisible(false);
