import { config } from "./config.js";
import {
  OPEN_OBSERVATORY_ACTION_ID,
  RECORD_ACTUAL_MEAL_ACTION_ID,
  SURVEY_RECOMMENDATIONS_ACTION_ID,
  TOGGLE_COFFEE_ACTION_ID
} from "./interaction-actions.js";
import {
  buildCandidatePreferenceConfirmation,
  candidatePreferenceModalForBlockAction,
  persistCandidatePreferenceSubmission
} from "./candidate-preference.js";
import {
  buildCoffeeMessageUpdate,
  coffeeTargetForBlockAction,
  restoreCoffeeParticipation,
  toggleCoffeeParticipation
} from "./coffee-participation.js";
import { slackApi } from "./slack.js";
import {
  buildMealSubmissionConfirmation,
  modalForBlockAction,
  persistMealSubmission
} from "./meal-feedback.js";
import { logInfo, logWarn } from "./logger.js";
import {
  scheduleMealEventNormalization,
  schedulePendingMealNormalizations
} from "./meal-event-normalizer.js";

const coffeeQueues = new Map();
const processedEnvelopes = new Map();
const ENVELOPE_REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_PROCESSED_ENVELOPES = 5000;

function ack(socket, envelopeId, payload) {
  socket.send(JSON.stringify({ envelope_id: envelopeId, ...(payload ? { payload } : {}) }));
}

async function enqueueCoffeeUpdate(key, task) {
  const previous = coffeeQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  coffeeQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (coffeeQueues.get(key) === current) coffeeQueues.delete(key);
  }
}

function claimEnvelope(envelopeId, now = Date.now()) {
  const cutoff = now - ENVELOPE_REPLAY_TTL_MS;
  for (const [key, timestamp] of processedEnvelopes) {
    if (timestamp >= cutoff) break;
    processedEnvelopes.delete(key);
  }
  if (processedEnvelopes.has(envelopeId)) return false;
  processedEnvelopes.set(envelopeId, now);
  while (processedEnvelopes.size > MAX_PROCESSED_ENVELOPES) {
    processedEnvelopes.delete(processedEnvelopes.keys().next().value);
  }
  return true;
}

async function processSocketEnvelope(envelope, {
  socket,
  slackCall = slackApi,
  modalBuilder = modalForBlockAction,
  persistSubmission = persistMealSubmission,
  preferenceModalBuilder = candidatePreferenceModalForBlockAction,
  persistPreferenceSubmission = persistCandidatePreferenceSubmission,
  toggleCoffee = toggleCoffeeParticipation,
  restoreCoffee = restoreCoffeeParticipation,
  coffeeUpdateBuilder = buildCoffeeMessageUpdate,
  scheduleMealNormalization = scheduleMealEventNormalization
} = {}) {
  const payload = envelope.payload;
  if (!envelope.envelope_id || !payload) return false;

  if (payload.type === "block_actions" && payload.actions?.some((item) => item.action_id === OPEN_OBSERVATORY_ACTION_ID)) {
    ack(socket, envelope.envelope_id);
    return true;
  }

  if (payload.type === "block_actions" && payload.actions?.some((item) => item.action_id === RECORD_ACTUAL_MEAL_ACTION_ID)) {
    ack(socket, envelope.envelope_id);
    const view = modalBuilder(payload);
    await slackCall("views.open", { trigger_id: payload.trigger_id, view });
    return true;
  }

  if (payload.type === "block_actions" && payload.actions?.some((item) => item.action_id === SURVEY_RECOMMENDATIONS_ACTION_ID)) {
    ack(socket, envelope.envelope_id);
    const view = preferenceModalBuilder(payload);
    await slackCall("views.open", { trigger_id: payload.trigger_id, view });
    return true;
  }

  if (payload.type === "block_actions" && payload.actions?.some((item) => item.action_id === TOGGLE_COFFEE_ACTION_ID)) {
    ack(socket, envelope.envelope_id);
    const target = coffeeTargetForBlockAction(payload);
    const key = `${target.channel}:${target.messageTs}`;
    await enqueueCoffeeUpdate(key, async () => {
      const state = toggleCoffee(target);
      try {
        await slackCall("chat.update", coffeeUpdateBuilder(payload, state));
      } catch (error) {
        try {
          restoreCoffee(state);
        } catch (restoreError) {
          logWarn("[interactions] coffee participation rollback failed:", restoreError.message);
        }
        throw error;
      }
    });
    return true;
  }

  if (payload.type === "view_submission") {
    const result = persistSubmission(payload);
    if (result.handled) {
      ack(socket, envelope.envelope_id, result.errors
        ? { response_action: "errors", errors: result.errors }
        : { response_action: "update", view: buildMealSubmissionConfirmation({ duplicate: result.duplicate }) });
      if (!result.errors && !result.duplicate && result.event?.normalizationStatus === "pending") {
        Promise.resolve().then(() => scheduleMealNormalization(result.event.eventId)).catch((error) => {
          logWarn("[interactions] meal normalization failed:", error.message);
        });
      }
      return true;
    }
    const preferenceResult = persistPreferenceSubmission(payload);
    if (preferenceResult.handled) {
      ack(socket, envelope.envelope_id, preferenceResult.errors
        ? { response_action: "errors", errors: preferenceResult.errors }
        : { response_action: "update", view: buildCandidatePreferenceConfirmation({ duplicate: preferenceResult.duplicate }) });
      return true;
    }
    ack(socket, envelope.envelope_id);
    return false;
  }

  ack(socket, envelope.envelope_id);
  return false;
}

