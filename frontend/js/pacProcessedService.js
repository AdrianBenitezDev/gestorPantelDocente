import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { functions } from "./firebaseClient.js";

function normalizeLimit(value, fallback = 40) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(120, Math.floor(parsed)));
}

function normalizeRowsPerItemLimit(value, fallback = 300) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(1200, Math.floor(parsed)));
}

export async function fetchProcessedPacList(options = {}) {
  const callable = httpsCallable(functions, "getProcessedPacList");
  const response = await callable({
    limit: normalizeLimit(options.limit, 40),
    includeRows: options.includeRows === true,
    rowsPerItemLimit: normalizeRowsPerItemLimit(options.rowsPerItemLimit, 300),
  });
  return response.data || {};
}

export async function fetchProcessedPacDetail(entry = {}) {
  const safeEntry = entry && typeof entry === "object" ? entry : {};
  const payload = {
    storageType: String(safeEntry.storageType || "subcollection").trim().toLowerCase(),
    docId: String(safeEntry.docId || safeEntry.id || "").trim(),
    legacyIndex: Number.isInteger(safeEntry.legacyIndex) ? safeEntry.legacyIndex : -1,
  };
  const callable = httpsCallable(functions, "getProcessedPacDetail");
  const response = await callable(payload);
  return response.data || {};
}
