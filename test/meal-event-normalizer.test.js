import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMealEventNormalizationPrompt,
  normalizeMealEventById,
  normalizeMealEventFromReviewedCatalog,
  normalizeMealEventWithCodex,
  parseDiningCodeCoordinates,
  pendingMealEventIds,
  validateMealEventNormalizationResult
} from "../src/meal-event-normalizer.js";
import { config } from "../src/config.js";
import {
  normalizeMealEventsIndependently,
  prepareMealEventsAtomically,
  rejectInvalidMealEventsAtomically
} from "../scripts/normalize-meal-events.js";

const event = {
  eventId: "E1",
  rawRestaurant: "두찜",
  rawMenu: "로제찜닭, 까만찜닭",
  restaurant: "두찜",
  branch: "전주금암점",
  menu: "로제찜닭 · 까만찜닭",
  menus: ["로제찜닭", "까만찜닭"]
};

const DINING_CODE_URL = "https://www.diningcode.com/profile.php?rid=verified";

function evidenceHtml({
  restaurant = "두찜",
  branch = "전주금암점",
  address = "전북특별자치도 전주시 덕진구 기린대로 400",
  menus = ["로제찜닭", "까만찜닭"],
  latitude = 35.8501,
  longitude = 127.137
} = {}) {
  const coordinates = latitude === null || longitude === null
    ? ""
    : `<input id="hdn_lat" value="${latitude}"><input id="hdn_lng" value="${longitude}">`;
  return `${coordinates}<div>${restaurant} ${branch} ${address} ${menus.join(" ")}</div>`;
}

function evidenceResponse(html) {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.byteLength) },
    arrayBuffer: async () => bytes.buffer
  };
}

function verifiedResult(overrides = {}) {
  return {
    status: "verified",
    restaurant: "두찜",
    branch: "전주금암점",
    address: "전북특별자치도 전주시 덕진구 기린대로 400",
    latitude: 35.8501,
    longitude: 127.137,
    category: "찜/탕",
    restaurantEvidenceUrl: DINING_CODE_URL,
    menus: [
      { input: "로제찜닭", canonicalName: "로제찜닭", evidenceUrl: DINING_CODE_URL },
      { input: "까만찜닭", canonicalName: "까만찜닭", evidenceUrl: DINING_CODE_URL }
    ],
    confidence: "high",
    note: "지점과 정식 메뉴명을 확인했습니다.",
    ...overrides
  };
}

test("a raw model claim cannot self-attest deterministic page verification", () => {
  assert.throws(
    () => validateMealEventNormalizationResult(verifiedResult(), event),
    /deterministic page evidence/u
  );
});

test("model normalization validates branch distance and every menu against fetched page HTML", async () => {
  let fetchCalls = 0;
  const output = await normalizeMealEventWithCodex(event, {
    runStructured: async () => ({ parsed: verifiedResult() }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return evidenceResponse(evidenceHtml());
    }
  });
  assert.equal(fetchCalls, 1);
  assert.equal(output.result.status, "verified");
  assert.equal(output.result.branch, "전주금암점");
  assert.ok(output.result.distanceKm > 0.05 && output.result.distanceKm < 6);
  assert.deepEqual(output.result.menus.map((item) => item.canonicalName), ["로제찜닭", "까만찜닭"]);
  assert.match(output.result.note, /결정론적으로 확인/u);
});

test("equivalent menu spellings become one evidence-backed normalization input", async () => {
  const variantEvent = {
    eventId: "E-SPELLING-VARIANT",
    rawRestaurant: "은하스시",
    rawMenu: "연어 후토마키, 연어후토마끼",
    restaurant: "은하스시",
    branch: "전북대점",
    menu: "연어 후토마키",
    menus: ["연어 후토마키"]
  };
  const evidenceUrl = "https://www.diningcode.com/profile.php?rid=spelling-variant";
  const output = await normalizeMealEventWithCodex(variantEvent, {
    runStructured: async () => ({
      parsed: verifiedResult({
        restaurant: "은하스시",
        branch: "전북대점",
        category: "일식",
        restaurantEvidenceUrl: evidenceUrl,
        menus: [{
          input: "연어 후토마키",
          canonicalName: "연어 후토마키",
          evidenceUrl
        }]
      })
    }),
    fetchImpl: async () => evidenceResponse(evidenceHtml({
      restaurant: "은하스시",
      branch: "전북대점",
      menus: ["연어 후토마키"]
    }))
  });
  assert.equal(output.result.status, "verified");
  assert.deepEqual(output.result.menus.map((item) => item.canonicalName), ["연어 후토마키"]);
});

