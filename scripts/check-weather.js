import { getWeatherAlert } from "../src/weather.js";
import { normalizeMealType } from "../src/meal-types.js";
import {
  weatherDiagnosticAirQualityRequirement,
  weatherDiagnosticUvRequirement,
} from "../src/weather-diagnostic.js";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const mealType = normalizeMealType(argValue("--meal", "저녁"));
const diagnosticNow = new Date();
const result = await getWeatherAlert({ mealType, now: diagnosticNow });
if (result === null) {
  console.log(JSON.stringify({
    enabled: false,
    provider: "KMA+AirKorea",
    status: "WEATHER_ENABLED is false"
  }, null, 2));
  if (process.argv.includes("--strict")) process.exitCode = 1;
} else {
  const uvRequirement = weatherDiagnosticUvRequirement({
    mealType,
    now: diagnosticNow,
    uvStatus: result.uvStatus,
    uvError: result.uvError,
  });
  const airQualityRequirement = weatherDiagnosticAirQualityRequirement({
    now: diagnosticNow,
    airQualityStatus: result.airQualityStatus,
    airQualityError: result.airQualityError,
  });
  console.log(JSON.stringify({
    enabled: true,
    provider: result.provider,
    mealType: result.mealType,
    kmaObservationStatus: result.kmaObservationStatus,
    kmaUltraShortStatus: result.kmaUltraShortStatus,
    kmaVillageStatus: result.kmaVillageStatus,
    airQualityStatus: result.airQualityStatus,
    airQualityDiagnosticStatus: airQualityRequirement.status,
    airQualityDataTime: result.airQualityDataTime,
    airQualityError: result.airQualityError,
    warningStatus: result.warningStatus,
    warningCheckedAt: result.warningCheckedAt,
    warnings: result.warnings,
    uvStatus: result.uvStatus,
    uvDiagnosticStatus: uvRequirement.status,
    uvDataTime: result.uvDataTime,
    uvIndex: result.uvIndex,
    airQualityWarningStatus: result.airQualityWarningStatus,
    airQualityWarningCheckedAt: result.airQualityWarningCheckedAt,
    airQualityWarnings: result.airQualityWarnings,
    text: result.text
  }, null, 2));
  const requiredStatuses = [
    result.provider === "KMA+AirKorea",
    result.kmaObservationStatus === "ok",
    result.kmaUltraShortStatus === "ok",
    result.kmaVillageStatus === "ok",
    airQualityRequirement.satisfied,
    result.warningStatus === "ok",
    uvRequirement.satisfied,
    result.airQualityWarningStatus === "ok",
    Number.isFinite(result.currentTemperature)
  ];
  if (process.argv.includes("--strict") && requiredStatuses.some((status) => !status)) process.exitCode = 1;
}
