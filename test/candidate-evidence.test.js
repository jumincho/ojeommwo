import test from "node:test";
import assert from "node:assert/strict";
import { verifyCandidateResearchEvidence } from "../src/candidate-evidence.js";
import { parseTablingCoordinates } from "../src/evidence-coordinates.js";

function candidate() {
  return {
    category: "도시락",
    restaurant: "근거식당",
    branch: "",
    address: "전북특별자치도 전주시 덕진구 테스트로 1",
    latitude: 35.9,
    longitude: 127.2,
    menu: "제육덮밥",
    ingredientFamilies: ["pork"],
    priceText: "9,000원",
    priceChannel: "store",
    priceCheckedAt: "2026-07-01T00:00:00.000Z",
    deliveryStatus: "likely",
    deliveryCheckedAt: "2026-07-01T00:00:00.000Z",
    priceEvidenceUrl: "https://www.tabling.co.kr/place/abc123",
    deliveryEvidenceUrl: "https://www.tabling.co.kr/place/abc123",
    comment: "매콤한 제육 양념과 따뜻한 밥이 어우러져, 부드러운 고기 식감과 진한 감칠맛을 함께 즐길 수 있습니다.",
    evidence: ["https://www.tabling.co.kr/place/abc123"]
  };
}

test("Tabling evidence corrects model coordinates and refreshes only matched facts", async () => {
  const html = '<script>{"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1","menu":"제육덮밥","price":"9,000원","classifications":["배달"],"latitude":35.8442,"longitude":127.1264}</script>';
  const calls = [];
  const now = new Date("2026-07-15T06:30:00.000Z");
  const result = await verifyCandidateResearchEvidence([candidate()], {
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const bytes = new TextEncoder().encode(html);
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.byteLength) },
        arrayBuffer: async () => bytes.buffer
      };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(result.length, 1);
  assert.equal(result[0].latitude, 35.8442);
  assert.equal(result[0].longitude, 127.1264);
  assert.equal(result[0].priceCheckedAt, now.toISOString());
  assert.equal(result[0].deliveryCheckedAt, now.toISOString());
  assert.equal(result[0].evidenceVerification, "deterministic-html");
  assert.equal(result[0].evidenceVerifiedAt, now.toISOString());
});

test("candidate evidence rejects address details that are absent from the evidence page", async () => {
  const input = { ...candidate(), address: "전북특별자치도 전주시 덕진구 테스트로 1 임의빌딩 113호" };
  const html = '<script>{"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1 113호","menu":"제육덮밥","price":"9,000원","classifications":["배달"],"latitude":35.8442,"longitude":127.1264}</script>';
  const bytes = new TextEncoder().encode(html);
  const result = await verifyCandidateResearchEvidence([input], {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    })
  });
  assert.deepEqual(result, []);
});

test("candidate evidence fails closed without an explicit delivery signal", async () => {
  const html = '<script>{"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1","menu":"제육덮밥","price":"9,000원","latitude":35.8442,"longitude":127.1264}</script>';
  const bytes = new TextEncoder().encode(html);
  const result = await verifyCandidateResearchEvidence([candidate()], {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    })
  });
  assert.deepEqual(result, []);
});

test("a raw model cannot self-attest deterministic candidate evidence", async () => {
  const html = '<script>{"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1","menu":"제육덮밥","price":"9,000원","latitude":35.8442,"longitude":127.1264}</script>';
  const bytes = new TextEncoder().encode(html);
  const modelClaim = {
    ...candidate(),
    evidenceVerification: "deterministic-html",
    evidenceVerifiedAt: "2026-07-01T00:00:00.000Z"
  };
  const result = await verifyCandidateResearchEvidence([modelClaim], {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    })
  });
  assert.deepEqual(result, [], "a model-provided verification stamp cannot replace live delivery evidence");
});

test("candidate evidence ignores delivery words that appear only in review prose", async () => {
  const html = '<script>{"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1","menu":"제육덮밥","price":"9,000원","review":"배달이 빨랐어요","latitude":35.8442,"longitude":127.1264}</script>';
  const bytes = new TextEncoder().encode(html);
  const result = await verifyCandidateResearchEvidence([candidate()], {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    })
  });
  assert.deepEqual(result, []);
});

