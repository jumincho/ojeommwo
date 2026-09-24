import type { TastePosterior } from "../types";

type TasteRailProps = {
  taste: TastePosterior;
  compact?: boolean;
};

function tastePercent(mean: number) {
  return `${(Math.min(1, Math.max(0, mean)) * 100).toFixed(1)}%`;
}

function tendency(taste: TastePosterior) {
  if (taste.evidenceWeight < 0.2) {
    return { label: "아직 판단 전", summary: "아직 취향을 판단할 기록이 없습니다.", tone: "neutral" };
  }
  if (taste.mean <= 0.35) {
    return { label: "비선호", summary: "선호하지 않는 편입니다.", tone: "negative" };
  }
  if (taste.mean >= 0.65) {
    return { label: "선호", summary: "선호하는 편입니다.", tone: "positive" };
  }
  return { label: "중립", summary: "뚜렷한 선호나 비선호가 없습니다.", tone: "neutral" };
}

export function TasteRail({ taste, compact = false }: TasteRailProps) {
  const currentTendency = tendency(taste);
  const beadPosition = Math.min(96, Math.max(4, taste.mean * 100));
  const percentage = tastePercent(taste.mean);

  return (
    <div
      className={compact ? "taste-rail taste-rail--compact" : "taste-rail"}
      data-tone={currentTendency.tone}
    >
      {!compact && (
        <div className="taste-rail__headline">
          <div>
            <span className="eyebrow">선호도</span>
            <strong>{percentage}</strong>
          </div>
          <span className="taste-rail__tendency">{currentTendency.label}</span>
        </div>
      )}

      <div className="taste-rail__labels" aria-hidden="true">
        <span>비선호</span>
        {compact && <strong>{percentage}</strong>}
        <span>선호</span>
      </div>
      <div
        className="taste-rail__track"
        role="img"
        aria-label={`선호도 ${percentage}, ${currentTendency.label}`}
      >
        <span className="taste-rail__pole taste-rail__pole--negative" />
        <span className="taste-rail__midpoint" />
        <span className="taste-rail__pole taste-rail__pole--positive" />
        <span
          className="taste-rail__bead"
          style={{ left: `${beadPosition}%` }}
        />
      </div>

      {!compact && (
        <p className="taste-rail__summary">{currentTendency.summary}</p>
      )}
    </div>
  );
}
