import test from "node:test";
import assert from "node:assert/strict";
import { tastePosterior, tasteScore } from "../src/taste-profile.js";

const candidate = { category: "도시락", restaurant: "밥집", menu: "제육덮밥" };

test("one and two real respondents move either direction by at most 7.15 and 12.5 percentage points", () => {
  const now = new Date("2026-09-05T00:00:00Z");
  for (const rating of [1, 5]) {
    const events = ["a", "b"].map((respondentId) => ({
      ...candidate, eventId: respondentId, respondentId, rating, mealType: "점심",
      source: "scheduled-cache", normalizationStatus: "verified-source", createdAt: now.toISOString(),
    }));
    for (const count of [1, 2]) {
      const result = tastePosterior(candidate, { events: events.slice(0, count), mealType: "점심", now });
      assert.ok(Math.abs(result.mean - 0.5) <= (count === 1 ? 0.07143 : 0.125001));
      assert.equal(result.evidenceWeight, count);
    }
  }
});

test("a respondent's actual rating replaces their survey instead of counting twice", () => {
  const now = new Date("2026-09-05T00:00:00Z");
  const actual = { ...candidate, eventId: "actual", respondentId: "same-person", rating: 1,
    mealType: "점심", source: "scheduled-cache", normalizationStatus: "verified-source", createdAt: now.toISOString() };
  const preferences = { responses: [{ responseId: "survey", respondentId: "same-person", source: "scheduled-cache",
    mealType: "점심", submittedAt: now.toISOString(), ratings: [{ ...candidate, rating: 5 }] }] };
  const baseline = tastePosterior(candidate, { events: [actual], mealType: "점심", now });
  assert.deepEqual(tastePosterior(candidate, { events: [actual], preferences, mealType: "점심", now }), baseline);
  const unrated = { ...actual, rating: null };
  assert.ok(tastePosterior(candidate, { events: [unrated], preferences, mealType: "점심", now }).mean > 0.5);
});

test("taste score learns only from actual meal events", () => {
  const liked = Array.from({ length: 6 }, (_, index) => ({
    eventId: String(index), category: "도시락", restaurant: "밥집", menu: "제육덮밥", rating: 5,
    respondentId: `respondent-${index}`, source: "scheduled-cache",
    mealType: "점심", normalizationStatus: "verified-source"
  }));
  const likedScore = tasteScore(candidate, { events: liked, mealType: "점심", rng: () => 0.5, explorationRate: 0 });
  const neutralScore = tasteScore(candidate, { events: [], mealType: "점심", rng: () => 0.5, explorationRate: 0 });
  assert.ok(likedScore > neutralScore);
});

test("private interaction tests do not change the taste score", () => {
  const testEvent = {
    eventId: "test",
    category: "도시락",
    restaurant: "밥집",
    menu: "제육덮밥",
    rating: 5,
    mealType: "점심",
    respondentId: "respondent-private",
    normalizationStatus: "verified-source",
    source: "manual-private-test"
  };
  const testScore = tasteScore(candidate, { events: [testEvent], mealType: "점심", rng: () => 0.5, explorationRate: 0 });
  const neutralScore = tasteScore(candidate, { events: [], mealType: "점심", rng: () => 0.5, explorationRate: 0 });
  assert.equal(testScore, neutralScore);
});

test("an unrated meal is neutral instead of an implicit dislike", () => {
  const unrated = {
    eventId: "unrated",
    category: "도시락",
    restaurant: "밥집",
    menu: "제육덮밥",
    rating: null,
    tags: [],
    mealType: "점심",
    respondentId: "respondent-unrated",
    source: "scheduled-cache",
    normalizationStatus: "verified-source"
  };
  const unratedScore = tasteScore(candidate, { events: [unrated], mealType: "점심", rng: () => 0.5, explorationRate: 0 });
  const neutralScore = tasteScore(candidate, { events: [], mealType: "점심", rng: () => 0.5, explorationRate: 0 });
  assert.equal(unratedScore, neutralScore);
});

