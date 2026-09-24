"use client";

import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { MenuRecord, ObservatorySnapshot, TasteGravityEasterEgg } from "../types";
import { nextCategorySelection } from "../lib/category-selection.mjs";
import { validateSnapshot } from "../lib/snapshot-validator.mjs";
import { MenuCosmos } from "./MenuCosmos";
import { RerollShop } from "./RerollShop";
import { TasteMap } from "./TasteMap";
import { TasteRail } from "./TasteRail";

type ViewMode = "cosmos" | "taste";

type SelectionState = {
  id: string | null;
  detailOpen: boolean;
};

const formatter = new Intl.NumberFormat("ko-KR");
const SNAPSHOT_CACHE_KEY = "ojeommwo-observatory:last-good:v2";
const MAX_SNAPSHOT_TEXT_LENGTH = 5_000_000;
const CONTROLS_OVERLAY_QUERY = "(max-width: 760px)";
const DETAILS_OVERLAY_QUERY = "(max-width: 980px)";
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function normalizeSearch(value: string) {
  return value.toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

function deliveryLabel(menu: MenuRecord) {
  if (menu.deliveryFreshness === "recent") {
    return menu.deliveryStatus === "verified" ? "최근 배달 가능 확인" : "최근 배달 운영 확인";
  }
  if (menu.deliveryStatus === "verified") return "배달 가능";
  if (menu.deliveryStatus === "likely") return "배달 운영 중";
  return "배달 정보 없음";
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function focusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && !element.closest("[inert]"));
}

function LoadingState() {
  return (
    <main className="observatory-loading">
      <div className="observatory-loading__orbit"><span /><span /><span /></div>
      <h1>메뉴를 불러오고 있습니다</h1>
      <p>잠시만 기다려 주세요.</p>
    </main>
  );
}

function ErrorState({ message, retry, title = "데이터에 연결하지 못했습니다" }: { message: string; retry: () => void; title?: string }) {
  return (
    <main className="observatory-loading observatory-loading--error">
      <div className="error-glyph">!</div>
      <h1>{title}</h1>
      <p>{message}</p>
      <button type="button" className="primary-button" onClick={retry}>다시 연결</button>
    </main>
  );
}

type SnapshotRenderBoundaryProps = {
  children: ReactNode;
  resetKey: string;
  onReset: () => void;
};

class SnapshotRenderBoundary extends Component<SnapshotRenderBoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Observatory rendering failed", error, info.componentStack);
  }

  componentDidUpdate(previous: SnapshotRenderBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          title="관측 화면을 표시하지 못했습니다"
          message="화면을 그리는 중 오류가 발생했습니다. 저장된 데이터는 변경하지 않았습니다."
          retry={() => {
            this.setState({ error: null });
            this.props.onReset();
          }}
        />
      );
    }
    return this.props.children;
  }
}

type ObservatoryAppProps = {
  snapshot: ObservatorySnapshot;
  snapshotNotice: string | null;
};

