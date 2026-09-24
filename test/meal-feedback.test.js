import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMealFeedbackModal,
  modalForBlockAction,
  normalizeCustomMealInput,
  parseMealSubmission,
  persistMealSubmission
} from "../src/meal-feedback.js";
import { encodeMealInteractionContext } from "../src/interaction-context.js";

const recommendations = [
  { candidateId: "a", category: "도시락", restaurant: "밥집", menu: "제육" },
  { candidateId: "b", category: "중식", restaurant: "반점", menu: "짬뽕" },
  { candidateId: "c", category: "돈까스", restaurant: "카츠집", menu: "돈카츠" }
];

test("feedback modal provides recommendations and an other choice", () => {
  const view = buildMealFeedbackModal({ channel: "C1", messageTs: "1.2", mealType: "점심", recommendations });
  assert.equal(view.callback_id, "actual_meal_submission");
  assert.equal(view.blocks[0].element.options.length, 4);
  assert.ok(view.blocks.some((block) => block.block_id === "other_restaurant" && block.optional));
  assert.ok(view.blocks.some((block) => block.block_id === "other_menu" && block.optional));
  assert.equal(view.blocks.some((block) => block.block_id === "participants"), false);
  assert.doesNotMatch(JSON.stringify(view), /함께 먹은 인원|participant_count/u);
});

test("feedback submission records an explicitly selected meal without participant metadata", () => {
  const metadata = JSON.stringify({ channel: "C1", messageTs: "1.2", mealType: "점심", recommendations });
  const parsed = parseMealSubmission({
    user: { id: "U1" },
    view: {
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: {
        meal_choice: { selected_choice: { selected_option: { value: "0" } } },
        rating: { selected_rating: { selected_option: { value: "5" } } },
        tags: { selected_tags: { selected_options: [{ value: "재주문" }] } },
        participants: { participant_count: { value: "4" } }
      } }
    }
  });
  assert.equal(parsed.event.restaurant, "밥집");
  assert.equal(parsed.event.rating, 5);
  assert.equal(Object.hasOwn(parsed.event, "participantCount"), false);
  assert.equal(parsed.event.submittedBy, undefined);
});

test("private test source is preserved through modal submission", () => {
  const metadata = JSON.stringify({
    channel: "D1",
    messageTs: "1.3",
    mealType: "점심",
    source: "manual-private-test",
    recommendations
  });
  const parsed = parseMealSubmission({
    user: { id: "U1" },
    view: {
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: {
        meal_choice: { selected_choice: { selected_option: { value: "0" } } }
      } }
    }
  });
  assert.equal(parsed.event.source, "manual-private-test");
});

test("feedback retries are idempotent and server-side values are validated", () => {
  const metadata = JSON.stringify({ channel: "C1", messageTs: "1.4", mealType: "저녁", recommendations });
  const payload = {
    user: { id: "U1" },
    view: {
      id: "V1",
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: {
        meal_choice: { selected_choice: { selected_option: { value: "0" } } },
        rating: { selected_rating: { selected_option: { value: "9" } } }
      } }
    }
  };
  assert.match(parseMealSubmission(payload).errors.rating, /다시 선택/u);
  payload.view.state.values.rating.selected_rating.selected_option.value = "4";
  const first = parseMealSubmission(payload);
  const second = parseMealSubmission(payload);
  assert.equal(first.event.eventId, second.event.eventId);
  assert.equal(first.event.mealType, "저녁");
  assert.match(first.event.date, /^\d{4}-\d{2}-\d{2}$/u);

  payload.view.id = "V2";
  assert.equal(parseMealSubmission(payload).event.eventId, first.event.eventId);
});