test("an unrated meal does not narrow exploration uncertainty", () => {
  const unrated = {
    eventId: "unrated-exploration",
    category: "도시락",
    restaurant: "밥집",
    menu: "제육덮밥",
    rating: null,
    tags: [],
    mealType: "점심",
    respondentId: "respondent-unrated-exploration",
    source: "scheduled-cache",
    normalizationStatus: "verified-source"
  };
  const sequence = [0.23, 0.71, 0.44, 0.82, 0.31, 0.66];
  const rngFor = () => {
    let index = 0;
    return () => sequence[index++ % sequence.length];
  };
  const unratedScore = tasteScore(candidate, { events: [unrated], mealType: "점심", rng: rngFor(), explorationRate: 1 });
  const neutralScore = tasteScore(candidate, { events: [], mealType: "점심", rng: rngFor(), explorationRate: 1 });
  assert.equal(unratedScore, neutralScore);
});

test("a verified custom event still contributes through a matching menu", () => {
  const menuOnly = {
    eventId: "menu-only",
    restaurant: "다른밥집",
    menu: "제육덮밥",
    rating: 5,
    mealType: "점심",
    respondentId: "respondent-custom",
    source: "scheduled-cache",
    normalizationStatus: "verified"
  };
  const learnedScore = tasteScore(candidate, { events: [menuOnly], mealType: "점심", rng: () => 0.5, explorationRate: 0 });
  const neutralScore = tasteScore(candidate, { events: [], mealType: "점심", rng: () => 0.5, explorationRate: 0 });
  assert.ok(learnedScore > neutralScore);
});

test("taste learning merges equivalent menu spellings", () => {
  const event = {
    eventId: "futomaki-variant",
    restaurant: "후토루",
    menu: "연어후토마끼",
    rating: 5,
    mealType: "점심",
    respondentId: "respondent-futomaki",
    source: "scheduled-cache",
    normalizationStatus: "verified",
  };
  const target = { category: "일식", restaurant: "다른 상호", menu: "연어 후토마키" };
  const options = { mealType: "점심", rng: () => 0.5, explorationRate: 0 };
  assert.ok(
    tasteScore(target, { ...options, events: [event] })
      > tasteScore(target, { ...options, events: [] })
  );
});

test("taste learning merges audited restaurant-specific historical menu labels", () => {
  const now = new Date("2026-08-29T00:00:00.000Z");
  const posterior = tastePosterior({
    category: "회/해물",
    restaurant: "광장수산 덕진광장로점",
    menu: "광어(소)",
  }, {
    events: [{
      eventId: "meal-scoped-alias",
      respondentId: "respondent-scoped-alias",
      source: "scheduled-cache",
      normalizationStatus: "verified",
      category: "회/해물",
      restaurant: "광장수산",
      branch: "덕진광장로점",
      menu: "광어",
      rating: 5,
      createdAt: now.toISOString(),
    }],
    now,
  });

  assert.ok(posterior.alpha > 3);
  assert.equal(posterior.beta, 3);
});

test("candidate survey ratings improve or reduce ranking while 3 points stays neutral", () => {
  const responseFor = (rating) => ({
    responseId: `response-${rating}`,
    respondentId: "respondent-a",
    mealType: "점심",
    source: "scheduled-cache",
    submittedAt: "2026-07-14T00:00:00.000Z",
    ratings: [{ ...candidate, rating }]
  });
  const options = {
    mealType: "점심",
    rng: () => 0.5,
    explorationRate: 0,
    now: new Date("2026-07-14T01:00:00.000Z")
  };
  const neutralScore = tasteScore(candidate, options);
  const likedScore = tasteScore(candidate, { ...options, preferences: { responses: [responseFor(5)] } });
  const dislikedScore = tasteScore(candidate, { ...options, preferences: { responses: [responseFor(1)] } });
  const threePointScore = tasteScore(candidate, { ...options, preferences: { responses: [responseFor(3)] } });
  assert.ok(likedScore > neutralScore);
  assert.ok(dislikedScore < neutralScore);
  assert.equal(threePointScore, neutralScore);
});