test("an independent restaurant without a formal branch verifies by exact address and evidence coordinates", async () => {
  const independentEvent = {
    eventId: "E-INDEPENDENT",
    rawRestaurant: "신대화",
    rawMenu: "닭복음탕",
    restaurant: "신대화회관",
    branch: "",
    menu: "닭볶음탕(한마리)",
    menus: ["닭볶음탕(한마리)"]
  };
  const evidenceUrl = "https://www.diningcode.com/profile.php?rid=independent";
  const output = await normalizeMealEventWithCodex(independentEvent, {
    runStructured: async () => ({
      parsed: verifiedResult({
        restaurant: "신대화회관",
        branch: "",
        address: "전북특별자치도 전주시 덕진구 백동로 43",
        restaurantEvidenceUrl: evidenceUrl,
        menus: [{
          input: "닭복음탕",
          canonicalName: "닭볶음탕(한마리)",
          evidenceUrl
        }]
      })
    }),
    fetchImpl: async () => evidenceResponse(evidenceHtml({
      restaurant: "신대화회관",
      branch: "",
      address: "전북특별자치도 전주시 덕진구 백동로 43",
      menus: ["닭볶음탕(한마리)"]
    }))
  });
  assert.equal(output.result.status, "verified");
  assert.equal(output.result.restaurant, "신대화회관");
  assert.equal(output.result.branch, "");
});

test("a verified omitted branch reuses the reviewed physical store identity", async () => {
  const source = { rawRestaurant: "더담다", rawMenu: "흑돼지 돈까스", menus: ["흑돼지 돈까스"] };
  const output = await normalizeMealEventWithCodex(source, {
    runStructured: async () => ({ parsed: verifiedResult({
      restaurant: "더담다", branch: "", category: "돈까스",
      address: "전북특별자치도 전주시 덕진구 권삼득로 333 원플러스빌딩 1층",
      menus: [{ input: "흑돼지 돈까스", canonicalName: "흑돼지인생돈까스", evidenceUrl: DINING_CODE_URL }],
    }) }),
    fetchImpl: async () => evidenceResponse(evidenceHtml({
      restaurant: "더담다", branch: "",
      address: "전북특별자치도 전주시 덕진구 권삼득로 333 원플러스빌딩 1층",
      menus: ["흑돼지인생돈까스"],
    })),
  });
  assert.equal(output.result.restaurant, "더 담다");
  assert.equal(output.result.branch, "전북대점");
  assert.equal(output.result.menus[0].canonicalName, "흑돼지인생돈까스");
});

test("a verified ambiguous menu may use the model's allowed category while deterministic rules still take precedence", async () => {
  const ambiguousEvent = {
    eventId: "E-AMBIGUOUS-CATEGORY",
    rawRestaurant: "은하식당",
    rawMenu: "시그니처 한그릇",
    restaurant: "은하식당",
    branch: "전북대점",
    menu: "시그니처 한그릇",
    menus: ["시그니처 한그릇"]
  };
  const ambiguousUrl = "https://www.diningcode.com/profile.php?rid=ambiguous-category";
  const output = await normalizeMealEventWithCodex(ambiguousEvent, {
    runStructured: async () => ({
      parsed: verifiedResult({
        restaurant: "은하식당",
        branch: "전북대점",
        category: "한식",
        restaurantEvidenceUrl: ambiguousUrl,
        menus: [{
          input: "시그니처 한그릇",
          canonicalName: "시그니처 한그릇",
          evidenceUrl: ambiguousUrl
        }]
      })
    }),
    fetchImpl: async () => evidenceResponse(evidenceHtml({
      restaurant: "은하식당",
      branch: "전북대점",
      menus: ["시그니처 한그릇"]
    }))
  });
  assert.equal(output.result.status, "verified");
  assert.equal(output.result.category, "한식");

  const deterministic = await normalizeMealEventWithCodex(ambiguousEvent, {
    runStructured: async () => ({
      parsed: verifiedResult({
        restaurant: "은하식당",
        branch: "전북대점",
        category: "양식",
        restaurantEvidenceUrl: ambiguousUrl,
        menus: [{
          input: "시그니처 한그릇",
          canonicalName: "연어 후토마끼",
          evidenceUrl: ambiguousUrl
        }]
      })
    }),
    fetchImpl: async () => evidenceResponse(evidenceHtml({
      restaurant: "은하식당",
      branch: "전북대점",
      menus: ["연어 후토마끼"]
    }))
  });
  assert.equal(deterministic.result.category, "일식");
});

