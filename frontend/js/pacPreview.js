import {
  GoogleAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";
import { formatUserError } from "./userFacingText.js";

const STORAGE_KEY = "pacPreviewPayload";
const GOOGLE_SCOPE_SHEETS = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SCOPE_DRIVE = "https://www.googleapis.com/auth/drive";
const GOOGLE_SCOPE_DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

const saveBtn = document.getElementById("preview-save-btn");
const downloadBtn = document.getElementById("preview-download-btn");
const cancelBtn = document.getElementById("preview-cancel-btn");
const msgEl = document.getElementById("preview-msg");
const openDriveBtn = document.getElementById("preview-open-drive-btn");
const subtitleEl = document.getElementById("pac-preview-subtitle");
const resultsBody = document.getElementById("preview-results-body");

const state = {
  payload: null,
  busy: false,
  savedFile: null,
  grantedScopes: new Set(),
};

function uniqueScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  return Array.from(new Set(
    list
      .map((scope) => String(scope || "").trim())
      .filter(Boolean)
  ));
}

function getMissingScopesFromError(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : null;
  const missingScopes = Array.isArray(details?.missingScopes) ? details.missingScopes : [];
  const grantedScopes = Array.isArray(details?.grantedScopes) ? details.grantedScopes : [];
  if (grantedScopes.length) {
    rememberGrantedScopes(grantedScopes);
  }
  return uniqueScopes(missingScopes);
}

function updatePayloadAccessToken(accessToken) {
  if (!state.payload || typeof state.payload !== "object") {
    return;
  }
  state.payload.accessToken = String(accessToken || "").trim();
}

function updatePayloadGrantedScopes(scopes = []) {
  if (!state.payload || typeof state.payload !== "object") {
    return;
  }
  state.payload.grantedScopes = uniqueScopes(scopes);
}

function rememberGrantedScopes(scopes) {
  uniqueScopes(scopes).forEach((scope) => {
    state.grantedScopes.add(scope);
    if (scope === GOOGLE_SCOPE_DRIVE) {
      state.grantedScopes.add(GOOGLE_SCOPE_DRIVE_FILE);
    }
  });
  updatePayloadGrantedScopes(Array.from(state.grantedScopes));
}

function hasAllGrantedScopes(scopes) {
  const required = uniqueScopes(scopes);
  if (!required.length) {
    return true;
  }
  return required.every((scope) => state.grantedScopes.has(scope));
}

async function signInAndAuthorizeGoogleScopes(options = {}) {
  const scopes = uniqueScopes(
    Array.isArray(options.scopes) && options.scopes.length
      ? options.scopes
      : [GOOGLE_SCOPE_SHEETS, GOOGLE_SCOPE_DRIVE_FILE]
  );
  const successMessage =
    String(options.successMessage || "").trim() || "Permisos de Google autorizados.";
  const errorMessage =
    String(options.errorMessage || "").trim() || "No se pudieron autorizar permisos de Google.";
  const currentUserEmail = String(auth.currentUser?.email || "").trim();
  const extraCustomParameters =
    options.customParameters && typeof options.customParameters === "object"
      ? options.customParameters
      : {};
  try {
    if (!auth.currentUser) {
      throw new Error("No hay sesion activa para solicitar permisos.");
    }
    const provider = new GoogleAuthProvider();
    scopes.forEach((scope) => {
      provider.addScope(scope);
    });
    const providerCustomParams = {
      include_granted_scopes: "true",
      ...extraCustomParameters,
    };
    if (!providerCustomParams.login_hint && currentUserEmail) {
      providerCustomParams.login_hint = currentUserEmail;
    }
    provider.setCustomParameters(providerCustomParams);
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = String(credential?.accessToken || "").trim();
    if (!accessToken) {
      throw new Error("No se obtuvo accessToken de Google.");
    }
    updatePayloadAccessToken(accessToken);
    const grantedScopes = uniqueScopes(
      String(
        result?._tokenResponse?.oauthScope ||
        result?._tokenResponse?.scope ||
        ""
      ).split(/\s+/)
    );
    rememberGrantedScopes(grantedScopes.length ? grantedScopes : scopes);
    setMsg(successMessage);
    return true;
  } catch (error) {
    console.error("preview scope auth error", error);
    setMsg(formatUserError(error, errorMessage), true);
    return false;
  }
}

