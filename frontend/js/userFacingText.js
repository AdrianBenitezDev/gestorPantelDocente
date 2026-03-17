function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

const BILLING_STATUS_LABELS = {
  null: "sin suscripcion activa",
  pending_checkout: "pendiente de completar el pago",
  pending_confirmation: "pago en validacion",
  active: "activa",
  paused: "pausada",
  cancelled: "cancelada",
  rejected: "rechazada",
  expired: "vencida",
  error: "con inconvenientes",
};

const ACCESS_REASON_LABELS = {
  payment_required: "Debes activar tu suscripcion para continuar.",
  profile_missing: "Debes completar tu registro para continuar.",
  user_profile_missing: "No encontramos tu perfil. Completa el registro para continuar.",
  tenant_not_assigned: "Tu cuenta aun no esta asociada a una institucion.",
  access_not_enabled: "Tu acceso aun no esta habilitado.",
};

const DETAILS_CODE_MESSAGES = {
  subscription_required: "Debes tener una suscripcion activa para continuar.",
  subscription_not_found: "No encontramos una suscripcion asociada a tu cuenta.",
  user_profile_missing: "No encontramos tu perfil de usuario.",
  mercadopago_preapproval_failed: "No pudimos iniciar el pago en este momento. Intenta nuevamente.",
  mercadopago_preapproval_lookup_failed: "No pudimos consultar el estado del pago. Intenta nuevamente.",
};

const RAW_MESSAGE_MESSAGES = {
  "auth required": "Necesitas iniciar sesion para continuar.",
  "subscription required": "Debes tener una suscripcion activa para continuar.",
  "subscription plan not configured": "El plan de suscripcion no esta disponible en este momento.",
  "subscription plan is not active": "El plan de suscripcion esta temporalmente inactivo.",
  "user profile not found": "No encontramos tu perfil de usuario.",
  "subscription not found": "No encontramos una suscripcion asociada a tu cuenta.",
  "user email is required to start checkout": "Necesitamos un correo valido para iniciar el pago.",
  "mercado pago access token is not configured": "El servicio de pagos no esta disponible temporalmente.",
  "could not complete registration": "No pudimos completar el registro en este momento.",
};

export function formatBillingStatusLabel(value) {
  const status = normalizeText(value || "null");
  return BILLING_STATUS_LABELS[status] || "en revision";
}

export function formatAccessReasonLabel(value) {
  const reason = normalizeText(value || "payment_required");
  return ACCESS_REASON_LABELS[reason] || "Tu cuenta requiere una validacion adicional.";
}

export function formatUserError(error, fallbackMessage = "Ocurrio un error. Intenta nuevamente.") {
  const detailsCode = normalizeText(error?.details?.code);
  if (DETAILS_CODE_MESSAGES[detailsCode]) {
    return DETAILS_CODE_MESSAGES[detailsCode];
  }

  const code = normalizeText(error?.code);
  if (code.includes("unauthenticated")) {
    return "Tu sesion vencio. Inicia sesion nuevamente.";
  }
  if (code.includes("permission-denied")) {
    return "No tienes permisos para realizar esta accion.";
  }
  if (code.includes("unavailable")) {
    return "El servicio no esta disponible temporalmente. Intenta nuevamente en unos minutos.";
  }
  if (code.includes("invalid-argument")) {
    return "Hay datos invalidos en la solicitud. Revisa la informacion e intenta nuevamente.";
  }

  const rawMessage = String(error?.message || "").trim();
  const normalizedMessage = normalizeText(rawMessage);
  if (RAW_MESSAGE_MESSAGES[normalizedMessage]) {
    return RAW_MESSAGE_MESSAGES[normalizedMessage];
  }
  if (!rawMessage) {
    return fallbackMessage;
  }
  if (rawMessage.length > 220) {
    return fallbackMessage;
  }
  return rawMessage;
}