test("a tracked reviewed alias still requires live deterministic page evidence", async () => {
  const reviewedEvent = {
    eventId: "E-REVIEWED",
    rawRestaurant: "신대화",
    rawMenu: "닭복음탕",
    restaurant: "신대화회관",
    branch: "",
    category: "찜/탕",
    menu: "닭볶음탕(한마리)",
    menus: ["닭볶음탕(한마리)"],
    normalization: {
      version: 2,
      method: "local-catalog-provisional",
      local: {
        fullyCanonical: true,
        reviewedEvidence: {
          address: "전북특별자치도 전주시 덕진구 백동로 43",
          evidenceUrl: "https://www.diningcode.com/profile.php?rid=reviewed"
        }
      }
    }
  };
  const verified = await normalizeMealEventFromReviewedCatalog(reviewedEvent, {
    fetchImpl: async () => evidenceResponse(evidenceHtml({
      restaurant: "신대화회관",
      branch: "",
      address: "전북특별자치도 전주시 덕진구 백동로 43",
      menus: ["닭볶음탕(한마리)"]
    }))
  });
  assert.equal(verified.result.status, "verified");
  assert.equal(verified.provenance.method, "reviewed-catalog-live-evidence");

  const changed = await normalizeMealEventFromReviewedCatalog(reviewedEvent, {
    fetchImpl: async () => evidenceResponse(evidenceHtml({
      restaurant: "신대화회관",
      branch: "",
      address: "전북특별자치도 전주시 덕진구 백동로 43",
      menus: ["다른메뉴"]
    }))
  });
  assert.equal(changed, null);
});

test("model normalization rejects changed menu order and evidence-derived out-of-range coordinates", async () => {
  const reversed = verifiedResult();
  reversed.menus.reverse();
  await assert.rejects(() => normalizeMealEventWithCodex(event, {
    runStructured: async () => ({ parsed: reversed }),
    fetchImpl: async () => evidenceResponse(evidenceHtml())
  }), /input order/u);
  await assert.rejects(
    () => normalizeMealEventWithCodex(event, {
      runStructured: async () => ({ parsed: verifiedResult({ latitude: 35.8501 }) }),
      fetchImpl: async () => evidenceResponse(evidenceHtml({ latitude: 36.2 }))
    }),
    /outside the allowed distance/u
  );
});

test("unresolved output stays explicit instead of inventing a branch", () => {
  const result = validateMealEventNormalizationResult({
    ...verifiedResult(),
    status: "unresolved",
    restaurant: "",
    branch: "",
    address: "",
    latitude: null,
    longitude: null,
    category: "",
    restaurantEvidenceUrl: "",
    menus: [
      { input: "로제찜닭", canonicalName: "", evidenceUrl: "" },
      { input: "까만찜닭", canonicalName: "", evidenceUrl: "" }
    ],
    confidence: "low"
  }, event);
  assert.equal(result.status, "unresolved");
});

test("Codex invocation is pinned to the normalization schema and search-oriented prompt", async () => {
  let call;
  const output = await normalizeMealEventWithCodex(event, {
    now: new Date("2026-07-14T00:00:00.000Z"),
    runStructured: async (options) => {
      call = options;
      return { parsed: verifiedResult(), logPath: "log", outputPath: "output", promptPath: "prompt" };
    },
    fetchImpl: async () => evidenceResponse(evidenceHtml())
  });
  assert.equal(call.runKind, "meal-normalization");
  assert.match(call.schemaPath, /meal-event-normalization\.schema\.json$/u);
  assert.match(call.prompt, /웹 검색/u);
  assert.match(call.prompt, /UNTRUSTED_MEAL_INPUT_JSON/u);
  assert.match(call.prompt, /테이블링 지점 페이지/u);
  assert.equal(output.result.status, "verified");
  assert.match(buildMealEventNormalizationPrompt(event), /입력 순서와 개수/u);
  assert.match(buildMealEventNormalizationPrompt(event), /공식 지점명이 없는 매장/u);
  assert.match(buildMealEventNormalizationPrompt(event), /줄임말·오탈자·띄어쓰기·지점 생략/u);
  assert.match(buildMealEventNormalizationPrompt(event), /상호가 비어 있어도/u);
  assert.match(buildMealEventNormalizationPrompt(event), /latitude\/longitude=null인 verified/u);
  assert.match(buildMealEventNormalizationPrompt(event), /canonicalName="치\+양도네르롤"/u);
});