function setMsg(text, isError = false) {
  msgEl.textContent = String(text || "");
  msgEl.classList.toggle("error", isError);
  msgEl.classList.toggle("success", !isError && Boolean(text));
}

function setDriveResultButton(sheetUrl = "") {
  if (!openDriveBtn) {
    return;
  }
  const safeUrl = String(sheetUrl || "").trim();
  if (!safeUrl) {
    openDriveBtn.hidden = true;
    openDriveBtn.classList.add("is-hidden");
    openDriveBtn.removeAttribute("href");
    return;
  }
  openDriveBtn.href = safeUrl;
  openDriveBtn.hidden = false;
  openDriveBtn.classList.remove("is-hidden");
}

function sanitize(value) {
  return String(value || "").replace(/[<>&]/g, "");
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function splitCuilParts(cuilValue, dniValue) {
  const cuilDigits = onlyDigits(cuilValue);
  const dniDigits = onlyDigits(dniValue);
  if (cuilDigits.length >= 11) {
    return {
      prefix: cuilDigits.slice(0, 2),
      dni: cuilDigits.slice(2, 10),
      suffix: cuilDigits.slice(10, 11),
    };
  }
  return {
    prefix: "",
    dni: dniDigits || String(dniValue || ""),
    suffix: "",
  };
}

function deriveModCarr(cursoValue) {
  const match = String(cursoValue || "").match(/\d{1,2}/);
  if (!match) {
    return "";
  }
  const year = Number(match[0]);
  if (!Number.isFinite(year) || year <= 0) {
    return "";
  }
  return year < 4 ? "CB" : "CS";
}

function decodeBase64ToBlob(base64Value, mimeType) {
  const binary = atob(String(base64Value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], {
    type: String(
      mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ),
  });
}

function downloadBlobFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = String(fileName || "pac.xlsx");
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
    resultsBody.innerHTML = `<tr><td colspan="14">Sin datos</td></tr>`;
    return;
  }

  const html = list.map((row) => {
    const cuilParts = splitCuilParts(row.cuil, row.dni);
    const modCarr = deriveModCarr(row.curso);
    return `<tr>
      <td>${sanitize(row.cupof)}</td>
      <td>${sanitize(cuilParts.prefix)}</td>
      <td>${sanitize(cuilParts.dni)}</td>
      <td>${sanitize(cuilParts.suffix)}</td>
      <td></td>
      <td>${sanitize(row.fechaNacimiento)}</td>
      <td>${sanitize(row.apellidoNombre)}</td>
      <td>${sanitize(row.situacionRevista)}</td>
      <td>${sanitize(modCarr)}</td>
      <td>${sanitize(row.pid)}</td>
      <td>${sanitize(row.cargoModulosHoras)}</td>
      <td></td>
      <td>${sanitize(row.curso)}</td>
      <td>${sanitize(row.division)}</td>
    </tr>`;
  }).join("");

  resultsBody.innerHTML = html;
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
    delivery: "drive",
    encabezadoPac:
      payload.encabezadoPac && typeof payload.encabezadoPac === "object"
        ? payload.encabezadoPac
        : undefined,
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

  let payload = buildSavePayload();
  if (!Array.isArray(payload.rows) || !payload.rows.length) {
    setMsg("No hay datos suficientes para guardar en Drive", true);
    return;
  }
  if (!hasAllGrantedScopes([GOOGLE_SCOPE_SHEETS, GOOGLE_SCOPE_DRIVE_FILE])) {
    const authorizedSaveScopes = await signInAndAuthorizeGoogleScopes({
      scopes: [GOOGLE_SCOPE_SHEETS, GOOGLE_SCOPE_DRIVE_FILE],
      successMessage: "Permisos de Sheets/Drive autorizados. Continuando guardado...",
      errorMessage: "No se pudieron autorizar permisos para guardar en Drive.",
    });
    if (!authorizedSaveScopes) {
      return;
    }
    payload = buildSavePayload();
  }
  if (!payload.accessToken) {
    const authorized = await signInAndAuthorizeGoogleScopes({
      scopes: [GOOGLE_SCOPE_SHEETS, GOOGLE_SCOPE_DRIVE_FILE],
      successMessage: "Permisos de Sheets/Drive autorizados. Continuando guardado...",
      errorMessage: "No se pudieron autorizar permisos para guardar en Drive.",
    });
    if (!authorized) {
      return;
    }
    payload = buildSavePayload();
  }

  setBusy(true);
  setDriveResultButton("");
  setMsg("Guardando en Google Drive...");
  try {
    const callable = httpsCallable(functions, "savePacRowsToDrive");
    let response;
    try {
      response = await callable(payload);
    } catch (error) {
      const missingScopes = getMissingScopesFromError(error);
      if (!missingScopes.length) {
        throw error;
      }
      const reauthorized = await signInAndAuthorizeGoogleScopes({
        scopes: missingScopes,
        successMessage: "Permisos adicionales autorizados. Reintentando guardado...",
        errorMessage: "No se pudieron autorizar permisos adicionales para guardar.",
      });
      if (!reauthorized) {
        throw error;
      }
      payload = buildSavePayload();
      response = await callable(payload);
    }
    const result = response.data || {};
    state.savedFile = result;
    setDriveResultButton(String(result.sheetUrl || ""));
    setMsg(`Archivo guardado en Drive. Filas escritas: ${Number(result.rowsWritten || 0)}`);
  } catch (error) {
    console.error("saveToDrive preview error", error);
    setDriveResultButton("");
    setMsg(formatUserError(error, "No pudimos guardar el archivo en Drive."), true);
  } finally {
    setBusy(false);
  }
}