test("candidate evidence requires menu and price in one bounded structure or near each other", async () => {
  const html = '<script>{"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1","classifications":["배달"],"latitude":35.8442,"longitude":127.1264}</script>'
    + '<div class="menu">제육덮밥</div>'
    + `<div>${"관련없는설명".repeat(80)}</div>`
    + '<div class="price">9,000원</div>';
  const bytes = new TextEncoder().encode(html);
  const diagnostics = [];
  const result = await verifyCandidateResearchEvidence([candidate()], {
    diagnostics,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    })
  });
  assert.deepEqual(result, []);
  assert.equal(diagnostics[0].reason, "matched-page-missing-coupled-menu-price");
  assert.equal(diagnostics[0].disposition, "transient");
});

test("Tabling structured closure is a hard negative while closure review prose is not", async () => {
  const closedHtml = '<script>{"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1","menu":"제육덮밥","price":"9,000원","classifications":["배달"],"businessStatus":"CLOSED","latitude":35.8442,"longitude":127.1264}</script>';
  const reviewHtml = '<script>{"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1","menu":"제육덮밥","price":"9,000원","classifications":["배달"],"review":"폐업 전에 갔던 다른 식당 이야기","latitude":35.8442,"longitude":127.1264}</script>';
  const diagnostics = [];
  const fetchFor = (html) => {
    const bytes = new TextEncoder().encode(html);
    return async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    });
  };
  assert.deepEqual(await verifyCandidateResearchEvidence([candidate()], {
    diagnostics,
    fetchImpl: fetchFor(closedHtml)
  }), []);
  assert.equal(diagnostics[0].reason, "structured-inactive-business");
  assert.equal(diagnostics[0].disposition, "hard-negative");
  assert.equal((await verifyCandidateResearchEvidence([candidate()], {
    fetchImpl: fetchFor(reviewHtml)
  })).length, 1);
});

test("a fetched identity mismatch is a hard negative but an all-fetch failure is transient", async () => {
  const mismatchHtml = '<script>{"name":"다른식당","address":"전북 전주시 덕진구 다른로 99","latitude":35.8442,"longitude":127.1264}</script>';
  const mismatchBytes = new TextEncoder().encode(mismatchHtml);
  const mismatchDiagnostics = [];
  assert.deepEqual(await verifyCandidateResearchEvidence([candidate()], {
    diagnostics: mismatchDiagnostics,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(mismatchBytes.byteLength) },
      arrayBuffer: async () => mismatchBytes.buffer
    })
  }), []);
  assert.equal(mismatchDiagnostics[0].reason, "identity-mismatch");
  assert.equal(mismatchDiagnostics[0].disposition, "hard-negative");

  const transientDiagnostics = [];
  assert.deepEqual(await verifyCandidateResearchEvidence([candidate()], {
    diagnostics: transientDiagnostics,
    fetchImpl: async () => {
      throw new Error("temporary network outage");
    }
  }), []);
  assert.equal(transientDiagnostics[0].reason, "all-fetch-failed");
  assert.equal(transientDiagnostics[0].disposition, "transient");
});

test("HTTP 404 and 410 are unavailable while rate limits and server errors stay transient", async () => {
  for (const status of [404, 410]) {
    const diagnostics = [];
    assert.deepEqual(await verifyCandidateResearchEvidence([candidate()], {
      diagnostics,
      fetchImpl: async () => ({ ok: false, status })
    }), []);
    assert.equal(diagnostics[0].reason, "evidence-url-unavailable");
    assert.equal(diagnostics[0].disposition, "unavailable");
    assert.equal(diagnostics[0].sources[0].status, status);
  }
  for (const status of [429, 500, 503]) {
    const diagnostics = [];
    assert.deepEqual(await verifyCandidateResearchEvidence([candidate()], {
      diagnostics,
      fetchImpl: async () => ({ ok: false, status })
    }), []);
    assert.equal(diagnostics[0].reason, "all-fetch-failed");
    assert.equal(diagnostics[0].disposition, "transient");
    assert.equal(diagnostics[0].sources[0].status, status);
  }
});

test("generic provider maintenance and access-denied pages are transient, not hard negatives", async () => {
  for (const html of [
    "<html><title>Maintenance</title><body>Please try again later</body></html>",
    "<html><title>Access denied</title><body>Request blocked</body></html>"
  ]) {
    const bytes = new TextEncoder().encode(html);
    const diagnostics = [];
    assert.deepEqual(await verifyCandidateResearchEvidence([candidate()], {
      diagnostics,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.byteLength) },
        arrayBuffer: async () => bytes.buffer
      })
    }), []);
    assert.equal(diagnostics[0].reason, "provider-page-unavailable");
    assert.equal(diagnostics[0].disposition, "transient");
  }
});

