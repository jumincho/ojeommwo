"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  buildTasteBeeswarm,
  nearestTasteTarget,
  sortMenusByTastePreference,
  TASTE_DOMAIN_END,
  TASTE_DOMAIN_START,
} from "../lib/taste-beeswarm.mjs";
import type { CategoryRecord, MenuRecord, TasteGravityEasterEgg } from "../types";

type TasteMapProps = {
  menus: MenuRecord[];
  easterEggs: TasteGravityEasterEgg[];
  taxonomy: CategoryRecord[];
  selectedId: string | null;
  onSelect: (menu: MenuRecord) => void;
  onSelectEasterEgg: (item: TasteGravityEasterEgg) => void;
};

type TastePresentation = "map" | "list";

type FocusState = {
  id: string | null;
  selectedId: string | null;
};

const TASTE_EASTER_EGG_LEFT = 11.5;

function tasteLabel(menu: MenuRecord) {
  if (menu.taste.evidenceWeight < 0.2) return "판단 전";
  if (menu.taste.mean <= 0.35) return "비선호";
  if (menu.taste.mean >= 0.65) return "선호";
  return "중립";
}

function tastePercent(menu: MenuRecord) {
  return `${(Math.min(1, Math.max(0, menu.taste.mean)) * 100).toFixed(1)}%`;
}

