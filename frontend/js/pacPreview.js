import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";

const STORAGE_KEY = "pacPreviewPayload";

const saveBtn = document.getElementById("preview-save-btn");
const downloadBtn = document.getElementById("preview-download-btn");
const cancelBtn = document.getElementById("preview-cancel-btn");
const msgEl = document.getElementById("preview-msg");
const subtitleEl = document.getElementById("pac-preview-subtitle");
const resultsBody = document.getElementById("preview-results-body");

const state = {
  payload: null,
  busy: false,
  savedFile: null,
};

function setMsg(text, isError = false) {
  msgEl.textContent = String(text || "");
  msgEl.classList.toggle("error", isError);
  msgEl.classList.toggle("success", !isError && Boolean(text));
}

function sanitize(value) {
  return String(value || "").replace(/[<>&]/g, "");
}

function setBusy(busy) {
  state.busy = busy;
  [saveBtn, downloadBtn, cancelBtn].forEach((btn) => {
    if (!btn) {
      return;
    }
    if (btn === cancelBtn) {
      btn.disabled = false;
      return;
    }
    btn.disabled = busy;
  });
}

function renderRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    resultsBody.innerHTML = `<tr><td colspan="9">Sin datos</td></tr>`;
    return;
  }

  const html = list.map((row) => {
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
      <td>${sanitize(row.subject)}${sanitize(missing)}</td>
    </tr>`;
  }).join("");

  resultsBody.innerHTML = html;
}

function downloadCsv(rows, filename = "pac-vista-previa.csv") {
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
    .map((line) => line.map((cell) => `\"${String(cell).replace(/\"/g, "\"\"")}\"`).join(","))
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

function loadPayload() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    console.error("preview payload parse error", error);
    return null;
  }
}

function buildSavePayload() {
  const payload = state.payload || {};
  return {
    mode: String(payload.mode || "interinos_docx"),
    sheetUrl: String(payload.sheetUrl || "").trim(),
    sheetName: String(payload.sheetName || "").trim(),
    startRow: Number(payload.startRow || 14),
    accessToken: String(payload.accessToken || ""),
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    outputTitle: "",
  };
}

async function saveToDrive() {
  if (state.busy) {
    return;
  }
  if (!auth.currentUser) {
    setMsg("No hay sesion activa en esta pestana. Volve a PAC y reintenta.", true);
    return;
  }

  const payload = buildSavePayload();
  if (!payload.sheetUrl || !payload.accessToken || !Array.isArray(payload.rows) || !payload.rows.length) {
    setMsg("No hay datos suficientes para guardar en Drive", true);
    return;
  }

  setBusy(true);
  setMsg("Guardando en Google Drive...");
  try {
    const callable = httpsCallable(functions, "savePacRowsToDrive");
    const response = await callable(payload);
    const result = response.data || {};
    state.savedFile = result;
    setMsg(`Archivo guardado en Drive. Filas escritas: ${Number(result.rowsWritten || 0)} | ${String(result.sheetUrl || "")}`);
  } catch (error) {
    console.error("saveToDrive preview error", error);
    setMsg(String(error?.message || "No se pudo guardar en Drive"), true);
  } finally {
    setBusy(false);
  }
}

saveBtn.addEventListener("click", async () => {
  await saveToDrive();
});

downloadBtn.addEventListener("click", () => {
  if (state.savedFile?.downloadXlsxUrl) {
    window.open(String(state.savedFile.downloadXlsxUrl), "_blank", "noopener");
    return;
  }
  const rows = Array.isArray(state.payload?.rows) ? state.payload.rows : [];
  if (!rows.length) {
    setMsg("No hay filas para descargar", true);
    return;
  }
  downloadCsv(rows);
});

cancelBtn.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  window.close();
});

state.payload = loadPayload();
if (!state.payload) {
  renderRows([]);
  setMsg("No hay datos de vista previa. Volve a la pantalla PAC y ejecuta Probar extraccion.", true);
} else {
  state.savedFile = state.payload.savedFile || null;
  const rows = Array.isArray(state.payload.rows) ? state.payload.rows : [];
  renderRows(rows);
  subtitleEl.textContent = `Filas seleccionadas: ${rows.length}`;
  setMsg("Listo para guardar o descargar.");
}

