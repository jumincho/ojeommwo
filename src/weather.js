import { config } from "./config.js";
import { normalizeMealType } from "./meal-types.js";
import { readBoundedResponseBytes } from "./bounded-response.js";

const KMA_API_BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const AIRKOREA_API_URL = "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty";
const KMA_WARNING_API_URL = "https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnStatus";
const KMA_UV_API_URL = "https://apis.data.go.kr/1360000/LivingWthrIdxServiceV5/getUVIdxV5";
const AIRKOREA_DUST_WARNING_API_URL = "https://apis.data.go.kr/B552584/UlfptcaAlarmInqireSvc/getUlfptcaAlarmInfo";
const AIR_QUALITY_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const REQUIRED_AIRKOREA_STATION = "노송동";
const KMA_LIVING_AREA_NO = "5211357000";
const AIRKOREA_WARNING_DISTRICT = "전북";
const AIRKOREA_WARNING_ZONE = "중부권역";
const AIRKOREA_FETCH_ATTEMPTS = 5;
const AIRKOREA_NETWORK_FETCH_ATTEMPTS = 3;
const AIRKOREA_RETRY_BASE_DELAY_MS = 500;
const KMA_NETWORK_FETCH_ATTEMPTS = 2;
const KMA_RETRY_DELAY_MS = 250;
const KMA_RECENT_BASE_COUNT = 3;
const KMA_ULTRA_FORECAST_BASE_COUNT = 7;
const KMA_ULTRA_FORECAST_MAX_LAG_MINUTES = 90;
const UV_WARNING_THRESHOLD = 6;
const HIGH_HUMIDITY_THRESHOLD_PERCENT = 80;
const WINTER_WIND_CHILL_MAX_TEMPERATURE_C = 10;
const WINTER_WIND_CHILL_MIN_SPEED_MPS = 1.3;
const PUBLIC_DATA_RESPONSE_LIMIT_BYTES = 4_000_000;
const REQUIRED_VILLAGE_FORECAST_CATEGORIES = Object.freeze([
  "TMP", "POP", "PTY", "SKY", "PCP", "SNO"
]);

const CONDITION_LABELS = {
  clear: ["☀️", "맑음"],
  "mostly-cloudy": ["⛅", "구름 많음"],
  overcast: ["☁️", "흐림"],
  rain: ["🌧️", "비"],
  "rain-snow": ["🌨️", "비/눈"],
  snow: ["❄️", "눈"],
  thunderstorm: ["⛈️", "뇌우"],
  shower: ["🌦️", "소나기"],
  raindrop: ["🌦️", "빗방울"],
  "raindrop-snow": ["🌨️", "빗방울/눈날림"],
  "snow-flurry": ["🌨️", "눈날림"]
};

const FORECAST_CONDITION_LABELS = {
  rain: ["☔", "비"],
  "rain-snow": ["🌨️", "비/눈"],
  snow: ["❄️", "눈"],
  thunderstorm: ["⛈️", "뇌우"],
  shower: ["🌦️", "소나기"],
  raindrop: ["🌦️", "빗방울"],
  "raindrop-snow": ["🌨️", "빗방울/눈날림"],
  "snow-flurry": ["🌨️", "눈날림"]
};

const PRECIPITATION_CONDITIONS = new Set([
  "rain",
  "rain-snow",
  "snow",
  "thunderstorm",
  "shower",
  "raindrop",
  "raindrop-snow",
  "snow-flurry"
]);

const SNOWFALL_CONDITIONS = new Set([
  "rain-snow",
  "snow",
  "raindrop-snow",
  "snow-flurry"
]);

function mealHours(mealType) {
  return normalizeMealType(mealType || "meal") === "저녁" ? [18, 19, 20] : [12, 13, 14];
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundOne(value) {
  return Number(Number(value).toFixed(1));
}

function maxOrNull(values) {
  return values.length ? Math.max(...values) : null;
}

function sumOrNull(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function wallClockMinute(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u);
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  ) / 60000;
}

function wallClockStamp(minute) {
  if (!Number.isFinite(minute)) return "";
  return new Date(minute * 60000).toISOString().slice(0, 16);
}

function kstParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const part = (type) => Number(parts.find((item) => item.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute")
  };
}

function localWallClockMinute(now) {
  const { year, month, day, hour, minute } = kstParts(now);
  return Date.UTC(year, month - 1, day, hour, minute) / 60000;
}