test("a custom meal uses separate restaurant and menu fields", () => {
  const metadata = JSON.stringify({ channel: "C1", messageTs: "1.5", mealType: "점심", recommendations });
  const payload = {
    user: { id: "U1" },
    view: {
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: {
        meal_choice: { selected_choice: { selected_option: { value: "other" } } },
        other_restaurant: { custom_restaurant: { value: "분식집" } },
        other_menu: { custom_menu: { value: "떡볶이" } }
      } }
    }
  };
  const parsed = parseMealSubmission(payload);
  assert.equal(parsed.event.restaurant, "분식집");
  assert.equal(parsed.event.menu, "떡볶이");
  assert.equal(parsed.event.inputText, "분식집 · 떡볶이");
  assert.equal(parsed.event.inputNormalization, "separate-fields");

  payload.view.state.values.other_restaurant.custom_restaurant.value = "";
  const menuOnly = parseMealSubmission(payload);
  assert.equal(menuOnly.event.restaurant, "");
  assert.equal(menuOnly.event.menu, "떡볶이");

  payload.view.state.values.other_menu.custom_menu.value = "";
  assert.match(parseMealSubmission(payload).errors.other_menu, /메뉴명/u);

  payload.view.state.values.other_restaurant.custom_restaurant.value = "으";
  payload.view.state.values.other_menu.custom_menu.value = "으";
  assert.match(parseMealSubmission(payload).errors.other_menu, /구체적으로/u);

  payload.view.state.values.other_restaurant.custom_restaurant.value = "분식집";
  for (const invalidMenu of ["떡볶이, !!!", "떡볶이, asdf", "짜장면, 으", "테스트테스트", "ㅋㅎ", "떡볶이\n쓰레기", "짜장면\r\n으"]) {
    payload.view.state.values.other_menu.custom_menu.value = invalidMenu;
    assert.match(parseMealSubmission(payload).errors.other_menu, /구체적으로/u);
  }

  payload.view.state.values.other_restaurant.custom_restaurant.value = "BHC";
  payload.view.state.values.other_menu.custom_menu.value = "Big Mac";
  assert.equal(parseMealSubmission(payload).errors, undefined);
});

test("malformed meal private metadata fails closed as an inline Slack error", () => {
  for (const privateMetadata of ["{not-json", "null", "[]", "{}"] ) {
    const payload = {
      user: { id: "U1" },
      view: {
        callback_id: "actual_meal_submission",
        private_metadata: privateMetadata,
        state: { values: {} }
      }
    };
    const parsed = parseMealSubmission(payload);
    assert.equal(parsed.handled, true);
    assert.match(parsed.errors.meal_choice, /다시 불러와/u);

    let writes = 0;
    const persisted = persistMealSubmission(payload, { appendEvent: () => { writes += 1; } });
    assert.match(persisted.errors.meal_choice, /다시 불러와/u);
    assert.equal(writes, 0);
  }
});

test("legacy free-form modal submissions remain compatible", () => {
  const metadata = JSON.stringify({ channel: "C1", messageTs: "1.6", mealType: "점심", recommendations });
  const payload = {
    user: { id: "U1" },
    view: {
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: {
        meal_choice: { selected_choice: { selected_option: { value: "other" } } },
        other_meal: { custom_meal: { value: "BHC-전북대점 - 뿌링클" } }
      } }
    }
  };
  const parsed = parseMealSubmission(payload);
  assert.equal(parsed.event.restaurant, "BHC-전북대점");
  assert.equal(parsed.event.menu, "뿌링클");
  assert.equal(parsed.event.inputNormalization, "delimiter");
});

test("contradictory preference tags are rejected", () => {
  const metadata = JSON.stringify({ channel: "C1", messageTs: "1.7", mealType: "점심", recommendations });
  const parsed = parseMealSubmission({
    user: { id: "U1" },
    view: {
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: {
        meal_choice: { selected_choice: { selected_option: { value: "0" } } },
        tags: { selected_tags: { selected_options: [{ value: "재주문" }, { value: "다시 안 먹기" }] } }
      } }
    }
  });
  assert.match(parsed.errors.tags, /함께 선택/u);
});

test("ratings that contradict reorder preference tags are rejected", () => {
  const metadata = JSON.stringify({ channel: "C1", messageTs: "1.71", mealType: "점심", recommendations });
  const submission = (rating, tag) => parseMealSubmission({
    user: { id: "U1" },
    view: {
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: {
        meal_choice: { selected_choice: { selected_option: { value: "0" } } },
        rating: { selected_rating: { selected_option: { value: String(rating) } } },
        tags: { selected_tags: { selected_options: [{ value: tag }] } }
      } }
    }
  });

  assert.match(submission(2, "재주문").errors.tags, /서로 맞지 않습니다/u);
  assert.match(submission(4, "다시 안 먹기").errors.tags, /서로 맞지 않습니다/u);
  assert.equal(submission(4, "재주문").errors, undefined);
  assert.equal(submission(2, "다시 안 먹기").errors, undefined);
});