test("allowlisted evidence HTML supplies missing coordinates without guessing", async () => {
  const fetchCalls = [];
  const output = await normalizeMealEventWithCodex(event, {
    runStructured: async () => ({
      parsed: verifiedResult({
        restaurantEvidenceUrl: "https://www.diningcode.com/profile.php?rid=verified",
        latitude: null,
        longitude: null
      })
    }),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      return evidenceResponse(evidenceHtml());
    }
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].options.redirect, "error");
  assert.equal(output.result.latitude, 35.8501);
  assert.equal(output.result.longitude, 127.137);
  assert.match(output.result.note, /좌표를 결정론적으로 확인/u);
});

test("unsafe or unsupported model-provided evidence URLs fail closed before any fetch", async () => {
  let fetchCalls = 0;
  const output = await normalizeMealEventWithCodex(event, {
    runStructured: async () => ({
      parsed: verifiedResult({
        restaurantEvidenceUrl: "https://www.diningcode.com:8443/profile.php?rid=unsafe",
        latitude: null,
        longitude: null
      })
    }),
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }
  });
  assert.equal(output.result.status, "unresolved");
  assert.equal(fetchCalls, 0);
});

test("finite model coordinates are ignored and always replaced from matching evidence HTML", async () => {
  let fetchCalls = 0;
  const output = await normalizeMealEventWithCodex(event, {
    runStructured: async () => ({
      parsed: verifiedResult({ latitude: 35.99, longitude: 127.99 })
    }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return evidenceResponse(evidenceHtml({ latitude: 35.8502, longitude: 127.1371 }));
    }
  });
  assert.equal(fetchCalls, 1);
  assert.equal(output.result.status, "verified");
  assert.equal(output.result.latitude, 35.8502);
  assert.equal(output.result.longitude, 127.1371);
});

test("missing restaurant, branch, address, menu, or coordinates in page HTML stays unresolved", async () => {
  const insufficientPages = [
    evidenceHtml({ restaurant: "다른식당" }),
    evidenceHtml({ branch: "다른지점" }),
    evidenceHtml({ address: "전북특별자치도 전주시 덕진구 다른로 9" }),
    evidenceHtml({ menus: ["로제찜닭"] }),
    evidenceHtml({ latitude: null, longitude: null })
  ];
  for (const html of insufficientPages) {
    const output = await normalizeMealEventWithCodex(event, {
      runStructured: async () => ({ parsed: verifiedResult() }),
      fetchImpl: async () => evidenceResponse(html)
    });
    assert.equal(output.result.status, "unresolved");
  }
});

test("each distinct menu evidence page must prove the same branch and its own menu", async () => {
  const menuOneUrl = "https://www.diningcode.com/profile.php?rid=menu-one";
  const menuTwoUrl = "https://www.diningcode.com/profile.php?rid=menu-two";
  const claim = verifiedResult({
    menus: [
      { input: "로제찜닭", canonicalName: "로제찜닭", evidenceUrl: menuOneUrl },
      { input: "까만찜닭", canonicalName: "까만찜닭", evidenceUrl: menuTwoUrl }
    ]
  });
  const output = await normalizeMealEventWithCodex(event, {
    runStructured: async () => ({ parsed: claim }),
    fetchImpl: async (url) => {
      const id = new URL(url).searchParams.get("rid");
      if (id === "menu-two") return evidenceResponse(evidenceHtml({ menus: ["로제찜닭"] }));
      return evidenceResponse(evidenceHtml());
    }
  });
  assert.equal(output.result.status, "unresolved");
});