function localDateKey(now) {
  const { year, month, day } = kstParts(now);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(dateKey, days) {
  const match = String(dateKey).match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) throw new Error(`Invalid date key: ${dateKey}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return date.toISOString().slice(0, 10);
}

function formatKmaBase(minute) {
  const date = new Date(minute * 60000);
  return {
    baseDate: date.toISOString().slice(0, 10).replaceAll("-", ""),
    baseTime: `${String(date.getUTCHours()).padStart(2, "0")}00`
  };
}

function kmaObservationBase(now) {
  return formatKmaBase(localWallClockMinute(now) - 15);
}

function kmaUltraShortBase(now) {
  const shifted = localWallClockMinute(now) - 45;
  const date = new Date(shifted * 60000);
  return {
    baseDate: date.toISOString().slice(0, 10).replaceAll("-", ""),
    baseTime: `${String(date.getUTCHours()).padStart(2, "0")}30`
  };
}

function kmaVillageBase(now) {
  const shifted = localWallClockMinute(now) - 15;
  const date = new Date(shifted * 60000);
  const hour = date.getUTCHours();
  const issueHours = [2, 5, 8, 11, 14, 17, 20, 23];
  let issueHour = [...issueHours].reverse().find((candidate) => candidate <= hour);
  if (issueHour === undefined) {
    date.setUTCDate(date.getUTCDate() - 1);
    issueHour = 23;
  }
  return {
    baseDate: date.toISOString().slice(0, 10).replaceAll("-", ""),
    baseTime: `${String(issueHour).padStart(2, "0")}00`
  };
}

function kmaDailyTemperatureRangeBase(now) {
  const shifted = localWallClockMinute(now) - 15;
  const date = new Date(shifted * 60000);
  let issueHour = 2;
  if (date.getUTCHours() < issueHour) {
    date.setUTCDate(date.getUTCDate() - 1);
    issueHour = 23;
  }
  return {
    baseDate: date.toISOString().slice(0, 10).replaceAll("-", ""),
    baseTime: `${String(issueHour).padStart(2, "0")}00`
  };
}

function shiftKmaBase(base, minutes) {
  const baseDate = String(base?.baseDate || "");
  const baseTime = String(base?.baseTime || "");
  if (!/^\d{8}$/u.test(baseDate) || !/^\d{4}$/u.test(baseTime)) {
    throw new Error("Invalid KMA base time");
  }
  const shifted = new Date(Date.UTC(
    Number(baseDate.slice(0, 4)),
    Number(baseDate.slice(4, 6)) - 1,
    Number(baseDate.slice(6, 8)),
    Number(baseTime.slice(0, 2)),
    Number(baseTime.slice(2, 4)) + minutes
  ));
  return {
    baseDate: shifted.toISOString().slice(0, 10).replaceAll("-", ""),
    baseTime: shifted.toISOString().slice(11, 16).replace(":", "")
  };
}

function recentKmaBases(primary, stepMinutes, count = KMA_RECENT_BASE_COUNT) {
  return Array.from({ length: count }, (_, index) => shiftKmaBase(primary, -stepMinutes * index));
}

function formatForecastTime(date, time) {
  const normalizedDate = String(date || "");
  const normalizedTime = String(time || "").padStart(4, "0");
  if (!/^\d{8}$/u.test(normalizedDate) || !/^\d{4}$/u.test(normalizedTime)) return null;
  return `${normalizedDate.slice(0, 4)}-${normalizedDate.slice(4, 6)}-${normalizedDate.slice(6, 8)}T${normalizedTime.slice(0, 2)}:${normalizedTime.slice(2, 4)}`;
}

function valuesInMealWindow(times, values, mealType, dateKey, { afterMinute = null } = {}) {
  const hours = new Set(mealHours(mealType));
  return (times || []).flatMap((time, index) => {
    const match = String(time).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):/u);
    if (!match || match[1] !== dateKey || !hours.has(Number(match[2]))) return [];
    if (Number.isFinite(afterMinute)) {
      const intervalEndMinute = wallClockMinute(time);
      if (intervalEndMinute === null || intervalEndMinute <= afterMinute) return [];
    }
    const value = numberOrNull(values?.[index]);
    return value === null ? [] : [value];
  });
}

async function fetchJson(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.weatherFetchTimeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Native fetch responses are always read through the bounded byte path.
    // The json-only branch keeps dependency-injected unit fixtures lightweight.
    if (typeof response.arrayBuffer === "function" || response?.body?.getReader) {
      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: PUBLIC_DATA_RESPONSE_LIMIT_BYTES,
        label: "Public weather API response"
      });
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    if (typeof response.json === "function") return await response.json();
    throw new Error("Public weather API response body is unreadable");
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAirKoreaWithRetry(label, operation) {
  let lastError;
  for (let attempt = 1; attempt <= AIRKOREA_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const detail = String(error?.message || error || "");
      const transientHttp = /HTTP (?:408|425|429|5\d\d)\b/u.test(detail);
      const transientNetwork = error?.name === "AbortError"
        || error instanceof TypeError
        || /(?:network|fetch failed|socket|ECONN|ETIMEDOUT|EAI_AGAIN)/iu.test(detail);
      const allowedAttempts = transientHttp
        ? AIRKOREA_FETCH_ATTEMPTS
        : transientNetwork
          ? AIRKOREA_NETWORK_FETCH_ATTEMPTS
          : 1;
      if (attempt < allowedAttempts) {
        const delayMs = AIRKOREA_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        break;
      }
    }
  }
  throw new Error(
    `${label} unavailable after retry policy: ${lastError?.message || "unknown error"}`
  );
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", "\"");
}

export function extractKmaWarnings(html, locationName = config.locationName) {
  const lines = decodeHtml(String(html || "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|tr|h\d)>/giu, "\n")
    .replace(/<[^>]*>/gu, " "))
    .split(/\n+/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const locationTokens = String(locationName || "").split(/\s+/u).filter((token) => token.length >= 2);
  const appliesToJeonju = (line) => {
    if (/전주\s*제외/u.test(line)) return false;
    if (line.includes("전주") || locationTokens.some((token) => line.includes(token))) return true;
    const province = line.match(/전북(?:특별)?자치도/u);
    if (!province || province.index === undefined) return false;
    const suffix = line.slice(province.index + province[0].length).trimStart();
    if (!suffix.startsWith("(")) return true;
    let depth = 0;
    let closingIndex = -1;
    for (let index = 0; index < suffix.length; index += 1) {
      if (suffix[index] === "(") depth += 1;
      if (suffix[index] === ")") depth -= 1;
      if (depth === 0) {
        closingIndex = index;
        break;
      }
    }
    if (closingIndex < 0) return false;
    const provinceScope = suffix.slice(1, closingIndex);
    let scopeDepth = 0;
    for (let index = 0; index < provinceScope.length; index += 1) {
      if (provinceScope[index] === "(") scopeDepth += 1;
      if (provinceScope[index] === ")") scopeDepth -= 1;
      if (scopeDepth === 0 && provinceScope.startsWith("제외", index)) return true;
    }
    return false;
  };
  const warningPattern = /(폭풍해일|지진해일|폭염|열대야|한파|호우|대설|태풍|강풍|풍랑|건조|황사|안개|해일)\s*(중대경보|경보|주의보)/gu;
  return lines
    .filter(appliesToJeonju)
    .flatMap((line) => [...line.matchAll(warningPattern)].map((match) => match[0]))
    .filter((warning, index, all) => all.indexOf(warning) === index);
}

export function toKmaGrid(latitude, longitude) {
  const RE = 6371.00877;
  const GRID = 5.0;
  const SLAT1 = 30.0;
  const SLAT2 = 60.0;
  const OLON = 126.0;
  const OLAT = 38.0;
  const XO = 43;
  const YO = 136;
  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + latitude * DEGRAD * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = longitude * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;
  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5)
  };
}

function kmaUrl(operation, base) {
  const { nx, ny } = toKmaGrid(config.targetLatitude, config.targetLongitude);
  const url = new URL(`${KMA_API_BASE}/${operation}`);
  url.search = new URLSearchParams({
    serviceKey: normalizedPublicDataServiceKey(),
    pageNo: "1",
    numOfRows: "1000",
    dataType: "JSON",
    base_date: base.baseDate,
    base_time: base.baseTime,
    nx: String(nx),
    ny: String(ny)
  }).toString();
  return url;
}

function kmaItemsFromResponse(data) {
  const header = data?.response?.header;
  if (String(header?.resultCode) !== "00") {
    throw new Error(`KMA API ${header?.resultCode || "UNKNOWN"}: ${header?.resultMsg || "unknown error"}`);
  }
  const items = data?.response?.body?.items?.item;
  if (!Array.isArray(items) || items.length === 0) throw new Error("KMA API returned no forecast items");
  return items;
}

function isKmaPublicationGap(error) {
  const detail = String(error?.message || error || "");
  return /KMA API 03:\s*NO_DATA/iu.test(detail)
    || /KMA API returned no forecast items/iu.test(detail)
    || /KMA .+ response is incomplete/iu.test(detail);
}

function isTransientKmaFailure(error) {
  const detail = String(error?.message || error || "");
  return error?.name === "AbortError"
    || error instanceof TypeError
    || /HTTP (?:408|425|429|5\d\d)\b/u.test(detail)
    || /KMA API (?:01|02|04|05|22):/u.test(detail)
    || /(?:network|fetch failed|socket|ECONN|ETIMEDOUT|EAI_AGAIN)/iu.test(detail);
}

async function fetchKmaItems(operation, baseCandidates, fetchImpl, validate, label) {
  const bases = Array.isArray(baseCandidates) ? baseCandidates : [baseCandidates];
  let lastError;
  for (const base of bases) {
    for (let attempt = 1; attempt <= KMA_NETWORK_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const data = await fetchJson(kmaUrl(operation, base), fetchImpl);
        const items = kmaItemsFromResponse(data);
        if (!validate(items)) throw new Error(`KMA ${label} response is incomplete`);
        return { items, base };
      } catch (error) {
        lastError = error;
        if (isKmaPublicationGap(error)) break;
        if (!isTransientKmaFailure(error) || attempt === KMA_NETWORK_FETCH_ATTEMPTS) {
          throw new Error(
            `KMA ${label} unavailable at ${base.baseDate} ${base.baseTime}: ${error?.message || "unknown error"}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, KMA_RETRY_DELAY_MS));
      }
    }
  }
  throw new Error(
    `KMA ${label} unavailable across ${bases.length} recent official base times: ${lastError?.message || "unknown error"}`
  );
}

function forecastCategoryIsValid(items, category, predicate) {
  const values = items
    .filter((item) => item.category === category)
    .map((item) => item.fcstValue);
  return values.length > 0 && values.every(predicate);
}

function forecastDateHasCompleteRow(items, dateKey, categories) {
  const compactDate = String(dateKey || "").replaceAll("-", "");
  const rows = new Map();
  for (const item of items) {
    if (String(item?.fcstDate || "") !== compactDate || !categories.includes(item.category)) continue;
    const row = rows.get(item.fcstTime) || new Set();
    row.add(item.category);
    rows.set(item.fcstTime, row);
  }
  return [...rows.values()].some((row) => categories.every((category) => row.has(category)));
}