test("a requested branch must match page text or an explicit structured branch identifier", async () => {
  const input = { ...candidate(), branch: "전북대점" };
  const verifyHtml = async (html, diagnostics = []) => {
    const bytes = new TextEncoder().encode(html);
    const result = await verifyCandidateResearchEvidence([input], {
      diagnostics,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.byteLength) },
        arrayBuffer: async () => bytes.buffer
      })
    });
    return { result, diagnostics };
  };
  const base = '"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1","menu":"제육덮밥","price":"9,000원","classifications":["배달"],"latitude":35.8442,"longitude":127.1264';
  assert.equal((await verifyHtml(
    `<script>{${base},"filler":"${"x".repeat(240)}","branch":"전북대점"}</script>`
  )).result.length, 1);

  const wrong = await verifyHtml(`<script>{${base},"branch":"완산점"}</script>`);
  assert.deepEqual(wrong.result, []);
  assert.equal(wrong.diagnostics[0].reason, "identity-mismatch");
  assert.equal(wrong.diagnostics[0].disposition, "hard-negative");

  const absent = await verifyHtml(`<script>{${base}}</script>`);
  assert.deepEqual(absent.result, []);
  assert.equal(absent.diagnostics[0].reason, "branch-unverified");
  assert.equal(absent.diagnostics[0].disposition, "unavailable");
});

test("an audited physical location may retain its canonical branch when the page proves its address", async () => {
  const input = {
    ...candidate(),
    restaurant: "광장수산",
    branch: "덕진광장로점",
    address: "전라북도 전주시 덕진구 덕진광장로 1-11 1호",
    menu: "광어(소)",
    priceText: "37,000원",
    priceEvidenceUrl: "https://www.diningcode.com/profile.php?rid=bzDOMtvnugZq",
    deliveryEvidenceUrl: "https://www.diningcode.com/profile.php?rid=bzDOMtvnugZq",
    evidence: ["https://www.diningcode.com/profile.php?rid=bzDOMtvnugZq"],
  };
  const diagnostics = [];
  const html = '<input id="hdn_lat" value="35.8444"><input id="hdn_lng" value="127.1240">'
    + "<div>광장수산 전라북도 전주시 덕진구 덕진광장로 1-11 1호 광어(소) 37,000원</div>"
    + "<span>배달 <b>1</b></span>";
  const bytes = new TextEncoder().encode(html);
  const verified = await verifyCandidateResearchEvidence([input], {
    now: new Date("2026-07-12T00:00:00.000Z"),
    diagnostics,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer,
    }),
  });
  assert.equal(verified.length, 1);
  assert.equal(verified[0].branch, "덕진광장로점");
  assert.deepEqual(diagnostics, []);
});

test("Tabling evidence URLs are canonicalized without following redirects", async () => {
  const input = candidate();
  input.priceEvidenceUrl = "https://tabling.co.kr/place/abc123";
  input.deliveryEvidenceUrl = "https://tabling.co.kr/place/abc123";
  input.evidence = [];
  const html = '<script>{"name":"근거식당","address":"전북 전주시 덕진구 테스트로 1","menu":"제육덮밥","price":"9,000원","classifications":["배달"],"latitude":35.8442,"longitude":127.1264}</script>';
  const bytes = new TextEncoder().encode(html);
  const urls = [];
  const result = await verifyCandidateResearchEvidence([input], {
    fetchImpl: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.byteLength) },
        arrayBuffer: async () => bytes.buffer
      };
    }
  });
  assert.deepEqual(urls, ["https://www.tabling.co.kr/place/abc123"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].priceEvidenceUrl, "https://www.tabling.co.kr/place/abc123");
});

test("candidate evidence rejects query, fragment, and extra-parameter URL variants", async () => {
  const variants = [
    "https://www.tabling.co.kr/place/abc123?tracking=1",
    "https://www.tabling.co.kr/place/abc123#menu",
    "https://www.diningcode.com/profile.php?rid=test123&tracking=1",
    "https://www.diningcode.com/profile.php?rid=test123#menu"
  ];
  for (const value of variants) {
    const input = candidate();
    input.priceEvidenceUrl = value;
    input.deliveryEvidenceUrl = value;
    input.evidence = [];
    let fetched = false;
    const diagnostics = [];
    assert.deepEqual(await verifyCandidateResearchEvidence([input], {
      diagnostics,
      fetchImpl: async () => {
        fetched = true;
        throw new Error("must not fetch");
      }
    }), []);
    assert.equal(fetched, false);
    assert.equal(diagnostics[0].reason, "no-supported-evidence-url");
  }
});

