import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";

const SUBSCRIPTION_STATUS_CACHE_PREFIX = "pd_sub_status_v1";
const SUBSCRIPTION_STATUS_TTL_MS = 90 * 1000;

function buildCacheKey(uid) {
  return `${SUBSCRIPTION_STATUS_CACHE_PREFIX}:${String(uid || "").trim()}`;
}

function readCache(uid) {
  const cacheKey = buildCacheKey(uid);
  try {
    const raw = window.sessionStorage?.getItem(cacheKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const cachedAt = Number(parsed.cachedAt || 0);
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data : null;
    if (!Number.isFinite(cachedAt) || cachedAt <= 0 || !data) {
      return null;
    }
    return { cachedAt, data };
  } catch (error) {
    console.error("No se pudo leer cache de suscripcion", error);
    return null;
  }
}

function writeCache(uid, data) {
  const cacheKey = buildCacheKey(uid);
  try {
    window.sessionStorage?.setItem(
      cacheKey,
      JSON.stringify({
        cachedAt: Date.now(),
        data: data && typeof data === "object" ? data : {},
      })
    );
  } catch (error) {
    console.error("No se pudo guardar cache de suscripcion", error);
  }
}

export function clearCachedSubscriptionStatus(uid = "") {
  const safeUid = String(uid || auth.currentUser?.uid || "").trim();
  if (!safeUid) {
    return;
  }
  try {
    window.sessionStorage?.removeItem(buildCacheKey(safeUid));
  } catch (error) {
    console.error("No se pudo limpiar cache de suscripcion", error);
  }
}

export async function getSubscriptionStatusCached(options = {}) {
  const safeUid = String(auth.currentUser?.uid || "").trim();
  if (!safeUid) {
    throw new Error("Auth required");
  }

  const forceRefresh = options.forceRefresh === true;
  const ttlMs = Number.isFinite(Number(options.ttlMs))
    ? Math.max(1_000, Math.floor(Number(options.ttlMs)))
    : SUBSCRIPTION_STATUS_TTL_MS;

  if (!forceRefresh) {
    const cached = readCache(safeUid);
    const ageMs = Date.now() - Number(cached?.cachedAt || 0);
    if (cached && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs) {
      const cachedTenantId = String(cached.data?.tenantId || "").trim();
      const cachedHasAccess = cached.data?.appEnabled === true && Boolean(cachedTenantId);
      if (cachedHasAccess) {
        return cached.data;
      }
    }
  }

  const callable = httpsCallable(functions, "getSubscriptionStatus");
  const response = await callable({});
  const data = response.data && typeof response.data === "object" ? response.data : {};
  writeCache(safeUid, data);
  return data;
}