function forecastCoversMinute(items, minute, maxLagMinutes) {
  const forecastMinutes = items
    .map((item) => wallClockMinute(formatForecastTime(item?.fcstDate, item?.fcstTime)))
    .filter(Number.isFinite);
  return forecastMinutes.length > 0
    && Math.max(...forecastMinutes) >= minute - maxLagMinutes;
}

function observationValues(items) {
  return Object.fromEntries(items.map((item) => [item.category, item.obsrValue]));
}

function observationIsComplete(items) {
  const observation = observationValues(items);
  const temperature = numberOrNull(observation.T1H);
  const precipitationType = numberOrNull(observation.PTY);
  const humidity = numberOrNull(observation.REH);
  const windSpeed = numberOrNull(observation.WSD);
  const precipitation = parseKmaPrecipitation(observation.RN1);
  return temperature !== null
    && temperature >= -80
    && temperature <= 60
    && Number.isInteger(precipitationType)
    && precipitationType >= 0
    && precipitationType <= 7
    && humidity !== null
    && humidity >= 0
    && humidity <= 100
    && windSpeed !== null
    && windSpeed >= 0
    && windSpeed <= 100
    && Object.hasOwn(observation, "RN1")
    && (precipitation.amountKnown || precipitation.rainy);
}

function lightningForecastIsComplete(items) {
  const values = items
    .filter((item) => item.category === "LGT")
    .map((item) => numberOrNull(item.fcstValue));
  return values.length > 0
    && values.every((value) => value !== null && value >= 0 && value <= 100);
}

export function calculateKmaApparentTemperature({
  temperatureC,
  relativeHumidityPercent,
  windSpeedMps,
  month
}) {
  const temperature = numberOrNull(temperatureC);
  const normalizedMonth = Number(month);
  if (temperature === null
    || temperature < -80
    || temperature > 60
    || !Number.isInteger(normalizedMonth)
    || normalizedMonth < 1
    || normalizedMonth > 12) {
    return null;
  }

  if (normalizedMonth >= 5 && normalizedMonth <= 9) {
    const humidity = numberOrNull(relativeHumidityPercent);
    if (humidity === null || humidity < 0 || humidity > 100) return null;
    const wetBulbTemperature = temperature * Math.atan(0.151977 * Math.sqrt(humidity + 8.313659))
      + Math.atan(temperature + humidity)
      - Math.atan(humidity - 1.67633)
      + 0.00391838 * Math.pow(humidity, 1.5) * Math.atan(0.023101 * humidity)
      - 4.686035;
    return roundOne(
      -0.2442
      + 0.55399 * wetBulbTemperature
      + 0.45535 * temperature
      - 0.0022 * wetBulbTemperature ** 2
      + 0.00278 * wetBulbTemperature * temperature
      + 3
    );
  }

  const windSpeed = numberOrNull(windSpeedMps);
  if (windSpeed === null || windSpeed < 0 || windSpeed > 100) return null;
  if (temperature > WINTER_WIND_CHILL_MAX_TEMPERATURE_C
    || windSpeed < WINTER_WIND_CHILL_MIN_SPEED_MPS) {
    return roundOne(temperature);
  }
  const windSpeedKmh = windSpeed * 3.6;
  const windFactor = Math.pow(windSpeedKmh, 0.16);
  return roundOne(
    13.12
    + 0.6215 * temperature
    - 11.37 * windFactor
    + 0.3965 * windFactor * temperature
  );
}

export function parseKmaPrecipitation(value) {
  if (value === null) return { amountMm: 0, amountKnown: true, rainy: false };
  if (value === undefined || String(value).trim() === "") {
    return { amountMm: null, amountKnown: false, rainy: false };
  }
  const text = String(value).trim();
  if (/^(?:강수없음|없음|-|0(?:\.0+)?(?:\s*mm)?)$/iu.test(text)) {
    return { amountMm: 0, amountKnown: true, rainy: false };
  }
  const exact = text.match(/^(\d+(?:\.\d+)?)\s*mm$/iu) || text.match(/^(\d+(?:\.\d+)?)$/u);
  if (exact) {
    const amountMm = Number(exact[1]);
    return { amountMm, amountKnown: true, rainy: amountMm > 0 };
  }
  if (/^-\d/u.test(text)) {
    return { amountMm: null, amountKnown: false, rainy: false };
  }
  if (/(?:미만|이상|~|∼|-)/u.test(text) && /\d/u.test(text)) {
    return { amountMm: null, amountKnown: false, rainy: true };
  }
  return { amountMm: null, amountKnown: false, rainy: false };
}

export function parseKmaSnowfall(value) {
  if (value === null) return { amountCm: 0, amountKnown: true, snowy: false };
  if (value === undefined || String(value).trim() === "") {
    return { amountCm: null, amountKnown: false, snowy: false };
  }
  const text = String(value).trim();
  if (/^(?:적설없음|없음|-|0(?:\.0+)?(?:\s*cm)?)$/iu.test(text)) {
    return { amountCm: 0, amountKnown: true, snowy: false };
  }
  const exact = text.match(/^(\d+(?:\.\d+)?)\s*cm$/iu) || text.match(/^(\d+(?:\.\d+)?)$/u);
  if (exact) {
    const amountCm = Number(exact[1]);
    return { amountCm, amountKnown: true, snowy: amountCm > 0 };
  }
  if (/^-\d/u.test(text)) {
    return { amountCm: null, amountKnown: false, snowy: false };
  }
  if (/(?:미만|이상|~|∼|-)/u.test(text) && /\d/u.test(text)) {
    return { amountCm: null, amountKnown: false, snowy: true };
  }
  return { amountCm: null, amountKnown: false, snowy: false };
}


// Keep official interval bounds instead of inventing a midpoint or dropping the amount.
function kmaAmountBounds(value, unit) {
  const parsed = unit === "mm" ? parseKmaPrecipitation(value) : parseKmaSnowfall(value);
  const exact = unit === "mm" ? parsed.amountMm : parsed.amountCm;
  if (parsed.amountKnown && Number.isFinite(exact)) {
    return { minimum: exact, maximum: exact, upperExclusive: false };
  }
  const text = String(value ?? "").trim();
  const number = "(\\d+(?:\\.\\d+)?)";
  const below = text.match(new RegExp("^" + number + "\\s*" + unit + "\\s*미만$", "u"));
  if (below && Number(below[1]) > 0) {
    return { minimum: 0, maximum: Number(below[1]), upperExclusive: true };
  }
  const above = text.match(new RegExp("^" + number + "\\s*" + unit + "\\s*이상$", "u"));
  if (above) return { minimum: Number(above[1]), maximum: null, upperExclusive: false };
  const range = text.match(new RegExp("^" + number + "\\s*(?:" + unit + ")?\\s*[~∼-]\\s*" + number + "\\s*" + unit + "$", "u"));
  if (range && Number(range[1]) <= Number(range[2])) {
    return { minimum: Number(range[1]), maximum: Number(range[2]), upperExclusive: false };
  }
  return null;
}

function sumAmountBounds(values) {
  if (!values.length || values.some((value) => !value
    || !Number.isFinite(value.minimum) || value.minimum < 0
    || (value.maximum !== null && (!Number.isFinite(value.maximum) || value.maximum < value.minimum)))) return null;
  const maximum = values.some((value) => value.maximum === null)
    ? null : roundOne(values.reduce((sum, value) => sum + value.maximum, 0));
  return {
    minimum: roundOne(values.reduce((sum, value) => sum + value.minimum, 0)),
    maximum,
    upperExclusive: maximum !== null && values.some((value) => value.upperExclusive === true)
  };
}