async function downloadWorkbook() {
  if (state.busy) {
    return;
  }
  if (!auth.currentUser) {
    setMsg("No hay sesion activa en esta pestana. Volve a PAC y reintenta.", true);
    return;
  }

  let payload = buildSavePayload();
  payload.delivery = "download";
  if (!Array.isArray(payload.rows) || !payload.rows.length) {
    setMsg("No hay datos suficientes para descargar", true);
    return;
  }

  setBusy(true);
  setDriveResultButton("");
  setMsg("Generando archivo para descarga...");
  try {
    const callable = httpsCallable(functions, "savePacRowsToDrive");
    const response = await callable(payload);
    const result = response.data || {};
    const fileBase64 = String(result.fileBase64 || "");
    if (!fileBase64) {
      throw new Error("No se recibio el archivo XLSX");
    }
    const blob = decodeBase64ToBlob(fileBase64, result.fileMimeType);
    const fileName = String(result.fileName || "PAC.xlsx");
    downloadBlobFile(blob, fileName);
    setMsg(`Archivo descargado: ${fileName}`);
    setDriveResultButton("");
  } catch (error) {
    console.error("downloadWorkbook preview error", error);
    setDriveResultButton("");
    setMsg(formatUserError(error, "No pudimos descargar el archivo."), true);
  } finally {
    setBusy(false);
  }
}

saveBtn.addEventListener("click", async () => {
  await saveToDrive();
});

downloadBtn.addEventListener("click", () => {
  downloadWorkbook();
});

cancelBtn.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  window.close();
});

state.payload = loadPayload();
if (!state.payload) {
  renderRows([]);
  setDriveResultButton("");
  setMsg("No hay datos de vista previa. Volve a la pantalla PAC y ejecuta Probar extraccion.", true);
} else {
  state.savedFile = state.payload.savedFile || null;
  rememberGrantedScopes(state.payload.grantedScopes || []);
  const rows = Array.isArray(state.payload.rows) ? state.payload.rows : [];
  renderRows(rows);
  setDriveResultButton(String(state.savedFile?.sheetUrl || ""));
  subtitleEl.textContent = `Filas seleccionadas: ${rows.length}`;
  setMsg("Listo para guardar o descargar.");
}
