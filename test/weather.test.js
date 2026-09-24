import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateKmaApparentTemperature,
  currentWeatherEmoji,
  extractKmaWarnings,
  formatCurrentWeatherCondition,
  formatWeatherAlert,
  getWeatherAlert,
  parseAirKoreaDustWarnings,
  parseKmaUvForMeal,
  parseKmaPrecipitation,
  parseKmaSnowfall,
  rainPeriodsForDate,
  toKmaGrid,
  uvRiskLabel
} from "../src/weather.js";
import { config } from "../src/config.js";

const NOW = new Date("2026-07-13T03:00:00.000Z");

function kmaResponse(items, resultCode = "00", resultMsg = "NORMAL_SERVICE") {
  return {
    response: {
      header: { resultCode, resultMsg },
      body: { items: { item: items } }
    }
  };
}

function kmaWarningResponse(text = "o 폭염경보 : 전북자치도(전주, 완주)") {
  return kmaResponse([{ t6: text, t7: "o 없음", tmFc: 202607131100 }]);
}

function kmaUvResponse({
  areaNo = "5211357000",
  date = "2026071300",
  h12 = "7",
  h18 = "2"
} = {}) {
  return kmaResponse([{ code: "A07_2", areaNo, date, h12, h18 }]);
}

function airKoreaWarningResponse(items = []) {
  return {
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL_CODE" },
      body: { items, totalCount: items.length, pageNo: 1, numOfRows: 1000 }
    }
  };
}

function observationItems({
  temperature = "28.4",
  precipitationType = "0",
  rain = "0",
  humidity = "70",
  windSpeed = "1.5"
} = {}) {
  return [
    { category: "T1H", obsrValue: temperature },
    { category: "PTY", obsrValue: precipitationType },
    { category: "RN1", obsrValue: rain },
    { category: "REH", obsrValue: humidity },
    { category: "WSD", obsrValue: windSpeed }
  ];
}

function addForecast(items, date, time, values) {
  for (const [category, fcstValue] of Object.entries(values)) {
    items.push({ category, fcstDate: date, fcstTime: time, fcstValue: String(fcstValue) });
  }
}

function defaultUltraItems() {
  const items = [];
  addForecast(items, "20260713", "1200", {
    T1H: 28.4,
    POP: 20,
    SKY: 1,
    PTY: 0,
    RN1: "강수없음",
    LGT: 0
  });
  addForecast(items, "20260713", "1300", {
    T1H: 29,
    POP: 85,
    SKY: 4,
    PTY: 1,
    RN1: "1.5mm",
    LGT: 0
  });
  addForecast(items, "20260713", "1400", {
    T1H: 29.2,
    POP: 40,
    SKY: 3,
    PTY: 0,
    RN1: "강수없음",
    LGT: 0
  });
  return items;
}

function defaultVillageItems() {
  const items = [];
  addForecast(items, "20260713", "0600", { TMN: 23 });
  addForecast(items, "20260713", "1200", {
    TMP: 28.4, POP: 20, SKY: 1, PTY: 0, PCP: "강수없음", SNO: "적설없음"
  });
  addForecast(items, "20260713", "1300", {
    TMP: 29, POP: 80, SKY: 4, PTY: 1, PCP: "1.5mm", SNO: "적설없음"
  });
  addForecast(items, "20260713", "1400", {
    TMP: 29.2, POP: 40, SKY: 3, PTY: 0, PCP: "강수없음", SNO: "적설없음"
  });
  addForecast(items, "20260713", "1500", { TMX: 31 });
  addForecast(items, "20260714", "0700", {
    TMP: 25, POP: 90, SKY: 4, PTY: 1, PCP: "14mm", SNO: "적설없음"
  });
  addForecast(items, "20260714", "0800", {
    TMP: 26, POP: 40, SKY: 3, PTY: 0, PCP: "강수없음", SNO: "적설없음"
  });
  return items;
}

function successfulFetch({
  observation = observationItems(),
  ultra = defaultUltraItems(),
  village = defaultVillageItems(),
  air = {
    response: {
      body: {
        items: [{ dataTime: "2026-07-13 12:00", pm10Value: "91", pm25Value: "44" }]
      }
    }
  },
  warning = kmaWarningResponse(),
  uv = kmaUvResponse(),
  airWarnings = airKoreaWarningResponse(),
  villageByBaseTime = {}
} = {}) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("getUltraSrtNcst")) {
      return { ok: true, json: async () => kmaResponse(observation) };
    }
    if (url.includes("getUltraSrtFcst")) {
      return { ok: true, json: async () => kmaResponse(ultra) };
    }
    if (url.includes("getVilageFcst")) {
      const baseTime = new URL(url).searchParams.get("base_time");
      return { ok: true, json: async () => kmaResponse(villageByBaseTime[baseTime] || village) };
    }
    if (url.includes("getPwnStatus")) return { ok: true, json: async () => warning };
    if (url.includes("getUVIdxV5")) return { ok: true, json: async () => uv };
    if (url.includes("getUlfptcaAlarmInfo")) {
      return { ok: true, json: async () => airWarnings };
    }
    if (url.includes("getMsrstnAcctoRltmMesureDnsty")) {
      return { ok: true, json: async () => air };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { calls, fetchImpl };
}

async function withWeatherConfig(callback, overrides = {}) {
  const previous = {
    weatherEnabled: config.weatherEnabled,
    publicDataServiceKey: config.publicDataServiceKey,
    airKoreaStationName: config.airKoreaStationName
  };
  Object.assign(config, {
    weatherEnabled: true,
    publicDataServiceKey: "test%2Bservice%3D",
    airKoreaStationName: "노송동",
    ...overrides
  });
  try {
    return await callback();
  } finally {
    Object.assign(config, previous);
  }
}