function formatAmountBounds(bounds, unit) {
  if (!bounds || !Number.isFinite(bounds.minimum) || bounds.minimum < 0) return "";
  const { minimum, maximum, upperExclusive } = bounds;
  if (maximum === null) return minimum > 0 ? formatNumber(minimum) + unit + " 이상" : "";
  if (!Number.isFinite(maximum) || maximum < minimum || maximum <= 0) return "";
  if (maximum === minimum) return formatNumber(minimum) + unit;
  if (minimum === 0 && upperExclusive) return formatNumber(maximum) + unit + " 미만";
  return formatNumber(minimum) + "~" + formatNumber(maximum) + unit + (upperExclusive ? " 미만" : "");
}

function conditionFromKma(ptyValue, skyValue, lightningValue = 0) {
  const pty = numberOrNull(ptyValue);
  const precipitation = new Map([
    [1, "rain"],
    [2, "rain-snow"],
    [3, "snow"],
    [4, "shower"],
    [5, "raindrop"],
    [6, "raindrop-snow"],
    [7, "snow-flurry"]
  ]);
  const lightning = numberOrNull(lightningValue);
  if (lightning !== null && lightning > 0 && lightning <= 100) return "thunderstorm";
  if (precipitation.has(pty)) return precipitation.get(pty);
  const sky = numberOrNull(skyValue);
  return new Map([[1, "clear"], [3, "mostly-cloudy"], [4, "overcast"]]).get(sky) || null;
}

function forecastRows(items) {
  const rows = new Map();
  for (const item of items) {
    const time = formatForecastTime(item.fcstDate, item.fcstTime);
    if (!time) continue;
    const row = rows.get(time) || {};
    row[item.category] = item.fcstValue;
    rows.set(time, row);
  }
  return rows;
}

function buildHourly(villageItems, ultraItems) {
  const villageRows = forecastRows(villageItems);
  const ultraRows = forecastRows(ultraItems);
  const timestamps = [...new Set([...villageRows.keys(), ...ultraRows.keys()])].sort();
  const hourly = {
    time: [],
    temperature: [],
    precipitation_probability: [],
    precipitation: [],
    precipitation_known: [],
    precipitation_bounds: [],
    snowfall: [],
    snowfall_known: [],
    snowfall_bounds: [],
    rainy: [],
    condition: [],
    precipitation_phase: [],
    sky_condition: [],
    lightning_density: []
  };
  for (const time of timestamps) {
    const village = villageRows.get(time) || {};
    const ultra = ultraRows.get(time) || {};
    const pty = ultra.PTY ?? village.PTY;
    const sky = ultra.SKY ?? village.SKY;
    const lightningDensity = numberOrNull(ultra.LGT);
    // KMA explicitly uses null for no precipitation; only an absent category
    // may fall back to the older village forecast.
    const precipitationValue = Object.hasOwn(ultra, "RN1") ? ultra.RN1 : village.PCP;
    const precipitation = parseKmaPrecipitation(precipitationValue);
    const condition = conditionFromKma(pty, sky, lightningDensity);
    const precipitationPhase = conditionFromKma(pty, sky);
    const snowfall = parseKmaSnowfall(village.SNO);
    const snowfallApplies = SNOWFALL_CONDITIONS.has(precipitationPhase);
    hourly.time.push(time);
    hourly.temperature.push(numberOrNull(ultra.T1H ?? village.TMP));
    hourly.precipitation_probability.push(numberOrNull(ultra.POP ?? village.POP));
    hourly.precipitation.push(precipitation.amountMm);
    hourly.precipitation_known.push(precipitation.amountKnown);
    hourly.precipitation_bounds.push(kmaAmountBounds(precipitationValue, "mm"));
    hourly.snowfall.push(snowfallApplies ? snowfall.amountCm : null);
    hourly.snowfall_known.push(snowfallApplies && snowfall.amountKnown);
    hourly.snowfall_bounds.push(snowfallApplies ? kmaAmountBounds(village.SNO, "cm") : null);
    hourly.rainy.push(precipitation.rainy || PRECIPITATION_CONDITIONS.has(condition));
    hourly.condition.push(condition);
    hourly.precipitation_phase.push(precipitationPhase);
    hourly.sky_condition.push(conditionFromKma(0, sky));
    hourly.lightning_density.push(
      lightningDensity !== null && lightningDensity >= 0 && lightningDensity <= 100
        ? lightningDensity
        : null
    );
  }
  return hourly;
}

function dailyTemperatureRange(villageItems, dateKey) {
  const compactDate = dateKey.replaceAll("-", "");
  const min = villageItems
    .filter((item) => item.fcstDate === compactDate && item.category === "TMN")
    .map((item) => numberOrNull(item.fcstValue))
    .find((value) => value !== null);
  const max = villageItems
    .filter((item) => item.fcstDate === compactDate && item.category === "TMX")
    .map((item) => numberOrNull(item.fcstValue))
    .find((value) => value !== null);
  return { min: min ?? null, max: max ?? null };
}

function completeDailyTemperatureRange(villageItems, dateKey) {
  const range = dailyTemperatureRange(villageItems, dateKey);
  return range.min !== null
    && range.max !== null
    && range.min >= -80
    && range.max <= 60
    && range.min <= range.max;
}

function hourlyRainIntervalsForDate(hourly, dateKey) {
  const intervals = [];
  for (let index = 0; index < (hourly.time || []).length; index += 1) {
    const endMinute = wallClockMinute(hourly.time[index]);
    if (endMinute === null) continue;
    // PCP/RN1 describe the hour ending at the forecast timestamp. Assign
    // midnight to the preceding day so the final hour is never lost.
    const startAt = wallClockStamp(endMinute - 60);
    if (!startAt.startsWith(dateKey + "T")) continue;
    intervals.push({
      startMinute: endMinute - 60,
      endMinute,
      amountMm: numberOrNull(hourly.precipitation?.[index]),
      amountKnown: hourly.precipitation_known?.[index] === true,
      amountBounds: hourly.precipitation_bounds?.[index] ?? null,
      snowfallCm: numberOrNull(hourly.snowfall?.[index]),
      snowfallKnown: hourly.snowfall_known?.[index] === true,
      snowfallBounds: hourly.snowfall_bounds?.[index] ?? null,
      rainy: hourly.rainy?.[index] === true,
      probability: numberOrNull(hourly.precipitation_probability?.[index]),
      condition: PRECIPITATION_CONDITIONS.has(hourly.condition?.[index])
        ? hourly.condition[index]
        : null,
      precipitationPhase: PRECIPITATION_CONDITIONS.has(hourly.precipitation_phase?.[index])
        ? hourly.precipitation_phase[index]
        : null
    });
  }
  return intervals;
}

function rainPeriodsFromIntervals(intervals) {
  const rainy = intervals.filter((interval) => interval.rainy);
  const periods = [];
  for (const interval of rainy) {
    const previous = periods.at(-1);
    if (previous && previous.endMinute === interval.startMinute) {
      previous.endMinute = interval.endMinute;
      previous.amountKnown = previous.amountKnown && interval.amountKnown;
      previous.amountMm = previous.amountKnown
        ? roundOne(previous.amountMm + (interval.amountMm || 0))
        : null;
      continue;
    }
    periods.push({
      startMinute: interval.startMinute,
      endMinute: interval.endMinute,
      amountKnown: interval.amountKnown,
      amountMm: interval.amountKnown ? (interval.amountMm || 0) : null
    });
  }
  return periods.map((period) => ({
    startAt: wallClockStamp(period.startMinute),
    endAt: wallClockStamp(period.endMinute),
    amountMm: period.amountMm
  }));
}