test("survey preferences remain weaker than an equally rated actually eaten meal", () => {
  const actualMeal = {
    eventId: "actual",
    ...candidate,
    rating: 5,
    mealType: "점심",
    respondentId: "respondent-actual",
    source: "scheduled-cache",
    normalizationStatus: "verified-source",
    createdAt: "2026-07-14T00:00:00.000Z"
  };
  const preference = {
    responseId: "survey",
    respondentId: "respondent-a",
    mealType: "점심",
    source: "scheduled-cache",
    submittedAt: "2026-07-14T00:00:00.000Z",
    ratings: [{ ...candidate, rating: 5 }]
  };
  const options = {
    mealType: "점심",
    rng: () => 0.5,
    explorationRate: 0,
    now: new Date("2026-07-14T01:00:00.000Z")
  };
  const actualScore = tasteScore(candidate, { ...options, events: [actualMeal] });
  const surveyScore = tasteScore(candidate, { ...options, preferences: { responses: [preference] } });
  assert.ok(actualScore > surveyScore);
});

test("private DM survey data does not change production taste ranking", () => {
  const privatePreference = {
    responseId: "private-survey",
    respondentId: "respondent-a",
    mealType: "점심",
    source: "manual-private-test",
    submittedAt: "2026-07-14T00:00:00.000Z",
    ratings: [{ ...candidate, rating: 5 }]
  };
  const options = { mealType: "점심", rng: () => 0.5, explorationRate: 0 };
  assert.equal(
    tasteScore(candidate, { ...options, preferences: { responses: [privatePreference] } }),
    tasteScore(candidate, options)
  );
});

test("a later private DM rating cannot hide a production rating on the same day", () => {
  const production = {
    responseId: "production-rating", respondentId: "respondent-a", mealType: "점심",
    source: "scheduled-cache", submittedAt: "2026-07-14T00:00:00.000Z",
    ratings: [{ ...candidate, rating: 5 }]
  };
  const privateTest = {
    ...production, responseId: "private-rating", source: "manual-private-test",
    submittedAt: "2026-07-14T00:05:00.000Z",
    ratings: [{ ...candidate, rating: 1 }]
  };
  const options = { mealType: "점심", now: new Date("2026-07-14T01:00:00.000Z") };
  assert.deepEqual(
    tastePosterior(candidate, { ...options, preferences: { responses: [production, privateTest] } }),
    tastePosterior(candidate, { ...options, preferences: { responses: [production] } })
  );
});

test("a verified multi-menu meal learns both menus without doubling the event signal", () => {
  const multi = {
    eventId: "multi",
    category: "중식",
    restaurant: "반점",
    menu: "짜장면 · 짬뽕",
    menus: ["짜장면", "짬뽕"],
    rating: 5,
    mealType: "저녁",
    respondentId: "respondent-multi",
    source: "scheduled-cache",
    normalizationStatus: "verified"
  };
  const options = { events: [multi], mealType: "저녁", rng: () => 0.5, explorationRate: 0 };
  const neutral = tasteScore({ category: "중식", restaurant: "다른집", menu: "탕수육" }, { ...options, events: [] });
  const jjajang = tasteScore({ category: "중식", restaurant: "반점", menu: "짜장면" }, options);
  const jjambbong = tasteScore({ category: "중식", restaurant: "반점", menu: "짬뽕" }, options);
  assert.ok(jjajang > neutral);
  assert.equal(jjajang, jjambbong);
});

test("pending custom records do not train preference before model verification", () => {
  const pending = {
    eventId: "pending",
    category: "도시락",
    restaurant: "밥집",
    menu: "제육덮밥",
    rating: 5,
    mealType: "점심",
    respondentId: "respondent-pending",
    source: "scheduled-cache",
    normalizationStatus: "pending"
  };
  const options = { mealType: "점심", rng: () => 0.5, explorationRate: 0 };
  assert.equal(
    tasteScore(candidate, { ...options, events: [pending] }),
    tasteScore(candidate, { ...options, events: [] })
  );
});