test("weather alert uses only fields supplied by the KMA and AirKorea contract", () => {
  assert.equal(formatWeatherAlert({
    currentTemperature: 31.2,
    currentApparentTemperature: 34.6,
    currentHumidity: 87,
    currentCondition: "rain",
    todayMinTemperature: 24.2,
    todayMaxTemperature: 33.8,
    warnings: ["폭염경보", "열대야주의보"],
    currentPrecipitationMm: 1.2,
    currentRainUntil: "2026-07-13T14:00",
    todayRainProbability: 70,
    todayRainMm: 2.4,
    todayRainPeriods: [{ startAt: "2026-07-13T12:00", endAt: "2026-07-13T14:00" }],
    tomorrowRainProbability: 80,
    tomorrowPrecipitationMm: 12.4,
    uvIndex: 7,
    pm10: 90,
    pm25: 40
  }), "🌡️ 현재 31.2° (체감 34.6°) · 💧 습도 높음 (87%) · 🌧️ 비 · 최고 33.8° · 최저 24.2° | 🌧️ 지금 비 1.2mm · 14:00까지 예보 · 우산 챙기세요 | ☔ 오늘 비 예보 70% · 예상 2.4mm · 12:00~14:00 | ☔ 내일 비 예보 80% · 예상 12.4mm | 🚨 폭염경보 | ⚠️ 열대야주의보 | 😎 자외선 높음 (7) | 😷 미세먼지 높음 (90㎍/㎥) | 😷 초미세먼지 높음 (40㎍/㎥)");
  assert.equal(formatWeatherAlert({ todayRainProbability: 10, pm10: 20, pm25: 10 }), "");
  assert.equal(formatWeatherAlert({ pm10: 80, pm25: 35 }), "");
  assert.equal(
    formatWeatherAlert({ pm10: 81, pm25: 36 }),
    "😷 미세먼지 높음 (81㎍/㎥) | 😷 초미세먼지 높음 (36㎍/㎥)"
  );
});

test("special precipitation keeps thunderstorm, snow, and rain-snow labels and emojis", () => {
  assert.equal(formatWeatherAlert({
    currentCondition: "thunderstorm",
    currentPrecipitationMm: 1.1,
    todayRainProbability: 80,
    todayRainMm: 3.4,
    todaySnowfallCm: 1.8,
    todayRainCondition: "snow",
    tomorrowRainProbability: 70,
    tomorrowPrecipitationMm: 5.2,
    tomorrowRainCondition: "rain-snow"
  }), "⛈️ 뇌우 | ⛈️ 지금 뇌우 1.1mm · 우산 챙기세요 | ❄️ 오늘 눈 예보 80% · 예상 3.4mm · 예상 적설 1.8cm | 🌨️ 내일 비/눈 예보 70% · 예상 5.2mm");
});

test("apparent temperature follows the official KMA seasonal formulas and winter validity limits", () => {
  assert.equal(calculateKmaApparentTemperature({
    temperatureC: 28.4,
    relativeHumidityPercent: 70,
    windSpeedMps: 1.5,
    month: 7
  }), 29.7);
  assert.equal(calculateKmaApparentTemperature({
    temperatureC: -5,
    relativeHumidityPercent: 50,
    windSpeedMps: 3,
    month: 1
  }), -9.5);
  assert.equal(calculateKmaApparentTemperature({
    temperatureC: 12,
    relativeHumidityPercent: 50,
    windSpeedMps: 5,
    month: 1
  }), 12);
  assert.equal(calculateKmaApparentTemperature({
    temperatureC: -5,
    relativeHumidityPercent: 50,
    windSpeedMps: 1.2,
    month: 1
  }), -5);
  assert.equal(calculateKmaApparentTemperature({
    temperatureC: 30,
    relativeHumidityPercent: 101,
    windSpeedMps: 1,
    month: 7
  }), null);
});

test("UV warnings use official severity labels and include the numeric index", () => {
  assert.equal(formatWeatherAlert({ uvIndex: 5 }), "");
  assert.equal(formatWeatherAlert({ uvIndex: 6 }), "😎 자외선 높음 (6)");
  assert.equal(formatWeatherAlert({ uvIndex: 10 }), "😎 자외선 매우 높음 (10)");
  assert.equal(formatWeatherAlert({ uvIndex: 11 }), "😎 자외선 위험 (11)");
  assert.equal(uvRiskLabel(2), "낮음");
  assert.equal(uvRiskLabel(4), "보통");
  assert.equal(uvRiskLabel(7), "높음");
  assert.equal(uvRiskLabel(9), "매우 높음");
  assert.equal(uvRiskLabel(12), "위험");
});

test("KMA UV data is selected for the requested JBNU meal window", () => {
  const item = {
    areaNo: "5211357000",
    date: "2026071300",
    h9: "6",
    h12: "10",
    h15: "7",
    h18: "2"
  };
  assert.deepEqual(parseKmaUvForMeal(item, "점심", NOW), {
    uvIndex: 10,
    dataTime: "2026071300"
  });
  assert.deepEqual(parseKmaUvForMeal(item, "저녁", NOW), {
    uvIndex: 2,
    dataTime: "2026071300"
  });
});

test("AirKorea warning parser keeps only active Jeonbuk central-zone alerts", () => {
  const data = airKoreaWarningResponse([
    {
      districtName: "전북",
      moveName: "중부권역",
      itemCode: "PM10",
      issueGbn: "주의보",
      clearDate: "",
      clearTime: ""
    },
    {
      districtName: "전북",
      moveName: "중부권역",
      itemCode: "PM25",
      issueGbn: "경보",
      clearDate: "",
      clearTime: ""
    },
    {
      districtName: "전북",
      moveName: "중부권역",
      itemCode: "PM10",
      issueGbn: "주의보",
      clearDate: "2026-07-13",
      clearTime: "10:00"
    },
    {
      districtName: "전북",
      moveName: "서부권역",
      itemCode: "PM10",
      issueGbn: "경보",
      clearDate: "",
      clearTime: ""
    }
  ]);
  assert.deepEqual(parseAirKoreaDustWarnings(data), ["미세먼지 주의보", "초미세먼지 경보"]);
  assert.equal(
    formatWeatherAlert({
      airQualityWarnings: parseAirKoreaDustWarnings(data),
      uvIndex: 7,
      pm10: 200,
      pm25: 100
    }),
    "😎 자외선 높음 (7) | ⚠️ 미세먼지 주의보 | 🚨 초미세먼지 경보 | 😷 미세먼지 높음 (200㎍/㎥) | 😷 초미세먼지 높음 (100㎍/㎥)"
  );
});