export function rainPeriodsForDate(hourly, dateKey, { afterMinute = null } = {}) {
  let intervals = hourlyRainIntervalsForDate(hourly, dateKey);
  if (Number.isFinite(afterMinute)) {
    intervals = intervals
      .filter((interval) => interval.endMinute > afterMinute)
      .map((interval) => ({
        ...interval,
        startMinute: Math.max(interval.startMinute, afterMinute)
      }));
  }
  return rainPeriodsFromIntervals(intervals);
}

function summaryPrecipitationCondition(intervals) {
  const conditions = new Set(
    intervals
      .filter((interval) => interval.rainy && PRECIPITATION_CONDITIONS.has(interval.condition))
      .map((interval) => interval.condition)
  );
  if (conditions.has("thunderstorm")) return "thunderstorm";
  const hasLiquid = ["rain", "shower", "raindrop"].some((condition) => conditions.has(condition));
  const hasFrozen = ["snow", "snow-flurry"].some((condition) => conditions.has(condition));
  if (conditions.has("rain-snow")
    || conditions.has("raindrop-snow")
    || (hasLiquid && hasFrozen)) {
    return "rain-snow";
  }
  if (conditions.has("snow")) return "snow";
  if (conditions.has("snow-flurry")) return "snow-flurry";
  if (conditions.has("shower")) return "shower";
  if (conditions.has("rain")) return "rain";
  if (conditions.has("raindrop")) return "raindrop";
  return null;
}

function rainSummaryForDate(hourly, dateKey, { afterMinute = null } = {}) {
  let intervals = hourlyRainIntervalsForDate(hourly, dateKey);
  if (Number.isFinite(afterMinute)) intervals = intervals.filter((interval) => interval.endMinute > afterMinute);
  const probabilities = intervals.map((interval) => interval.probability).filter((value) => value !== null);
  const rainy = intervals.filter((interval) => interval.rainy);
  const precipitationMm = rainy.length === 0 || rainy.some((interval) => !interval.amountKnown)
    ? null
    : sumOrNull(rainy.map((interval) => interval.amountMm).filter((value) => value !== null));
  const snowy = rainy.filter((interval) => SNOWFALL_CONDITIONS.has(interval.precipitationPhase));
  const snowfallCm = snowy.length === 0 || snowy.some((interval) => !interval.snowfallKnown)
    ? null
    : sumOrNull(snowy.map((interval) => interval.snowfallCm).filter((value) => value !== null));
  return {
    probability: maxOrNull(probabilities),
    precipitationMm: precipitationMm === null ? null : roundOne(precipitationMm),
    precipitationBounds: sumAmountBounds(rainy.map((interval) => interval.amountBounds)),
    snowfallBounds: sumAmountBounds(snowy.map((interval) => interval.snowfallBounds)),
    snowfallCm: snowfallCm === null ? null : roundOne(snowfallCm),
    periods: rainPeriodsFromIntervals(intervals),
    condition: summaryPrecipitationCondition(intervals)
  };
}

function precipitationForMealWindow(hourly, mealType, dateKey, afterMinute) {
  const hours = new Set(mealHours(mealType));
  const indexes = (hourly.time || []).flatMap((time, index) => {
    const match = String(time).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):/u);
    const endMinute = wallClockMinute(time);
    return match
      && match[1] === dateKey
      && hours.has(Number(match[2]))
      && endMinute !== null
      && endMinute > afterMinute
      ? [index]
      : [];
  });
  const rainy = indexes.filter((index) => hourly.rainy?.[index]);
  if (rainy.some((index) => hourly.precipitation_known?.[index] !== true)) return null;
  return sumOrNull(indexes.map((index) => numberOrNull(hourly.precipitation?.[index])).filter((value) => value !== null));
}

function nearestSkyCondition(hourly, currentMinute) {
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < (hourly.time || []).length; index += 1) {
    const minute = wallClockMinute(hourly.time[index]);
    const condition = hourly.sky_condition?.[index];
    if (minute === null || !condition) continue;
    const distance = Math.abs(minute - currentMinute);
    if (distance < nearestDistance) {
      nearest = condition;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function nearestLightningDensity(hourly, currentMinute) {
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < (hourly.time || []).length; index += 1) {
    const minute = wallClockMinute(hourly.time[index]);
    const lightningDensity = numberOrNull(hourly.lightning_density?.[index]);
    if (minute === null
      || lightningDensity === null
      || lightningDensity < 0
      || lightningDensity > 100) {
      continue;
    }
    const distance = Math.abs(minute - currentMinute);
    if (distance < nearestDistance) {
      nearest = lightningDensity;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function currentRainUntil(periods, currentMinute) {
  const period = periods.find(({ startAt, endAt }) => {
    const start = wallClockMinute(startAt);
    const end = wallClockMinute(endAt);
    return start !== null && end !== null && start <= currentMinute && currentMinute < end;
  });
  return period?.endAt || null;
}

function airKoreaUrl() {
  const url = new URL(AIRKOREA_API_URL);
  url.search = new URLSearchParams({
    serviceKey: normalizedPublicDataServiceKey(),
    returnType: "json",
    numOfRows: "1",
    pageNo: "1",
    stationName: config.airKoreaStationName,
    dataTerm: "DAILY",
    ver: "1.4"
  }).toString();
  return url;
}

function normalizedPublicDataServiceKey() {
  const key = String(config.publicDataServiceKey || "").trim();
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function publicDataUrl(base, params) {
  const url = new URL(base);
  url.search = new URLSearchParams({
    serviceKey: normalizedPublicDataServiceKey(),
    ...params
  }).toString();
  return url;
}

function compactKstHour(minute) {
  const date = new Date(minute * 60000);
  return `${date.toISOString().slice(0, 10).replaceAll("-", "")}${String(date.getUTCHours()).padStart(2, "0")}`;
}

function kmaUvBaseTimes(now) {
  const latestAvailableMinute = localWallClockMinute(now) - 30;
  const latestDate = new Date(latestAvailableMinute * 60000);
  latestDate.setUTCMinutes(0, 0, 0);
  latestDate.setUTCHours(Math.floor(latestDate.getUTCHours() / 3) * 3);
  const latest = latestDate.getTime() / 60000;
  return [compactKstHour(latest), compactKstHour(latest - 3 * 60)];
}

function compactHourMinute(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})$/u);
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4])
  ) / 60000;
}

export function parseKmaUvForMeal(item, mealType, now) {
  const issuedMinute = compactHourMinute(item?.date);
  if (issuedMinute === null) throw new Error("KMA UV response has an invalid issue time");
  const targetDate = localDateKey(now);
  const targetHours = new Set(mealHours(mealType));
  const values = [];
  for (let offsetHours = 0; offsetHours <= 75; offsetHours += 3) {
    const forecastMinute = issuedMinute + offsetHours * 60;
    const forecastAt = wallClockStamp(forecastMinute);
    const match = forecastAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):/u);
    if (!match || match[1] !== targetDate || !targetHours.has(Number(match[2]))) continue;
    const value = numberOrNull(item[`h${offsetHours}`]);
    if (value !== null && value >= 0 && value <= 30) values.push(value);
  }
  if (!values.length) throw new Error("KMA UV response has no value for the meal window");
  return {
    uvIndex: roundOne(Math.max(...values)),
    dataTime: String(item.date)
  };
}

function kmaUvUrl(time) {
  return publicDataUrl(KMA_UV_API_URL, {
    pageNo: "1",
    numOfRows: "10",
    dataType: "JSON",
    areaNo: KMA_LIVING_AREA_NO,
    time
  });
}

