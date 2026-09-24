import { config } from "./config.js";
import {
  canonicalizeMenuForRestaurant,
  canonicalizeRestaurantIdentity,
  normalizeKey,
  normalizeMenuKey,
} from "./text.js";
import {
  isLearningCandidatePreferenceResponse,
  isLearningMealEvent
} from "./history-policy.js";
import { expandMealEvents } from "./meal-event-items.js";

function safeRandom(rng) {
  return Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, rng()));
}

function sampleNormal(rng) {
  const u = safeRandom(rng);
  const v = safeRandom(rng);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleGamma(shape, rng) {
  if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(safeRandom(rng), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleNormal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = safeRandom(rng);
    if (u < 1 - 0.0331 * Math.pow(x, 4)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha, beta, rng = Math.random) {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

function outcomeFor(event) {
  const rating = event.rating === null || event.rating === undefined || event.rating === ""
    ? null
    : Number(event.rating);
  const tags = new Set(event.tags || []);
  if (tags.has("다시 안 먹기") || tags.has("비추천") || (Number.isFinite(rating) && rating <= 2)) return 0;
  if (tags.has("재주문") || (Number.isFinite(rating) && rating >= 4)) return 1;
  return null;
}

function surveySignalFor(ratingValue) {
  const rating = Number(ratingValue);
  if (rating === 1) return { outcome: 0, confidence: 1 };
  if (rating === 2) return { outcome: 0, confidence: 0.5 };
  if (rating === 4) return { outcome: 1, confidence: 0.5 };
  if (rating === 5) return { outcome: 1, confidence: 1 };
  return null;
}

function tasteIdentity(record = {}) {
  const identity = canonicalizeRestaurantIdentity(record);
  return {
    restaurant: normalizeKey(identity.restaurant),
    menu: normalizeMenuKey(canonicalizeMenuForRestaurant({
      restaurant: identity.restaurant,
      menu: record.menu,
    })),
  };
}

function preferenceRatings(preferences) {
  const responses = Array.isArray(preferences)
    ? preferences
    : Array.isArray(preferences?.responses)
      ? preferences.responses
      : [];
  const flattened = responses.flatMap((response) => {
    if (Array.isArray(response?.ratings)) {
      return response.ratings.map((rating, index) => ({
        ...rating,
        responseId: response.responseId,
        respondentId: response.respondentId,
        responseRatingIndex: index,
        mealType: response.mealType,
        source: response.source,
        date: response.date,
        createdAt: response.updatedAt || response.submittedAt || response.createdAt
      }));
    }
    return response && typeof response === "object" ? [response] : [];
  });
  // Repeated surveys on different days are useful evidence, but one person
  // must not count like an unlimited number of independent respondents.
  // Keep the latest vote per day and taper up to three distinct days.
  const byRespondentMenu = new Map();
  for (const rating of flattened.filter(isLearningCandidatePreferenceResponse)) {
    const respondent = String(rating.respondentId || "");
    const identity = tasteIdentity(rating);
    const candidateKey = `${identity.restaurant}:${identity.menu}`;
    const key = respondent && candidateKey !== ":"
      ? `respondent:${respondent}:${candidateKey}`
      : `legacy:${rating.responseId || "direct"}:${rating.responseRatingIndex ?? byRespondentMenu.size}`;
    const group = byRespondentMenu.get(key) || [];
    group.push(rating);
    byRespondentMenu.set(key, group);
  }
  const weighted = [];
  for (const group of byRespondentMenu.values()) {
    group.sort((left, right) => (Date.parse(right.createdAt || "") || 0)
      - (Date.parse(left.createdAt || "") || 0));
    const seenDays = new Set();
    for (const rating of group) {
      const day = /^\d{4}-\d{2}-\d{2}$/u.test(String(rating.date || ""))
        ? rating.date
        : /^\d{4}-\d{2}-\d{2}/u.exec(String(rating.createdAt || ""))?.[0]
          || String(rating.responseId || rating.responseRatingIndex || "undated");
      if (seenDays.has(day)) continue;
      const observationScale = [1, 0.5, 0.25][seenDays.size];
      if (observationScale === undefined) break;
      seenDays.add(day);
      weighted.push({ ...rating, observationScale });
    }
  }
  return weighted;
}

function uniqueMealEvents(events) {
  const unique = new Map();
  for (const event of expandMealEvents(events.filter(isLearningMealEvent))) {
    const identity = tasteIdentity(event);
    const key = [
      event.respondentId,
      identity.restaurant,
      identity.menu,
    ].join(":");
    const previous = unique.get(key);
    const previousTime = Date.parse(previous?.createdAt || previous?.eatenAt || "");
    const nextTime = Date.parse(event.createdAt || event.eatenAt || "");
    if (!previous || !Number.isFinite(previousTime) || !Number.isFinite(nextTime) || nextTime >= previousTime) {
      unique.set(key, event);
    }
  }
  return [...unique.values()];
}

function matchWeight(candidate, event, mealType, now, halfLifeDays) {
  let weight = 0;
  const candidateIdentity = tasteIdentity(candidate);
  const eventIdentity = tasteIdentity(event);
  const sameRestaurant = candidateIdentity.restaurant === eventIdentity.restaurant;
  const sameMenu = candidateIdentity.menu === eventIdentity.menu;
  if (sameRestaurant && sameMenu) weight += 2;
  else if (sameMenu) weight += 1.5;
  else if (sameRestaurant) weight += 1;
  if (candidate.category && candidate.category === event.category) weight += 0.25;
  if (mealType && event.mealType === mealType) weight *= 1.15;
  // Similarity chooses how much one response transfers to this candidate;
  // it must not turn that response into several independent observations.
  // The exact menu/category/meal-time match is one effective observation.
  weight /= 2.25 * 1.15;
  const eventTime = Date.parse(event.createdAt || event.eatenAt || "");
  if (Number.isFinite(eventTime)) {
    const ageDays = Math.max(0, (now.getTime() - eventTime) / (24 * 60 * 60 * 1000));
    weight *= Math.pow(0.5, ageDays / halfLifeDays);
  }
  const signalScale = Number(event.menuSignalScale);
  if (Number.isFinite(signalScale) && signalScale > 0 && signalScale <= 1) weight *= signalScale;
  return weight;
}

export function tastePosterior(candidate, {
  events = [],
  preferences = [],
  mealType,
  halfLifeDays = config.tasteHalfLifeDays,
  priorAlpha = config.tastePriorAlpha,
  preferenceWeight = config.candidatePreferenceWeight,
  now = new Date()
} = {}) {
  if (!Number.isFinite(priorAlpha) || priorAlpha < 1) {
    throw new Error("Taste prior alpha must be a positive number");
  }
  let alpha = priorAlpha;
  let beta = priorAlpha;
  const sources = {
    mealPositive: 0,
    mealNegative: 0,
    surveyPositive: 0,
    surveyNegative: 0
  };
  const actualEvents = uniqueMealEvents(events);
  const ratedActualIdentities = new Set(actualEvents
    .filter((event) => outcomeFor(event) !== null)
    .map((event) => {
      const identity = tasteIdentity(event);
      return `${event.respondentId}:${identity.restaurant}:${identity.menu}`;
    }));
  for (const event of actualEvents) {
    const weight = matchWeight(candidate, event, mealType, now, halfLifeDays);
    if (!weight) continue;
    const outcome = outcomeFor(event);
    if (outcome === null) continue;
    const positiveWeight = weight * outcome;
    const negativeWeight = weight * (1 - outcome);
    alpha += positiveWeight;
    beta += negativeWeight;
    sources.mealPositive += positiveWeight;
    sources.mealNegative += negativeWeight;
  }
  for (const preference of preferenceRatings(preferences)) {
    const identity = tasteIdentity(preference);
    if (preference.respondentId && ratedActualIdentities.has(
      `${preference.respondentId}:${identity.restaurant}:${identity.menu}`
    )) continue;
    const signal = surveySignalFor(preference.rating);
    if (!signal) continue;
    const weight = matchWeight(candidate, preference, mealType, now, halfLifeDays)
      * preferenceWeight
      * signal.confidence
      * preference.observationScale;
    if (!weight) continue;
    const positiveWeight = weight * signal.outcome;
    const negativeWeight = weight * (1 - signal.outcome);
    alpha += positiveWeight;
    beta += negativeWeight;
    sources.surveyPositive += positiveWeight;
    sources.surveyNegative += negativeWeight;
  }
  const mean = alpha / (alpha + beta);
  const evidenceWeight = Math.max(0, alpha + beta - 2 * priorAlpha);
  const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
  const deviation = Math.sqrt(Math.max(0, variance));
  return {
    alpha,
    beta,
    mean,
    bias: mean * 2 - 1,
    evidenceWeight,
    confidence: evidenceWeight / (evidenceWeight + 2),
    intervalLow: Math.max(0, mean - 1.645 * deviation),
    intervalHigh: Math.min(1, mean + 1.645 * deviation),
    sources
  };
}

export function tasteScore(candidate, {
  events = [],
  preferences = [],
  mealType,
  rng = Math.random,
  explorationRate = config.tasteExplorationRate,
  halfLifeDays = config.tasteHalfLifeDays,
  priorAlpha = config.tastePriorAlpha,
  preferenceWeight = config.candidatePreferenceWeight,
  now = new Date()
} = {}) {
  const posterior = tastePosterior(candidate, {
    events,
    preferences,
    mealType,
    halfLifeDays,
    priorAlpha,
    preferenceWeight,
    now
  });
  const sampled = sampleBeta(posterior.alpha, posterior.beta, rng);
  return (1 - explorationRate) * posterior.mean + explorationRate * sampled;
}
