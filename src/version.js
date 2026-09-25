export const SERVICE_VERSION = "3.0";
export const RELEASE_DATE = "2026-09-25T16:30:40+09:00";
export const RELEASE_IMPLEMENTATION_MODEL = "GPT-6 Astra Max";
export const RELEASE_LABEL = `${SERVICE_VERSION} · ${RELEASE_DATE} · ${RELEASE_IMPLEMENTATION_MODEL}`;
export const RELEASE = Object.freeze({
  version: SERVICE_VERSION,
  date: RELEASE_DATE,
  implementationModel: RELEASE_IMPLEMENTATION_MODEL,
  label: RELEASE_LABEL
});