test("Tabling place HTML uses the same full deterministic verification flow", async () => {
  const tablingUrl = "https://tabling.co.kr/place/abc123";
  const urls = [];
  const output = await normalizeMealEventWithCodex(event, {
    runStructured: async () => ({
      parsed: verifiedResult({
        restaurantEvidenceUrl: tablingUrl,
        menus: verifiedResult().menus.map((menu) => ({ ...menu, evidenceUrl: tablingUrl }))
      })
    }),
    fetchImpl: async (url) => {
      urls.push(String(url));
      return evidenceResponse('<script>{"restaurant":"두찜","branch":"전주금암점","address":"전북특별자치도 전주시 덕진구 기린대로 400","menus":["로제찜닭","까만찜닭"],"latitude":35.8501,"longitude":127.137}</script>');
    }
  });
  assert.deepEqual(urls, ["https://www.tabling.co.kr/place/abc123"]);
  assert.equal(output.result.status, "verified");
});

test("coordinate parser rejects missing or invalid hidden values", () => {
  assert.deepEqual(parseDiningCodeCoordinates('<input id="hdn_lat" value="35.8392187"><input id="hdn_lng" value="127.1380701">'), {
    latitude: 35.8392187,
    longitude: 127.1380701
  });
  assert.equal(parseDiningCodeCoordinates('<input id="hdn_lat" value="999"><input id="hdn_lng" value="127">'), null);
  assert.equal(parseDiningCodeCoordinates(""), null);
});