function livingIndexItem(data) {
  const header = data?.response?.header;
  if (String(header?.resultCode) !== "00") {
    throw new Error(`KMA UV API ${header?.resultCode || "UNKNOWN"}: ${header?.resultMsg || "unknown error"}`);
  }
  const items = data?.response?.body?.items?.item;
  const item = Array.isArray(items) ? items[0] : items;
  if (!item) throw new Error("KMA UV API returned no forecast item");
  if (String(item.areaNo) !== KMA_LIVING_AREA_NO) {
    throw new Error(`KMA UV API returned the wrong area: ${item.areaNo || "missing areaNo"}`);
  }
  return item;
}

async function getKmaUv(mealType, now, fetchImpl) {
  let lastError;
  for (const baseTime of kmaUvBaseTimes(now)) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const item = livingIndexItem(await fetchJson(kmaUvUrl(baseTime), fetchImpl));
        return parseKmaUvForMeal(item, mealType, now);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  throw new Error(`KMA UV unavailable: ${lastError?.message || "unknown error"}`);
}

function parseKstDataTime(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/u);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const dateKey = [year, month, day].join("-");
  if (!Number.isFinite(calendarDate.getTime())
    || calendarDate.toISOString().slice(0, 10) !== dateKey
    || Number(hour) > 24
    || Number(minute) > 59
    || (Number(hour) === 24 && Number(minute) !== 0)) return null;
  // AirKorea may label the day's final measurement 24:00. ISO parsing maps
  // that valid boundary to the next midnight, while impossible dates fail.
  const measuredAt = new Date(dateKey + "T" + hour + ":" + minute + ":00+09:00");
  return Number.isFinite(measuredAt.getTime()) ? measuredAt : null;
}

function parseAirQuality(data, now) {
  const item = data?.response?.body?.items?.[0];
  if (!item) throw new Error("AirKorea returned no station measurement");
  const measuredAt = parseKstDataTime(item.dataTime);
  if (!measuredAt || now.getTime() - measuredAt.getTime() > AIR_QUALITY_MAX_AGE_MS
    || measuredAt.getTime() - now.getTime() > 15 * 60 * 1000) {
    throw new Error(`AirKorea measurement is stale or invalid: ${item.dataTime || "missing dataTime"}`);
  }
  const particleValue = (valueField, flagField) => {
    if (String(item[flagField] || "").trim()) return null;
    const value = numberOrNull(item[valueField]);
    return value !== null && value >= 0 ? value : null;
  };
  const pm10 = particleValue("pm10Value", "pm10Flag");
  const pm25 = particleValue("pm25Value", "pm25Flag");
  if (pm10 === null && pm25 === null) throw new Error("AirKorea returned no PM10/PM2.5 values");
  return { pm10, pm25, dataTime: item.dataTime };
}

async function getAirQuality(now, fetchImpl) {
  return fetchAirKoreaWithRetry(
    "AirKorea",
    async () => parseAirQuality(await fetchJson(airKoreaUrl(), fetchImpl), now)
  );
}

function kmaWarningUrl() {
  return publicDataUrl(KMA_WARNING_API_URL, {
    pageNo: "1",
    numOfRows: "10",
    dataType: "JSON"
  });
}

function kmaWarningText(data) {
  const header = data?.response?.header;
  if (String(header?.resultCode) !== "00") {
    throw new Error(`KMA warning API ${header?.resultCode || "UNKNOWN"}: ${header?.resultMsg || "unknown error"}`);
  }
  const items = data?.response?.body?.items?.item;
  const normalizedItems = Array.isArray(items) ? items : items ? [items] : [];
  const item = [...normalizedItems].sort(
    (left, right) => (numberOrNull(right.tmFc) ?? -1) - (numberOrNull(left.tmFc) ?? -1)
  )[0];
  if (!item) throw new Error("KMA warning API returned no status item");
  return [item.t6, item.t7].filter(Boolean).join("\n");
}

async function getKmaWarnings(fetchImpl) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return extractKmaWarnings(kmaWarningText(await fetchJson(kmaWarningUrl(), fetchImpl)));
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`KMA warning unavailable after 2 attempts: ${lastError?.message || "unknown error"}`);
}

function airKoreaDustWarningUrl(year) {
  return publicDataUrl(AIRKOREA_DUST_WARNING_API_URL, {
    returnType: "json",
    numOfRows: "1000",
    pageNo: "1",
    year: String(year)
  });
}

export function parseAirKoreaDustWarnings(data) {
  const header = data?.response?.header;
  if (String(header?.resultCode) !== "00") {
    throw new Error(`AirKorea warning API ${header?.resultCode || "UNKNOWN"}: ${header?.resultMsg || "unknown error"}`);
  }
  const rawItems = data?.response?.body?.items;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  const itemLabels = { PM10: "미세먼지", PM25: "초미세먼지" };
  return items
    .filter((item) => item.districtName === AIRKOREA_WARNING_DISTRICT)
    .filter((item) => item.moveName === AIRKOREA_WARNING_ZONE)
    .filter((item) => !String(item.clearDate || "").trim() && !String(item.clearTime || "").trim())
    .map((item) => {
      const label = itemLabels[String(item.itemCode || "").toUpperCase()];
      const level = String(item.issueGbn || "").trim();
      return label && /^(?:주의보|경보|중대경보)$/u.test(level) ? `${label} ${level}` : "";
    })
    .filter(Boolean)
    .filter((warning, index, all) => all.indexOf(warning) === index);
}

async function getAirKoreaDustWarnings(now, fetchImpl) {
  const { year, month, day } = kstParts(now);
  const years = month === 1 && day <= 2 ? [year, year - 1] : [year];
  const warnings = [];
  for (const queryYear of years) {
    const yearWarnings = await fetchAirKoreaWithRetry(
      "AirKorea warning",
      async () => parseAirKoreaDustWarnings(
        await fetchJson(airKoreaDustWarningUrl(queryYear), fetchImpl)
      )
    );
    warnings.push(...yearWarnings);
  }
  return warnings.filter((warning, index, all) => all.indexOf(warning) === index);
}

function settled(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason })
  );
}

function requireWeatherConfiguration() {
  if (!String(config.publicDataServiceKey || "").trim()) {
    throw new Error("PUBLIC_DATA_SERVICE_KEY is required for KMA and AirKorea weather data");
  }
  if (config.airKoreaStationName !== REQUIRED_AIRKOREA_STATION) {
    throw new Error(`AIRKOREA_STATION_NAME must be ${REQUIRED_AIRKOREA_STATION} for the JBNU target`);
  }
}

export function currentWeatherEmoji(condition) {
  return CONDITION_LABELS[condition]?.[0] || "🌡️";
}

export function formatCurrentWeatherCondition(condition) {
  const label = CONDITION_LABELS[condition];
  return label ? `${label[0]} ${label[1]}` : "";
}

export function uvRiskLabel(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value >= 11) return "위험";
  if (value >= 8) return "매우 높음";
  if (value >= 6) return "높음";
  if (value >= 3) return "보통";
  return "낮음";
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(roundOne(value));
}

function formatRainPeriod(period) {
  const start = String(period.startAt || "").slice(11, 16);
  const rawEnd = String(period.endAt || "").slice(11, 16);
  const end = rawEnd === "00:00"
    && String(period.endAt).slice(0, 10) > String(period.startAt).slice(0, 10)
    ? "24:00"
    : rawEnd;
  if (!start || !end) return "";
  return `${start}~${end}`;
}