test("free-form custom meal normalization supports natural language and common separators", () => {
  assert.deepEqual(normalizeCustomMealInput("오늘 점심은 떡볶이를 먹었어요"), {
    inputText: "오늘 점심은 떡볶이를 먹었어요",
    restaurant: "",
    menu: "떡볶이",
    normalization: "menu-only"
  });
  assert.equal(normalizeCustomMealInput("분식집에서 떡볶이 먹었어요").restaurant, "분식집");
  assert.equal(normalizeCustomMealInput("분식집에서 떡볶이 먹었어요").menu, "떡볶이");
  assert.deepEqual(normalizeCustomMealInput("BHC-전북대점 - 뿌링클"), {
    inputText: "BHC-전북대점 - 뿌링클",
    restaurant: "BHC-전북대점",
    menu: "뿌링클",
    normalization: "delimiter"
  });
  assert.equal(normalizeCustomMealInput("분식집: 떡볶이").menu, "떡볶이");
  assert.equal(normalizeCustomMealInput("로제떡볶이").menu, "로제떡볶이");
  assert.equal(normalizeCustomMealInput("짜장/짬뽕").restaurant, "");
  assert.equal(normalizeCustomMealInput("짜장/짬뽕").menu, "짜장/짬뽕");
});

test("known recommendation names are recovered from conversational input", () => {
  assert.deepEqual(normalizeCustomMealInput("오늘은 BHC 전북대점 뿌링클 먹었어요", {
    knownMeals: [{ restaurant: "BHC 전북대점", menu: "뿌링클" }]
  }), {
    inputText: "오늘은 BHC 전북대점 뿌링클 먹었어요",
    restaurant: "BHC 전북대점",
    menu: "뿌링클",
    normalization: "known-meal"
  });
  assert.equal(normalizeCustomMealInput("뿌링클 먹었어요", {
    knownMeals: [{ restaurant: "BHC 전북대점", menu: "뿌링클" }]
  }).restaurant, "BHC 전북대점");
});

test("meal submissions fail closed without a valid Slack user", () => {
  const metadata = JSON.stringify({ channel: "C1", messageTs: "1.8", mealType: "점심", recommendations });
  assert.throws(() => parseMealSubmission({
    view: {
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: { meal_choice: { selected_choice: { selected_option: { value: "0" } } } } }
    }
  }), /valid Slack user/u);
});

test("a repeat meal button click shows a locked first-record notice", () => {
  const submissionDate = "2026-07-14";
  const metadata = JSON.stringify({
    channel: "C1",
    messageTs: "1.9",
    mealType: "저녁",
    source: "scheduled-cache",
    submissionDate,
    recommendations
  });
  const existing = parseMealSubmission({
    user: { id: "U1" },
    view: {
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: { meal_choice: { selected_choice: { selected_option: { value: "0" } } } } }
    }
  }).event;
  const modal = modalForBlockAction({
    user: { id: "U1" },
    channel: { id: "C1" },
    message: { ts: "1.9" },
    actions: [{ value: encodeMealInteractionContext({ mealType: "저녁", source: "scheduled-cache", recommendations }) }]
  }, {
    events: { version: 1, events: [existing] },
    now: new Date("2026-07-14T12:00:00.000Z")
  });
  assert.equal(modal.submit, undefined);
  assert.match(modal.blocks[0].text.text, /최초 기록을 유지/u);
});

test("a stale meal modal cannot overwrite the first stored event", () => {
  const metadata = JSON.stringify({
    channel: "C1",
    messageTs: "2.0",
    mealType: "저녁",
    submissionDate: "2026-07-14",
    recommendations
  });
  const persisted = persistMealSubmission({
    user: { id: "U1" },
    view: {
      callback_id: "actual_meal_submission",
      private_metadata: metadata,
      state: { values: { meal_choice: { selected_choice: { selected_option: { value: "0" } } } } }
    }
  }, {
    appendEvent: () => ({ inserted: false, event: { eventId: "existing" } })
  });
  assert.equal(persisted.duplicate, true);
});