export async function handleSocketEnvelope(envelope, options = {}) {
  const payload = envelope?.payload;
  const envelopeId = String(envelope?.envelope_id || "");
  if (!envelopeId || !payload) return false;
  if (!claimEnvelope(envelopeId)) {
    ack(options.socket, envelopeId);
    return true;
  }
  try {
    return await processSocketEnvelope(envelope, options);
  } catch (error) {
    processedEnvelopes.delete(envelopeId);
    throw error;
  }
}

async function connectionUrl() {
  const result = await slackApi("apps.connections.open", {}, config.slackAppToken);
  return result.url;
}

export async function runInteractionListener({ WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!config.enableMealFeedback) throw new Error("ENABLE_MEAL_FEEDBACK is disabled");
  if (!config.slackAppToken) throw new Error("SLACK_APP_TOKEN is missing");
  let retryMs = 1000;
  let pendingResumeStarted = false;
  const retryPending = () => schedulePendingMealNormalizations().then((results) => {
    if (results.length) logInfo(`[interactions] processed ${results.length} pending meal normalizations.`);
  }).catch((error) => logWarn("[interactions] pending meal normalization retry failed:", error.message));
  const normalizationRetryTimer = setInterval(retryPending, config.mealNormalizationRetryIntervalMs);
  normalizationRetryTimer.unref?.();

  for (;;) {
    try {
      const url = await connectionUrl();
      await new Promise((resolve, reject) => {
        const socket = new WebSocketImpl(url);
        let opened = false;
        socket.addEventListener("open", () => {
          opened = true;
          retryMs = 1000;
          logInfo("[interactions] Socket Mode connected.");
          if (!pendingResumeStarted) {
            pendingResumeStarted = true;
            retryPending();
          }
        });
        socket.addEventListener("message", async (event) => {
          try {
            const envelope = JSON.parse(String(event.data));
            if (envelope.type === "disconnect") socket.close();
            else await handleSocketEnvelope(envelope, { socket });
          } catch (error) {
            logWarn("[interactions] payload failed:", error.message);
          }
        });
        socket.addEventListener("error", () => reject(new Error("Socket Mode connection error")));
        socket.addEventListener("close", () => opened ? resolve() : reject(new Error("Socket Mode closed before opening")));
      });
    } catch (error) {
      logWarn("[interactions] reconnecting after error:", error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    retryMs = Math.min(retryMs * 2, config.interactionReconnectMaxMs);
  }
}