export function formatWeatherAlert(metrics) {
  const parts = [];
  const current = [];
  if (Number.isFinite(metrics.currentTemperature)) {
    const apparent = Number.isFinite(metrics.currentApparentTemperature)
      ? ` (체감 ${formatNumber(metrics.currentApparentTemperature)}°)`
      : "";
    current.push(`🌡️ 현재 ${formatNumber(metrics.currentTemperature)}°${apparent}`);
  }
  if (Number.isFinite(metrics.currentHumidity)
    && metrics.currentHumidity >= HIGH_HUMIDITY_THRESHOLD_PERCENT) {
    current.push(`💧 습도 높음 (${formatNumber(metrics.currentHumidity)}%)`);
  }
  const condition = formatCurrentWeatherCondition(metrics.currentCondition);
  if (condition) current.push(condition);
  if (Number.isFinite(metrics.todayMaxTemperature)) current.push(`최고 ${formatNumber(metrics.todayMaxTemperature)}°`);
  if (Number.isFinite(metrics.todayMinTemperature)) current.push(`최저 ${formatNumber(metrics.todayMinTemperature)}°`);
  if (current.length) parts.push(current.join(" · "));

  if (PRECIPITATION_CONDITIONS.has(metrics.currentCondition)) {
    const label = CONDITION_LABELS[metrics.currentCondition] || ["🌧️", "강수"];
    const amount = Number.isFinite(metrics.currentPrecipitationMm)
      && metrics.currentPrecipitationMm > 0
      ? ` ${formatNumber(metrics.currentPrecipitationMm)}mm`
      : formatAmountBounds(metrics.currentPrecipitationBounds, "mm")
        ? " " + formatAmountBounds(metrics.currentPrecipitationBounds, "mm") : "";
    const until = metrics.currentRainUntil ? ` · ${String(metrics.currentRainUntil).slice(11, 16)}까지 예보` : "";
    parts.push(`${label[0]} 지금 ${label[1]}${amount}${until} · 우산 챙기세요`);
  }

  const appendForecast = (
    label,
    probability,
    precipitationMm,
    snowfallCm,
    periods,
    condition,
    precipitationBounds,
    snowfallBounds
  ) => {
    if (!Number.isFinite(probability) || probability < config.weatherRainThresholdPercent) return;
    const forecastLabel = FORECAST_CONDITION_LABELS[condition] || FORECAST_CONDITION_LABELS.rain;
    const amount = Number.isFinite(precipitationMm) && precipitationMm > 0
      ? ` · 예상 ${formatNumber(precipitationMm)}mm`
      : formatAmountBounds(precipitationBounds, "mm")
        ? " · 예상 " + formatAmountBounds(precipitationBounds, "mm") : "";
    const snowfall = Number.isFinite(snowfallCm) && snowfallCm > 0
      ? ` · 예상 적설 ${formatNumber(snowfallCm)}cm`
      : formatAmountBounds(snowfallBounds, "cm")
        ? " · 예상 적설 " + formatAmountBounds(snowfallBounds, "cm") : "";
    const periodText = (periods || []).map(formatRainPeriod).filter(Boolean).join(", ");
    parts.push(
      `${forecastLabel[0]} ${label} ${forecastLabel[1]} 예보 ${formatNumber(probability)}%`
      + `${amount}${snowfall}${periodText ? ` · ${periodText}` : ""}`
    );
  };
  appendForecast(
    "오늘",
    metrics.todayRainProbability,
    metrics.todayRainMm,
    metrics.todaySnowfallCm,
    metrics.todayRainPeriods,
    metrics.todayRainCondition,
    metrics.todayPrecipitationBounds,
    metrics.todaySnowfallBounds
  );
  appendForecast(
    "내일",
    metrics.tomorrowRainProbability,
    metrics.tomorrowPrecipitationMm,
    metrics.tomorrowSnowfallCm,
    metrics.tomorrowRainPeriods,
    metrics.tomorrowRainCondition,
    metrics.tomorrowPrecipitationBounds,
    metrics.tomorrowSnowfallBounds
  );

  const appendWarning = (warning) => {
    const emoji = String(warning).endsWith("주의보") ? "⚠️" : "🚨";
    parts.push(`${emoji} ${warning}`);
  };
  for (const warning of metrics.warnings || []) appendWarning(warning);

  if (Number.isFinite(metrics.uvIndex) && metrics.uvIndex >= UV_WARNING_THRESHOLD) {
    parts.push(`😎 자외선 ${uvRiskLabel(metrics.uvIndex)} (${formatNumber(metrics.uvIndex)})`);
  }

  for (const warning of metrics.airQualityWarnings || []) appendWarning(warning);

  if (Number.isFinite(metrics.pm10)
    && metrics.pm10 > config.weatherPm10Threshold) {
    parts.push(`😷 미세먼지 높음 (${formatNumber(metrics.pm10)}㎍/㎥)`);
  }
  if (Number.isFinite(metrics.pm25)
    && metrics.pm25 > config.weatherPm25Threshold) {
    parts.push(`😷 초미세먼지 높음 (${formatNumber(metrics.pm25)}㎍/㎥)`);
  }
  return parts.join(" | ");
}

