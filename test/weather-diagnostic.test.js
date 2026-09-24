import test from "node:test";
import assert from "node:assert/strict";
import {
  weatherDiagnosticAirQualityRequirement,
  weatherDiagnosticUvRequirement,
} from "../src/weather-diagnostic.js";

const NO_WINDOW = "KMA UV unavailable: KMA UV response has no value for the meal window";

test("weather diagnostics waive only a past meal window with a valid no-window UV response", () => {
  assert.deepEqual(weatherDiagnosticUvRequirement({
    mealType: "저녁",
    now: new Date("2026-08-01T12:00:00.000Z"), // 21:00 KST
    uvStatus: "unavailable",
    uvError: NO_WINDOW,
  }), { satisfied: true, status: "not-applicable-past-window" });
  assert.deepEqual(weatherDiagnosticUvRequirement({
    mealType: "점심",
    now: new Date("2026-08-01T06:00:00.000Z"), // 15:00 KST
    uvStatus: "unavailable",
    uvError: NO_WINDOW,
  }), { satisfied: true, status: "not-applicable-past-window" });
});

test("weather diagnostics keep UV mandatory before and during sends and on real API failures", () => {
  assert.deepEqual(weatherDiagnosticUvRequirement({
    mealType: "저녁",
    now: new Date("2026-08-01T08:25:00.000Z"), // 17:25 KST
    uvStatus: "unavailable",
    uvError: NO_WINDOW,
  }), { satisfied: false, status: "required" });
  assert.deepEqual(weatherDiagnosticUvRequirement({
    mealType: "저녁",
    now: new Date("2026-08-01T13:00:00.000Z"),
    uvStatus: "unavailable",
    uvError: "KMA UV unavailable: network timeout",
  }), { satisfied: false, status: "required" });
  assert.deepEqual(weatherDiagnosticUvRequirement({
    mealType: "저녁",
    now: new Date("2026-08-01T08:25:00.000Z"),
    uvStatus: "ok",
  }), { satisfied: true, status: "ok" });
});

test("weather diagnostics waive only the official overnight AirKorea no-measurement gap", () => {
  assert.deepEqual(weatherDiagnosticAirQualityRequirement({
    now: new Date("2026-08-15T16:23:00.000Z"), // 01:23 KST
    airQualityStatus: "unavailable",
    airQualityError: "AirKorea returned no station measurement",
  }), { satisfied: true, status: "not-applicable-off-hours" });
  assert.deepEqual(weatherDiagnosticAirQualityRequirement({
    now: new Date("2026-08-16T02:23:00.000Z"), // 11:23 KST
    airQualityStatus: "unavailable",
    airQualityError: "AirKorea returned no station measurement",
  }), { satisfied: false, status: "required" });
  assert.deepEqual(weatherDiagnosticAirQualityRequirement({
    now: new Date("2026-08-15T16:23:00.000Z"),
    airQualityStatus: "unavailable",
    airQualityError: "AirKorea unavailable after retry policy: HTTP 504",
  }), { satisfied: false, status: "required" });
  assert.deepEqual(weatherDiagnosticAirQualityRequirement({
    now: new Date("2026-08-16T02:23:00.000Z"),
    airQualityStatus: "ok",
  }), { satisfied: true, status: "ok" });
});
