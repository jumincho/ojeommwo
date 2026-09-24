import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_JSON_STORE_BYTES } from "../src/storage.js";
import { mergeOperatingSnapshots } from "../src/operating-snapshot-merge.js";
import { validateOperatingSnapshotDirectory } from "../src/operating-snapshot.js";

const NOW = new Date("2026-07-16T00:00:00.000Z");
const STORE_FILES = {
  history: "recommendation-history.json",
  sentMessages: "sent-messages.json",
  mealEvents: "meal-events.json",
  verifiedCandidates: "verified-candidates.json",
  candidatePreferences: "candidate-preferences.json",
  coffeeParticipation: "coffee-participation.json",
  deliveryOutbox: "delivery-outbox.json"
};

function emptyStores() {
  return {
    history: { version: 1, items: [] },
    sentMessages: { version: 1, messages: [] },
    mealEvents: { version: 1, events: [] },
    verifiedCandidates: { version: 1, candidates: [] },
    candidatePreferences: { version: 1, responses: [] },
    coffeeParticipation: { version: 1, messages: [] },
    deliveryOutbox: { version: 1, deliveries: [] }
  };
}

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-merge-"));
}

function writeSnapshot(root, name, overrides = {}) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const stores = { ...emptyStores(), ...structuredClone(overrides) };
  for (const [key, fileName] of Object.entries(STORE_FILES)) {
    fs.writeFileSync(path.join(directory, fileName), `${JSON.stringify(stores[key], null, 2)}\n`, "utf8");
  }
  return directory;
}

function readStore(directory, key) {
  return JSON.parse(fs.readFileSync(path.join(directory, STORE_FILES[key]), "utf8"));
}

function recommendationGroup({ channel, messageTs, recommendedAt, seed, source = "scheduled-cache" }) {
  const values = [
    ["도시락", `도시락집${seed}`, `덮밥${seed}`],
    ["중식", `중식집${seed}`, `짜장면${seed}`],
    ["피자", `피자집${seed}`, `치즈피자${seed}`]
  ];
  return values.map(([category, restaurant, menu], index) => ({
    category,
    restaurant,
    menu,
    priceText: `${9 + index},000원`,
    comment: "고소한 재료와 따뜻한 소스가 어우러져 든든하고 맛있게 즐기기 좋습니다.",
    evidence: [`https://example.com/${seed}/${index}`],
    channel,
    messageTs,
    mealType: "점심",
    source,
    requestedMode: "cache",
    generationMode: "cache",
    fallbackUsed: false,
    recommendedAt
  }));
}

function sentMessage({ channel, ts, sentAt, source = "scheduled-cache", clientMsgId } = {}) {
  return {
    channel,
    ts,
    mealType: "점심",
    source,
    requestedMode: "cache",
    generationMode: "cache",
    fallbackUsed: false,
    sentAt,
    ...(clientMsgId ? { clientMsgId } : {})
  };
}

function mealEvent({ eventId, respondentId, date, mealType = "점심", menu }) {
  return {
    eventId,
    respondentId,
    date,
    mealType,
    source: "manual-feedback",
    restaurant: "테스트식당",
    menu,
    category: null,
    rating: 4,
    tags: [],
    createdAt: `${date}T04:00:00.000Z`
  };
}

function preference({
  responseId,
  respondentId,
  channel,
  messageTs,
  date = "2026-05-01",
  source = "manual-private-test",
  ratings
}) {
  return {
    responseId,
    respondentId,
    date,
    mealType: "점심",
    source,
    channel,
    messageTs,
    ratings: ratings || [
      { category: "도시락", restaurant: "선호식당A", menu: "선호메뉴A", rating: 3 },
      { category: "중식", restaurant: "선호식당B", menu: "선호메뉴B", rating: 4 },
      { category: "피자", restaurant: "선호식당C", menu: "선호메뉴C", rating: 5 }
    ],
    submittedAt: `${date}T05:00:00.000Z`,
    createdAt: `${date}T05:00:00.000Z`,
    updatedAt: `${date}T05:00:00.000Z`
  };
}