export async function getWeatherAlert({
  mealType = "점심",
  now = new Date(),
  fetchImpl = globalThis.fetch
} = {}) {
  if (!config.weatherEnabled) return null;
  requireWeatherConfiguration();
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  const observationBases = recentKmaBases(kmaObservationBase(now), 60);
  const ultraBases = recentKmaBases(
    kmaUltraShortBase(now),
    60,
    KMA_ULTRA_FORECAST_BASE_COUNT
  );
  const villageBases = recentKmaBases(kmaVillageBase(now), 180);
  const dateKey = localDateKey(now);
  const tomorrowKey = addDays(dateKey, 1);
  const requestMinute = localWallClockMinute(now);
  const [
    observationResult,
    ultraResult,
    villageResult,
    airQuality,
    warnings,
    uv,
    airQualityWarnings
  ] = await Promise.all([
    fetchKmaItems(
      "getUltraSrtNcst",
      observationBases,
      fetchImpl,
      observationIsComplete,
      "초단기실황"
    ),
    fetchKmaItems(
      "getUltraSrtFcst",
      ultraBases,
      fetchImpl,
      (items) => forecastCategoryIsValid(
        items,
        "T1H",
        (value) => {
          const numeric = numberOrNull(value);
          return numeric !== null && numeric >= -80 && numeric <= 60;
        }
      )
        && forecastCategoryIsValid(items, "POP", (value) => {
          const numeric = numberOrNull(value);
          return numeric !== null && numeric >= 0 && numeric <= 100;
        })
        && forecastCategoryIsValid(items, "PTY", (value) => {
          const numeric = numberOrNull(value);
          return Number.isInteger(numeric) && numeric >= 0 && numeric <= 7;
        })
        && forecastCategoryIsValid(
          items,
          "SKY",
          (value) => [1, 3, 4].includes(numberOrNull(value))
        )
        && forecastCategoryIsValid(items, "RN1", (value) => {
          const parsed = parseKmaPrecipitation(value);
          return parsed.amountKnown || parsed.rainy;
        })
        && lightningForecastIsComplete(items)
        && forecastCoversMinute(
          items,
          requestMinute,
          KMA_ULTRA_FORECAST_MAX_LAG_MINUTES
        ),
      "초단기예보"
    ),
    fetchKmaItems(
      "getVilageFcst",
      villageBases,
      fetchImpl,
      (items) => forecastCategoryIsValid(
        items,
        "TMP",
        (value) => {
          const numeric = numberOrNull(value);
          return numeric !== null && numeric >= -80 && numeric <= 60;
        }
      )
        && forecastCategoryIsValid(items, "POP", (value) => {
          const numeric = numberOrNull(value);
          return numeric !== null && numeric >= 0 && numeric <= 100;
        })
        && forecastCategoryIsValid(items, "PTY", (value) => {
          const numeric = numberOrNull(value);
          return Number.isInteger(numeric) && numeric >= 0 && numeric <= 4;
        })
        && forecastCategoryIsValid(
          items,
          "SKY",
          (value) => [1, 3, 4].includes(numberOrNull(value))
        )
        && forecastCategoryIsValid(items, "PCP", (value) => {
          const parsed = parseKmaPrecipitation(value);
          return parsed.amountKnown || parsed.rainy;
        })
        && forecastCategoryIsValid(items, "SNO", (value) => {
          const parsed = parseKmaSnowfall(value);
          return parsed.amountKnown || parsed.snowy;
        })
        && forecastDateHasCompleteRow(
          items,
          tomorrowKey,
          REQUIRED_VILLAGE_FORECAST_CATEGORIES
        ),
      "단기예보"
    ),
    settled(getAirQuality(now, fetchImpl)),
    settled(getKmaWarnings(fetchImpl)),
    settled(getKmaUv(mealType, now, fetchImpl)),
    settled(getAirKoreaDustWarnings(now, fetchImpl))
  ]);

  const observationItems = observationResult.items;
  const ultraItems = ultraResult.items;
  const villageItems = villageResult.items;

  const observation = observationValues(observationItems);
  const currentTemperature = numberOrNull(observation.T1H);
  const currentHumidity = numberOrNull(observation.REH);
  const currentWindSpeedMps = numberOrNull(observation.WSD);
  const currentApparentTemperature = calculateKmaApparentTemperature({
    temperatureC: currentTemperature,
    relativeHumidityPercent: currentHumidity,
    windSpeedMps: currentWindSpeedMps,
    month: kstParts(now).month
  });
  if (!Number.isFinite(currentApparentTemperature)) {
    throw new Error("KMA current conditions could not produce an apparent temperature");
  }
  const hourly = buildHourly(villageItems, ultraItems);
  const currentMinute = localWallClockMinute(now);
  const todayRain = rainSummaryForDate(hourly, dateKey, { afterMinute: currentMinute });
  const tomorrowRain = rainSummaryForDate(hourly, tomorrowKey);
  const currentPrecipitation = parseKmaPrecipitation(observation.RN1);
  const observedPrecipitationCondition = conditionFromKma(observation.PTY, null);
  const currentCondition = observedPrecipitationCondition
    ? conditionFromKma(
      observation.PTY,
      null,
      nearestLightningDensity(hourly, currentMinute)
    )
    : nearestSkyCondition(hourly, currentMinute);
  let temperatureRange = dailyTemperatureRange(villageItems, dateKey);
  let temperatureRangeBase = villageResult.base;
  if (!completeDailyTemperatureRange(villageItems, dateKey)) {
    const dailyRangeResult = await fetchKmaItems(
      "getVilageFcst",
      recentKmaBases(kmaDailyTemperatureRangeBase(now), 180),
      fetchImpl,
      (items) => completeDailyTemperatureRange(items, dateKey),
      "당일 최저·최고기온"
    );
    const dailyRangeItems = dailyRangeResult.items;
    temperatureRangeBase = dailyRangeResult.base;
    const fallbackRange = dailyTemperatureRange(dailyRangeItems, dateKey);
    temperatureRange = {
      min: temperatureRange.min ?? fallbackRange.min,
      max: temperatureRange.max ?? fallbackRange.max
    };
  }
  if (temperatureRange.min === null
    || temperatureRange.max === null
    || temperatureRange.min > temperatureRange.max) {
    throw new Error("KMA daily temperature range is incomplete or invalid");
  }
  const rainProbability = maxOrNull(valuesInMealWindow(
    hourly.time,
    hourly.precipitation_probability,
    mealType,
    dateKey,
    { afterMinute: currentMinute }
  ));
  const mealPrecipitationMm = precipitationForMealWindow(hourly, mealType, dateKey, currentMinute);
  const metrics = {
    provider: "KMA+AirKorea",
    source: "기상청 날씨·특보·자외선 + 에어코리아 노송동 대기질·전북 중부권역 경보",
    mealType: normalizeMealType(mealType),
    currentTemperature,
    currentApparentTemperature,
    currentHumidity,
    currentWindSpeedMps,
    currentCondition,
    headerEmoji: currentWeatherEmoji(currentCondition),
    currentPrecipitationMm: currentPrecipitation.amountMm,
    currentPrecipitationBounds: kmaAmountBounds(observation.RN1, "mm"),
    currentRainUntil: currentRainUntil(todayRain.periods, currentMinute),
    todayMinTemperature: temperatureRange.min,
    todayMaxTemperature: temperatureRange.max,
    temperatureRangeBaseDate: temperatureRangeBase.baseDate,
    temperatureRangeBaseTime: temperatureRangeBase.baseTime,
    rainProbability,
    mealPrecipitationMm: mealPrecipitationMm === null ? null : roundOne(mealPrecipitationMm),
    todayRainProbability: todayRain.probability,
    todayRainMm: todayRain.precipitationMm,
    todayPrecipitationBounds: todayRain.precipitationBounds,
    todaySnowfallBounds: todayRain.snowfallBounds,
    todaySnowfallCm: todayRain.snowfallCm,
    todayRainPeriods: todayRain.periods,
    todayRainCondition: todayRain.condition,
    tomorrowRainProbability: tomorrowRain.probability,
    tomorrowPrecipitationMm: tomorrowRain.precipitationMm,
    tomorrowPrecipitationBounds: tomorrowRain.precipitationBounds,
    tomorrowSnowfallBounds: tomorrowRain.snowfallBounds,
    tomorrowSnowfallCm: tomorrowRain.snowfallCm,
    tomorrowRainPeriods: tomorrowRain.periods,
    tomorrowRainCondition: tomorrowRain.condition,
    pm10: airQuality.status === "fulfilled" ? airQuality.value.pm10 : null,
    pm25: airQuality.status === "fulfilled" ? airQuality.value.pm25 : null,
    airQualityDataTime: airQuality.status === "fulfilled" ? airQuality.value.dataTime : null,
    airQualityStatus: airQuality.status === "fulfilled" ? "ok" : "unavailable",
    airQualityError: airQuality.status === "rejected" ? airQuality.reason?.message : null,
    warnings: warnings.status === "fulfilled" ? warnings.value : [],
    warningStatus: warnings.status === "fulfilled" ? "ok" : "unavailable",
    warningError: warnings.status === "rejected" ? warnings.reason?.message : null,
    warningCheckedAt: now.toISOString(),
    uvIndex: uv.status === "fulfilled" ? uv.value.uvIndex : null,
    uvDataTime: uv.status === "fulfilled" ? uv.value.dataTime : null,
    uvStatus: uv.status === "fulfilled" ? "ok" : "unavailable",
    uvError: uv.status === "rejected" ? uv.reason?.message : null,
    airQualityWarnings: airQualityWarnings.status === "fulfilled" ? airQualityWarnings.value : [],
    airQualityWarningStatus: airQualityWarnings.status === "fulfilled" ? "ok" : "unavailable",
    airQualityWarningError: airQualityWarnings.status === "rejected"
      ? airQualityWarnings.reason?.message
      : null,
    airQualityWarningCheckedAt: now.toISOString(),
    kmaObservationBaseDate: observationResult.base.baseDate,
    kmaObservationBaseTime: observationResult.base.baseTime,
    kmaUltraShortBaseDate: ultraResult.base.baseDate,
    kmaUltraShortBaseTime: ultraResult.base.baseTime,
    kmaVillageBaseDate: villageResult.base.baseDate,
    kmaVillageBaseTime: villageResult.base.baseTime,
    kmaObservationStatus: "ok",
    kmaUltraShortStatus: "ok",
    kmaVillageStatus: "ok"
  };
  const alertText = formatWeatherAlert(metrics);
  return {
    ...metrics,
    alertText,
    text: alertText
  };
}
