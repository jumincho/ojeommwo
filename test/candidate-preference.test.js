import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidatePreferenceConfirmation,
  buildCandidatePreferenceModal,
  candidatePreferenceModalForBlockAction,
  parseCandidatePreferenceSubmission,
  persistCandidatePreferenceSubmission
} from "../src/candidate-preference.js";
import { encodeMealInteractionContext } from "../src/interaction-context.js";
import { stampCategoryAdjudication } from "../src/category-arbitration.js";

const recommendations = [
  { candidateId: "a", category: "도시락", restaurant: "밥집", menu: "제육" },
  { candidateId: "b", category: "중식", restaurant: "반점", menu: "짬뽕" },
  { candidateId: "c", category: "돈까스", restaurant: "카츠집", menu: "돈카츠" }
];

function submission({
  ratings = [5, 3, 1],
  userId = "U123ABC",
  source = "scheduled-cache",
  recommendationItems = recommendations,
} = {}) {
  const privateMetadata = JSON.stringify({
    channel: "C123ABC",
    messageTs: "123.456",
    mealType: "저녁",
    source,
    recommendations: recommendationItems
  });
  const values = Object.fromEntries(ratings.map((rating, index) => [
    `candidate_preference_${index}`,
    { [`candidate_rating_${index}`]: { selected_option: rating == null ? undefined : { value: String(rating) } } }
  ]));
  return {
    user: { id: userId },
    view: {
      callback_id: "candidate_preference_submission",
      private_metadata: privateMetadata,
      state: { values }
    }
  };
}

test("candidate preference modal requires a 1-5 rating for all three menus", () => {
  const modal = buildCandidatePreferenceModal({
    channel: "C123ABC",
    messageTs: "123.456",
    mealType: "저녁",
    recommendations
  });
  const inputs = modal.blocks.filter((block) => block.type === "input");
  assert.equal(modal.callback_id, "candidate_preference_submission");
  assert.equal(inputs.length, 3);
  assert.ok(inputs.every((block) => block.optional !== true && block.element.options.length === 5));
  assert.deepEqual(inputs[0].element.options.map((option) => option.value), ["1", "2", "3", "4", "5"]);
});

test("candidate preference preserves the shared 320-character candidate ID contract", () => {
  const longId = "후".repeat(300);
  const modal = buildCandidatePreferenceModal({
    channel: "C123ABC",
    messageTs: "123.456",
    mealType: "점심",
    recommendations: recommendations.map((item, index) => index === 0 ? { ...item, candidateId: longId } : item)
  });
  const metadata = JSON.parse(modal.private_metadata);
  assert.equal(metadata.recommendations[0].candidateId, longId);
  assert.throws(() => buildCandidatePreferenceModal({
    channel: "C123ABC",
    messageTs: "123.456",
    mealType: "점심",
    recommendations: recommendations.map((item, index) => index === 0 ? { ...item, candidateId: "후".repeat(321) } : item)
  }), /oversized candidate ID/u);
});

test("candidate preference preserves valid model category adjudication and rejects tampering", () => {
  const adjudicated = stampCategoryAdjudication({
    candidateId: "a",
    category: "멕시칸",
    restaurant: "새로운식당",
    menu: "시그니처 보울",
  }, {
    category: "멕시칸",
    now: new Date("2026-07-14T00:00:00.000Z"),
  });
  const recommendationItems = [adjudicated, recommendations[1], recommendations[2]];
  const modal = buildCandidatePreferenceModal({
    channel: "C123ABC",
    messageTs: "123.456",
    mealType: "점심",
    recommendations: recommendationItems,
  });
  const metadata = JSON.parse(modal.private_metadata);
  assert.equal(metadata.recommendations[0].categoryAuthority, "model-adjudicated");

  const parsed = parseCandidatePreferenceSubmission(submission({
    recommendationItems: metadata.recommendations,
  }));
  assert.equal(parsed.response.ratings[0].categoryAuthority, "model-adjudicated");

  metadata.recommendations[0].menu = "변조 메뉴";
  const tampered = parseCandidatePreferenceSubmission(submission({
    recommendationItems: metadata.recommendations,
  }));
  assert.match(tampered.errors.candidate_preference_0, /다시 불러와/u);
});

