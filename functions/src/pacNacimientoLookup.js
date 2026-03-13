const UNKNOWN_BIRTHDATE = "??/??/???";

function normalizeDni(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 8) {
    return "";
  }
  return digits;
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([0-3]?\d)[\/\-.]([01]?\d)[\/\-.]((?:19|20)?\d{2})$/);
  if (!match) {
    return "";
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
    return "";
  }
  if (year < 100) {
    year += year >= 30 ? 1900 : 2000;
  }
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900 || year > 2100) {
    return "";
  }

  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${String(year)}`;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function todayAsNormalizedDate() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = String(now.getFullYear());
  return `${day}/${month}/${year}`;
}

function isTodayDate(value) {
  return String(value || "").trim() === todayAsNormalizedDate();
}

function extractBirthDateFromHtml(htmlText) {
  const source = decodeHtmlEntities(String(htmlText || ""));
  if (!source) {
    return UNKNOWN_BIRTHDATE;
  }

  const birthDateLabel = "fecha de nacimiento";
  const labelIndex = source.toLowerCase().indexOf(birthDateLabel);
  if (labelIndex >= 0) {
    const textAfterLabel = source.slice(labelIndex + birthDateLabel.length);
    const firstDateAfterLabel = textAfterLabel.match(/\b[0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)?\d{2}\b/i);
    const parsed = normalizeDate(firstDateAfterLabel?.[0] || "");
    if (parsed && !isTodayDate(parsed)) {
      return parsed;
    }
  }

  const labeledPatterns = [
    /fecha\s*de\s*nac(?:imiento)?[^0-9]{0,50}([0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)?\d{2})/i,
    /fec\.?\s*nac\.?[^0-9]{0,30}([0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)?\d{2})/i,
    /nac(?:imiento)?[^0-9]{0,30}([0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)?\d{2})/i,
  ];
  for (const pattern of labeledPatterns) {
    const match = source.match(pattern);
    const parsed = normalizeDate(match?.[1] || "");
    if (parsed && !isTodayDate(parsed)) {
      return parsed;
    }
  }

  const allDates = source.match(/\b[0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)?\d{2}\b/g) || [];
  for (const item of allDates) {
    const parsed = normalizeDate(item);
    if (parsed && !isTodayDate(parsed)) {
      return parsed;
    }
  }

  return UNKNOWN_BIRTHDATE;
}

function buildLookupUrl(dniDigits, yearValue = new Date().getFullYear()) {
  const dniBase64 = Buffer.from(String(dniDigits), "utf8")
    .toString("base64")
    .replace(/=+$/g, "");
  const safeYear = Number.isFinite(Number(yearValue))
    ? Number(yearValue)
    : new Date().getFullYear();
  const anioActual = Buffer.from(String(safeYear), "utf8")
    .toString("base64")
    .replace(/=+$/g, "");

  return (
    "http://servicios.abc.gov.ar/servaddo/puntaje.ingreso.docencia/ingreso.servaddo.cfm" +
    `?documento=${encodeURIComponent(dniBase64)}=` +
    `&anio=${encodeURIComponent(anioActual)}==` +
    "&listado=ZmluZXM==" +
    "&tipo="
  );
}

async function fetchFechaNacimientoByDni(dni) {
  const dniDigits = normalizeDni(dni);
  if (!dniDigits) {
    return UNKNOWN_BIRTHDATE;
  }

  const currentYear = new Date().getFullYear();
  const candidateYears = [currentYear, currentYear - 1, currentYear - 2];

  for (const year of candidateYears) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(buildLookupUrl(dniDigits, year), {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (!response.ok) {
        continue;
      }

      const htmlText = await response.text();
      const parsed = extractBirthDateFromHtml(htmlText);
      if (parsed !== UNKNOWN_BIRTHDATE) {
        return parsed;
      }
    } catch (error) {
      // Seguir con el siguiente año candidato.
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return UNKNOWN_BIRTHDATE;
}

module.exports = {
  UNKNOWN_BIRTHDATE,
  fetchFechaNacimientoByDni,
};
