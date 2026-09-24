import crypto from "node:crypto";
import {
  config,
  assertRecommendationMode,
  REQUIRED_LUNCH_CHANNEL_ID,
  REQUIRED_OPERATOR_DM_CHANNEL_ID
} from "./config.js";
import { buildCodexCliMealResponse } from "./codex-cli.js";
import { normalizeMealType } from "./meal-types.js";
import { buildMealMessage } from "./message.js";
import { getCachedRecommendations, getRecommendations } from "./recommender.js";
import { assertSlackPostResult, postMessage } from "./slack.js";
import {
  appendRecommendationHistory,
  appendSentMessage,
  getPreparedDelivery,
  getRecommendationHistory,
  getSentMessageByClientMsgId,
  removePreparedDelivery,
  savePreparedDelivery
} from "./storage.js";
import { cleanupOldMessages } from "./cleanup.js";
import { logWarn } from "./logger.js";
import { getWeatherAlert } from "./weather.js";
import { validateRecommendationBatchForDelivery } from "./operating-data-integrity.js";

const DEFAULT_DEPENDENCIES = Object.freeze({
  buildCodexCliMealResponse,
  buildMealMessage,
  getCachedRecommendations,
  getRecommendations,
  postMessage,
  appendRecommendationHistory,
  appendSentMessage,
  getPreparedDelivery,
  getRecommendationHistory,
  getSentMessageByClientMsgId,
  removePreparedDelivery,
  savePreparedDelivery,
  cleanupOldMessages,
  logWarn,
  getWeatherAlert,
  validateRecommendationBatchForDelivery
});

