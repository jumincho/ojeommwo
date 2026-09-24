import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMealResponse,
  deterministicRecommendationRng,
  executeMeal
} from "../src/meal-service.js";
import {
  config,
  REQUIRED_LUNCH_CHANNEL_ID,
  REQUIRED_OPERATOR_DM_CHANNEL_ID
} from "../src/config.js";

const recommendations = [
  { category: "도시락", restaurant: "한식집", menu: "제육덮밥", priceText: "9,000원", comment: "매콤한 제육 양념과 따뜻한 밥이 든든하게 어우러져, 한입마다 진한 감칠맛을 즐길 수 있습니다.", evidence: ["test fixture evidence"] },
  { category: "중식", restaurant: "중식집", menu: "짬뽕", priceText: "10,000원", comment: "칼칼한 국물과 풍성한 해물이 조화롭게 어우러져, 따뜻하게 먹을수록 깊은 풍미가 살아납니다.", evidence: ["test fixture evidence"] },
  { category: "돈까스", restaurant: "일식집", menu: "돈카츠", priceText: "11,000원", comment: "바삭한 튀김옷과 촉촉한 고기가 진한 소스와 어우러져, 한입마다 고소한 풍미가 살아납니다.", evidence: ["test fixture evidence"] }
];

function messageFor({ mealType }) {
  return { text: `${mealType}:${recommendations.length}`, blocks: [{ type: "section" }] };
}

const noWeather = async () => null;

function inMemoryOutbox() {
  let prepared = null;
  return {
    getSentMessageByClientMsgId: () => null,
    getRecommendationHistory: () => ({ version: 1, items: [] }),
    getPreparedDelivery: (clientMsgId) => prepared?.clientMsgId === clientMsgId ? structuredClone(prepared) : null,
    savePreparedDelivery: (value) => {
      if (!prepared) prepared = structuredClone(value);
      return structuredClone(prepared);
    },
    removePreparedDelivery: (clientMsgId) => {
      if (prepared?.clientMsgId !== clientMsgId) return false;
      prepared = null;
      return true;
    },
    current: () => structuredClone(prepared)
  };
}

function inMemoryDeliveryState({
  failHistoryCount = 0,
  failRemoveCount = 0,
  failSentCount = 0
} = {}) {
  let prepared = null;
  let sent = null;
  let history = [];
  return {
    getPreparedDelivery: (clientMsgId) => prepared?.clientMsgId === clientMsgId
      ? structuredClone(prepared)
      : null,
    savePreparedDelivery: (value) => {
      if (!prepared) prepared = structuredClone(value);
      return structuredClone(prepared);
    },
    removePreparedDelivery: (clientMsgId) => {
      if (failRemoveCount > 0) {
        failRemoveCount -= 1;
        throw new Error("outbox remove failed");
      }
      if (prepared?.clientMsgId !== clientMsgId) return false;
      prepared = null;
      return true;
    },
    getSentMessageByClientMsgId: (clientMsgId) => sent?.clientMsgId === clientMsgId
      ? structuredClone(sent)
      : null,
    appendSentMessage: (value) => {
      if (failSentCount > 0) {
        failSentCount -= 1;
        throw new Error("sent receipt write failed");
      }
      if (!sent) sent = structuredClone(value);
      return { inserted: true, message: structuredClone(sent) };
    },
    getRecommendationHistory: () => ({ version: 1, items: structuredClone(history) }),
    appendRecommendationHistory: (value) => {
      if (failHistoryCount > 0) {
        failHistoryCount -= 1;
        throw new Error("history write failed");
      }
      if (history.length === 0) {
        history = value.recommendations.map((item) => ({
          ...structuredClone(item),
          channel: value.channel,
          messageTs: value.messageTs,
          mealType: value.mealType,
          source: value.source,
          requestedMode: value.requestedMode,
          generationMode: value.generationMode,
          fallbackUsed: value.fallbackUsed,
          ...(value.fallbackReason ? { fallbackReason: value.fallbackReason } : {}),
          recommendedAt: "2026-07-16T00:00:00.000Z"
        }));
      }
      return { inserted: true };
    },
    current: () => ({
      prepared: structuredClone(prepared),
      sent: structuredClone(sent),
      history: structuredClone(history)
    })
  };
}

