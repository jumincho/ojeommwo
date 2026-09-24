"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CategoryRecord, MenuRecord } from "../types";
import { TasteRail } from "./TasteRail";

type RerollShopProps = {
  menus: MenuRecord[];
  taxonomy: CategoryRecord[];
  onSelect: (menu: MenuRecord) => void;
};

function randomIndex(max: number) {
  if (max <= 1) return 0;
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] % max;
  }
  return Math.floor(Math.random() * max);
}

function drawFive(menus: MenuRecord[]) {
  const pool = [...menus];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = randomIndex(index + 1);
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, 5);
}

export function RerollShop({ menus, taxonomy, onSelect }: RerollShopProps) {
  const [roll, setRoll] = useState(0);
  const [rolling, setRolling] = useState(false);
  const rollingTimerRef = useRef<number | null>(null);
  const categoryById = useMemo(() => new Map(taxonomy.map((category) => [category.id, category])), [taxonomy]);
  const cards = useMemo(() => {
    void roll;
    return drawFive(menus);
  }, [menus, roll]);
  const announcement = roll > 0
    ? `${roll}번째 다시 뽑기: 새 메뉴 ${cards.length}개를 표시했습니다. ${cards.map((menu) => menu.menu).join(", ")}`
    : "";

  const reroll = useCallback(() => {
    if (!menus.length) return;
    if (rollingTimerRef.current !== null) window.clearTimeout(rollingTimerRef.current);
    setRolling(true);
    setRoll((value) => value + 1);
    rollingTimerRef.current = window.setTimeout(() => {
      rollingTimerRef.current = null;
      setRolling(false);
    }, 420);
  }, [menus]);

  useEffect(() => () => {
    if (rollingTimerRef.current !== null) window.clearTimeout(rollingTimerRef.current);
  }, []);

  return (
    <section className="reroll-shop" aria-label="메뉴 둘러보기">
      <div className="reroll-shop__control">
        <div>
          <strong>메뉴 둘러보기</strong>
          <small>마음에 드는 메뉴를 눌러 자세히 보세요.</small>
        </div>
        <button type="button" className="reroll-button" onClick={reroll} disabled={menus.length < 1}>
          <span className={rolling ? "reroll-icon is-rolling" : "reroll-icon"}>↻</span>
          다시 뽑기
        </button>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <div className={`reroll-shop__cards${rolling ? " is-rolling" : ""}`} aria-label="현재 뽑힌 메뉴">
        {cards.map((menu, index) => {
          const category = categoryById.get(menu.category);
          const color = category?.color ?? "#ffffff";
          return (
            <button
              type="button"
              className="reroll-card"
              key={menu.id}
              onClick={() => onSelect(menu)}
              style={{ "--card-color": color } as React.CSSProperties}
              aria-label={`${index + 1}번 메뉴 ${menu.restaurantLabel} ${menu.menu}`}
            >
              <span className="reroll-card__category">{category?.emoji} {menu.category}</span>
              <strong>{menu.menu}</strong>
              <span className="reroll-card__restaurant">{menu.restaurantLabel}</span>
              <TasteRail taste={menu.taste} compact />
              <span className="reroll-card__price">{menu.priceText || "가격 정보 없음"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