function ObservatoryApp({ snapshot, snapshotNotice }: ObservatoryAppProps) {
  const [view, setView] = useState<ViewMode>("cosmos");
  const [selectedCategories, setSelectedCategories] = useState(() => new Set(snapshot.taxonomy.map((item) => item.id)));
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<SelectionState>(() => ({
    id: snapshot.menus[0]?.id ?? snapshot.displayOnly?.tasteGravity?.[0]?.id ?? null,
    detailOpen: false,
  }));
  const [paused, setPaused] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const controlsAreOverlay = useMediaQuery(CONTROLS_OVERLAY_QUERY);
  const detailsAreOverlay = useMediaQuery(DETAILS_OVERLAY_QUERY);
  const sidebarButtonRef = useRef<HTMLButtonElement>(null);
  const controlPanelRef = useRef<HTMLElement>(null);
  const detailPanelRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const lastSelectionTriggerRef = useRef<HTMLElement | null>(null);

  const filteredMenus = useMemo(() => {
    const needle = normalizeSearch(query);
    return snapshot.menus.filter((menu) => {
      if (!selectedCategories.has(menu.category)) return false;
      if (!needle) return true;
      const haystack = normalizeSearch([
        menu.restaurant,
        menu.branch,
        menu.restaurantLabel,
        menu.menu,
        menu.category,
        ...menu.ingredientFamilies,
      ].join(" "));
      return haystack.includes(needle);
    });
  }, [query, selectedCategories, snapshot.menus]);

  const visibleTasteEasterEggs = useMemo(
    () => (snapshot.displayOnly?.tasteGravity ?? []).filter((item) => selectedCategories.has(item.category)),
    [selectedCategories, snapshot.displayOnly],
  );
  const visibleTaxonomy = useMemo(
    () => snapshot.taxonomy.filter((category) => selectedCategories.has(category.id)),
    [selectedCategories, snapshot.taxonomy],
  );
  const selectableIds = useMemo(
    () => new Set([...snapshot.menus.map((menu) => menu.id), ...(snapshot.displayOnly?.tasteGravity ?? []).map((item) => item.id)]),
    [snapshot.displayOnly, snapshot.menus],
  );
  const selectionStillExists = Boolean(selection.id && selectableIds.has(selection.id));
  const selectedId = selectionStillExists
    ? selection.id
    : snapshot.menus[0]?.id ?? snapshot.displayOnly?.tasteGravity?.[0]?.id ?? null;
  const detailOpen = selectionStillExists && selection.detailOpen;
  const selectedMenu = snapshot.menus.find((menu) => menu.id === selectedId) ?? null;
  const selectedEasterEgg = (snapshot.displayOnly?.tasteGravity ?? []).find((item) => item.id === selectedId) ?? null;
  const activeModal = detailsAreOverlay && detailOpen
    ? "details"
    : controlsAreOverlay && sidebarOpen ? "controls" : null;
  const categoryById = useMemo(() => new Map(snapshot.taxonomy.map((item) => [item.id, item])), [snapshot.taxonomy]);

  const selectMenu = useCallback((menu: MenuRecord) => {
    if (document.activeElement instanceof HTMLElement && document.activeElement.matches(FOCUSABLE_SELECTOR)) {
      lastSelectionTriggerRef.current = document.activeElement;
    }
    setSelection({ id: menu.id, detailOpen: true });
  }, []);

  const selectEasterEgg = useCallback((item: TasteGravityEasterEgg) => {
    if (document.activeElement instanceof HTMLElement && document.activeElement.matches(FOCUSABLE_SELECTOR)) {
      lastSelectionTriggerRef.current = document.activeElement;
    }
    setSelection({ id: item.id, detailOpen: true });
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    window.requestAnimationFrame(() => {
      if (controlsAreOverlay) sidebarButtonRef.current?.focus();
    });
  }, [controlsAreOverlay]);

  const closeDetail = useCallback(() => {
    setSelection((current) => ({ ...current, detailOpen: false }));
    window.requestAnimationFrame(() => {
      const trigger = lastSelectionTriggerRef.current;
      if (trigger?.isConnected && !trigger.closest("[inert]")) trigger.focus();
      else viewportRef.current?.querySelector<HTMLButtonElement>(".view-switch button")?.focus();
    });
  }, []);

  useEffect(() => {
    const controlsMedia = window.matchMedia(CONTROLS_OVERLAY_QUERY);
    function closeSidebarWhenControlsBecomeInline(event: MediaQueryListEvent) {
      if (!event.matches) setSidebarOpen(false);
    }
    controlsMedia.addEventListener("change", closeSidebarWhenControlsBecomeInline);
    return () => controlsMedia.removeEventListener("change", closeSidebarWhenControlsBecomeInline);
  }, []);

  useEffect(() => {
    const panel = activeModal === "details" ? detailPanelRef.current
      : activeModal === "controls" ? controlPanelRef.current : null;
    if (!panel) return;

    const firstFocusable = focusableElements(panel)[0];
    const focusFrame = window.requestAnimationFrame(() => firstFocusable?.focus());

    function handleModalKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (activeModal === "details") closeDetail();
        else closeSidebar();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = focusableElements(panel);
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (!panel.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleModalKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleModalKeyDown);
    };
  }, [activeModal, closeDetail, closeSidebar]);

  useEffect(() => {
    if (activeModal) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && detailOpen) closeDetail();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [activeModal, closeDetail, detailOpen]);

  const toggleCategory = useCallback((category: string) => {
    const categoryIds = snapshot.taxonomy.map((item) => item.id);
    const next = nextCategorySelection(selectedCategories, category, categoryIds);
    setSelectedCategories(next);
    setSelection((current) => {
      const selectedCategory = snapshot.menus.find((menu) => menu.id === current.id)?.category
        ?? (snapshot.displayOnly?.tasteGravity ?? []).find((item) => item.id === current.id)?.category;
      if (selectedCategory && next.has(selectedCategory)) return current;
      return {
        id: snapshot.menus.find((menu) => next.has(menu.category))?.id
          ?? (snapshot.displayOnly?.tasteGravity ?? []).find((item) => next.has(item.category))?.id
          ?? null,
        detailOpen: false,
      };
    });
  }, [selectedCategories, snapshot.displayOnly, snapshot.menus, snapshot.taxonomy]);

  const selectAllCategories = useCallback(() => {
    setSelectedCategories(new Set(snapshot.taxonomy.map((item) => item.id)));
  }, [snapshot.taxonomy]);

  return (
    <main className="observatory-shell">
      <div className="space-noise" aria-hidden="true" />
      <header className="topbar" inert={activeModal ? true : undefined}>
        <button
          type="button"
          className="mobile-panel-button"
          ref={sidebarButtonRef}
          onClick={() => setSidebarOpen((value) => !value)}
          aria-label={sidebarOpen ? "메뉴 필터 닫기" : "메뉴 필터 열기"}
          aria-controls="observatory-controls"
          aria-expanded={sidebarOpen}
        ><span aria-hidden="true">☰</span></button>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /></span>
          <div>
            <p className="eyebrow">오늘 뭐 먹지?</p>
            <h1>오점뭐 메뉴 관측소</h1>
          </div>
        </div>
      </header>

      {snapshotNotice && (
        <div className="snapshot-warning" role="status">
          <strong>오프라인 보기</strong>
          <span>{snapshotNotice}</span>
        </div>
      )}

      <div className="observatory-grid">
        <aside
          className={`control-panel${sidebarOpen ? " is-open" : ""}`}
          id="observatory-controls"
          ref={controlPanelRef}
          role={controlsAreOverlay ? "dialog" : undefined}
          aria-modal={controlsAreOverlay && sidebarOpen ? true : undefined}
          aria-labelledby={controlsAreOverlay ? "observatory-controls-title" : undefined}
          aria-label={!controlsAreOverlay ? "메뉴 필터" : undefined}
          inert={(controlsAreOverlay && !sidebarOpen) || activeModal === "details" ? true : undefined}
          tabIndex={controlsAreOverlay ? -1 : undefined}
        >
          <div className="panel-mobile-header">
            <strong id="observatory-controls-title">메뉴 필터</strong>
            <button type="button" onClick={closeSidebar} aria-label="메뉴 필터 닫기">×</button>
          </div>

          <section className="panel-section panel-section--stats">
            <div className="section-heading">
              <div><h2>한눈에 보기</h2></div>
            </div>
            <div className="stat-grid">
              <div><strong>{formatter.format(snapshot.stats.menus)}</strong><span>메뉴</span></div>
              <div><strong>{formatter.format(snapshot.stats.restaurants)}</strong><span>상호</span></div>
              <div><strong>{formatter.format(snapshot.taxonomy.length)}</strong><span>카테고리</span></div>
              <div><strong>{formatter.format(snapshot.stats.mealEvents)}</strong><span>식사 기록</span></div>
            </div>
          </section>

          <section className="panel-section panel-section--search">
            <div className="search-field" role="search">
              <svg className="search-field__icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <circle cx="8.5" cy="8.5" r="5.6" />
                <path d="m12.8 12.8 4.2 4.2" />
              </svg>
              <input aria-label="메뉴 데이터 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="상호·메뉴·재료 검색" />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="검색 지우기">×</button>}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-heading section-heading--inline">
              <div><h2>카테고리</h2></div>
              <button
                type="button"
                className="text-button"
                onClick={selectAllCategories}
                aria-pressed={selectedCategories.size === snapshot.taxonomy.length}
              >전체 보기</button>
            </div>
            <div className="category-list">
              {snapshot.taxonomy.map((category) => {
                const active = selectedCategories.has(category.id);
                return (
                  <button
                    type="button"
                    className={`category-filter${active ? " is-active" : ""}`}
                    key={category.id}
                    onClick={() => toggleCategory(category.id)}
                    aria-pressed={active}
                    style={{ "--category-color": category.color, "--category-glow": category.glow } as React.CSSProperties}
                  >
                    <span className="category-filter__symbol">{category.emoji}</span>
                    <span className="category-filter__name">{category.id}</span>
                    <strong className="category-filter__count">{snapshot.stats.categoryCounts[category.id] ?? 0}</strong>
                  </button>
                );
              })}
            </div>
          </section>
        </aside>

        <section
          className="viewport"
          id="observatory-viewport"
          ref={viewportRef}
          inert={activeModal ? true : undefined}
        >
          <div className="viewport-toolbar">
            <div className="view-switch" role="group" aria-label="관측 보기 전환">
              <button type="button" className={view === "cosmos" ? "is-active" : ""} onClick={() => setView("cosmos")} aria-pressed={view === "cosmos"}><span>✦</span> 3D 코스모스</button>
              <button type="button" className={view === "taste" ? "is-active" : ""} onClick={() => setView("taste")} aria-pressed={view === "taste"}><span>◒</span> 취향 지도</button>
            </div>
            <div className="viewport-count"><strong>{filteredMenus.length}</strong> / {snapshot.menus.length}개 메뉴</div>
            {view === "cosmos" && (
              <button
                type="button"
                className={`pause-button${paused ? " is-active" : ""}`}
                onClick={() => setPaused((value) => !value)}
                aria-label={paused ? "자동 회전 켜기" : "자동 회전 끄기"}
                aria-pressed={paused}
              >
                <span className="pause-button__icon" aria-hidden="true">{paused ? "▶" : "Ⅱ"}</span>
                <span className="pause-button__label">{paused ? "회전 켜기" : "회전 끄기"}</span>
              </button>
            )}
          </div>

          <div className="viewport-stage">
            {filteredMenus.length ? (
              view === "cosmos" ? (
                <MenuCosmos
                  menus={filteredMenus}
                  easterEggs={visibleTasteEasterEggs}
                  taxonomy={visibleTaxonomy}
                  selectedId={selectedId}
                  paused={paused}
                  onSelect={selectMenu}
                  onSelectEasterEgg={selectEasterEgg}
                />
              ) : (
                <TasteMap
                  menus={filteredMenus}
                  easterEggs={visibleTasteEasterEggs}
                  taxonomy={visibleTaxonomy}
                  selectedId={selectedId}
                  onSelect={selectMenu}
                  onSelectEasterEgg={selectEasterEgg}
                />
              )
            ) : (
              <div className="empty-orbit"><span>∅</span><strong>조건에 맞는 메뉴가 없습니다</strong><button type="button" onClick={() => { setQuery(""); selectAllCategories(); }}>필터 초기화</button></div>
            )}
          </div>
        </section>

        <aside
          className={`detail-panel${detailOpen ? " is-open" : ""}`}
          id="observatory-details"
          ref={detailPanelRef}
          role={detailsAreOverlay ? "dialog" : undefined}
          aria-modal={detailsAreOverlay && detailOpen ? true : undefined}
          aria-labelledby={detailsAreOverlay ? "observatory-details-title" : undefined}
          aria-label={!detailsAreOverlay ? "선택한 메뉴 상세" : undefined}
          inert={(detailsAreOverlay && !detailOpen) || activeModal === "controls" ? true : undefined}
          tabIndex={detailsAreOverlay ? -1 : undefined}
        >
          <div className="panel-mobile-header">
            <strong id="observatory-details-title">메뉴 상세</strong>
            <button type="button" onClick={closeDetail} aria-label="메뉴 상세 닫기">×</button>
          </div>
          {selectedMenu ? (
            <>
              <div className="detail-hero" style={{ "--category-color": categoryById.get(selectedMenu.category)?.color ?? "#fff" } as React.CSSProperties}>
                <span className="detail-hero__orbit" />
                <span className="detail-hero__emoji">{categoryById.get(selectedMenu.category)?.emoji}</span>
                <span className="detail-hero__category">{selectedMenu.category}</span>
              </div>
              <section className="detail-content">
                <h2>{selectedMenu.menu}</h2>
                <p className="detail-restaurant">{selectedMenu.restaurantLabel}</p>
                {selectedMenu.comment && <p className="detail-comment">“{selectedMenu.comment}”</p>}
                <TasteRail taste={selectedMenu.taste} />
                <div className="detail-metrics">
                  <div><span>추천된 횟수</span><strong>{selectedMenu.occurrences}회</strong></div>
                  <div><span>먹은 횟수</span><strong>{selectedMenu.mealEventCount}회</strong></div>
                  <div><span>평가 수</span><strong>{selectedMenu.surveyCount}건</strong></div>
                  <div><span>평균 평가</span><strong>{selectedMenu.averageSurveyRating ? `${selectedMenu.averageSurveyRating.toFixed(1)} / 5` : "—"}</strong></div>
                </div>
                <dl className="detail-facts">
                  <div><dt>가격</dt><dd>{selectedMenu.priceText || "가격 정보 없음"}</dd></div>
                  <div><dt>배달</dt><dd>{deliveryLabel(selectedMenu)}</dd></div>
                </dl>
                {!!selectedMenu.ingredientFamilies.length && (
                  <div className="ingredient-tags">{selectedMenu.ingredientFamilies.map((item) => <span key={item}>{item}</span>)}</div>
                )}
              </section>
            </>
          ) : selectedEasterEgg ? (
            <>
              <div className="detail-hero detail-hero--easter" style={{ "--category-color": categoryById.get(selectedEasterEgg.category)?.color ?? "#fff" } as React.CSSProperties}>
                <span className="detail-hero__orbit" />
                <span className="detail-hero__emoji">{categoryById.get(selectedEasterEgg.category)?.emoji}</span>
                <span className="detail-hero__category">{selectedEasterEgg.category}</span>
              </div>
              <section className="detail-content">
                <h2>{selectedEasterEgg.menu}</h2>
                <p className="detail-restaurant">{selectedEasterEgg.restaurantLabel}</p>
                <p className="detail-comment">연구실 공식 금지 메뉴입니다.</p>
                <div className="detail-infinity" role="img" aria-label="취향 마이너스 무한대, 추천에서는 제외">
                  <span>취향</span>
                  <strong>−∞</strong>
                  <small>추천에서 제외됩니다</small>
                </div>
              </section>
            </>
          ) : (
            <div className="detail-empty">별을 선택하면 관측 기록을 표시합니다.</div>
          )}
        </aside>
      </div>

      <div
        className="reroll-inert-boundary"
        inert={activeModal ? true : undefined}
      >
        <RerollShop menus={filteredMenus} taxonomy={snapshot.taxonomy} onSelect={selectMenu} />
      </div>
      {activeModal && (
        <button
          type="button"
          className="panel-backdrop"
          tabIndex={-1}
          aria-label="열린 패널 닫기"
          onClick={() => { if (activeModal === "details") closeDetail(); else closeSidebar(); }}
        />
      )}
    </main>
  );
}