test("terminal unverified custom records never train preference", () => {
  const unverified = {
    eventId: "unverified",
    category: "도시락",
    restaurant: "밥집",
    menu: "제육덮밥",
    rating: 5,
    mealType: "점심",
    respondentId: "respondent-unverified",
    source: "scheduled-cache",
    normalizationStatus: "unverified",
    normalizationAttemptCount: 3
  };
  const options = { mealType: "점심", rng: () => 0.5, explorationRate: 0 };
  assert.equal(
    tasteScore(candidate, { ...options, events: [unverified] }),
    tasteScore(candidate, { ...options, events: [] })
  );
});

test("legacy custom meals without verification do not train preference", () => {
  const legacy = {
    eventId: "legacy-custom",
    ...candidate,
    rating: 5,
    mealType: "점심"
  };
  const options = { mealType: "점심", rng: () => 0.5, explorationRate: 0 };
  assert.equal(
    tasteScore(candidate, { ...options, events: [legacy] }),
    tasteScore(candidate, { ...options, events: [] })
  );
});

test("legacy survey responses without a respondent do not train preference", () => {
  const legacy = {
    responseId: "legacy-survey",
    mealType: "점심",
    source: "scheduled-cache",
    submittedAt: "2026-07-14T00:00:00.000Z",
    ratings: [{ ...candidate, rating: 1 }]
  };
  const options = { mealType: "점심", rng: () => 0.5, explorationRate: 0 };
  assert.equal(
    tasteScore(candidate, { ...options, preferences: { responses: [legacy] } }),
    tasteScore(candidate, options)
  );
});

test("one respondent contributes at most the latest survey vote per candidate per day", () => {
  const response = (responseId, respondentId, rating, submittedAt) => ({
    responseId,
    respondentId,
    mealType: "점심",
    source: "scheduled-cache",
    submittedAt,
    ratings: [{ ...candidate, rating }]
  });
  const latest = response("new", "respondent-a", 1, "2026-07-14T01:00:00.000Z");
  const repeated = {
    responses: [
      response("old", "respondent-a", 5, "2026-07-14T00:00:00.000Z"),
      latest
    ]
  };
  const options = {
    mealType: "점심",
    rng: () => 0.5,
    explorationRate: 0,
    now: new Date("2026-07-14T02:00:00.000Z")
  };
  assert.equal(
    tasteScore(candidate, { ...options, preferences: repeated }),
    tasteScore(candidate, { ...options, preferences: { responses: [latest] } })
  );
  assert.ok(
    tasteScore(candidate, {
      ...options,
      preferences: { responses: [latest, response("other", "respondent-b", 1, "2026-07-14T01:00:00.000Z")] }
    }) < tasteScore(candidate, { ...options, preferences: { responses: [latest] } })
  );
});

test("separate-day surveys contribute with a bounded taper, including changed opinions", () => {
  const response = (day, rating) => ({
    responseId: day,
    respondentId: "repeat-respondent",
    date: day,
    mealType: "점심",
    source: "scheduled-cache",
    submittedAt: `${day}T00:00:00.000Z`,
    ratings: [{ ...candidate, rating }]
  });
  const now = new Date("2026-07-20T00:00:00.000Z");
  const single = tastePosterior(candidate, {
    preferences: { responses: [response("2026-07-20", 5)] }, now
  });
  const repeated = tastePosterior(candidate, {
    preferences: { responses: [
      response("2026-07-20", 5), response("2026-07-19", 5),
      response("2026-07-18", 5), response("2026-07-17", 5)
    ] }, now
  });
  const reversed = tastePosterior(candidate, {
    preferences: { responses: [response("2026-07-19", 5), response("2026-07-20", 1)] }, now
  });
  assert.ok(repeated.mean > single.mean);
  assert.ok(repeated.sources.surveyPositive < 1.58, "one person is capped below two full survey votes");
  assert.ok(reversed.mean < 0.5, "the latest changed opinion remains dominant");
});