export function TasteMap({ menus, easterEggs, taxonomy, selectedId, onSelect, onSelectEasterEgg }: TasteMapProps) {
  const [presentation, setPresentation] = useState<TastePresentation>("map");
  const [plotWidth, setPlotWidth] = useState(800);
  const [focusState, setFocusState] = useState<FocusState>(() => ({
    id: selectedId ?? menus[0]?.id ?? easterEggs[0]?.id ?? null,
    selectedId,
  }));
  const plotRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const categoryById = useMemo(() => new Map(taxonomy.map((category) => [category.id, category])), [taxonomy]);
  const menuById = useMemo(() => new Map(menus.map((menu) => [menu.id, menu])), [menus]);
  const easterEggById = useMemo(() => new Map(easterEggs.map((item) => [item.id, item])), [easterEggs]);
  const orderedMenus = useMemo(() => sortMenusByTastePreference(menus), [menus]);
  const layout = useMemo(() => buildTasteBeeswarm(menus, taxonomy, plotWidth), [menus, plotWidth, taxonomy]);
  const rowByCategory = useMemo(
    () => new Map<string, number>(layout.rows.map((row: { category: string; y: number }): [string, number] => [row.category, row.y])),
    [layout.rows],
  );

  const navigationIds = useMemo(() => {
    const positions = [
      ...layout.points.map((point: { id: string; x: number; y: number }) => ({ id: point.id, x: point.x, y: point.y })),
      ...easterEggs.map((item) => ({
        id: item.id,
        x: plotWidth * TASTE_EASTER_EGG_LEFT / 100,
        y: rowByCategory.get(item.category) ?? 132,
      })),
    ];
    return positions.sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id)).map((item) => item.id);
  }, [easterEggs, layout.points, plotWidth, rowByCategory]);
  const navigationIdSet = useMemo(() => new Set(navigationIds), [navigationIds]);
  const hitTargets = useMemo(() => [
    ...layout.points.map((point: { id: string; x: number; y: number }) => ({
      id: point.id,
      x: point.x,
      y: point.y,
    })),
    ...easterEggs.map((item) => ({
      id: item.id,
      x: plotWidth * TASTE_EASTER_EGG_LEFT / 100,
      y: rowByCategory.get(item.category) ?? 132,
    })),
  ], [easterEggs, layout.points, plotWidth, rowByCategory]);
  const focusedId = focusState.selectedId === selectedId && focusState.id && navigationIdSet.has(focusState.id)
    ? focusState.id
    : selectedId && navigationIdSet.has(selectedId) ? selectedId : navigationIds[0] ?? null;

  useEffect(() => {
    if (presentation !== "map" || !plotRef.current) return;
    const plot = plotRef.current;
    const updateWidth = (width: number) => setPlotWidth((current) => {
      const next = Math.max(280, Math.round(width));
      return Math.abs(current - next) > 1 ? next : current;
    });
    const updateFromElement = () => updateWidth(plot.getBoundingClientRect().width);
    updateFromElement();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateFromElement);
      return () => window.removeEventListener("resize", updateFromElement);
    }
    const observer = new ResizeObserver(([entry]) => updateWidth(entry.contentRect.width));
    observer.observe(plot);
    return () => observer.disconnect();
  }, [presentation]);

  const registerButton = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) buttonRefs.current.set(id, element);
    else buttonRefs.current.delete(id);
  }, []);

  const moveKeyboardFocus = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(0, navigationIds.indexOf(id));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? navigationIds.length - 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (currentIndex - 1 + navigationIds.length) % navigationIds.length
          : (currentIndex + 1) % navigationIds.length;
    const nextId = navigationIds[nextIndex];
    if (!nextId) return;
    setFocusState({ id: nextId, selectedId });
    window.requestAnimationFrame(() => buttonRefs.current.get(nextId)?.focus());
  }, [navigationIds, selectedId]);

  const selectNearestPointerTarget = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.detail === 0) return;
    // Resolve every nearby surface click, including the transparent selected
    // ring and the gap between two visible points. DOM stacking is irrelevant.
    const bounds = event.currentTarget.getBoundingClientRect();
    const nearestId = nearestTasteTarget(
      hitTargets,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
    if (!nearestId) return;
    const menu = menuById.get(nearestId);
    const easterEgg = easterEggById.get(nearestId);
    if (!menu && !easterEgg) return;
    event.preventDefault();
    event.stopPropagation();
    setFocusState({ id: nearestId, selectedId });
    if (menu) onSelect(menu);
    else if (easterEgg) onSelectEasterEgg(easterEgg);
    window.requestAnimationFrame(() => buttonRefs.current.get(nearestId)?.focus());
  }, [easterEggById, hitTargets, menuById, onSelect, onSelectEasterEgg, selectedId]);

  return (
    <section className={`taste-map taste-map--${presentation}`} aria-label="메뉴 취향 지도">
      <p className="sr-only" id="taste-map-keyboard-help">
        지도에서는 방향키로 메뉴 사이를 이동하고 Enter 또는 Space 키로 상세 정보를 엽니다. Home과 End 키로 처음과 끝 항목으로 이동할 수 있습니다.
      </p>
      <div className="taste-map__presentation" role="group" aria-label="취향 데이터 표시 방식">
        <button type="button" onClick={() => setPresentation("map")} aria-pressed={presentation === "map"} aria-controls="taste-map-plot">지도</button>
        <button type="button" onClick={() => setPresentation("list")} aria-pressed={presentation === "list"} aria-controls="taste-map-list">목록</button>
      </div>

      {presentation === "map" ? (
        <>
          <div
            className="taste-map__semantic-scale"
            role="img"
            aria-label="선호도 축: 왼쪽 비선호 0퍼센트, 가운데 중립 50퍼센트, 오른쪽 선호 100퍼센트"
          >
            <span className="taste-map__semantic-pole taste-map__semantic-pole--negative"><b>← 비선호</b><small>0%</small></span>
            <span className="taste-map__semantic-pole taste-map__semantic-pole--neutral"><b>◇ 중립</b><small>50%</small></span>
            <span className="taste-map__semantic-pole taste-map__semantic-pole--positive"><b>선호 →</b><small>100%</small></span>
            <i aria-hidden="true" />
          </div>

          <div className="taste-map__plot" id="taste-map-plot" ref={plotRef} role="group" aria-describedby="taste-map-keyboard-help">
            <div
              className="taste-map__surface"
              style={{ height: layout.height }}
              onClickCapture={selectNearestPointerTarget}
            >
              <div className="taste-map__zone taste-map__zone--negative" aria-hidden="true" />
              <div className="taste-map__zone taste-map__zone--neutral" aria-hidden="true" />
              <div className="taste-map__zone taste-map__zone--positive" aria-hidden="true" />
              <div className="taste-map__aurora taste-map__aurora--left" aria-hidden="true" />
              <div className="taste-map__aurora taste-map__aurora--right" aria-hidden="true" />
              <div className="taste-map__axis taste-map__axis--negative" aria-hidden="true" />
              <div className="taste-map__axis taste-map__axis--neutral" aria-hidden="true" />
              <div className="taste-map__axis taste-map__axis--positive" aria-hidden="true" />

              <div className="taste-map__rows" aria-hidden="true">
                {taxonomy.map((category) => (
                  <div
                    className="taste-map__row"
                    key={category.id}
                    style={{ top: rowByCategory.get(category.id) ?? 132 }}
                  >
                    <span style={{ color: category.color }}>{category.emoji} {category.id}</span>
                  </div>
                ))}
              </div>

              {layout.points.map((point: { id: string; left: number; y: number; size: number }) => {
                const menu = menuById.get(point.id);
                if (!menu) return null;
                const color = categoryById.get(menu.category)?.color ?? "#ffffff";
                const selected = selectedId === menu.id;
                return (
                  <button
                    type="button"
                    key={menu.id}
                    ref={(element) => registerButton(menu.id, element)}
                    data-taste-id={menu.id}
                    className={`taste-map__star${selected ? " is-selected" : ""}`}
                    style={{
                      left: `${point.left}%`,
                      top: point.y,
                      width: Math.max(24, point.size),
                      height: Math.max(24, point.size),
                      color,
                      opacity: 0.9,
                      "--taste-dot-size": `${point.size}px`,
                      "--taste-dot-glow": `0 0 18px ${color}`,
                    } as React.CSSProperties}
                    onClick={() => onSelect(menu)}
                    onFocus={() => setFocusState({ id: menu.id, selectedId })}
                    onKeyDown={(event) => moveKeyboardFocus(event, menu.id)}
                    aria-label={`${menu.restaurantLabel} ${menu.menu}, ${menu.category}, 선호도 ${tastePercent(menu)}, ${tasteLabel(menu)}`}
                    aria-pressed={selected}
                    aria-describedby="taste-map-keyboard-help"
                    tabIndex={focusedId === menu.id ? 0 : -1}
                    title={`${menu.restaurantLabel} · ${menu.menu}`}
                  >
                    <span />
                  </button>
                );
              })}

              {easterEggs.map((item) => {
                const top = rowByCategory.get(item.category) ?? 132;
                const color = categoryById.get(item.category)?.color ?? "#ffffff";
                const selected = selectedId === item.id;
                return (
                  <button
                    type="button"
                    className={`taste-map__star taste-map__star--easter${selected ? " is-selected" : ""}`}
                    key={item.id}
                    ref={(element) => registerButton(item.id, element)}
                    data-taste-id={item.id}
                    style={{
                      left: `${TASTE_EASTER_EGG_LEFT}%`,
                      top,
                      width: 24,
                      height: 24,
                      color,
                      opacity: 0.88,
                      "--taste-dot-size": "14px",
                      "--taste-dot-glow": `0 0 18px ${color}`,
                    } as React.CSSProperties}
                    onClick={() => onSelectEasterEgg(item)}
                    onFocus={() => setFocusState({ id: item.id, selectedId })}
                    onKeyDown={(event) => moveKeyboardFocus(event, item.id)}
                    aria-label={`${item.restaurantLabel} ${item.menu}, 취향 마이너스 무한대, 추천 알고리즘 영향 없음`}
                    aria-pressed={selected}
                    aria-describedby="taste-map-keyboard-help"
                    tabIndex={focusedId === item.id ? 0 : -1}
                    title={`${item.restaurantLabel} · ${item.menu} · 취향 −∞`}
                  >
                    <span />
                  </button>
                );
              })}
            </div>
          </div>

        </>
      ) : (
        <div className="taste-map__list" id="taste-map-list" aria-label="필터된 메뉴 취향 목록">
          <div className="taste-map__list-heading">
            <p>{menus.length}개 메뉴를 선호하는 순서로 모았습니다.</p>
            <span aria-label="정렬 기준: 선호 순">선호 순 ↓</span>
          </div>
          <div className="taste-map__list-columns" aria-hidden="true">
            <span>카테고리</span>
            <span>메뉴</span>
            <span>상호</span>
            <span>선호도</span>
          </div>
          <div className="taste-map__list-grid">
            {orderedMenus.map((menu: MenuRecord) => {
              const category = categoryById.get(menu.category);
              const selected = selectedId === menu.id;
              return (
                <button
                  type="button"
                  className={`taste-map__list-item${selected ? " is-selected" : ""}`}
                  key={menu.id}
                  onClick={() => onSelect(menu)}
                  aria-pressed={selected}
                  style={{ "--category-color": category?.color ?? "#ffffff" } as React.CSSProperties}
                >
                  <span className="taste-map__list-category">{category?.emoji} {menu.category}</span>
                  <strong>{menu.menu}</strong>
                  <span>{menu.restaurantLabel}</span>
                  <b>{tastePercent(menu)}</b>
                </button>
              );
            })}
            {easterEggs.map((item) => {
              const category = categoryById.get(item.category);
              const selected = selectedId === item.id;
              return (
                <button
                  type="button"
                  className={`taste-map__list-item taste-map__list-item--easter${selected ? " is-selected" : ""}`}
                  key={`${item.id}:list`}
                  onClick={() => onSelectEasterEgg(item)}
                  aria-label={`${item.restaurantLabel} ${item.menu}, 취향 마이너스 무한대, 추천 알고리즘 영향 없음`}
                  aria-pressed={selected}
                  title={item.note}
                  style={{ "--category-color": category?.color ?? "#ffffff" } as React.CSSProperties}
                >
                  <span className="taste-map__list-category">{category?.emoji} {item.category}</span>
                  <strong>{item.menu}</strong>
                  <span>{item.restaurantLabel}</span>
                  <b>−∞</b>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export { TASTE_DOMAIN_END, TASTE_DOMAIN_START };