function memoryStores(initialEvent) {
  let store = { version: 1, events: [structuredClone(initialEvent)] };
  return {
    getStore: () => structuredClone(store),
    saveStore: (next) => { store = structuredClone(next); },
    current: () => structuredClone(store.events[0])
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("meal preparation rechecks the latest row and verified reset guard inside the atomic update", () => {
  let current = {
    ...event,
    inputText: "두찜 로제찜닭",
    normalizationStatus: "verified",
    concurrentField: "preserve-me"
  };
  const updateEvents = (eventIds, mutate) => {
    assert.deepEqual(eventIds, [current.eventId]);
    current = mutate(structuredClone(current), current.eventId);
    return [structuredClone(current)];
  };
  const prepareEvent = (latest) => ({ ...latest, normalizationStatus: "pending" });

  assert.throws(() => prepareMealEventsAtomically([event.eventId], {
    updateEvents,
    prepareEvent
  }), /Refusing to reset verified custom meal events/u);
  assert.equal(current.normalizationStatus, "verified");

  const prepared = prepareMealEventsAtomically([event.eventId], {
    forceResetVerified: true,
    updateEvents,
    prepareEvent
  });
  assert.equal(prepared[0].normalizationStatus, "pending");
  assert.equal(prepared[0].concurrentField, "preserve-me");
});

test("meal preparation delegates the whole selection to one all-or-nothing batch mutation", () => {
  let rows = [
    { ...event, eventId: "E1", inputText: "두찜", normalizationStatus: "failed" },
    { ...event, eventId: "E2", inputText: "두찜", normalizationStatus: "verified" }
  ];
  let batchCalls = 0;
  const updateEvents = (eventIds, mutate) => {
    batchCalls += 1;
    const draft = structuredClone(rows);
    const updated = eventIds.map((eventId) => {
      const index = draft.findIndex((item) => item.eventId === eventId);
      draft[index] = mutate(draft[index], eventId);
      return draft[index];
    });
    rows = draft;
    return updated;
  };

  assert.throws(() => prepareMealEventsAtomically(["E1", "E2"], {
    updateEvents,
    prepareEvent: (latest) => ({ ...latest, normalizationStatus: "pending" })
  }), /Refusing to reset verified custom meal events/u);
  assert.equal(batchCalls, 1);
  assert.equal(rows[0].normalizationStatus, "failed");
  assert.equal(rows[1].normalizationStatus, "verified");
});

test("obviously invalid historical meal input is rejected atomically and a concurrent correction survives", () => {
  let rows = [
    {
      ...event,
      eventId: "invalid",
      inputText: "으 / 으",
      rawRestaurant: "으",
      rawMenu: "으",
      restaurant: "으",
      menu: "으",
      normalizationStatus: "failed",
      normalizationAttemptCount: 3
    },
    {
      ...event,
      eventId: "corrected",
      inputText: "!!!",
      rawRestaurant: "",
      rawMenu: "!!!",
      restaurant: "",
      menu: "!!!",
      normalizationStatus: "failed",
      normalizationAttemptCount: 3
    }
  ];
  const updateEvents = (eventIds, mutate) => {
    assert.deepEqual(eventIds, ["invalid", "corrected"]);
    // Simulate a meaningful correction after the initial scan but before the
    // atomic mutation obtains its lock.
    rows[1] = {
      ...rows[1],
      inputText: "죽",
      rawMenu: "죽",
      menu: "죽",
      normalizationStatus: "pending",
      normalizationAttemptCount: 0
    };
    rows = rows.map((row) => eventIds.includes(row.eventId)
      ? mutate(structuredClone(row), row.eventId)
      : row);
    return structuredClone(rows);
  };

  const updated = rejectInvalidMealEventsAtomically({
    getStore: () => ({ version: 1, events: structuredClone(rows) }),
    updateEvents
  });
  assert.equal(updated[0].normalizationStatus, "rejected-input");
  assert.equal(updated[0].normalizationAttemptCount, 0);
  assert.match(updated[0].normalizationLastError, /구체적으로/u);
  assert.equal(updated[1].rawMenu, "죽");
  assert.equal(updated[1].normalizationStatus, "pending");
});

test("historical compound and repeated garbage inputs are selected by the invalid migration", () => {
  let rows = [
    {
      ...event,
      eventId: "compound-garbage",
      inputText: "분식집 / 떡볶이, !!!",
      rawRestaurant: "분식집",
      rawMenu: "떡볶이, !!!",
      restaurant: "분식집",
      menu: "떡볶이 · !!!",
      menus: ["떡볶이", "!!!"],
      normalizationStatus: "failed",
      normalizationAttemptCount: 3
    },
    {
      ...event,
      eventId: "repeated-placeholder",
      inputText: "테스트테스트",
      rawRestaurant: "",
      rawMenu: "테스트테스트",
      restaurant: "",
      menu: "테스트테스트",
      menus: ["테스트테스트"],
      normalizationStatus: "failed",
      normalizationAttemptCount: 3
    },
    {
      ...event,
      eventId: "bot-name-placeholder",
      inputText: "오점뭐 / 오점뭐",
      rawRestaurant: "오점뭐",
      rawMenu: "오점뭐",
      restaurant: "오점뭐",
      menu: "오점뭐",
      menus: ["오점뭐"],
      normalizationStatus: "unverified",
      normalizationAttemptCount: 3
    }
  ];
  const updateEvents = (eventIds, mutate) => {
    assert.deepEqual(eventIds, ["compound-garbage", "repeated-placeholder", "bot-name-placeholder"]);
    rows = rows.map((row) => mutate(structuredClone(row), row.eventId));
    return structuredClone(rows);
  };

  const updated = rejectInvalidMealEventsAtomically({
    getStore: () => ({ version: 1, events: structuredClone(rows) }),
    updateEvents
  });
  assert.deepEqual(updated.map((item) => item.normalizationStatus), [
    "rejected-input", "rejected-input", "rejected-input"
  ]);
  assert.ok(updated.every((item) => item.normalizationAttemptCount === 0));
});

test("invalid historical meal rejection is an idempotent no-op when no target exists", () => {
  let updateCalls = 0;
  const updated = rejectInvalidMealEventsAtomically({
    getStore: () => ({
      version: 1,
      events: [{ ...event, inputText: "두찜 로제찜닭", normalizationStatus: "verified" }]
    }),
    updateEvents: () => {
      updateCalls += 1;
      throw new Error("must not update");
    }
  });
  assert.deepEqual(updated, []);
  assert.equal(updateCalls, 0);
});

test("Codex normalization batches have an explicit independent idempotent failure contract", async () => {
  const calls = [];
  const batch = await normalizeMealEventsIndependently(["E1", "E2", "E3"], {
    normalizeEvent: async (eventId) => {
      calls.push(eventId);
      if (eventId === "E2") throw new Error("evidence source unavailable");
      return eventId === "E1"
        ? { event: { normalizationStatus: "verified" } }
        : { skipped: true, reason: "already-verified" };
    }
  });

  assert.deepEqual(calls, ["E1", "E2", "E3"]);
  assert.equal(batch.succeeded, 2);
  assert.equal(batch.failed, 1);
  assert.deepEqual(batch.results.map(({ eventId, ok }) => ({ eventId, ok })), [
    { eventId: "E1", ok: true },
    { eventId: "E2", ok: false },
    { eventId: "E3", ok: true }
  ]);
  assert.match(batch.results[1].error, /evidence source unavailable/u);
});

test("successful background normalization atomically replaces only canonical fields and keeps raw input", async () => {
  const stores = memoryStores({
    ...event,
    normalizationStatus: "pending",
    normalizationAttemptCount: 0,
    mealType: "저녁",
    createdAt: "2026-07-14T00:00:00.000Z"
  });
  const result = await normalizeMealEventById("E1", {
    ...stores,
    now: new Date("2026-07-14T01:00:00.000Z"),
    normalizeWithCodex: async () => ({ result: { ...verifiedResult(), distanceKm: 1 }, run: { logPath: "log" } })
  });
  const saved = stores.current();
  assert.equal(result.event.normalizationStatus, "verified");
  assert.equal(saved.rawRestaurant, "두찜");
  assert.equal(saved.rawMenu, "로제찜닭, 까만찜닭");
  assert.equal(saved.menu, "로제찜닭 · 까만찜닭");
  assert.equal(saved.normalization.model, "gpt-6-luna");
  assert.equal(saved.normalization.reasoningEffort, "xhigh");
  assert.equal(saved.normalizationAttemptCount, 1);
  assert.ok(Date.parse(saved.normalizationCompletedAt) > Date.parse(saved.normalizationStartedAt));
  assert.equal(saved.normalization.verifiedAt, saved.normalizationCompletedAt);
});

test("an explicitly rejected input can never be forced through direct normalization", async () => {
  const stores = memoryStores({
    ...event,
    normalizationStatus: "rejected-input",
    normalizationAttemptCount: 0,
    normalizationLastError: "입력값이 명백히 유효하지 않습니다."
  });
  let calls = 0;
  const result = await normalizeMealEventById("E1", {
    ...stores,
    normalizeWithCodex: async () => {
      calls += 1;
      throw new Error("must not run");
    }
  });
  assert.equal(result.reason, "rejected-input");
  assert.equal(calls, 0);
  assert.equal(stores.current().normalizationStatus, "rejected-input");
  assert.equal(stores.current().normalizationAttemptCount, 0);

  const legacyPending = memoryStores({
    ...event,
    rawRestaurant: "임의상호",
    rawMenu: "asdf",
    restaurant: "임의상호",
    menu: "asdf",
    menus: ["asdf"],
    normalizationStatus: "pending",
    normalizationAttemptCount: 0
  });
  const migrated = await normalizeMealEventById("E1", {
    ...legacyPending,
    normalizeWithCodex: async () => {
      calls += 1;
      throw new Error("must not run");
    }
  });
  assert.equal(migrated.reason, "rejected-input");
  assert.equal(calls, 0);
  assert.equal(legacyPending.current().normalizationStatus, "rejected-input");
  assert.equal(legacyPending.current().normalizationAttemptCount, 0);
});

test("failed and unresolved normalization retry, then meaningful exhausted input becomes terminal unverified", async () => {
  const base = {
    ...event,
    normalizationStatus: "pending",
    normalizationAttemptCount: 0,
    mealType: "저녁",
    createdAt: "2026-07-14T00:00:00.000Z"
  };
  const failed = memoryStores(base);
  await assert.rejects(() => normalizeMealEventById("E1", {
    ...failed,
    now: new Date("2026-07-14T01:00:00.000Z"),
    normalizeWithCodex: async () => { throw new Error("xoxb-secret at C:\\private\\file"); }
  }), /xoxb-secret/u);
  assert.equal(failed.current().normalizationStatus, "failed");
  assert.ok(Date.parse(failed.current().normalizationCompletedAt) > Date.parse(failed.current().normalizationStartedAt));
  assert.doesNotMatch(failed.current().normalizationLastError, /xoxb-secret|private/u);
  assert.equal(failed.current().menu, base.menu);

  const unresolved = memoryStores(base);
  await normalizeMealEventById("E1", {
    ...unresolved,
    now: new Date("2026-07-14T01:00:00.000Z"),
    normalizeWithCodex: async () => ({ result: { status: "unresolved", confidence: "low", note: "지점을 특정할 수 없습니다." } })
  });
  assert.equal(unresolved.current().normalizationStatus, "unresolved");
  assert.match(unresolved.current().normalizationLastError, /특정할 수 없습니다/u);

  const exhaustedUnresolved = memoryStores({
    ...base,
    normalizationStatus: "unresolved",
    normalizationAttemptCount: config.mealNormalizationMaxAttempts - 1
  });
  await normalizeMealEventById("E1", {
    ...exhaustedUnresolved,
    now: new Date("2026-07-14T01:00:00.000Z"),
    normalizeWithCodex: async () => ({
      result: { status: "unresolved", confidence: "low", note: "검증 근거를 찾지 못했습니다." }
    })
  });
  assert.equal(exhaustedUnresolved.current().normalizationStatus, "unverified");
  assert.equal(exhaustedUnresolved.current().normalizationAttemptCount, config.mealNormalizationMaxAttempts);
  assert.ok(exhaustedUnresolved.current().normalizationStartedAt);
  assert.ok(exhaustedUnresolved.current().normalizationCompletedAt);
  assert.match(exhaustedUnresolved.current().normalizationLastError, /근거를 찾지 못했습니다/u);

  let callsAfterExhaustion = 0;
  const attemptLimited = await normalizeMealEventById("E1", {
    ...exhaustedUnresolved,
    now: new Date("2026-07-14T02:00:00.000Z"),
    normalizeWithCodex: async () => {
      callsAfterExhaustion += 1;
      throw new Error("terminal unverified input must not be retried");
    }
  });
  assert.equal(attemptLimited.reason, "attempt-limit");
  assert.equal(callsAfterExhaustion, 0);
  assert.equal(exhaustedUnresolved.current().normalizationStatus, "unverified");
});

test("normalization claim and completion CAS prevent concurrent failure from downgrading verified data", async () => {
  const stores = memoryStores({
    ...event,
    normalizationStatus: "pending",
    normalizationAttemptCount: 0,
    mealType: "저녁",
    createdAt: "2026-07-14T00:00:00.000Z"
  });
  const firstDeferred = deferred();
  const startedAt = new Date("2026-07-14T01:00:00.000Z");
  const firstRun = normalizeMealEventById("E1", {
    ...stores,
    now: startedAt,
    normalizeWithCodex: async () => firstDeferred.promise
  });
  await new Promise((resolve) => setImmediate(resolve));

  let duplicateCalls = 0;
  const duplicate = await normalizeMealEventById("E1", {
    ...stores,
    now: new Date(startedAt.getTime() + 1000),
    normalizeWithCodex: async () => {
      duplicateCalls += 1;
      throw new Error("fresh duplicate must not run");
    }
  });
  assert.equal(duplicate.reason, "in-progress");
  assert.equal(duplicateCalls, 0);

  const recovered = await normalizeMealEventById("E1", {
    ...stores,
    now: new Date(startedAt.getTime() + config.mealNormalizationTimeoutMs + 31_000),
    normalizeWithCodex: async () => ({
      result: { ...verifiedResult(), distanceKm: 1 },
      run: { logPath: "recovered" }
    })
  });
  assert.equal(recovered.event.normalizationStatus, "verified");
  assert.equal(recovered.event.normalizationAttemptCount, 2);

  const rejected = assert.rejects(firstRun, /older worker failed/u);
  firstDeferred.reject(new Error("older worker failed"));
  await rejected;
  assert.equal(stores.current().normalizationStatus, "verified");
  assert.equal(stores.current().normalizationAttemptCount, 2);
  assert.equal(stores.current().normalization?.method, "codex-web-search");
});

test("pending event selection recovers stale work but respects attempt limits", () => {
  const getStore = () => ({
    version: 1,
    events: [
      { eventId: "pending", normalizationStatus: "pending", normalizationAttemptCount: 0 },
      { eventId: "stale", normalizationStatus: "normalizing", normalizationAttemptCount: 1, normalizationStartedAt: "2026-07-13T00:00:00.000Z" },
      { eventId: "done", normalizationStatus: "verified", normalizationAttemptCount: 1 },
      { eventId: "exhausted", normalizationStatus: "failed", normalizationAttemptCount: 3 },
      { eventId: "unverified", normalizationStatus: "unverified", normalizationAttemptCount: 3 }
    ]
  });
  assert.deepEqual(pendingMealEventIds({
    getStore,
    maxEvents: 10,
    now: new Date("2026-07-14T00:00:00.000Z")
  }), ["pending", "stale"]);
});