test("buildMealResponse falls back to cache after a Codex CLI failure", async () => {
  const warnings = [];
  const result = await buildMealResponse({
    mealType: "점심",
    mode: "codex-cli",
    dependencies: {
      buildCodexCliMealResponse: async () => { throw new Error("timeout"); },
      getCachedRecommendations: () => recommendations,
      buildMealMessage: messageFor,
      getWeatherAlert: noWeather,
      logWarn: (...args) => warnings.push(args.join(" "))
    }
  });

  assert.equal(result.text, "점심:3");
  assert.equal(result.generationMode, "cache");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackReason, "timeout");
  assert.match(warnings[0], /falling back/u);
});

test("executeMeal dry-run cannot call Slack or mutate operating history", async () => {
  const forbidden = () => { throw new Error("side effect reached"); };
  const result = await executeMeal({
    channel: "not-required-for-dry-run",
    mealType: "점심",
    mode: "cache",
    source: "test",
    dryRun: true,
    dependencies: {
      getRecommendations: async () => recommendations,
      buildMealMessage: messageFor,
      getWeatherAlert: noWeather,
      postMessage: forbidden,
      appendSentMessage: forbidden,
      appendRecommendationHistory: forbidden,
      cleanupOldMessages: forbidden
    }
  });

  assert.equal(result.delivery.sent, false);
  assert.equal(result.text, "점심:3");
});

test("executeMeal normalizes English meal aliases before every dependency", async () => {
  const seen = [];
  const result = await executeMeal({
    channel: "not-required-for-dry-run",
    mealType: "dinner",
    mode: "cache",
    source: "test",
    dryRun: true,
    dependencies: {
      getRecommendations: async ({ mealType }) => { seen.push(mealType); return recommendations; },
      buildMealMessage: messageFor,
      getWeatherAlert: async ({ mealType }) => { seen.push(mealType); return null; }
    }
  });
  assert.equal(result.text, "저녁:3");
  assert.deepEqual(seen, ["저녁", "저녁"]);
});

test("executeMeal records one successful delivery through the shared path", async () => {
  const calls = [];
  const outbox = inMemoryOutbox();
  const result = await executeMeal({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    mealType: "저녁",
    mode: "cache",
    source: "scheduled-cache",
    dependencies: {
      getRecommendations: async () => recommendations,
      buildMealMessage: messageFor,
      getWeatherAlert: noWeather,
      ...outbox,
      postMessage: async (payload) => {
        calls.push(["post", payload]);
        return { channel: REQUIRED_LUNCH_CHANNEL_ID, ts: "123.456" };
      },
      appendSentMessage: (payload) => calls.push(["sent", payload]),
      appendRecommendationHistory: (payload) => calls.push(["history", payload]),
      cleanupOldMessages: async (channel) => calls.push(["cleanup", channel])
    }
  });

  assert.equal(result.delivery.sent, true);
  assert.deepEqual(calls.map(([name]) => name), ["post", "sent", "history", "cleanup"]);
  assert.equal(calls[1][1].requestedMode, "cache");
  assert.equal(calls[1][1].generationMode, "cache");
  assert.equal(calls[1][1].fallbackUsed, false);
  assert.match(calls[0][1].clientMsgId, /^[0-9a-f-]{36}$/u);
  assert.equal(calls[0][1].messagePurpose, "meal-recommendation");
});