test("official Korean APIs merge forecasts, warnings, UV, and AirKorea data", async () => {
  await withWeatherConfig(async () => {
    const { calls, fetchImpl } = successfulFetch();
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });

    assert.equal(result.provider, "KMA+AirKorea");
    assert.equal(result.currentTemperature, 28.4);
    assert.equal(result.currentApparentTemperature, 29.7);
    assert.equal(result.currentHumidity, 70);
    assert.equal(result.currentWindSpeedMps, 1.5);
    assert.equal(result.currentCondition, "clear");
    assert.equal(result.headerEmoji, "☀️");
    assert.equal(result.todayMinTemperature, 23);
    assert.equal(result.todayMaxTemperature, 31);
    assert.equal(result.rainProbability, 85);
    assert.equal(result.mealPrecipitationMm, 1.5);
    assert.equal(result.todayRainProbability, 85);
    assert.equal(result.todayRainMm, 1.5);
    assert.deepEqual(result.todayRainPeriods.map(({ startAt, endAt }) => ({ startAt, endAt })), [
      { startAt: "2026-07-13T12:00", endAt: "2026-07-13T13:00" }
    ]);
    assert.equal(result.tomorrowRainProbability, 90);
    assert.equal(result.tomorrowPrecipitationMm, 14);
    assert.equal(result.pm10, 91);
    assert.equal(result.pm25, 44);
    assert.equal(result.airQualityStatus, "ok");
    assert.deepEqual(result.warnings, ["폭염경보"]);
    assert.equal(result.warningStatus, "ok");
    assert.equal(result.uvIndex, 7);
    assert.equal(result.uvStatus, "ok");
    assert.deepEqual(result.airQualityWarnings, []);
    assert.equal(result.airQualityWarningStatus, "ok");
    assert.match(result.text, /현재 28\.4° \(체감 29\.7°\)/u);
    assert.match(result.text, /자외선 높음 \(7\)/u);
    assert.match(result.text, /미세먼지 높음 \(91㎍\/㎥\)/u);
    assert.match(result.text, /초미세먼지 높음 \(44㎍\/㎥\)/u);
    assert.equal(result.text, result.alertText);
    assert.doesNotMatch(result.text, /(?:자료|출처)\s*:/u);
    assert.doesNotMatch(result.text, /Open-Meteo|open-meteo/u);
    assert.equal(calls.some((url) => url.includes("weather.go.kr")), false);

    const observationUrl = new URL(calls.find((url) => url.includes("getUltraSrtNcst")));
    assert.equal(observationUrl.searchParams.get("base_date"), "20260713");
    assert.equal(observationUrl.searchParams.get("base_time"), "1100");
    assert.equal(observationUrl.searchParams.get("nx"), "63");
    assert.equal(observationUrl.searchParams.get("ny"), "89");
    assert.equal(observationUrl.searchParams.get("serviceKey"), "test+service=");
    const ultraUrl = new URL(calls.find((url) => url.includes("getUltraSrtFcst")));
    assert.equal(ultraUrl.searchParams.get("base_time"), "1130");
    const villageUrl = new URL(calls.find((url) => url.includes("getVilageFcst")));
    assert.equal(villageUrl.searchParams.get("base_time"), "1100");
    const airUrl = new URL(calls.find((url) => url.includes("getMsrstnAcctoRltmMesureDnsty")));
    assert.equal(airUrl.searchParams.get("stationName"), "노송동");
    const warningUrl = new URL(calls.find((url) => url.includes("getPwnStatus")));
    assert.equal(warningUrl.hostname, "apis.data.go.kr");
    const uvUrl = new URL(calls.find((url) => url.includes("getUVIdxV5")));
    assert.equal(uvUrl.searchParams.get("areaNo"), "5211357000");
    assert.equal(uvUrl.searchParams.get("time"), "2026071309");
    const airWarningUrl = new URL(calls.find((url) => url.includes("getUlfptcaAlarmInfo")));
    assert.equal(airWarningUrl.searchParams.get("year"), "2026");
  });
});

test("official weather responses are bounded before JSON parsing", async () => {
  await withWeatherConfig(async () => {
    let observationCalls = 0;
    const { fetchImpl: fallback } = successfulFetch();
    const fetchImpl = async (input, options) => {
      if (String(input).includes("getUltraSrtNcst")) {
        observationCalls += 1;
        return new Response("{}", {
          status: 200,
          headers: { "content-length": "4000001" }
        });
      }
      return fallback(input, options);
    };
    await assert.rejects(
      getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl }),
      /KMA 초단기실황 unavailable at .*Public weather API response is too large/u
    );
    assert.equal(observationCalls, 1);
  });
});

test("a village forecast without next-day precipitation coverage is rejected", async () => {
  await withWeatherConfig(async () => {
    const village = defaultVillageItems().filter((item) => item.fcstDate !== "20260714");
    const { calls, fetchImpl } = successfulFetch({ village });
    await assert.rejects(
      getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl }),
      /KMA 단기예보 unavailable across 3 recent official base times.*response is incomplete/u
    );
    assert.equal(calls.filter((url) => url.includes("getVilageFcst")).length, 3);
  });
});

test("official ultra-short lightning density upgrades observed precipitation to a thunderstorm", async () => {
  await withWeatherConfig(async () => {
    const ultra = defaultUltraItems().map((item) => (
      item.category === "LGT" && item.fcstTime === "1200"
        ? { ...item, fcstValue: "2.5" }
        : item
    ));
    const { fetchImpl } = successfulFetch({
      observation: observationItems({ precipitationType: "1", rain: "0.8mm" }),
      ultra
    });
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
    assert.equal(result.currentCondition, "thunderstorm");
    assert.equal(result.headerEmoji, "⛈️");
    assert.match(result.text, /⛈️ 뇌우/u);
    assert.match(result.text, /⛈️ 지금 뇌우 0\.8mm/u);
  });
});

test("every official KMA sky and precipitation type has a deterministic condition and emoji", async () => {
  await withWeatherConfig(async () => {
    const precipitationCases = [
      [1, "rain", "🌧️"],
      [2, "rain-snow", "🌨️"],
      [3, "snow", "❄️"],
      [4, "shower", "🌦️"],
      [5, "raindrop", "🌦️"],
      [6, "raindrop-snow", "🌨️"],
      [7, "snow-flurry", "🌨️"]
    ];
    for (const [precipitationType, condition, emoji] of precipitationCases) {
      const { fetchImpl } = successfulFetch({
        observation: observationItems({
          precipitationType: String(precipitationType),
          rain: precipitationType === 3 ? "0.4mm" : "0.2mm"
        })
      });
      const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
      assert.equal(result.currentCondition, condition);
      assert.equal(result.headerEmoji, emoji);
    }

    const skyCases = [
      [1, "clear", "☀️"],
      [3, "mostly-cloudy", "⛅"],
      [4, "overcast", "☁️"]
    ];
    for (const [skyCode, condition, emoji] of skyCases) {
      const ultra = defaultUltraItems().map((item) => (
        item.category === "SKY" && item.fcstTime === "1200"
          ? { ...item, fcstValue: String(skyCode) }
          : item
      ));
      const { fetchImpl } = successfulFetch({ ultra });
      const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
      assert.equal(result.currentCondition, condition);
      assert.equal(result.headerEmoji, emoji);
    }
  });
});