test("DiningCode evidence requires its explicit delivery keyword count", async () => {
  const input = candidate();
  input.priceEvidenceUrl = "https://www.diningcode.com/profile.php?rid=test123";
  input.deliveryEvidenceUrl = "https://www.diningcode.com/profile.php?rid=test123";
  input.evidence = [];
  const html = '<input id="hdn_lat" value="35.8442"><input id="hdn_lng" value="127.1264"><div>근거식당 전북 전주시 덕진구 테스트로 1 제육덮밥 9,000원</div><span>배달 <b>1</b></span>';
  const bytes = new TextEncoder().encode(html);
  const result = await verifyCandidateResearchEvidence([input], {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    })
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].latitude, 35.8442);
  assert.equal(result[0].longitude, 127.1264);
});

test("DiningCode business identity ignores nested MenuItem names and accepts the visible road address", async () => {
  const input = {
    ...candidate(),
    branch: "전북대점",
    priceEvidenceUrl: "https://www.diningcode.com/profile.php?rid=test123",
    deliveryEvidenceUrl: "https://www.diningcode.com/profile.php?rid=test123",
    evidence: []
  };
  const jsonLd = {
    "@context": "http://schema.org/",
    "@type": "FoodEstablishment",
    name: "근거식당 전북대점",
    address: { streetAddress: "전북특별자치도 전주시 덕진구 시험동 123-4" },
    hasMenu: {
      "@type": "Menu",
      hasMenuItem: [
        { "@type": "MenuItem", name: "다른 메뉴", offers: { price: "8,000원" } },
        { "@type": "MenuItem", name: "제육덮밥", offers: { price: "9,000원" } }
      ]
    }
  };
  const html = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
    + '<input id="hdn_lat" value="35.8442"><input id="hdn_lng" value="127.1264">'
    + '<div>근거식당 전북대점 · 전북특별자치도 전주시 덕진구 테스트로 1</div>'
    + '<span>배달 <b>1</b></span>';
  const bytes = new TextEncoder().encode(html);
  const result = await verifyCandidateResearchEvidence([input], {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    })
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].restaurant, "근거식당");
});

test("DiningCode evidence accepts a structured delivery classification link", async () => {
  const input = candidate();
  input.priceEvidenceUrl = "https://www.diningcode.com/profile.php?rid=test123";
  input.deliveryEvidenceUrl = "https://www.diningcode.com/profile.php?rid=test123";
  input.evidence = [];
  const html = '<input id="hdn_lat" value="35.8442"><input id="hdn_lng" value="127.1264"><div>근거식당 전북 전주시 덕진구 테스트로 1 제육덮밥 9,000원</div><a href="/list.dc?query=전주 배달">배달</a>';
  const bytes = new TextEncoder().encode(html);
  const result = await verifyCandidateResearchEvidence([input], {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    })
  });
  assert.equal(result.length, 1);
});

test("DiningCode structured closure rejects the profile but a closure-report control does not", async () => {
  const input = candidate();
  input.priceEvidenceUrl = "https://www.diningcode.com/profile.php?rid=test123";
  input.deliveryEvidenceUrl = "https://www.diningcode.com/profile.php?rid=test123";
  input.evidence = [];
  const base = '<input id="hdn_lat" value="35.8442"><input id="hdn_lng" value="127.1264"><div>근거식당 전북 전주시 덕진구 테스트로 1 제육덮밥 9,000원</div><span>배달 <b>1</b></span>';
  const fetchFor = (html) => {
    const bytes = new TextEncoder().encode(html);
    return async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer
    });
  };
  assert.deepEqual(await verifyCandidateResearchEvidence([input], {
    fetchImpl: fetchFor(`${base}<div class="business-status">휴업</div>`)
  }), []);
  assert.equal((await verifyCandidateResearchEvidence([input], {
    fetchImpl: fetchFor(`${base}<div class="business-status">폐업신고 · 정보수정 제안</div>`)
  })).length, 1);
});