test("executeMeal rejects an invalid Slack receipt before sent/history persistence", async () => {
  for (const [receipt, pattern] of [
    [{ channel: "CWRONG", ts: "123.456" }, /wrong Slack channel/u],
    [{ channel: REQUIRED_LUNCH_CHANNEL_ID, ts: "bad" }, /invalid Slack timestamp/u]
  ]) {
    const outbox = inMemoryOutbox();
    let persisted = 0;
    await assert.rejects(() => executeMeal({
      channel: REQUIRED_LUNCH_CHANNEL_ID,
      mealType: "점심",
      mode: "cache",
      source: "scheduled-cache",
      dependencies: {
        getRecommendations: async () => recommendations,
        buildMealMessage: messageFor,
        getWeatherAlert: noWeather,
        ...outbox,
        postMessage: async () => receipt,
        appendSentMessage: () => { persisted += 1; },
        appendRecommendationHistory: () => { persisted += 1; },
        cleanupOldMessages: async () => {}
      }
    }), pattern);
    assert.equal(persisted, 0);
    assert.ok(outbox.current(), "uncertain delivery payload must remain retryable");
  }
});

test("non-scheduled deliveries do not reuse a scheduled idempotency key", async () => {
  let posted;
  await executeMeal({
    channel: REQUIRED_OPERATOR_DM_CHANNEL_ID,
    mealType: "점심",
    mode: "cache",
    source: "manual-private-test",
    dependencies: {
      getRecommendations: async () => recommendations,
      buildMealMessage: messageFor,
      getWeatherAlert: noWeather,
      postMessage: async (payload) => {
        posted = payload;
        return { channel: REQUIRED_OPERATOR_DM_CHANNEL_ID, ts: "1.2" };
      },
      appendSentMessage: () => {},
      appendRecommendationHistory: () => {},
      cleanupOldMessages: async () => {}
    }
  });
  assert.equal(posted.clientMsgId, undefined);
});

test("the core delivery boundary keeps private tests out of lunch and arbitrary DMs", async () => {
  let dependenciesReached = false;
  const dependencies = {
    getRecommendations: async () => {
      dependenciesReached = true;
      return recommendations;
    }
  };
  await assert.rejects(() => executeMeal({
    channel: config.lunchChannelId,
    mealType: "점심",
    mode: "cache",
    source: "manual-private-test",
    dependencies
  }), /live meal delivery is limited/u);
  await assert.rejects(() => executeMeal({
    channel: "D123ABC",
    mealType: "점심",
    mode: "cache",
    source: "manual-private-test",
    dependencies
  }), /live meal delivery is limited/u);
  await assert.rejects(() => executeMeal({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    mealType: "점심",
    mode: "codex-cli",
    source: "scheduled-cache",
    dependencies
  }), /live meal delivery is limited/u);
  await assert.rejects(() => executeMeal({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    mealType: "점심",
    mode: "cache",
    source: "scheduled-codex-cli",
    dependencies
  }), /live meal delivery is limited/u);
  await assert.rejects(() => executeMeal({
    channel: REQUIRED_OPERATOR_DM_CHANNEL_ID,
    mealType: "점심",
    mode: "cache",
    source: "scheduled-cache",
    dependencies
  }), /live meal delivery is limited/u);
  assert.equal(dependenciesReached, false);
});

test("server and local scheduled reruns share one daily receipt and skip a second Slack post", async () => {
  const clientMessageIds = [];
  const state = inMemoryDeliveryState();
  let builds = 0;
  const dependencies = {
    getRecommendations: async () => {
      builds += 1;
      return recommendations;
    },
    buildMealMessage: messageFor,
    getWeatherAlert: noWeather,
    ...state,
    postMessage: async (payload) => {
      clientMessageIds.push(payload.clientMsgId);
      return { channel: REQUIRED_LUNCH_CHANNEL_ID, ts: "400.500" };
    },
    cleanupOldMessages: async () => {}
  };
  const first = await executeMeal({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    mealType: "저녁",
    mode: "cache",
    source: "scheduled-cache",
    dependencies
  });
  const second = await executeMeal({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    mealType: "저녁",
    mode: "cache",
    source: "scheduled-cache",
    dependencies
  });
  assert.equal(first.delivery.sent, true);
  assert.equal(second.delivery.alreadySent, true);
  assert.equal(clientMessageIds.length, 1);
  assert.equal(builds, 1);
  assert.equal(state.current().prepared, null);
  assert.match(state.current().sent.clientMsgId, /^[0-9a-f-]{36}$/u);
});