test("tomorrow precipitation keeps the KMA snow phase, probability, amount, and period", async () => {
  await withWeatherConfig(async () => {
    const village = defaultVillageItems().map((item) => {
      if (item.fcstDate !== "20260714" || item.fcstTime !== "0700") return item;
      if (item.category === "PTY") return { ...item, fcstValue: "3" };
      if (item.category === "PCP") return { ...item, fcstValue: "2.2mm" };
      if (item.category === "SNO") return { ...item, fcstValue: "1.6cm" };
      return item;
    });
    const { fetchImpl } = successfulFetch({ village });
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
    assert.equal(result.tomorrowRainCondition, "snow");
    assert.equal(result.tomorrowRainProbability, 90);
    assert.equal(result.tomorrowPrecipitationMm, 2.2);
    assert.equal(result.tomorrowSnowfallCm, 1.6);
    assert.match(
      result.text,
      /❄️ 내일 눈 예보 90% · 예상 2\.2mm · 예상 적설 1\.6cm · 06:00~07:00/u
    );
  });
});

test("an 11:25 lunch supplements the missing current-day minimum from the official 02:00 village forecast", async () => {
  await withWeatherConfig(async () => {
    const latestVillage = [];
    addForecast(latestVillage, "20260729", "1200", {
      TMP: 34, POP: 10, SKY: 1, PTY: 0, PCP: "강수없음", SNO: "적설없음"
    });
    addForecast(latestVillage, "20260729", "1500", {
      TMP: 35, TMX: 35, POP: 10, SKY: 1, PTY: 0, PCP: "강수없음", SNO: "적설없음"
    });
    addForecast(latestVillage, "20260730", "0700", {
      TMP: 27, POP: 10, SKY: 1, PTY: 0, PCP: "강수없음", SNO: "적설없음"
    });
    const morningVillage = [];
    addForecast(morningVillage, "20260729", "0600", { TMN: 26 });
    addForecast(morningVillage, "20260729", "1500", { TMX: 35 });
    const ultra = [];
    addForecast(ultra, "20260729", "1200", {
      T1H: 34,
      POP: 10,
      SKY: 1,
      PTY: 0,
      RN1: "강수없음",
      LGT: 0
    });
    const { calls, fetchImpl } = successfulFetch({
      observation: observationItems({ temperature: "33.5", humidity: "58", windSpeed: "1.8" }),
      ultra,
      village: latestVillage,
      villageByBaseTime: { "0200": morningVillage },
      air: { response: { body: { items: [{ dataTime: "2026-07-29 11:00", pm10Value: "20", pm25Value: "10" }] } } },
      warning: kmaWarningResponse("o 없음")
    });
    const result = await getWeatherAlert({
      mealType: "점심",
      now: new Date("2026-07-29T02:25:00.000Z"),
      fetchImpl
    });
    assert.equal(result.todayMaxTemperature, 35);
    assert.equal(result.todayMinTemperature, 26);
    assert.equal(result.temperatureRangeBaseDate, "20260729");
    assert.equal(result.temperatureRangeBaseTime, "0200");
    assert.match(result.text, /최고 35° · 최저 26°/u);
    const villageBaseTimes = calls
      .filter((url) => url.includes("getVilageFcst"))
      .map((url) => new URL(url).searchParams.get("base_time"));
    assert.deepEqual(villageBaseTimes, ["1100", "0200"]);
  });
});

test("current conditions use the freshest available observation without borrowing forecast rain", async () => {
  await withWeatherConfig(async () => {
    const { calls, fetchImpl } = successfulFetch();
    const result = await getWeatherAlert({
      mealType: "점심",
      now: new Date("2026-07-13T03:39:00.000Z"),
      fetchImpl
    });
    const observationUrl = new URL(calls.find((url) => url.includes("getUltraSrtNcst")));
    assert.equal(observationUrl.searchParams.get("base_time"), "1200");
    assert.equal(result.currentCondition, "overcast");
    assert.doesNotMatch(result.alertText, /지금 비/u);
  });
});

test("current KMA rain includes the observation and the forecast end time", async () => {
  await withWeatherConfig(async () => {
    const ultra = [];
    addForecast(ultra, "20260714", "1400", {
      T1H: 27,
      POP: 80,
      SKY: 4,
      PTY: 1,
      RN1: "0.4mm",
      LGT: 0
    });
    addForecast(ultra, "20260714", "1500", {
      T1H: 27,
      POP: 70,
      SKY: 4,
      PTY: 1,
      RN1: "0.3mm",
      LGT: 0
    });
    addForecast(ultra, "20260714", "1600", {
      T1H: 27,
      POP: 10,
      SKY: 3,
      PTY: 0,
      RN1: "강수없음",
      LGT: 0
    });
    const village = [];
    addForecast(village, "20260714", "0600", { TMN: 23 });
    addForecast(village, "20260714", "1400", {
      TMP: 27, POP: 80, SKY: 4, PTY: 1, PCP: "0.4mm", SNO: "적설없음"
    });
    addForecast(village, "20260714", "1500", {
      TMP: 27,
      POP: 70,
      SKY: 4,
      PTY: 1,
      PCP: "0.3mm",
      SNO: "적설없음",
      TMX: 31
    });
    addForecast(village, "20260714", "1600", {
      TMP: 27, POP: 10, SKY: 3, PTY: 0, PCP: "강수없음", SNO: "적설없음"
    });
    addForecast(village, "20260715", "0700", {
      TMP: 24, POP: 10, SKY: 1, PTY: 0, PCP: "강수없음", SNO: "적설없음"
    });
    const { fetchImpl } = successfulFetch({
      observation: observationItems({ temperature: "27", precipitationType: "1", rain: "0.8mm" }),
      ultra,
      village,
      air: { response: { body: { items: [{ dataTime: "2026-07-14 13:00", pm10Value: "20", pm25Value: "10" }] } } },
      warning: kmaWarningResponse("o 없음")
    });
    const result = await getWeatherAlert({
      mealType: "점심",
      now: new Date("2026-07-14T04:30:00.000Z"),
      fetchImpl
    });
    assert.equal(result.currentPrecipitationMm, 0.8);
    assert.equal(result.currentRainUntil, "2026-07-14T15:00");
    assert.equal(result.todayRainMm, 0.7);
    assert.match(result.text, /지금 비 0\.8mm · 15:00까지 예보/u);
  });
});