test("one respondent contributes at most the latest actual-meal signal per candidate", () => {
  const actual = (eventId, rating, createdAt) => ({
    eventId,
    respondentId: "respondent-a",
    source: "scheduled-cache",
    ...candidate,
    rating,
    mealType: "점심",
    normalizationStatus: "verified-source",
    createdAt
  });
  const latest = actual("actual-new", 1, "2026-07-14T01:00:00.000Z");
  const options = {
    mealType: "점심",
    rng: () => 0.5,
    explorationRate: 0,
    now: new Date("2026-07-14T02:00:00.000Z")
  };
  assert.equal(
    tasteScore(candidate, { ...options, events: [actual("actual-old", 5, "2026-07-14T00:00:00.000Z"), latest] }),
    tasteScore(candidate, { ...options, events: [latest] })
  );
});

test("Beta(3,3) prior keeps one or two fresh feedback effects gradual", () => {
  const timestamp = "2026-07-14T00:00:00.000Z";
  const options = {
    mealType: "점심",
    rng: () => 0.5,
    explorationRate: 0,
    now: new Date(timestamp)
  };
  const actualWeight = 1;
  const surveyWeight = actualWeight * 0.9;
  const actualEvent = {
    eventId: "quantified-actual",
    ...candidate,
    rating: 5,
    mealType: "점심",
    respondentId: "respondent-quantified",
    source: "scheduled-cache",
    normalizationStatus: "verified-source",
    createdAt: timestamp
  };
  const actual = tasteScore(candidate, { ...options, events: [actualEvent] });
  const survey = (responseId, respondentId) => ({
    responseId,
    respondentId,
    mealType: "점심",
    source: "scheduled-cache",
    submittedAt: timestamp,
    ratings: [{ ...candidate, rating: 5 }]
  });
  const oneSurvey = tasteScore(candidate, {
    ...options,
    preferences: { responses: [survey("survey-a", "respondent-a")] }
  });
  const twoSurveys = tasteScore(candidate, {
    ...options,
    preferences: { responses: [
      survey("survey-a", "respondent-a"),
      survey("survey-b", "respondent-b")
    ] }
  });

  assert.ok(Math.abs(actual - ((3 + actualWeight) / (6 + actualWeight))) < 1e-12);
  assert.ok(Math.abs(oneSurvey - ((3 + surveyWeight) / (6 + surveyWeight))) < 1e-12);
  assert.ok(Math.abs(twoSurveys - ((3 + 2 * surveyWeight) / (6 + 2 * surveyWeight))) < 1e-12);
  assert.ok(actual - 0.5 < 0.072);
  assert.ok(oneSurvey - 0.5 < 0.066);
  assert.ok(twoSurveys - 0.5 < 0.116);

  const preference = survey("canonical-survey", "canonical-respondent");
  const posteriorOptions = {
    events: [actualEvent],
    preferences: { responses: [preference] },
    mealType: "점심",
    now: new Date(timestamp)
  };
  const posterior = tastePosterior(candidate, posteriorOptions);
  assert.equal(posterior.alpha, 3 + actualWeight + surveyWeight);
  assert.equal(posterior.beta, 3);
  assert.equal(posterior.mean, posterior.alpha / (posterior.alpha + posterior.beta));
  assert.equal(posterior.bias, posterior.mean * 2 - 1);
  assert.ok(Math.abs(posterior.evidenceWeight - (actualWeight + surveyWeight)) < 1e-12);
  assert.equal(posterior.confidence, posterior.evidenceWeight / (posterior.evidenceWeight + 2));
  assert.deepEqual(posterior.sources, {
    mealPositive: actualWeight,
    mealNegative: 0,
    surveyPositive: surveyWeight,
    surveyNegative: 0
  });
  assert.ok(posterior.intervalLow >= 0 && posterior.intervalLow < posterior.mean);
  assert.ok(posterior.intervalHigh <= 1 && posterior.intervalHigh > posterior.mean);
  assert.equal(tasteScore(candidate, { ...posteriorOptions, explorationRate: 0 }), posterior.mean);
  assert.deepEqual(tastePosterior(candidate), {
    alpha: 3,
    beta: 3,
    mean: 0.5,
    bias: 0,
    evidenceWeight: 0,
    confidence: 0,
    intervalLow: 0.1891242209499106,
    intervalHigh: 0.8108757790500893,
    sources: {
      mealPositive: 0,
      mealNegative: 0,
      surveyPositive: 0,
      surveyNegative: 0
    }
  });
});
