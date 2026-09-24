import test from "node:test";
import assert from "node:assert/strict";
import { handleSocketEnvelope } from "../src/interaction-listener.js";

test("observatory URL button is acknowledged without Slack or database side effects", async () => {
  const sent = [];
  let slackCalls = 0;
  const handled = await handleSocketEnvelope({
    envelope_id: "E-OBSERVATORY",
    payload: {
      type: "block_actions",
      actions: [{ action_id: "open_menu_observatory", url: "https://ojeommwo-observatory.jumincho.chatgpt.site/" }]
    }
  }, {
    socket: { send: (value) => sent.push(JSON.parse(value)) },
    slackCall: async () => { slackCalls += 1; }
  });
  assert.equal(handled, true);
  assert.deepEqual(sent, [{ envelope_id: "E-OBSERVATORY" }]);
  assert.equal(slackCalls, 0);
});

test("Socket Mode block action is acknowledged before opening a modal", async () => {
  const calls = [];
  const socket = { send: (value) => calls.push(["ack", JSON.parse(value)]) };
  await handleSocketEnvelope({
    envelope_id: "E1",
    payload: {
      type: "block_actions",
      trigger_id: "T1",
      actions: [{ action_id: "record_actual_meal" }]
    }
  }, {
    socket,
    modalBuilder: () => ({ type: "modal" }),
    slackCall: async (method, body) => calls.push([method, body])
  });
  assert.deepEqual(calls.map(([name]) => name), ["ack", "views.open"]);
  assert.equal(calls[0][1].envelope_id, "E1");
});

test("preference survey button is acknowledged before opening its modal", async () => {
  const calls = [];
  const socket = { send: (value) => calls.push(["ack", JSON.parse(value)]) };
  await handleSocketEnvelope({
    envelope_id: "E-PREF",
    payload: {
      type: "block_actions",
      trigger_id: "T-PREF",
      actions: [{ action_id: "survey_recommended_preferences" }]
    }
  }, {
    socket,
    preferenceModalBuilder: () => ({ type: "modal", callback_id: "candidate_preference_submission" }),
    slackCall: async (method, body) => calls.push([method, body])
  });
  assert.deepEqual(calls.map(([name]) => name), ["ack", "views.open"]);
  assert.equal(calls[1][1].view.callback_id, "candidate_preference_submission");
});

test("coffee button is acknowledged before updating actual participants", async () => {
  const calls = [];
  const socket = { send: (value) => calls.push(["ack", JSON.parse(value)]) };
  const handled = await handleSocketEnvelope({
    envelope_id: "E-COFFEE",
    payload: {
      type: "block_actions",
      channel: { id: "D123ABC" },
      user: { id: "U123ABC" },
      message: { ts: "123.456", text: "fallback", blocks: [] },
      actions: [{ action_id: "toggle_coffee_participation" }]
    }
  }, {
    socket,
    toggleCoffee: (target) => ({ ...target, userIds: [target.userId], count: 1, joined: true, previousUserIds: [] }),
    coffeeUpdateBuilder: (_payload, state) => ({ channel: state.channel, ts: state.messageTs, text: "fallback", blocks: [] }),
    slackCall: async (method, body) => calls.push([method, body])
  });
  assert.equal(handled, true);
  assert.deepEqual(calls.map(([name]) => name), ["ack", "chat.update"]);
  assert.deepEqual(calls[1][1], { channel: "D123ABC", ts: "123.456", text: "fallback", blocks: [] });
});

test("coffee update failure restores the previous participant state", async () => {
  const sent = [];
  const restored = [];
  await assert.rejects(() => handleSocketEnvelope({
    envelope_id: "E-COFFEE-AGAIN",
    payload: {
      type: "block_actions",
      container: { channel_id: "C123ABC", message_ts: "987.654" },
      user: { id: "U123ABC" },
      message: { text: "fallback", blocks: [] },
      actions: [{ action_id: "toggle_coffee_participation" }]
    }
  }, {
    socket: { send: (value) => sent.push(JSON.parse(value)) },
    toggleCoffee: (target) => ({ ...target, userIds: [target.userId], count: 1, joined: true, previousUserIds: [] }),
    restoreCoffee: (state) => restored.push(state),
    coffeeUpdateBuilder: () => ({ channel: "C123ABC", ts: "987.654", text: "fallback", blocks: [] }),
    slackCall: async () => { throw new Error("chat.update failed"); }
  }), /chat\.update failed/u);
  assert.equal(sent.length, 1);
  assert.equal(restored.length, 1);
});

test("coffee button acknowledges malformed message targets before rejecting them", async () => {
  const sent = [];
  await assert.rejects(
    () => handleSocketEnvelope({
      envelope_id: "E-COFFEE-BAD",
      payload: {
        type: "block_actions",
        actions: [{ action_id: "toggle_coffee_participation" }]
      }
    }, {
      socket: { send: (value) => sent.push(JSON.parse(value)) },
      slackCall: async () => { throw new Error("must not call Slack"); }
    }),
    /valid channel/u
  );
  assert.equal(sent.length, 1);
});

test("Socket Mode view submission returns inline validation errors", async () => {
  const sent = [];
  await handleSocketEnvelope({ envelope_id: "E2", payload: { type: "view_submission" } }, {
    socket: { send: (value) => sent.push(JSON.parse(value)) },
    persistSubmission: () => ({ handled: true, errors: { other_menu: "입력 필요" } })
  });
  assert.equal(sent[0].payload.response_action, "errors");
});