test("past rain and midnight preceding-hour values are excluded", () => {
  const hourly = {
    time: ["2026-07-15T00:00", "2026-07-15T01:00", "2026-07-15T02:00"],
    precipitation_probability: [90, 80, 0],
    precipitation: [0.5, 0.4, 0],
    precipitation_known: [true, true, true],
    rainy: [true, true, false]
  };
  assert.deepEqual(rainPeriodsForDate(hourly, "2026-07-15"), [
    { startAt: "2026-07-15T00:00", endAt: "2026-07-15T01:00", amountMm: 0.4 }
  ]);
  assert.deepEqual(rainPeriodsForDate(hourly, "2026-07-15", {
    afterMinute: Date.UTC(2026, 6, 15, 1, 30) / 60000
  }), []);
});

test("KMA precipitation bands remain rainy without inventing a numeric total", () => {
  assert.deepEqual(parseKmaPrecipitation("강수없음"), { amountMm: 0, amountKnown: true, rainy: false });
  assert.deepEqual(parseKmaPrecipitation("-"), { amountMm: 0, amountKnown: true, rainy: false });
  assert.deepEqual(parseKmaPrecipitation(null), { amountMm: 0, amountKnown: true, rainy: false });
  assert.deepEqual(parseKmaPrecipitation("0.7mm"), { amountMm: 0.7, amountKnown: true, rainy: true });
  assert.deepEqual(parseKmaPrecipitation("1.0mm 미만"), { amountMm: null, amountKnown: false, rainy: true });
  assert.deepEqual(parseKmaPrecipitation("30.0~50.0mm"), { amountMm: null, amountKnown: false, rainy: true });
  assert.deepEqual(parseKmaPrecipitation("50.0mm 이상"), { amountMm: null, amountKnown: false, rainy: true });
  assert.deepEqual(parseKmaPrecipitation("-1mm"), { amountMm: null, amountKnown: false, rainy: false });
});

test("KMA snowfall bands preserve known accumulation and never invent a ranged total", () => {
  assert.deepEqual(parseKmaSnowfall("적설없음"), { amountCm: 0, amountKnown: true, snowy: false });
  assert.deepEqual(parseKmaSnowfall("-"), { amountCm: 0, amountKnown: true, snowy: false });
  assert.deepEqual(parseKmaSnowfall(null), { amountCm: 0, amountKnown: true, snowy: false });
  assert.deepEqual(parseKmaSnowfall("2.4cm"), { amountCm: 2.4, amountKnown: true, snowy: true });
  assert.deepEqual(parseKmaSnowfall("0.5cm 미만"), { amountCm: null, amountKnown: false, snowy: true });
  assert.deepEqual(parseKmaSnowfall("5.0cm 이상"), { amountCm: null, amountKnown: false, snowy: true });
  assert.deepEqual(parseKmaSnowfall("-1cm"), { amountCm: null, amountKnown: false, snowy: false });
});

test("stale AirKorea data is reported unavailable without masking valid KMA weather", async () => {
  await withWeatherConfig(async () => {
    const { fetchImpl } = successfulFetch({
      air: {
        response: {
          body: {
            items: [{ dataTime: "2026-07-13 07:00", pm10Value: "91", pm25Value: "44" }]
          }
        }
      }
    });
    const result = await getWeatherAlert({ now: NOW, fetchImpl });
    assert.equal(result.airQualityStatus, "unavailable");
    assert.equal(result.pm10, null);
    assert.match(result.airQualityError, /stale or invalid/u);
    assert.equal(result.kmaObservationStatus, "ok");
  });
});