function dependenciesWith(overrides = {}) {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function assertDeliveryInput({ channel, source, mode, dryRun }) {
  if (dryRun) return;
  if (!/^[CGD][A-Z0-9]+$/.test(String(channel || ""))) {
    throw new Error("channel must be a Slack channel or conversation ID");
  }
  const normalizedSource = String(source || "").trim();
  if (!normalizedSource) {
    throw new Error("source is required for a delivered meal");
  }
  const scheduledMeal = channel === REQUIRED_LUNCH_CHANNEL_ID
    && mode === "cache"
    && normalizedSource === "scheduled-cache";
  const privateTest = channel === REQUIRED_OPERATOR_DM_CHANNEL_ID
    && mode === "cache"
    && normalizedSource === "manual-private-test";
  if (!scheduledMeal && !privateTest) {
    throw new Error(
      "live meal delivery is limited to scheduled-cache on the protected lunch channel or manual-private-test on the protected operator DM"
    );
  }
}

function scheduledClientMessageId({ channel, mealType, source, now = new Date() }) {
  if (!String(source || "").startsWith("scheduled-")) return undefined;
  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  const hex = crypto.createHash("sha256")
    .update(`${channel}:${mealType}:${dateKey}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function deterministicRecommendationRng(seed) {
  const normalizedSeed = String(seed || "").trim();
  if (!normalizedSeed) throw new Error("Deterministic recommendation RNG requires a seed");
  let counter = 0;
  return () => {
    const digest = crypto.createHash("sha256")
      .update(`${normalizedSeed}:${counter}`)
      .digest();
    counter += 1;
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  };
}

function persistedDeliveryResponse(response) {
  return {
    recommendations: structuredClone(response.recommendations),
    text: response.text,
    blocks: structuredClone(response.blocks),
    generationMode: response.generationMode,
    fallbackUsed: response.fallbackUsed,
    ...(response.fallbackReason ? { fallbackReason: response.fallbackReason } : {})
  };
}

function assertPreparedDeliveryTarget(prepared, {
  channel,
  mealType,
  source,
  requestedMode
}) {
  if (prepared.channel !== channel
      || prepared.mealType !== mealType
      || (source !== undefined && prepared.source !== source)
      || (requestedMode !== undefined && prepared.requestedMode !== requestedMode)) {
    throw new Error(`Prepared delivery ${prepared.clientMsgId} does not match the requested target`);
  }
}

function assertCommittedDeliveryTarget(committed, { channel, mealType, clientMsgId }) {
  if (committed.channel !== channel || committed.mealType !== mealType || committed.clientMsgId !== clientMsgId) {
    throw new Error(`Committed delivery ${clientMsgId} does not match the requested target`);
  }
}

function assertPreparedMatchesCommit(prepared, committed) {
  assertPreparedDeliveryTarget(prepared, committed);
  const comparisons = [
    ["clientMsgId", prepared.clientMsgId, committed.clientMsgId],
    ["source", prepared.source, committed.source],
    ["requestedMode", prepared.requestedMode, committed.requestedMode],
    ["generationMode", prepared.response?.generationMode, committed.generationMode],
    ["fallbackUsed", prepared.response?.fallbackUsed, committed.fallbackUsed],
    ["fallbackReason", prepared.response?.fallbackReason || "", committed.fallbackReason || ""]
  ];
  const mismatch = comparisons.find(([, preparedValue, committedValue]) => preparedValue !== committedValue);
  if (mismatch) {
    throw new Error(`Prepared delivery ${prepared.clientMsgId} conflicts with committed ${mismatch[0]}`);
  }
}

function historyItemsForCommit(store, committed) {
  return store.items.filter((item) => item.channel === committed.channel && item.messageTs === committed.ts);
}

function responseFromCommittedDelivery({ prepared, historyItems, committed, deps }) {
  if (prepared) return structuredClone(prepared.response);
  const recommendations = structuredClone(historyItems);
  return {
    recommendations,
    ...deps.buildMealMessage({
      mealType: committed.mealType,
      recommendations,
      feedbackEnabled: config.enableMealFeedback,
      observatoryEnabled: config.enableObservatoryLink,
      observatoryUrl: config.observatoryUrl,
      interactionSource: committed.source,
      timezone: config.timezone
    }),
    generationMode: committed.generationMode,
    fallbackUsed: committed.fallbackUsed,
    ...(committed.fallbackReason ? { fallbackReason: committed.fallbackReason } : {})
  };
}

function clearPreparedDelivery(deps, clientMsgId) {
  try {
    deps.removePreparedDelivery(clientMsgId);
  } catch (error) {
    deps.logWarn("[meal] committed delivery but could not clear its durable outbox entry:", error.message);
  }
}

export async function buildMealResponse({
  mealType,
  mode = config.recommendationMode,
  source = "",
  rng,
  dependencies
} = {}) {
  assertRecommendationMode(mode);
  const normalizedMealType = normalizeMealType(mealType || "meal");
  const deps = dependenciesWith(dependencies);

  if (mode === "codex-cli") {
    try {
      const response = await deps.buildCodexCliMealResponse({ mealType: normalizedMealType });
      const weather = await safeWeather(deps, normalizedMealType);
      return {
        ...response,
        ...deps.buildMealMessage({
          mealType: normalizedMealType,
          recommendations: response.recommendations,
          weatherAlert: weather?.text || "",
          headerEmoji: weather?.headerEmoji || "🍽️",
          feedbackEnabled: config.enableMealFeedback,
          observatoryEnabled: config.enableObservatoryLink,
          observatoryUrl: config.observatoryUrl,
          interactionSource: source,
          timezone: config.timezone
        }),
        weather,
        generationMode: "codex-cli",
        fallbackUsed: false
      };
    } catch (error) {
      if (!config.codexCliFallbackToCache) throw error;
      deps.logWarn("[meal] codex-cli failed; falling back to local cache:", error.message);
      const recommendations = deps.getCachedRecommendations({
        mealType: normalizedMealType,
        ...(rng ? { rng } : {})
      });
      const weather = await safeWeather(deps, normalizedMealType);
      return {
        recommendations,
        ...deps.buildMealMessage({
          mealType: normalizedMealType,
          recommendations,
          weatherAlert: weather?.text || "",
          headerEmoji: weather?.headerEmoji || "🍽️",
          feedbackEnabled: config.enableMealFeedback,
          observatoryEnabled: config.enableObservatoryLink,
          observatoryUrl: config.observatoryUrl,
          interactionSource: source,
          timezone: config.timezone
        }),
        weather,
        generationMode: "cache",
        fallbackUsed: true,
        fallbackReason: error.message
      };
    }
  }

  const recommendations = await deps.getRecommendations({
    mealType: normalizedMealType,
    mode,
    ...(rng ? { rng } : {})
  });
  const weather = await safeWeather(deps, normalizedMealType);
  return {
    recommendations,
    ...deps.buildMealMessage({
      mealType: normalizedMealType,
      recommendations,
      weatherAlert: weather?.text || "",
      headerEmoji: weather?.headerEmoji || "🍽️",
      feedbackEnabled: config.enableMealFeedback,
      observatoryEnabled: config.enableObservatoryLink,
      observatoryUrl: config.observatoryUrl,
      interactionSource: source,
      timezone: config.timezone
    }),
    weather,
    generationMode: mode,
    fallbackUsed: false
  };
}

async function safeWeather(deps, mealType) {
  try {
    const weather = await deps.getWeatherAlert({ mealType });
    if (weather?.warningStatus === "unavailable") {
      deps.logWarn("[meal] KMA warning lookup unavailable; continuing with forecast data:", weather.warningError || "unknown warning error");
    }
    if (weather?.airQualityStatus === "unavailable") {
      deps.logWarn("[meal] AirKorea lookup unavailable; continuing with KMA forecast data:", weather.airQualityError || "unknown air-quality error");
    }
    if (weather?.uvStatus === "unavailable") {
      deps.logWarn("[meal] KMA UV lookup unavailable; continuing without a UV warning:", weather.uvError || "unknown UV error");
    }
    if (weather?.airQualityWarningStatus === "unavailable") {
      deps.logWarn("[meal] AirKorea warning lookup unavailable; continuing with station measurements:", weather.airQualityWarningError || "unknown AirKorea warning error");
    }
    return weather;
  } catch (error) {
    deps.logWarn("[meal] weather unavailable; omitting weather line:", error.message);
    return null;
  }
}

export async function executeMeal({
  channel,
  mealType,
  mode = config.recommendationMode,
  source,
  dryRun = false,
  dependencies
} = {}) {
  assertDeliveryInput({ channel, source, mode, dryRun });
  const normalizedMealType = normalizeMealType(mealType || "meal");
  const deps = dependenciesWith(dependencies);
  const clientMsgId = dryRun ? undefined : scheduledClientMessageId({
    channel,
    mealType: normalizedMealType,
    source
  });
  const recommendationRng = clientMsgId ? deterministicRecommendationRng(clientMsgId) : undefined;
  let effectiveSource = source;
  let effectiveMode = mode;
  let prepared = clientMsgId ? deps.getPreparedDelivery(clientMsgId) : null;
  const committed = clientMsgId ? deps.getSentMessageByClientMsgId(clientMsgId) : null;
  let response;
  if (committed) {
    assertCommittedDeliveryTarget(committed, {
      channel,
      mealType: normalizedMealType,
      clientMsgId
    });
    if (prepared) assertPreparedMatchesCommit(prepared, committed);
    const history = deps.getRecommendationHistory();
    let historyItems = historyItemsForCommit(history, committed);
    let recovered = false;
    if (historyItems.length === 0) {
      if (!prepared) {
        throw new Error(`Committed delivery ${clientMsgId} has no recommendation history or exact outbox payload; refusing to resend`);
      }
      deps.appendRecommendationHistory({
        recommendations: prepared.response.recommendations,
        channel: committed.channel,
        messageTs: committed.ts,
        mealType: committed.mealType,
        source: committed.source,
        requestedMode: committed.requestedMode,
        generationMode: committed.generationMode,
        fallbackUsed: committed.fallbackUsed,
        ...(committed.fallbackReason ? { fallbackReason: committed.fallbackReason } : {}),
        retentionDays: config.historyRetentionDays
      });
      historyItems = structuredClone(prepared.response.recommendations);
      recovered = true;
    }
    if (prepared) clearPreparedDelivery(deps, clientMsgId);
    response = responseFromCommittedDelivery({ prepared, historyItems, committed, deps });
    return {
      ...response,
      delivery: {
        sent: true,
        alreadySent: true,
        ...(recovered ? { recovered: true } : {}),
        channel: committed.channel,
        ts: committed.ts,
        sentAt: committed.sentAt
      }
    };
  }
  if (prepared) {
    assertPreparedDeliveryTarget(prepared, {
      channel,
      mealType: normalizedMealType,
      source,
      requestedMode: mode
    });
    effectiveSource = prepared.source;
    effectiveMode = prepared.requestedMode;
    response = structuredClone(prepared.response);
  } else {
    response = await buildMealResponse({
      mealType: normalizedMealType,
      mode,
      source,
      rng: recommendationRng,
      dependencies: deps
    });
  }

  deps.validateRecommendationBatchForDelivery(response.recommendations, {
    mealType: normalizedMealType,
    source: effectiveSource || source
  });

  if (dryRun) {
    return { ...response, delivery: { sent: false } };
  }

  if (clientMsgId && !prepared) {
    prepared = deps.savePreparedDelivery({
      clientMsgId,
      channel,
      mealType: normalizedMealType,
      source,
      requestedMode: mode,
      preparedAt: new Date().toISOString(),
      response: persistedDeliveryResponse(response)
    });
    assertPreparedDeliveryTarget(prepared, {
      channel,
      mealType: normalizedMealType,
      source,
      requestedMode: mode
    });
    effectiveSource = prepared.source;
    effectiveMode = prepared.requestedMode;
    response = structuredClone(prepared.response);
  }

  const result = assertSlackPostResult(await deps.postMessage({
    channel,
    text: response.text,
    blocks: response.blocks,
    clientMsgId,
    messagePurpose: "meal-recommendation"
  }), channel);
  const sentAt = new Date().toISOString();
  const provenance = {
    source: effectiveSource,
    requestedMode: effectiveMode,
    generationMode: response.generationMode,
    fallbackUsed: response.fallbackUsed,
    ...(response.fallbackReason ? { fallbackReason: response.fallbackReason } : {})
  };
  deps.appendSentMessage({
    channel: result.channel,
    ts: result.ts,
    ...(clientMsgId ? { clientMsgId } : {}),
    mealType: normalizedMealType,
    ...provenance,
    sentAt
  });
  deps.appendRecommendationHistory({
    recommendations: response.recommendations,
    channel: result.channel,
    messageTs: result.ts,
    mealType: normalizedMealType,
    ...provenance,
    retentionDays: config.historyRetentionDays
  });
  if (clientMsgId) {
    clearPreparedDelivery(deps, clientMsgId);
  }
  try {
    await deps.cleanupOldMessages(result.channel);
  } catch (error) {
    deps.logWarn("[meal] message cleanup failed after successful delivery:", error.message);
  }

  return {
    ...response,
    delivery: {
      sent: true,
      channel: result.channel,
      ts: result.ts,
      sentAt
    }
  };
}
