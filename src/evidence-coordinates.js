function finiteCoordinates(latitude, longitude) {
  if (latitude === null || latitude === undefined || String(latitude).trim() === ""
    || longitude === null || longitude === undefined || String(longitude).trim() === "") return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)
    || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { latitude: lat, longitude: lon };
}

function inputValueById(html, id) {
  const inputs = String(html || "").match(/<input\b[^>]*>/giu) || [];
  const input = inputs.find((tag) => tag.match(/\bid=["']([^"']+)["']/iu)?.[1] === id) || "";
  return input.match(/\bvalue=["']([^"']+)["']/iu)?.[1] || "";
}

export function parseDiningCodeCoordinates(html) {
  return finiteCoordinates(
    inputValueById(html, "hdn_lat"),
    inputValueById(html, "hdn_lng")
  );
}

export function parseTablingCoordinates(html) {
  const text = String(html || "");
  const latitudeFirst = text.match(
    /latitude\\*["']?\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]{0,160}?longitude\\*["']?\s*:\s*(-?\d+(?:\.\d+)?)/iu
  );
  if (latitudeFirst) return finiteCoordinates(latitudeFirst[1], latitudeFirst[2]);
  const longitudeFirst = text.match(
    /longitude\\*["']?\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]{0,160}?latitude\\*["']?\s*:\s*(-?\d+(?:\.\d+)?)/iu
  );
  return longitudeFirst ? finiteCoordinates(longitudeFirst[2], longitudeFirst[1]) : null;
}