test("candidate preference submission records three ratings without a raw user ID", () => {
  const parsed = parseCandidatePreferenceSubmission(submission());
  assert.equal(parsed.handled, true);
  assert.deepEqual(parsed.response.ratings.map((item) => item.rating), [5, 3, 1]);
  assert.equal(parsed.response.mealType, "저녁");
  assert.equal(parsed.response.submittedBy, undefined);
  assert.equal(JSON.stringify(parsed.response).includes("U123ABC"), false);
});

test("candidate preference retries resolve to one stable pseudonymous response", () => {
  const first = parseCandidatePreferenceSubmission(submission());
  const second = parseCandidatePreferenceSubmission(submission({ ratings: [4, 2, 5] }));
  const anotherUser = parseCandidatePreferenceSubmission(submission({ userId: "U999XYZ" }));
  assert.equal(first.response.responseId, second.response.responseId);
  assert.notEqual(first.response.responseId, anotherUser.response.responseId);
});

test("a repeat button click shows a locked first-response notice", () => {
  const first = parseCandidatePreferenceSubmission(submission());
  const value = encodeMealInteractionContext({
    mealType: "저녁",
    source: "scheduled-cache",
    recommendations
  });
  const modal = candidatePreferenceModalForBlockAction({
    user: { id: "U123ABC" },
    channel: { id: "C123ABC" },
    message: { ts: "123.456" },
    actions: [{ value }]
  }, {
    preferences: { version: 1, responses: [first.response] }
  });
  assert.equal(modal.submit, undefined);
  assert.match(modal.blocks[0].text.text, /최초 응답을 유지/u);
});

test("candidate preference validates every rating and supports injected persistence", () => {
  const invalid = parseCandidatePreferenceSubmission(submission({ ratings: [5, null, 1] }));
  assert.match(invalid.errors.candidate_preference_1, /1점에서 5점/u);

  const writes = [];
  const persisted = persistCandidatePreferenceSubmission(submission(), {
    appendPreference: (response, options) => writes.push({ response, options }),
    retentionDays: 365
  });
  assert.equal(persisted.handled, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.retentionDays, 365);
  assert.equal(persisted.duplicate, false);
});

test("malformed candidate preference metadata fails closed as an inline Slack error", () => {
  for (const privateMetadata of ["{not-json", "null", "[]", "{}"] ) {
    const payload = submission();
    payload.view.private_metadata = privateMetadata;
    const parsed = parseCandidatePreferenceSubmission(payload);
    assert.equal(parsed.handled, true);
    assert.match(parsed.errors.candidate_preference_0, /다시 불러와/u);

    let writes = 0;
    const persisted = persistCandidatePreferenceSubmission(payload, {
      appendPreference: () => { writes += 1; }
    });
    assert.match(persisted.errors.candidate_preference_0, /다시 불러와/u);
    assert.equal(writes, 0);
  }
});

test("a stale open modal cannot overwrite the first stored response", () => {
  const persisted = persistCandidatePreferenceSubmission(submission({ ratings: [1, 1, 1] }), {
    appendPreference: () => ({ inserted: false, response: { responseId: "existing" } })
  });
  assert.equal(persisted.duplicate, true);
  assert.match(buildCandidatePreferenceConfirmation({ duplicate: true }).blocks[0].text.text, /중복 반영을 막기 위해/u);
});

test("candidate preference submissions fail closed without a Slack user", () => {
  const payload = submission();
  delete payload.user;
  assert.throws(() => parseCandidatePreferenceSubmission(payload), /valid Slack user/u);
});

test("private DM survey source is retained so it cannot train production ranking", () => {
  const parsed = parseCandidatePreferenceSubmission(submission({ source: "manual-private-test" }));
  assert.equal(parsed.response.source, "manual-private-test");
});