function delivery({ clientMsgId, channel, preparedAt = "2026-05-01T03:00:00.000Z" }) {
  return {
    clientMsgId,
    channel,
    mealType: "점심",
    source: "scheduled-cache",
    requestedMode: "cache",
    preparedAt,
    response: {
      recommendations: [
        { category: "도시락", restaurant: "배달식당A", menu: "배달메뉴A" },
        { category: "중식", restaurant: "배달식당B", menu: "배달메뉴B" },
        { category: "피자", restaurant: "배달식당C", menu: "배달메뉴C" }
      ],
      text: "테스트 추천 메시지",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "테스트" } }],
      generationMode: "cache",
      fallbackUsed: false
    }
  };
}

function withHistory(group) {
  const first = group[0];
  return {
    history: { version: 1, items: group },
    sentMessages: {
      version: 1,
      messages: [sentMessage({
        channel: first.channel,
        ts: first.messageTs,
        sentAt: first.recommendedAt,
        source: first.source
      })]
    }
  };
}

test("snapshot merge unions independent server and local additions and keeps server candidates authoritative", () => {
  const root = makeWorkspace();
  try {
    const serverGroup = recommendationGroup({
      channel: "CSERVER1", messageTs: "100.001", recommendedAt: "2026-05-01T02:00:00.000Z", seed: "서버"
    });
    const localGroup = recommendationGroup({
      channel: "CLOCAL1", messageTs: "200.002", recommendedAt: "2026-05-02T02:00:00.000Z", seed: "로컬"
    });
    const server = writeSnapshot(root, "server", {
      ...withHistory(serverGroup),
      mealEvents: { version: 1, events: [mealEvent({
        eventId: "event-server",
        respondentId: "11111111-1111-5111-a111-111111111111",
        date: "2026-05-01",
        menu: "서버메뉴"
      })] },
      verifiedCandidates: { version: 1, candidates: [], authority: "server" },
      candidatePreferences: { version: 1, responses: [preference({
        responseId: "response-server",
        respondentId: "22222222-2222-5222-a222-222222222222",
        channel: "CSERVER1",
        messageTs: "100.001",
        source: "scheduled-cache",
        ratings: serverGroup.map(({ category, restaurant, menu }) => ({ category, restaurant, menu, rating: 4 }))
      })] },
      coffeeParticipation: { version: 1, messages: [
        { channel: "CCOMMON", messageTs: "300.003", userIds: ["USEROLD"], updatedAt: "2026-05-01T01:00:00.000Z" },
        { channel: "CSERVER1", messageTs: "301.003", userIds: ["USERVER"], updatedAt: "2026-05-01T01:00:00.000Z" }
      ] },
      deliveryOutbox: { version: 1, deliveries: [delivery({
        clientMsgId: "aaaaaaaa-aaaa-5aaa-aaaa-aaaaaaaaaaaa",
        channel: "CQUEUE1"
      })] }
    });
    const local = writeSnapshot(root, "local", {
      ...withHistory(localGroup),
      mealEvents: { version: 1, events: [mealEvent({
        eventId: "event-local",
        respondentId: "33333333-3333-5333-a333-333333333333",
        date: "2026-05-02",
        menu: "로컬메뉴"
      })] },
      verifiedCandidates: { version: 1, candidates: [], authority: "local" },
      candidatePreferences: { version: 1, responses: [preference({
        responseId: "response-local",
        respondentId: "44444444-4444-5444-a444-444444444444",
        channel: "CLOCAL1",
        messageTs: "200.002",
        date: "2026-05-02",
        source: "scheduled-cache",
        ratings: localGroup.map(({ category, restaurant, menu }) => ({ category, restaurant, menu, rating: 4 }))
      })] },
      coffeeParticipation: { version: 1, messages: [
        { channel: "CCOMMON", messageTs: "300.003", userIds: [], updatedAt: "2026-05-02T01:00:00.000Z" },
        { channel: "CLOCAL1", messageTs: "302.003", userIds: ["ULOCAL"], updatedAt: "2026-05-02T01:00:00.000Z" }
      ] },
      deliveryOutbox: { version: 1, deliveries: [delivery({
        clientMsgId: "bbbbbbbb-bbbb-5bbb-abbb-bbbbbbbbbbbb",
        channel: "CQUEUE2",
        preparedAt: "2026-05-02T03:00:00.000Z"
      })] }
    });
    const serverBefore = fs.readFileSync(path.join(server, STORE_FILES.history), "utf8");
    const localBefore = fs.readFileSync(path.join(local, STORE_FILES.history), "utf8");
    const output = path.join(root, "merged");

    const result = mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW });

    assert.equal(result.historyGroups, 2);
    assert.equal(readStore(output, "history").items.length, 6);
    assert.equal(readStore(output, "sentMessages").messages.length, 2);
    assert.equal(readStore(output, "mealEvents").events.length, 2);
    assert.equal(readStore(output, "candidatePreferences").responses.length, 2);
    assert.equal(readStore(output, "deliveryOutbox").deliveries.length, 2);
    assert.equal(readStore(output, "verifiedCandidates").authority, "server");
    const coffee = readStore(output, "coffeeParticipation").messages;
    assert.equal(coffee.length, 3);
    assert.deepEqual(coffee.find((item) => item.channel === "CCOMMON").userIds, []);
    assert.equal(fs.readFileSync(path.join(server, STORE_FILES.history), "utf8"), serverBefore);
    assert.equal(fs.readFileSync(path.join(local, STORE_FILES.history), "utf8"), localBefore);
    assert.equal(validateOperatingSnapshotDirectory(output, { now: NOW }).counts.history.groupCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge normalizes benign receipt timestamp races and advances deletion state", () => {
  const root = makeWorkspace();
  try {
    const groupServer = recommendationGroup({
      channel: "CRACE1", messageTs: "400.004", recommendedAt: "2026-05-03T02:00:01.000Z", seed: "경합"
    });
    const groupLocal = groupServer.map((item) => ({ ...item, recommendedAt: "2026-05-03T02:00:02.000Z" }));
    const serverMessage = {
      ...sentMessage({
        channel: "CRACE1",
        ts: "400.004",
        sentAt: "2026-05-03T02:00:01.000Z",
        clientMsgId: "cccccccc-cccc-5ccc-accc-cccccccccccc"
      }),
      deletionRequestedAt: "2026-05-04T01:00:00.000Z",
      deletionReason: "retention-cleanup"
    };
    const localMessage = {
      ...sentMessage({
        channel: "CRACE1",
        ts: "400.004",
        sentAt: "2026-05-03T02:00:02.000Z",
        clientMsgId: "cccccccc-cccc-5ccc-accc-cccccccccccc"
      }),
      deletionRequestedAt: "2026-05-04T01:00:00.000Z",
      deletedAt: "2026-05-04T01:00:03.000Z",
      deletionReason: "retention-cleanup"
    };
    const server = writeSnapshot(root, "server", {
      history: { version: 1, items: groupServer },
      sentMessages: { version: 1, messages: [serverMessage] }
    });
    const local = writeSnapshot(root, "local", {
      history: { version: 1, items: groupLocal },
      sentMessages: { version: 1, messages: [localMessage] }
    });
    const output = path.join(root, "merged");

    mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW });

    const history = readStore(output, "history");
    assert.ok(history.items.every((item) => item.recommendedAt === "2026-05-03T02:00:01.000Z"));
    const [sent] = readStore(output, "sentMessages").messages;
    assert.equal(sent.sentAt, "2026-05-03T02:00:01.000Z");
    assert.equal(sent.clientMsgId, "cccccccc-cccc-5ccc-accc-cccccccccccc");
    assert.equal(sent.deletedAt, "2026-05-04T01:00:03.000Z");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge preserves pending cleanup as retryable instead of marking it deleted", () => {
  const root = makeWorkspace();
  try {
    const group = recommendationGroup({
      channel: "CPENDING", messageTs: "450.004", recommendedAt: "2026-05-04T02:00:00.000Z", seed: "대기"
    });
    const active = sentMessage({
      channel: "CPENDING", ts: "450.004", sentAt: "2026-05-04T02:00:00.000Z"
    });
    const pending = {
      ...active,
      deletionRequestedAt: "2026-05-05T01:00:00.000Z",
      deletionReason: "retention-cleanup"
    };
    const server = writeSnapshot(root, "server", {
      history: { version: 1, items: group },
      sentMessages: { version: 1, messages: [active] }
    });
    const local = writeSnapshot(root, "local", {
      history: { version: 1, items: group },
      sentMessages: { version: 1, messages: [pending] }
    });
    const output = path.join(root, "merged");

    mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW });

    const [message] = readStore(output, "sentMessages").messages;
    assert.equal(message.deletionRequestedAt, "2026-05-05T01:00:00.000Z");
    assert.equal(message.deletionReason, "retention-cleanup");
    assert.equal(Object.hasOwn(message, "deletedAt"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge removes a durable outbox entry when the merged sent store has its receipt", () => {
  const root = makeWorkspace();
  try {
    const group = recommendationGroup({
      channel: "CRECEIPT", messageTs: "500.005", recommendedAt: "2026-05-05T02:00:00.000Z", seed: "영수증"
    });
    const clientMsgId = "dddddddd-dddd-5ddd-addd-dddddddddddd";
    const unsentClientMsgId = "ffffffff-ffff-5fff-afff-ffffffffffff";
    const server = writeSnapshot(root, "server", {
      history: { version: 1, items: group },
      sentMessages: { version: 1, messages: [sentMessage({
        channel: "CRECEIPT",
        ts: "500.005",
        sentAt: "2026-05-05T02:00:00.000Z",
        clientMsgId
      })] }
    });
    const local = writeSnapshot(root, "local", {
      deliveryOutbox: { version: 1, deliveries: [
        delivery({
          clientMsgId,
          channel: "CRECEIPT",
          preparedAt: "2026-05-05T01:59:00.000Z"
        }),
        delivery({
          clientMsgId: unsentClientMsgId,
          channel: "CRECEIPT",
          preparedAt: "2026-05-05T01:59:00.000Z"
        })
      ] }
    });
    const output = path.join(root, "merged");

    mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW });

    const outbox = readStore(output, "deliveryOutbox");
    assert.deepEqual(outbox.deliveries.map((item) => item.clientMsgId), [unsentClientMsgId]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge fails atomically on a same-target recommendation conflict", () => {
  const root = makeWorkspace();
  try {
    const serverGroup = recommendationGroup({
      channel: "CCONFLICT", messageTs: "600.006", recommendedAt: "2026-05-06T02:00:00.000Z", seed: "서버"
    });
    const localGroup = recommendationGroup({
      channel: "CCONFLICT", messageTs: "600.006", recommendedAt: "2026-05-06T02:00:00.000Z", seed: "로컬"
    });
    const server = writeSnapshot(root, "server", withHistory(serverGroup));
    const local = writeSnapshot(root, "local", withHistory(localGroup));
    const output = path.join(root, "merged");

    assert.throws(
      () => mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW }),
      /Recommendation history conflict/u
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge rejects event and preference secondary-slot conflicts", () => {
  const makeConflict = ({ kind }) => {
    const root = makeWorkspace();
    const respondentId = "55555555-5555-5555-a555-555555555555";
    const serverOverrides = {};
    const localOverrides = {};
    if (kind === "event") {
      serverOverrides.mealEvents = { version: 1, events: [mealEvent({
        eventId: "event-a", respondentId, date: "2026-05-07", menu: "메뉴A"
      })] };
      localOverrides.mealEvents = { version: 1, events: [mealEvent({
        eventId: "event-b", respondentId, date: "2026-05-07", menu: "메뉴B"
      })] };
    } else {
      serverOverrides.candidatePreferences = { version: 1, responses: [preference({
        responseId: "response-a", respondentId, channel: "CPREF1", messageTs: "700.007"
      })] };
      localOverrides.candidatePreferences = { version: 1, responses: [preference({
        responseId: "response-b", respondentId, channel: "CPREF1", messageTs: "700.007"
      })] };
    }
    return {
      root,
      server: writeSnapshot(root, "server", serverOverrides),
      local: writeSnapshot(root, "local", localOverrides),
      output: path.join(root, "merged")
    };
  };

  for (const [kind, pattern] of [["event", /Meal event secondary slot conflict/u], ["preference", /Candidate preference secondary slot conflict/u]]) {
    const fixture = makeConflict({ kind });
    try {
      assert.throws(
        () => mergeOperatingSnapshots({
          serverDir: fixture.server,
          localDir: fixture.local,
          outputDir: fixture.output,
          now: NOW
        }),
        pattern
      );
      assert.equal(fs.existsSync(fixture.output), false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("snapshot merge selects the more advanced normalization revision for one event ID", () => {
  const root = makeWorkspace();
  try {
    const base = mealEvent({
      eventId: "event-revision",
      respondentId: "66666666-6666-5666-a666-666666666666",
      date: "2026-05-09",
      menu: "정규화 전 메뉴"
    });
    const pending = {
      ...base,
      normalizationStatus: "pending",
      normalizationAttemptCount: 0
    };
    const failed = {
      ...base,
      restaurant: "정규화된식당",
      menu: "정규화된메뉴",
      normalizationStatus: "failed",
      normalizationAttemptCount: 1,
      normalizationStartedAt: "2026-05-09T05:00:00.000Z",
      normalizationCompletedAt: "2026-05-09T05:01:00.000Z",
      normalizationLastError: "검증 근거 부족"
    };
    const server = writeSnapshot(root, "server", {
      mealEvents: { version: 1, events: [pending] }
    });
    const local = writeSnapshot(root, "local", {
      mealEvents: { version: 1, events: [failed] }
    });
    const output = path.join(root, "merged");

    mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW });

    const [event] = readStore(output, "mealEvents").events;
    assert.equal(event.normalizationStatus, "failed");
    assert.equal(event.normalizationAttemptCount, 1);
    assert.equal(event.menu, "정규화된메뉴");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge preserves terminal unverified over an equally exhausted unresolved revision", () => {
  const root = makeWorkspace();
  try {
    const base = mealEvent({
      eventId: "event-unverified",
      respondentId: "67676767-6767-5767-a767-676767676769",
      date: "2026-05-09",
      restaurant: "밥집",
      menu: "제육",
      rawRestaurant: "밥집",
      rawMenu: "제육"
    });
    const unresolved = {
      ...base,
      normalizationStatus: "unresolved",
      normalizationAttemptCount: 3,
      normalizationStartedAt: "2026-05-09T05:00:00.000Z",
      normalizationCompletedAt: "2026-05-09T05:01:00.000Z",
      normalizationLastError: "검증 근거 부족"
    };
    const unverified = {
      ...unresolved,
      normalizationStatus: "unverified"
    };
    const server = writeSnapshot(root, "server", { mealEvents: { version: 1, events: [unresolved] } });
    const local = writeSnapshot(root, "local", { mealEvents: { version: 1, events: [unverified] } });
    const output = path.join(root, "merged");
    mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW });
    assert.equal(readStore(output, "mealEvents").events[0].normalizationStatus, "unverified");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge preserves terminal rejected input over a retryable failure", () => {
  const root = makeWorkspace();
  try {
    const base = mealEvent({
      eventId: "event-rejected-input",
      respondentId: "67676767-6767-5767-a767-676767676768",
      date: "2026-05-09",
      restaurant: "으",
      menu: "으",
      rawRestaurant: "으",
      rawMenu: "으"
    });
    const failed = {
      ...base,
      normalizationStatus: "failed",
      normalizationAttemptCount: 1,
      normalizationStartedAt: "2026-05-09T05:00:00.000Z",
      normalizationCompletedAt: "2026-05-09T05:01:00.000Z",
      normalizationLastError: "검증 근거 부족"
    };
    const rejected = {
      ...base,
      normalizationStatus: "rejected-input",
      normalizationAttemptCount: 0,
      normalizationLastError: "실제 상호명과 메뉴명을 확인할 수 없습니다."
    };
    const server = writeSnapshot(root, "server", { mealEvents: { version: 1, events: [failed] } });
    const local = writeSnapshot(root, "local", { mealEvents: { version: 1, events: [rejected] } });
    const output = path.join(root, "merged");
    mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW });
    assert.equal(readStore(output, "mealEvents").events[0].normalizationStatus, "rejected-input");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge never lets a later failed retry erase a verified normalization", () => {
  const root = makeWorkspace();
  try {
    const base = mealEvent({
      eventId: "event-verified-monotonic",
      respondentId: "67676767-6767-5767-a767-676767676767",
      date: "2026-05-09",
      menu: "정규화 전 메뉴"
    });
    const verified = {
      ...base,
      restaurant: "검증된식당",
      menu: "검증된메뉴",
      normalizationStatus: "verified-source",
      normalizationAttemptCount: 1,
      normalizationStartedAt: "2026-05-09T05:00:00.000Z",
      normalizationCompletedAt: "2026-05-09T05:01:00.000Z"
    };
    const laterFailedRetry = {
      ...base,
      restaurant: "실패한후보",
      menu: "실패한메뉴",
      normalizationStatus: "failed",
      normalizationAttemptCount: 2,
      normalizationStartedAt: "2026-05-09T06:00:00.000Z",
      normalizationCompletedAt: "2026-05-09T06:01:00.000Z",
      normalizationLastError: "재검증 실패"
    };
    const server = writeSnapshot(root, "server", {
      mealEvents: { version: 1, events: [laterFailedRetry] }
    });
    const local = writeSnapshot(root, "local", {
      mealEvents: { version: 1, events: [verified] }
    });
    const output = path.join(root, "merged");

    mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW });

    const [event] = readStore(output, "mealEvents").events;
    assert.equal(event.normalizationStatus, "verified-source");
    assert.equal(event.menu, "검증된메뉴");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge rejects immutable submission changes under one event ID", () => {
  const root = makeWorkspace();
  try {
    const event = mealEvent({
      eventId: "event-immutable",
      respondentId: "88888888-8888-5888-a888-888888888888",
      date: "2026-05-09",
      menu: "동일 메뉴"
    });
    const server = writeSnapshot(root, "server", {
      mealEvents: { version: 1, events: [event] }
    });
    const local = writeSnapshot(root, "local", {
      mealEvents: { version: 1, events: [{ ...event, rating: 1 }] }
    });
    const output = path.join(root, "merged");

    assert.throws(
      () => mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW }),
      /Meal event immutable submission conflict/u
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge keeps the earliest distinct event in one respondent meal slot", () => {
  const root = makeWorkspace();
  try {
    const respondentId = "77777777-7777-5777-a777-777777777777";
    const earliest = mealEvent({
      eventId: "event-earliest", respondentId, date: "2026-05-10", menu: "최초 메뉴"
    });
    const later = {
      ...mealEvent({
        eventId: "event-later", respondentId, date: "2026-05-10", menu: "후속 메뉴"
      }),
      createdAt: "2026-05-10T05:00:00.000Z"
    };
    const server = writeSnapshot(root, "server", {
      mealEvents: { version: 1, events: [earliest] }
    });
    const local = writeSnapshot(root, "local", {
      mealEvents: { version: 1, events: [later] }
    });
    const output = path.join(root, "merged");

    mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW });

    assert.deepEqual(readStore(output, "mealEvents").events.map((event) => event.eventId), ["event-earliest"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge rejects sent provenance and outbox payload conflicts", () => {
  const root = makeWorkspace();
  try {
    const group = recommendationGroup({
      channel: "CSENT1", messageTs: "800.008", recommendedAt: "2026-05-08T02:00:00.000Z", seed: "동일"
    });
    const server = writeSnapshot(root, "server", withHistory(group));
    const local = writeSnapshot(root, "local", {
      history: { version: 1, items: group },
      sentMessages: { version: 1, messages: [sentMessage({
        channel: "CSENT1", ts: "800.008", sentAt: "2026-05-08T02:00:01.000Z", source: "scheduled-static"
      })] }
    });
    assert.throws(
      () => mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: path.join(root, "sent-merged"), now: NOW }),
      /Sent message core provenance conflict/u
    );

    const clientMsgId = "eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee";
    const outboxServer = writeSnapshot(root, "outbox-server", {
      deliveryOutbox: { version: 1, deliveries: [delivery({ clientMsgId, channel: "COUT1" })] }
    });
    const conflicting = delivery({ clientMsgId, channel: "COUT1" });
    conflicting.response.text = "서로 다른 영속 페이로드";
    const outboxLocal = writeSnapshot(root, "outbox-local", {
      deliveryOutbox: { version: 1, deliveries: [conflicting] }
    });
    assert.throws(
      () => mergeOperatingSnapshots({
        serverDir: outboxServer,
        localDir: outboxLocal,
        outputDir: path.join(root, "outbox-merged"),
        now: NOW
      }),
      /Delivery outbox conflict/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge requires an explicit seventh outbox store", () => {
  const root = makeWorkspace();
  try {
    const server = writeSnapshot(root, "server");
    const local = writeSnapshot(root, "local");
    fs.rmSync(path.join(local, STORE_FILES.deliveryOutbox));
    const output = path.join(root, "merged");
    assert.throws(
      () => mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW }),
      /missing required delivery-outbox\.json/u
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge rejects oversized input before JSON parsing and creates no output", () => {
  const root = makeWorkspace();
  try {
    const server = writeSnapshot(root, "server");
    const local = writeSnapshot(root, "local");
    const sourcePath = path.join(server, STORE_FILES.history);
    const oversized = "x".repeat(MAX_JSON_STORE_BYTES + 1);
    fs.writeFileSync(sourcePath, oversized);
    const output = path.join(root, "merged");
    assert.throws(
      () => mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW }),
      /byte safety limit/u
    );
    assert.equal(fs.readFileSync(sourcePath, "utf8"), oversized);
    assert.deepEqual(fs.readdirSync(root).sort(), ["local", "server"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot merge refuses linked input before following or parsing the target", {
  skip: process.platform === "win32"
}, () => {
  const root = makeWorkspace();
  try {
    const server = writeSnapshot(root, "server");
    const local = writeSnapshot(root, "local");
    const foreignPath = path.join(root, "foreign.json");
    fs.writeFileSync(foreignPath, "not JSON and must not be parsed");
    const sourcePath = path.join(server, STORE_FILES.history);
    fs.rmSync(sourcePath);
    fs.symlinkSync(foreignPath, sourcePath);
    const output = path.join(root, "merged");
    assert.throws(
      () => mergeOperatingSnapshots({ serverDir: server, localDir: local, outputDir: output, now: NOW }),
      /regular non-link file/u
    );
    assert.equal(fs.readFileSync(foreignPath, "utf8"), "not JSON and must not be parsed");
    assert.equal(fs.lstatSync(sourcePath).isSymbolicLink(), true);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