test("successful submission shows only a private modal confirmation", async () => {
  const sent = [];
  let slackCalls = 0;
  await handleSocketEnvelope({ envelope_id: "E3", payload: { type: "view_submission" } }, {
    socket: { send: (value) => sent.push(JSON.parse(value)) },
    persistSubmission: () => ({ handled: true, event: { menu: "비빔밥" } }),
    slackCall: async () => { slackCalls += 1; }
  });
  assert.equal(sent[0].payload.response_action, "update");
  assert.equal(sent[0].payload.view.blocks[0].text.text, "✅ 저장되었습니다.");
  assert.equal(slackCalls, 0);
});

test("custom meal normalization starts only after the Slack submission is acknowledged", async () => {
  const order = [];
  await handleSocketEnvelope({ envelope_id: "E-NORM", payload: { type: "view_submission" } }, {
    socket: { send: () => order.push("ack") },
    persistSubmission: () => ({ handled: true, event: { eventId: "MEAL-1", menu: "짜장면", normalizationStatus: "pending" } }),
    scheduleMealNormalization: async () => order.push("normalize")
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["ack", "normalize"]);
});

test("successful preference submission shows only its private confirmation", async () => {
  const sent = [];
  await handleSocketEnvelope({ envelope_id: "E4", payload: { type: "view_submission" } }, {
    socket: { send: (value) => sent.push(JSON.parse(value)) },
    persistSubmission: () => ({ handled: false }),
    persistPreferenceSubmission: () => ({ handled: true, response: { responseId: "R1" } })
  });
  assert.equal(sent[0].payload.response_action, "update");
  assert.equal(sent[0].payload.view.blocks[0].text.text, "✅ 세 메뉴의 선호도를 저장했습니다.");
});

test("duplicate preference submission keeps the first response", async () => {
  const sent = [];
  await handleSocketEnvelope({ envelope_id: "E4-DUP", payload: { type: "view_submission" } }, {
    socket: { send: (value) => sent.push(JSON.parse(value)) },
    persistSubmission: () => ({ handled: false }),
    persistPreferenceSubmission: () => ({ handled: true, duplicate: true, response: { responseId: "R1" } })
  });
  assert.equal(sent[0].payload.response_action, "update");
  assert.match(sent[0].payload.view.blocks[0].text.text, /최초 응답을 유지/u);
});

test("duplicate meal submission keeps the first record and skips normalization", async () => {
  const sent = [];
  let normalizations = 0;
  await handleSocketEnvelope({ envelope_id: "E-MEAL-DUP", payload: { type: "view_submission" } }, {
    socket: { send: (value) => sent.push(JSON.parse(value)) },
    persistSubmission: () => ({
      handled: true,
      duplicate: true,
      event: { eventId: "MEAL-EXISTING", normalizationStatus: "pending" }
    }),
    scheduleMealNormalization: async () => { normalizations += 1; }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent[0].payload.view.blocks[0].text.text, /최초 기록을 유지/u);
  assert.equal(normalizations, 0);
});

test("replayed Slack envelopes are acknowledged without repeating side effects", async () => {
  const sent = [];
  let toggles = 0;
  let updates = 0;
  const envelope = {
    envelope_id: "E-REPLAY-PROTECTION",
    payload: {
      type: "block_actions",
      channel: { id: "D123ABC" },
      user: { id: "U123ABC" },
      message: { ts: "333.444", text: "fallback", blocks: [] },
      actions: [{ action_id: "toggle_coffee_participation" }]
    }
  };
  const options = {
    socket: { send: (value) => sent.push(JSON.parse(value)) },
    toggleCoffee: (target) => {
      toggles += 1;
      return { ...target, userIds: [target.userId], count: 1, joined: true, previousUserIds: [] };
    },
    coffeeUpdateBuilder: () => ({ channel: "D123ABC", ts: "333.444", text: "fallback", blocks: [] }),
    slackCall: async () => { updates += 1; }
  };
  await handleSocketEnvelope(envelope, options);
  await handleSocketEnvelope(envelope, options);
  assert.equal(sent.length, 2);
  assert.equal(toggles, 1);
  assert.equal(updates, 1);
});

test("a failed envelope is released so a genuine retry can succeed", async () => {
  let attempts = 0;
  const envelope = {
    envelope_id: "E-RETRY-AFTER-FAILURE",
    payload: {
      type: "block_actions",
      channel: { id: "D123ABC" },
      user: { id: "U123ABC" },
      message: { ts: "555.666", text: "fallback", blocks: [] },
      actions: [{ action_id: "toggle_coffee_participation" }]
    }
  };
  const options = {
    socket: { send: () => {} },
    toggleCoffee: (target) => ({ ...target, userIds: [target.userId], count: 1, joined: true, previousUserIds: [] }),
    restoreCoffee: () => {},
    coffeeUpdateBuilder: () => ({ channel: "D123ABC", ts: "555.666", text: "fallback", blocks: [] }),
    slackCall: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
    }
  };
  await assert.rejects(() => handleSocketEnvelope(envelope, options), /temporary failure/u);
  assert.equal(await handleSocketEnvelope(envelope, options), true);
  assert.equal(attempts, 2);
});