test("AirKorea maintenance flags suppress only the affected particle measurement", async () => {
  await withWeatherConfig(async () => {
    const { fetchImpl } = successfulFetch({
      air: {
        response: {
          body: {
            items: [{
              dataTime: "2026-07-13 12:00",
              pm10Value: "191",
              pm10Flag: "점검및교정",
              pm25Value: "44",
              pm25Flag: ""
            }]
          }
        }
      }
    });
    const result = await getWeatherAlert({ now: NOW, fetchImpl });
    assert.equal(result.airQualityStatus, "ok");
    assert.equal(result.pm10, null);
    assert.equal(result.pm25, 44);
    assert.doesNotMatch(result.text, /미세먼지 높음 \(191/u);
    assert.match(result.text, /초미세먼지 높음 \(44/u);
  });
});

test("AirKorea data is unavailable when both particle measurements are flagged", async () => {
  await withWeatherConfig(async () => {
    const { fetchImpl } = successfulFetch({
      air: {
        response: {
          body: {
            items: [{
              dataTime: "2026-07-13 12:00",
              pm10Value: "191",
              pm10Flag: "장비점검",
              pm25Value: "88",
              pm25Flag: "통신장애"
            }]
          }
        }
      }
    });
    const result = await getWeatherAlert({ now: NOW, fetchImpl });
    assert.equal(result.airQualityStatus, "unavailable");
    assert.equal(result.pm10, null);
    assert.equal(result.pm25, null);
    assert.match(result.airQualityError, /no PM10\/PM2\.5 values/u);
  });
});

test("AirKorea measurement and warning APIs recover after four transient gateway failures", async () => {
  await withWeatherConfig(async () => {
    let measurementCalls = 0;
    let warningCalls = 0;
    const { fetchImpl: fallback } = successfulFetch();
    const fetchImpl = async (input, options) => {
      const url = String(input);
      if (url.includes("getMsrstnAcctoRltmMesureDnsty")) {
        measurementCalls += 1;
        if (measurementCalls <= 4) return { ok: false, status: 504 };
      }
      if (url.includes("getUlfptcaAlarmInfo")) {
        warningCalls += 1;
        if (warningCalls <= 4) return { ok: false, status: 504 };
      }
      return fallback(input, options);
    };
    const result = await getWeatherAlert({ now: NOW, fetchImpl });
    assert.equal(result.airQualityStatus, "ok");
    assert.equal(result.airQualityWarningStatus, "ok");
    assert.equal(measurementCalls, 5);
    assert.equal(warningCalls, 5);
  });
});

test("AirKorea deterministic invalid payloads fail without pointless retry delay", async () => {
  await withWeatherConfig(async () => {
    let measurementCalls = 0;
    const { fetchImpl: fallback } = successfulFetch();
    const fetchImpl = async (input, options) => {
      if (String(input).includes("getMsrstnAcctoRltmMesureDnsty")) {
        measurementCalls += 1;
        return {
          ok: true,
          json: async () => ({ response: { body: { items: [] } } }),
        };
      }
      return fallback(input, options);
    };
    const result = await getWeatherAlert({ now: NOW, fetchImpl });
    assert.equal(result.airQualityStatus, "unavailable");
    assert.equal(measurementCalls, 1);
    assert.match(result.airQualityError, /no station measurement/u);
  });
});

test("missing credentials or the wrong station fail before any network request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };
  await withWeatherConfig(async () => {
    await assert.rejects(getWeatherAlert({ now: NOW, fetchImpl }), /PUBLIC_DATA_SERVICE_KEY is required/u);
  }, { publicDataServiceKey: "" });
  await withWeatherConfig(async () => {
    await assert.rejects(getWeatherAlert({ now: NOW, fetchImpl }), /AIRKOREA_STATION_NAME must be 노송동/u);
  }, { airKoreaStationName: "송천동" });
  assert.equal(calls, 0);
});

test("a publication gap falls back only to bounded recent official KMA base times", async () => {
  await withWeatherConfig(async () => {
    const calls = [];
    const { fetchImpl: fallback } = successfulFetch();
    const unavailableBaseByOperation = new Map([
      ["getUltraSrtNcst", "1100"],
      ["getUltraSrtFcst", "1130"],
      ["getVilageFcst", "1100"]
    ]);
    const fetchImpl = async (input, options) => {
      const url = String(input);
      const operation = [...unavailableBaseByOperation.keys()]
        .find((candidate) => url.includes(candidate));
      if (operation) {
        calls.push(url);
        if (new URL(url).searchParams.get("base_time") === unavailableBaseByOperation.get(operation)) {
          return { ok: true, json: async () => kmaResponse([], "03", "NO_DATA") };
        }
      }
      return fallback(input, options);
    };

    const result = await getWeatherAlert({ now: NOW, fetchImpl });
    assert.equal(result.kmaObservationBaseTime, "1000");
    assert.equal(result.kmaUltraShortBaseTime, "1030");
    assert.equal(result.kmaVillageBaseTime, "0800");
    assert.equal(calls.filter((url) => url.includes("getUltraSrtNcst")).length, 2);
    assert.equal(calls.filter((url) => url.includes("getUltraSrtFcst")).length, 2);
    assert.equal(calls.filter((url) => url.includes("getVilageFcst")).length, 2);
  });
});

test("an incomplete required KMA response checks bounded recent official bases and is rejected", async () => {
  await withWeatherConfig(async () => {
    let observationCalls = 0;
    const { fetchImpl: fallback } = successfulFetch();
    const fetchImpl = async (input, options) => {
      if (String(input).includes("getUltraSrtNcst")) {
        observationCalls += 1;
        return { ok: true, json: async () => kmaResponse([{ category: "PTY", obsrValue: "0" }]) };
      }
      return fallback(input, options);
    };
    await assert.rejects(
      getWeatherAlert({ now: NOW, fetchImpl }),
      /KMA 초단기실황 unavailable across 3 recent official base times.*response is incomplete/u
    );
    assert.equal(observationCalls, 3);
  });
});

test("an ultra-short forecast without official lightning density is rejected", async () => {
  await withWeatherConfig(async () => {
    const ultraWithoutLightning = defaultUltraItems().filter((item) => item.category !== "LGT");
    const { calls, fetchImpl } = successfulFetch({ ultra: ultraWithoutLightning });
    await assert.rejects(
      getWeatherAlert({ now: NOW, fetchImpl }),
      /KMA 초단기예보 unavailable across 7 recent official base times.*response is incomplete/u
    );
    assert.equal(calls.filter((url) => url.includes("getUltraSrtFcst")).length, 7);
  });
});

test("a village forecast without the official SNO field is retried and rejected", async () => {
  await withWeatherConfig(async () => {
    const villageWithoutSnowfall = defaultVillageItems()
      .filter((item) => item.category !== "SNO");
    const { calls, fetchImpl } = successfulFetch({ village: villageWithoutSnowfall });
    await assert.rejects(
      getWeatherAlert({ now: NOW, fetchImpl }),
      /KMA 단기예보 unavailable across 3 recent official base times.*response is incomplete/u
    );
    assert.equal(calls.filter((url) => url.includes("getVilageFcst")).length, 3);
  });
});

test("humidity and wind are required so every displayed current temperature has an apparent temperature", async () => {
  await withWeatherConfig(async () => {
    let observationCalls = 0;
    const { fetchImpl: fallback } = successfulFetch();
    const incomplete = observationItems().filter((item) => item.category !== "WSD");
    const fetchImpl = async (input, options) => {
      if (String(input).includes("getUltraSrtNcst")) {
        observationCalls += 1;
        return { ok: true, json: async () => kmaResponse(incomplete) };
      }
      return fallback(input, options);
    };
    await assert.rejects(
      getWeatherAlert({ now: NOW, fetchImpl }),
      /KMA 초단기실황 unavailable across 3 recent official base times.*response is incomplete/u
    );
    assert.equal(observationCalls, 3);
  });
});

test("a KMA API error code cannot be masked by optional AirKorea or warning success", async () => {
  await withWeatherConfig(async () => {
    let villageCalls = 0;
    const { fetchImpl: fallback } = successfulFetch();
    const fetchImpl = async (input, options) => {
      if (String(input).includes("getVilageFcst")) {
        villageCalls += 1;
        return { ok: true, json: async () => kmaResponse([], "03", "NO_DATA") };
      }
      return fallback(input, options);
    };
    await assert.rejects(
      getWeatherAlert({ now: NOW, fetchImpl }),
      /KMA 단기예보 unavailable across 3 recent official base times.*KMA API 03: NO_DATA/u
    );
    assert.equal(villageCalls, 3);
  });
});

test("a failed KMA warning lookup is distinguishable from a valid empty warning list", async () => {
  await withWeatherConfig(async () => {
    const { fetchImpl: fallback } = successfulFetch();
    const fetchImpl = async (input, options) => {
      if (String(input).includes("getPwnStatus")) throw new Error("warning source down");
      return fallback(input, options);
    };
    const result = await getWeatherAlert({ now: NOW, fetchImpl });
    assert.equal(result.warningStatus, "unavailable");
    assert.deepEqual(result.warnings, []);
    assert.match(result.warningError, /warning source down/u);
    assert.match(result.text, /현재 28\.4°/u);
  });
});

test("UV and regional dust-warning outages stay explicit without masking required forecasts", async () => {
  await withWeatherConfig(async () => {
    let uvCalls = 0;
    let dustWarningCalls = 0;
    const { fetchImpl: fallback } = successfulFetch();
    const fetchImpl = async (input, options) => {
      const url = String(input);
      if (url.includes("getUVIdxV5")) {
        uvCalls += 1;
        throw new Error("UV source down");
      }
      if (url.includes("getUlfptcaAlarmInfo")) {
        dustWarningCalls += 1;
        throw new Error("dust warning source down");
      }
      return fallback(input, options);
    };
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
    assert.equal(result.currentTemperature, 28.4);
    assert.equal(result.uvStatus, "unavailable");
    assert.match(result.uvError, /UV source down/u);
    assert.equal(result.airQualityWarningStatus, "unavailable");
    assert.match(result.airQualityWarningError, /dust warning source down/u);
    assert.equal(uvCalls, 4);
    assert.equal(dustWarningCalls, 1);
    assert.doesNotMatch(result.alertText, /자외선/u);
  });
});

test("KMA warning parser keeps only warnings that apply to Jeonju", () => {
  const html = `
    <p>o 폭염중대경보·호우주의보 : 전북자치도(전주, 완주)<br>
    o 강풍주의보 : 전라남도(여수)<br>
    o 열대야주의보 : 전북특별자치도(익산, 전주, 군산)</p>`;
  assert.deepEqual(
    extractKmaWarnings(html),
    ["폭염중대경보", "호우주의보", "열대야주의보"]
  );
});

test("KMA warning parser understands province-wide exclusion notation", () => {
  const html = `<p>
    o 폭염주의보 : 전북자치도(진안, 장수 제외), 경상남도(거창)<br>
    o 강풍주의보 : 전북자치도(고창, 김제, 부안(위도면 제외), 군산)<br>
    o 호우경보 : 전북특별자치도(전주 제외)
  </p>`;
  assert.deepEqual(extractKmaWarnings(html), ["폭염주의보"]);
});

test("KMA warning status selects the newest item even when the API order changes", async () => {
  await withWeatherConfig(async () => {
    const warning = kmaResponse([
      {
        tmFc: 202607131000,
        t6: "o 폭염주의보 : 전북자치도(전주)",
        t7: "o 없음"
      },
      {
        tmFc: 202607131130,
        t6: "o 호우경보 : 전북자치도(전주)",
        t7: "o 없음"
      }
    ]);
    const { fetchImpl } = successfulFetch({ warning });
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
    assert.deepEqual(result.warnings, ["호우경보"]);
  });
});

test("engineering building coordinates map to the official KMA grid", () => {
  assert.deepEqual(toKmaGrid(35.8461205, 127.1340012), { nx: 63, ny: 89 });
});

test("all KMA precipitation and sky conditions have explicit Korean labels", () => {
  const cases = new Map([
    ["clear", "☀️ 맑음"],
    ["mostly-cloudy", "⛅ 구름 많음"],
    ["overcast", "☁️ 흐림"],
    ["rain", "🌧️ 비"],
    ["rain-snow", "🌨️ 비/눈"],
    ["snow", "❄️ 눈"],
    ["thunderstorm", "⛈️ 뇌우"],
    ["shower", "🌦️ 소나기"],
    ["raindrop", "🌦️ 빗방울"],
    ["raindrop-snow", "🌨️ 빗방울/눈날림"],
    ["snow-flurry", "🌨️ 눈날림"]
  ]);
  for (const [condition, label] of cases) {
    assert.equal(formatCurrentWeatherCondition(condition), label);
  }
  assert.equal(currentWeatherEmoji("rain"), "🌧️");
  assert.equal(currentWeatherEmoji("rain-snow"), "🌨️");
  assert.equal(currentWeatherEmoji("snow"), "❄️");
  assert.equal(currentWeatherEmoji("snow-flurry"), "🌨️");
  assert.equal(currentWeatherEmoji("thunderstorm"), "⛈️");
  assert.equal(currentWeatherEmoji("unknown"), "🌡️");
  assert.equal(formatCurrentWeatherCondition("unknown"), "");
});

test("midnight precipitation belongs to the preceding day's final hour", async () => {
  const hourly = {
    time: ["2026-07-13T23:00", "2026-07-14T00:00", "2026-07-14T01:00"],
    precipitation_probability: [80, 90, 70],
    precipitation: [1, 2, 3],
    precipitation_known: [true, true, true],
    rainy: [true, true, true]
  };
  assert.deepEqual(rainPeriodsForDate(hourly, "2026-07-13"), [
    { startAt: "2026-07-13T22:00", endAt: "2026-07-14T00:00", amountMm: 3 }
  ]);
  assert.deepEqual(rainPeriodsForDate(hourly, "2026-07-14"), [
    { startAt: "2026-07-14T00:00", endAt: "2026-07-14T01:00", amountMm: 3 }
  ]);
  await withWeatherConfig(async () => {
    const village = defaultVillageItems();
    addForecast(village, "20260714", "0000", {
      TMP: 25, POP: 95, SKY: 4, PTY: 1, PCP: "2mm", SNO: "적설없음"
    });
    addForecast(village, "20260715", "0000", {
      TMP: 24, POP: 95, SKY: 4, PTY: 1, PCP: "3mm", SNO: "적설없음"
    });
    const { fetchImpl } = successfulFetch({ village });
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
    assert.equal(result.todayRainMm, 3.5);
    assert.equal(result.tomorrowPrecipitationMm, 17);
    assert.ok(result.text.includes("오늘 비 예보 95% · 예상 3.5mm · 12:00~13:00, 23:00~24:00"));
    assert.ok(result.text.includes("내일 비 예보 95% · 예상 17mm · 06:00~07:00, 23:00~24:00"));
  });
});

test("AirKorea invalid calendar and clock values cannot bypass freshness checks", async () => {
  await withWeatherConfig(async () => {
    for (const dataTime of ["2026-13-13 12:00", "2026-02-30 12:00", "2026-07-13 25:00", "2026-07-13 24:01", "2026-07-13 12:60"]) {
      const { fetchImpl } = successfulFetch({
        air: { response: { body: { items: [{ dataTime, pm10Value: "91", pm25Value: "44" }] } } }
      });
      const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
      assert.equal(result.airQualityStatus, "unavailable", dataTime);
      assert.equal(result.pm10, null, dataTime);
      assert.match(result.airQualityError, /stale or invalid/u);
    }
  });
});

test("AirKorea valid 24:00 measurement remains a current next-day midnight", async () => {
  await withWeatherConfig(async () => {
    const { fetchImpl } = successfulFetch({
      air: { response: { body: { items: [{ dataTime: "2026-07-12 24:00", pm10Value: "91", pm25Value: "44" }] } } }
    });
    const result = await getWeatherAlert({
      mealType: "점심",
      now: new Date("2026-07-12T15:30:00.000Z"),
      fetchImpl
    });
    assert.equal(result.airQualityStatus, "ok");
    assert.equal(result.pm10, 91);
  });
});


test("KMA ranged rain is preserved in current, today and tomorrow message amounts", async () => {
  await withWeatherConfig(async () => {
    const ultra = defaultUltraItems().map((item) => item.category === "RN1" && item.fcstTime === "1300"
      ? { ...item, fcstValue: "1.0mm 미만" } : item);
    const village = defaultVillageItems().map((item) => item.category === "PCP" && item.fcstDate === "20260714" && item.fcstTime === "0700"
      ? { ...item, fcstValue: "30.0~50.0mm" } : item);
    const { fetchImpl } = successfulFetch({
      observation: observationItems({ precipitationType: "1", rain: "1.0mm 미만" }), ultra, village
    });
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
    assert.equal(result.currentPrecipitationMm, null);
    assert.equal(result.todayRainMm, null);
    assert.equal(result.tomorrowPrecipitationMm, null);
    assert.match(result.text, /지금 비 1mm 미만/u);
    assert.match(result.text, /오늘 비 예보 85% · 예상 1mm 미만/u);
    assert.match(result.text, /내일 비 예보 90% · 예상 30~50mm/u);
  });
});

test("KMA ranged totals combine exact values and midnight within their correct day", async () => {
  await withWeatherConfig(async () => {
    const village = defaultVillageItems();
    addForecast(village, "20260714", "0000", {
      TMP: 24, POP: 90, SKY: 4, PTY: 1, PCP: "30.0~50.0mm", SNO: "적설없음"
    });
    addForecast(village, "20260714", "0900", {
      TMP: 24, POP: 90, SKY: 4, PTY: 1, PCP: "50.0mm 이상", SNO: "적설없음"
    });
    const { fetchImpl } = successfulFetch({ village });
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
    assert.deepEqual(result.todayPrecipitationBounds, { minimum: 31.5, maximum: 51.5, upperExclusive: false });
    assert.deepEqual(result.tomorrowPrecipitationBounds, { minimum: 64, maximum: null, upperExclusive: false });
    assert.match(result.text, /오늘 비 예보 90% · 예상 31\.5~51\.5mm/u);
    assert.match(result.text, /내일 비 예보 90% · 예상 64mm 이상/u);
  });
});

test("KMA snowfall lower, upper and ranged limits survive the end-to-end forecast", async () => {
  await withWeatherConfig(async () => {
    for (const [snowfall, expected] of [
      ["0.5cm 미만", "0.5cm 미만"], ["1.0~3.0cm", "1~3cm"], ["5.0cm 이상", "5cm 이상"]
    ]) {
      const village = defaultVillageItems().map((item) => {
        if (item.fcstDate !== "20260714" || item.fcstTime !== "0700") return item;
        if (item.category === "PTY") return { ...item, fcstValue: "3" };
        if (item.category === "PCP") return { ...item, fcstValue: "1.0mm 미만" };
        if (item.category === "SNO") return { ...item, fcstValue: snowfall };
        return item;
      });
      const { fetchImpl } = successfulFetch({ village });
      const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
      assert.equal(result.tomorrowSnowfallCm, null);
      assert.ok(result.text.includes("❄️ 내일 눈 예보 90% · 예상 1mm 미만 · 예상 적설 " + expected));
    }
  });
});

test("an unrecognized precipitation bound cannot fabricate a total", async () => {
  await withWeatherConfig(async () => {
    const ultra = defaultUltraItems().map((item) => item.category === "RN1" && item.fcstTime === "1300"
      ? { ...item, fcstValue: "unknown 1~mm" } : item);
    const { fetchImpl } = successfulFetch({ ultra });
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
    assert.equal(result.todayRainMm, null);
    assert.equal(result.todayPrecipitationBounds, null);
    const todayPart = result.text.split(" | ").find((part) => part.includes("오늘 비 예보"));
    assert.ok(todayPart);
    assert.doesNotMatch(todayPart, /예상|NaN|unknown/u);
  });
});

test("explicit KMA no-rain null takes precedence over older village rain", async () => {
  await withWeatherConfig(async () => {
    const ultra = defaultUltraItems().map((item) => {
      if (item.fcstTime !== "1300") return item;
      if (item.category === "RN1") return { ...item, fcstValue: null };
      if (item.category === "PTY" || item.category === "POP") return { ...item, fcstValue: "0" };
      return item;
    });
    const { fetchImpl } = successfulFetch({ ultra });
    const result = await getWeatherAlert({ mealType: "점심", now: NOW, fetchImpl });
    assert.deepEqual(result.todayRainPeriods, []);
    assert.equal(result.todayPrecipitationBounds, null);
    assert.equal(result.todayRainMm, null);
  });
});