export function Observatory() {
  const [snapshot, setSnapshot] = useState<ObservatorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshotNotice, setSnapshotNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function loadSnapshot() {
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      let timedOut = false;
      controller.signal.addEventListener("abort", abortRequest, { once: true });
      const timeout = window.setTimeout(() => {
        timedOut = true;
        requestController.abort();
      }, 15_000);
      try {
        let data: ObservatorySnapshot | null = null;
        let endpointError: unknown = null;
        for (const endpoint of ["/api/snapshot/current", "/data/snapshot.json"] as const) {
          try {
            const response = await fetch(endpoint, { cache: "no-store", signal: requestController.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const declaredLength = Number(response.headers.get("content-length"));
            if (Number.isFinite(declaredLength) && declaredLength > MAX_SNAPSHOT_TEXT_LENGTH) {
              throw new Error("데이터 파일이 허용 크기를 초과했습니다.");
            }
            const snapshotText = await response.text();
            if (snapshotText.length > MAX_SNAPSHOT_TEXT_LENGTH) throw new Error("데이터 파일이 허용 크기를 초과했습니다.");
            data = validateSnapshot(JSON.parse(snapshotText)) as ObservatorySnapshot;
            break;
          } catch (cause: unknown) {
            if (requestController.signal.aborted) throw cause;
            endpointError = cause;
          }
        }
        if (!data) throw endpointError ?? new Error("스냅샷을 불러오지 못했습니다.");
        if (!active) return;
        setSnapshot(data);
        setError(null);
        setSnapshotNotice(null);
        try {
          window.localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(data));
        } catch {
          // Storage can be unavailable in privacy modes; the in-memory copy remains authoritative.
        }
      } catch (cause: unknown) {
        if (controller.signal.aborted || !active) return;
        const message = timedOut
          ? "요청 시간 초과"
          : cause instanceof Error ? cause.message : "알 수 없는 연결 오류";
        let cachedSnapshot: ObservatorySnapshot | null = null;
        try {
          const cached = window.localStorage.getItem(SNAPSHOT_CACHE_KEY);
          if (cached) cachedSnapshot = validateSnapshot(JSON.parse(cached)) as ObservatorySnapshot;
        } catch {
          cachedSnapshot = null;
        }
        if (cachedSnapshot) {
          setSnapshot(cachedSnapshot);
          setError(null);
          setSnapshotNotice("연결할 수 없어 이 브라우저에 저장된 메뉴를 표시합니다.");
        } else {
          setError(message);
        }
      } finally {
        window.clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abortRequest);
      }
    }

    void loadSnapshot();
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);

  if (error) return <ErrorState message={error} retry={() => { setError(null); setAttempt((value) => value + 1); }} />;
  if (!snapshot) return <LoadingState />;
  return (
    <SnapshotRenderBoundary
      resetKey={`${attempt}:${snapshot.generatedAt}:${snapshot.source.sourceFingerprint}`}
      onReset={() => setAttempt((value) => value + 1)}
    >
      <ObservatoryApp snapshot={snapshot} snapshotNotice={snapshotNotice} />
    </SnapshotRenderBoundary>
  );
}
