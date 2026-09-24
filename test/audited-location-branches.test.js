import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDITED_LOCATION_BRANCH_COUNT,
  auditedBranchForLocation,
  auditedIdentityCorrectionForLocation,
  enrichAuditedLocationBranch,
  isAuditedLocationBranch,
} from "../src/audited-location-branches.js";

test("audited location identities cover only the seven reviewed physical stores", () => {
  assert.equal(AUDITED_LOCATION_BRANCH_COUNT, 7);
  assert.equal(auditedBranchForLocation({
    restaurant: "본도시락",
    evidence: ["https://www.diningcode.com/profile.php?rid=QPwXHDtb7lGP"],
  }), "전북대점");
  assert.equal(auditedBranchForLocation({
    restaurant: "광장수산",
    address: "전북특별자치도 전주시 덕진구 덕진광장로 1-11 1호",
  }), "덕진광장로점");
  assert.equal(auditedBranchForLocation({
    restaurant: "하나요리당고",
    priceEvidenceUrl: "https://www.diningcode.com/profile.php?tracking=1&rid=2xHNItG0xclL",
  }), "전북대점");
  assert.equal(auditedBranchForLocation({
    restaurant: "더 담다",
    evidence: ["https://www.tabling.co.kr/place/677ccbd066de5f06987decbb"],
  }), "전북대점");
  assert.equal(auditedBranchForLocation({
    restaurant: "주모",
    evidence: ["https://www.diningcode.com/profile.php?rid=kQsMWwrcahu3"],
  }), "전북대점");
  assert.equal(auditedBranchForLocation({
    restaurant: "코지버거",
    address: "전북특별자치도 전주시 덕진구 명륜3길 9-4",
  }), "전북대점");
  assert.deepEqual(auditedIdentityCorrectionForLocation({
    restaurant: "모퉁이",
    branch: "전북대점",
    address: "전북특별자치도 전주시 덕진구 삼송3길 42, 107호",
  }), { restaurant: "모퉁이덮밥", branch: "" });
});

test("audited location branches refuse fuzzy, conflicting, or untrusted matches", () => {
  const exact = {
    restaurant: "본도시락",
    address: "전주시 덕진구 조경단로 83",
  };
  assert.equal(auditedBranchForLocation({ ...exact, restaurant: "다른도시락" }), "");
  assert.equal(auditedBranchForLocation({ ...exact, address: "전주시 덕진구 조경단로 8" }), "");
  assert.equal(auditedBranchForLocation({ ...exact, branch: "다른점" }), "");
  assert.equal(isAuditedLocationBranch({ ...exact, branch: "전북대점" }), true);
  assert.equal(isAuditedLocationBranch({ ...exact, branch: "다른점" }), false);
  assert.equal(auditedBranchForLocation({
    restaurant: "본도시락",
    evidence: ["http://www.diningcode.com/profile.php?rid=QPwXHDtb7lGP"],
  }), "");
  assert.equal(auditedBranchForLocation({
    restaurant: "본도시락",
    evidence: ["https://example.com/profile.php?rid=QPwXHDtb7lGP"],
  }), "");
  assert.equal(auditedBranchForLocation({
    restaurant: "더 담다",
    evidence: ["https://www.tabling.co.kr/place/677ccbd066de5f06987decbb?tracking=1"],
  }), "");
  assert.equal(auditedIdentityCorrectionForLocation({
    restaurant: "모퉁이",
    branch: "전북대점",
    address: "전주시 덕진구 삼송3길 4",
  }), null);
  assert.deepEqual(enrichAuditedLocationBranch({ ...exact, branch: "다른점" }), {
    ...exact,
    branch: "다른점",
  });
});