test("cleanup failure does not turn a successful Slack delivery into a resend", async () => {
  const warnings = [];
  const outbox = inMemoryOutbox();
  const result = await executeMeal({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    mealType: "점심",
    mode: "cache",
    source: "scheduled-cache",
    dependencies: {
      getRecommendations: async () => recommendations,
      buildMealMessage: messageFor,
      getWeatherAlert: noWeather,
      ...outbox,
      postMessage: async () => ({ channel: REQUIRED_LUNCH_CHANNEL_ID, ts: "2.3" }),
      appendSentMessage: () => {},
      appendRecommendationHistory: () => {},
      cleanupOldMessages: async () => { throw new Error("disk full"); },
      logWarn: (...args) => warnings.push(args.join(" "))
    }
  });
  assert.equal(result.delivery.sent, true);
  assert.match(warnings[0], /cleanup failed/u);
});

test("scheduled retry reuses the exact durable payload after an uncertain Slack result", async () => {
  const outbox = inMemoryOutbox();
  const posted = [];
  let builds = 0;
  let attempts = 0;
  const dependencies = {
    getRecommendations: async () => {
      builds += 1;
      return recommendations.map((item) => ({ ...item, menu: `${item.menu}-${builds}` }));
    },
    buildMealMessage: ({ mealType, recommendations: items }) => ({
      text: `${mealType}:${items.map((item) => item.menu).join(",")}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: items[0].menu } }]
    }),
    getWeatherAlert: noWeather,
    ...outbox,
    postMessage: async (payload) => {
      posted.push(structuredClone(payload));
      attempts += 1;
      if (attempts === 1) throw new Error("response lost after acceptance");
      return { channel: REQUIRED_LUNCH_CHANNEL_ID, ts: "777.888" };
    },
    appendSentMessage: () => {},
    appendRecommendationHistory: () => {},
    cleanupOldMessages: async () => {}
  };

  await assert.rejects(() => executeMeal({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    mealType: "점심",
    mode: "cache",
    source: "scheduled-cache",
    dependencies
  }), /response lost/u);
  assert.ok(outbox.current());

  await executeMeal({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    mealType: "점심",
    mode: "cache",
    source: "scheduled-cache",
    dependencies
  });

  assert.equal(builds, 1);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].text, posted[1].text);
  assert.deepEqual(posted[0].blocks, posted[1].blocks);
  assert.equal(posted[0].clientMsgId, posted[1].clientMsgId);
  assert.equal(outbox.current(), null);
});

test("scheduled delivery recovers missing history from the exact outbox without reposting", async () => {
  const state = inMemoryDeliveryState({ failHistoryCount: 1 });
  let posts = 0;
  const dependencies = {
    ...state,
    getRecommendations: async () => recommendations,
    buildMealMessage: messageFor,
    getWeatherAlert: noWeather,
    postMessage: async () => { posts += 1; return { channel: REQUIRED_LUNCH_CHANNEL_ID, ts: "700.800" }; },
    cleanupOldMessages: async () => {}
  };
  const input = { channel: REQUIRED_LUNCH_CHANNEL_ID, mealType: "점심", mode: "cache", source: "scheduled-cache", dependencies };
  await assert.rejects(() => executeMeal(input), /history write failed/u);
  assert.ok(state.current().sent);
  assert.ok(state.current().prepared);
  const recovered = await executeMeal(input);
  assert.equal(recovered.delivery.recovered, true);
  assert.equal(posts, 1);
  assert.equal(state.current().prepared, null);
  assert.equal(state.current().history.length, 3);
});

test("scheduled delivery clears a lingering outbox after the full commit without reposting", async () => {
  const state = inMemoryDeliveryState({ failRemoveCount: 1 });
  let posts = 0;
  const dependencies = {
    ...state,
    getRecommendations: async () => recommendations,
    buildMealMessage: messageFor,
    getWeatherAlert: noWeather,
    postMessage: async () => { posts += 1; return { channel: REQUIRED_LUNCH_CHANNEL_ID, ts: "701.801" }; },
    cleanupOldMessages: async () => {},
    logWarn: () => {}
  };
  const input = { channel: REQUIRED_LUNCH_CHANNEL_ID, mealType: "점심", mode: "cache", source: "scheduled-cache", dependencies };
  await executeMeal(input);
  assert.ok(state.current().prepared);
  const retry = await executeMeal(input);
  assert.equal(retry.delivery.alreadySent, true);
  assert.equal(posts, 1);
  assert.equal(state.current().prepared, null);
});

test("scheduled delivery fails closed when a receipt lacks both history and outbox payload", async () => {
  const forbidden = () => { throw new Error("forbidden side effect"); };
  await assert.rejects(() => executeMeal({
    channel: REQUIRED_LUNCH_CHANNEL_ID,
    mealType: "점심",
    mode: "cache",
    source: "scheduled-cache",
    dependencies: {
      getPreparedDelivery: () => null,
      getSentMessageByClientMsgId: (clientMsgId) => ({
        clientMsgId,
        channel: REQUIRED_LUNCH_CHANNEL_ID,
        ts: "702.802",
        mealType: "점심",
        source: "scheduled-cache",
        requestedMode: "cache",
        generationMode: "cache",
        fallbackUsed: false,
        sentAt: "2026-07-16T00:00:00.000Z"
      }),
      getRecommendationHistory: () => ({ version: 1, items: [] }),
      getRecommendations: forbidden,
      postMessage: forbidden
    }
  }), /refusing to resend/u);
});

test("scheduled retry after a pre-receipt crash reuses one payload and client message ID", async () => {
  const state = inMemoryDeliveryState({ failSentCount: 1 });
  const posted = [];
  let builds = 0;
  const dependencies = {
    ...state,
    getRecommendations: async () => { builds += 1; return recommendations; },
    buildMealMessage: messageFor,
    getWeatherAlert: noWeather,
    postMessage: async (payload) => {
      posted.push(structuredClone(payload));
      return { channel: REQUIRED_LUNCH_CHANNEL_ID, ts: "703.803" };
    },
    cleanupOldMessages: async () => {}
  };
  const input = { channel: REQUIRED_LUNCH_CHANNEL_ID, mealType: "점심", mode: "cache", source: "scheduled-cache", dependencies };
  await assert.rejects(() => executeMeal(input), /sent receipt write failed/u);
  await executeMeal(input);
  assert.equal(builds, 1);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].clientMsgId, posted[1].clientMsgId);
  assert.equal(posted[0].text, posted[1].text);
});

test("deterministic recommendation RNG produces a stable stream per scheduled receipt", () => {
  const first = deterministicRecommendationRng("same-receipt");
  const second = deterministicRecommendationRng("same-receipt");
  const different = deterministicRecommendationRng("different-receipt");
  const firstValues = Array.from({ length: 12 }, () => first());
  assert.deepEqual(firstValues, Array.from({ length: 12 }, () => second()));
  assert.notDeepEqual(firstValues, Array.from({ length: 12 }, () => different()));
  assert.ok(firstValues.every((value) => value >= 0 && value < 1));
});

test("executeMeal rejects invalid live delivery input before building content", async () => {
  const forbidden = () => { throw new Error("dependency reached"); };
  await assert.rejects(
    () => executeMeal({
      channel: "general",
      mealType: "점심",
      mode: "cache",
      source: "scheduled",
      dependencies: { getRecommendations: forbidden, postMessage: forbidden }
    }),
    /channel must be/u
  );
});
