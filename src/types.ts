export const flowIds = [
  "analyze",
  "compose",
  "review",
  "client",
  "hr",
  "marketplace",
  "complaint",
] as const;

export type FlowId = (typeof flowIds)[number];

export const categoryIds = [
  "auto",
  "business",
  "sales",
  "work",
  "marketplace",
  "personal",
] as const;

export type CategoryId = (typeof categoryIds)[number];

export const refinementIds = [
  "softer",
  "confident",
  "shorter",
  "neutral",
  "boundaries",
  "premium",
  "more",
  "english",
] as const;

export type RefinementId = (typeof refinementIds)[number];

export interface BotSession {
  flow?: FlowId;
  category?: CategoryId;
  awaitingInput: boolean;
  lastSource?: string;
  lastResult?: string;
  visualResponseId?: string;
  awaitingImagePrompt?: boolean;
}

export interface UserAccess {
  freeUsed: number;
  freeLimit: number;
  credits: number;
  plan: string;
  allowed: boolean;
}

export interface GenerationRecord {
  id: number;
  flow: FlowId;
  category: CategoryId;
  source: string;
  result: string;
  createdAt: string;
}

export interface PaymentRecord {
  chargeId: string;
  packageId: string;
  credits: number;
  remainingCredits: number;
  stars: number;
  status: "paid" | "refunded";
  createdAt: string;
  refundedAt?: string | undefined;
}

export interface RequestReservation {
  id: string;
}

export type AnalyticsPeriodDays = 1 | 7 | 30 | 0;

export interface BusinessStats {
  periodDays: AnalyticsPeriodDays;
  users: number;
  newUsers: number;
  activeUsers: number;
  generations: number;
  photoRequests: number;
  textRequests: number;
  voiceRequests: number;
  createdImages: number;
  activeSubscriptions: number;
  purchases: number;
  payingUsers: number;
  grossStars: number;
  refunds: number;
  refundedStars: number;
  conversionPercent: number;
  popularPackage?: string | undefined;
}

export type ImageTier = "free" | "plus" | "pro";

export interface ImageAllowance {
  allowed: boolean;
  tier: ImageTier;
  used: number;
  limit: number;
  remaining: number;
  resetAt?: number | undefined;
  subscriptionEndsAt?: number | undefined;
  reason?: "trial_used" | "user_limit" | "global_limit" | undefined;
}

export interface ImageReservation {
  id: string;
  allowance: ImageAllowance;
}

export interface SubscriptionAccess {
  active: boolean;
  planId?: "plus" | undefined;
  periodEnd?: number | undefined;
  autoRenew: boolean;
  latestChargeId?: string | undefined;
}

export interface AcquisitionStats {
  source: string;
  users: number;
  payingUsers: number;
  stars: number;
}

export const FLOW_LABELS: Record<FlowId, string> = {
  analyze: "Разбор переписки",
  compose: "Ответ с нуля",
  review: "Проверка моего ответа",
  client: "Ответ клиенту",
  hr: "Ответ HR",
  marketplace: "Ответ покупателю",
  complaint: "Ответ на претензию",
};

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  auto: "Определить автоматически",
  business: "Деловая переписка",
  sales: "Продажи и клиенты",
  work: "Работа и HR",
  marketplace: "Маркетплейсы и объявления",
  personal: "Личная переписка",
};

export const REFINEMENT_LABELS: Record<RefinementId, string> = {
  softer: "мягче",
  confident: "увереннее",
  shorter: "короче",
  neutral: "без эмоций",
  boundaries: "с границами",
  premium: "дороже и статуснее",
  more: "ещё 5 вариантов",
  english: "на английском",
};
