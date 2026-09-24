export type TasteSources = {
  mealPositive: number;
  mealNegative: number;
  surveyPositive: number;
  surveyNegative: number;
};

export type TastePosterior = {
  alpha: number;
  beta: number;
  mean: number;
  bias: number;
  evidenceWeight: number;
  confidence: number;
  intervalLow: number;
  intervalHigh: number;
  sources: TasteSources;
};

export type MenuRecord = {
  id: string;
  restaurantId: string;
  restaurant: string;
  branch: string;
  restaurantLabel: string;
  menu: string;
  category: string;
  priceText: string;
  priceCheckedAt: string | null;
  priceExpiresAt: string | null;
  comment: string;
  ingredientFamilies: string[];
  occurrences: number;
  firstRecommendedAt: string | null;
  lastRecommendedAt: string | null;
  mealEventCount: number;
  surveyCount: number;
  averageSurveyRating: number | null;
  availableNow: boolean;
  availabilityCheckedAt: string | null;
  availabilityExpiresAt: string | null;
  deliveryStatus: "verified" | "likely" | null;
  deliveryFreshness: "current" | "recent" | null;
  sources: string[];
  taste: TastePosterior;
};

export type CategoryRecord = {
  id: string;
  emoji: string;
  color: string;
  glow: string;
};

export type TasteGravityEasterEgg = {
  id: string;
  restaurantLabel: string;
  menu: string;
  category: string;
  score: number;
  algorithmImpact: false;
  note: string;
};

export type ObservatorySnapshot = {
  schemaVersion: number;
  generatedAt: string;
  source: {
    project: string;
    releaseVersion: string;
    sourceFingerprint: string;
    privacy: string;
  };
  algorithm: {
    posterior: string;
    priorAlpha: number;
    priorBeta: number;
    tasteHalfLifeDays: number;
    candidatePreferenceWeight: number;
    explorationRate: number;
    contractFingerprint: string;
    displayUsesStablePosteriorMean: boolean;
  };
  displayOnly?: {
    tasteGravity: TasteGravityEasterEgg[];
  };
  taxonomy: CategoryRecord[];
  stats: {
    recommendationItems: number;
    recommendationMessages: number;
    sentMessages: number;
    restaurants: number;
    menus: number;
    mealEvents: number;
    preferenceResponses: number;
    preferenceRatings: number;
    freshCandidates: number;
    categoryCounts: Record<string, number>;
    ratingDistribution: Record<string, number>;
    timelineStart: string;
    timelineEnd: string;
  };
  menus: MenuRecord[];
  restaurants: Array<{
    id: string;
    name: string;
    branches: string[];
    menuCount: number;
    occurrences: number;
    categories: string[];
  }>;
  recommendationEvents: Array<{
    id: string;
    recommendedAt: string;
    mealType: string;
    menuIds: string[];
  }>;
  cooccurrenceEdges: Array<{
    source: string;
    target: string;
    count: number;
  }>;
};
