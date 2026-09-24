"use strict";

const state = { menus: [] };
const searchInput = document.querySelector("#menu-search");
const rows = document.querySelector("#menu-rows");
const status = document.querySelector("#snapshot-status");
const emptyState = document.querySelector("#empty-state");

function normalized(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ").trim();
}

function appendCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "");
  if (className) cell.className = className;
  row.append(cell);
}

function render() {
  const query = normalized(searchInput?.value);
  const visible = state.menus.filter((menu) => normalized([
    menu.menu,
    menu.restaurant,
    menu.branch,
    menu.category,
    ...(Array.isArray(menu.ingredientFamilies) ? menu.ingredientFamilies : []),
  ].join(" ")).includes(query));
  const fragment = document.createDocumentFragment();
  for (const menu of visible) {
    const row = document.createElement("tr");
    appendCell(row, menu.menu);
    appendCell(row, menu.restaurant);
    appendCell(row, menu.branch || "-");
    appendCell(row, menu.category);
    appendCell(row, Array.isArray(menu.ingredientFamilies) ? menu.ingredientFamilies.join(", ") : "-");
    appendCell(row, menu.priceText);
    appendCell(row, `${Math.round(Number(menu.taste?.mean || 0.5) * 100)}%`);
    appendCell(row, menu.occurrences);
    appendCell(
      row,
      menu.availableNow ? "현재 검증됨" : "이력 정보",
      menu.availableNow ? "availability-current" : "availability-history",
    );
    fragment.append(row);
  }
  rows?.replaceChildren(fragment);
  if (emptyState) emptyState.hidden = visible.length !== 0;
  if (status?.dataset.ready === "true") {
    status.textContent = `전체 ${state.menus.length.toLocaleString("ko-KR")}개 중 ${visible.length.toLocaleString("ko-KR")}개 메뉴를 표시합니다.`;
  }
}

async function loadSnapshot() {
  try {
    const response = await fetch("/data/snapshot.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    if (snapshot?.schemaVersion !== 2 || !Array.isArray(snapshot.menus)) throw new Error("지원하지 않는 스냅샷입니다");
    state.menus = [...snapshot.menus].sort((left, right) => (
      Number(right.occurrences || 0) - Number(left.occurrences || 0)
      || String(left.restaurantLabel || left.restaurant).localeCompare(String(right.restaurantLabel || right.restaurant), "ko")
      || String(left.menu).localeCompare(String(right.menu), "ko")
    ));
    if (status) status.dataset.ready = "true";
    render();
  } catch {
    if (status) status.textContent = "검증된 스냅샷을 표시할 수 없습니다. 터미널 오류를 확인해 주세요.";
    if (emptyState) {
      emptyState.hidden = false;
      emptyState.textContent = "데이터를 불러오지 못했습니다.";
    }
  }
}

searchInput?.addEventListener("input", render);
void loadSnapshot();