test("candidate evidence limits global fetch concurrency and preserves result order", async () => {
  const inputs = Array.from({ length: 13 }, (_, index) => {
    const input = {
      ...candidate(),
      restaurant: `근거식당${index}`,
      address: `전북특별자치도 전주시 덕진구 테스트로 ${index + 1}`,
      menu: `제육덮밥${index}`,
      priceEvidenceUrl: `https://www.tabling.co.kr/place/item${index}`,
      deliveryEvidenceUrl: `https://www.tabling.co.kr/place/item${index}`,
      evidence: [`https://www.tabling.co.kr/place/item${index}`]
    };
    return input;
  });
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const diagnostics = [];
  const result = await verifyCandidateResearchEvidence(inputs, {
    diagnostics,
    fetchImpl: async (url) => {
      const index = Number(new URL(url).pathname.replace("/place/item", ""));
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (index % 3 === 0) await new Promise((resolve) => setImmediate(resolve));
        if (index % 4 === 0) await new Promise((resolve) => setImmediate(resolve));
        const html = index % 2 === 0
          ? `<script>{"name":"근거식당${index}","address":"전북 전주시 덕진구 테스트로 ${index + 1}","menu":"제육덮밥${index}","price":"9,000원","classifications":["배달"],"latitude":35.8442,"longitude":127.1264}</script>`
          : "<html><title>Maintenance</title><body>Please try again later</body></html>";
        const bytes = new TextEncoder().encode(html);
        return {
          ok: true,
          status: 200,
          headers: { get: () => String(bytes.byteLength) },
          arrayBuffer: async () => bytes.buffer
        };
      } finally {
        active -= 1;
      }
    }
  });
  assert.equal(calls, 13);
  assert.equal(maximumActive, 2);
  assert.deepEqual(
    result.map((item) => item.restaurant),
    inputs.filter((_, index) => index % 2 === 0).map((item) => item.restaurant)
  );
  assert.deepEqual(
    diagnostics.map((item) => item.restaurant),
    inputs.filter((_, index) => index % 2 === 1).map((item) => item.restaurant)
  );
  assert.ok(diagnostics.every((item) => item.reason === "provider-page-unavailable"));
});

test("Tabling coordinate parser accepts escaped application JSON", () => {
  assert.deepEqual(
    parseTablingCoordinates('latitude\\\":35.84420199800019,\\\"longitude\\\":127.12643259975269'),
    { latitude: 35.84420199800019, longitude: 127.12643259975269 }
  );
  assert.equal(parseTablingCoordinates("no coordinates"), null);
});

test("a current exact menu price change cannot be reused as a transient old-price candidate", async () => {
  const identity = { name: "근거식당", address: "전북 전주시 덕진구 테스트로 1",
    classifications: ["배달"], latitude: 35.8442, longitude: 127.1264 };
  const fetchFor = (html) => async () => new Response(html, { status: 200 });
  for (const html of [
    '<script>' + JSON.stringify({ ...identity, menu: "제육덮밥", price: "10,000원" }) + '</script>',
    '<script>' + JSON.stringify({ ...identity, menus: [{ name: "제육덮밥", price: 10000, priceCurrency: "KRW" }] }) + '</script>',
    '<script>' + JSON.stringify(identity) + '</script><li><strong>제육 덮밥</strong><span>10,000원</span></li>',
  ]) {
    const diagnostics = [];
    const result = await verifyCandidateResearchEvidence([candidate()], { fetchImpl: fetchFor(html), diagnostics });
    assert.deepEqual(result, []);
    assert.equal(diagnostics[0].reason, "current-menu-price-changed");
    assert.equal(diagnostics[0].disposition, "unavailable");
  }
});

test("different sizes, ambiguous prices, and review claims cannot prove a menu price change", async () => {
  const base = { name: "근거식당", address: "전북 전주시 덕진구 테스트로 1",
    classifications: ["배달"], latitude: 35.8442, longitude: 127.1264 };
  for (const extra of [
    { menus: [{ name: "제육덮밥(대)", price: 10000 }] },
    { menus: [{ name: "제육덮밥", price: 10000 }, { name: "제육덮밥", price: 12000 }] },
    { reviews: [{ name: "제육덮밥", price: 10000 }] },
    { relatedMenus: [{ name: "제육덮밥", price: 10000 }] },
    { menus: [{ name: "제육덮밥", price: "무료 10,000원", priceCurrency: "KRW" }] },
    { menus: [{ name: "제육덮밥", price: 10000, priceCurrency: "USD" }] },
  ]) {
    const diagnostics = [];
    const html = '<script>' + JSON.stringify({ ...base, ...extra }) + '</script>';
    await verifyCandidateResearchEvidence([candidate()], {
      fetchImpl: async () => new Response(html, { status: 200 }), diagnostics,
    });
    assert.notEqual(diagnostics[0]?.reason, "current-menu-price-changed", JSON.stringify(extra));
  }
});
