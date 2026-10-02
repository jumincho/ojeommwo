// Projection only: expired commercial facts must never survive an old API,
// static or browser cache snapshot. Historical taste/counts are unchanged.
export function projectSnapshotFreshness(snapshot, nowMs = Date.now()) {
  const menus = snapshot.menus.map((menu) => {
    const priceCurrent = Number.isFinite(Date.parse(menu.priceExpiresAt))
      && Date.parse(menu.priceExpiresAt) > nowMs;
    const deliveryCurrent = Number.isFinite(Date.parse(menu.availabilityExpiresAt))
      && Date.parse(menu.availabilityExpiresAt) > nowMs;
    const availableNow = menu.availableNow && priceCurrent && deliveryCurrent;
    return {
      ...menu,
      availableNow,
      priceText: priceCurrent ? menu.priceText : "가격 정보 없음",
      priceCheckedAt: priceCurrent ? menu.priceCheckedAt : null,
      priceExpiresAt: priceCurrent ? menu.priceExpiresAt : null,
      deliveryStatus: deliveryCurrent ? menu.deliveryStatus : null,
      deliveryFreshness: deliveryCurrent ? menu.deliveryFreshness : null,
      availabilityCheckedAt: deliveryCurrent ? menu.availabilityCheckedAt : null,
      availabilityExpiresAt: deliveryCurrent ? menu.availabilityExpiresAt : null,
      sources: availableNow ? menu.sources : menu.sources.filter((source) => source !== "verified"),
    };
  });
  return { ...snapshot, menus, stats: { ...snapshot.stats, freshCandidates: menus.filter((menu) => menu.availableNow).length } };
}

export function nextFactExpiry(snapshot, nowMs = Date.now()) {
  const times = snapshot.menus.flatMap((menu) => [menu.priceExpiresAt, menu.availabilityExpiresAt])
    .map((value) => Date.parse(value)).filter((time) => Number.isFinite(time) && time > nowMs);
  return times.length ? Math.min(...times) : null;
}
