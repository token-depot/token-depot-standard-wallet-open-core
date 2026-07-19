import express from "express";
import { listSponsoredOffers, type SponsoredOfferAudience, type SponsoredOfferPlacement, type SponsoredOfferRecordV1 } from "../storage/sponsoredOfferStore";
import { getUser, readUserProfile } from "../storage/userStore";
import { calculateWalletPlusEntitlementForUserIds, type EntitlementWalletPlusStatusV1 } from "../storage/entitlementTokenStore";

export type SponsoredOffersCtx = {
  repoRoot: string;
};

type PublicSponsoredOffer = {
  id: string;
  title: string;
  body: string;
  cta_label: string;
  destination_url: string | null;
  placement: SponsoredOfferPlacement;
  audience: SponsoredOfferAudience;
  priority: number;
  max_impressions_per_day: number | null;
  cooldown_minutes: number | null;
  allow_user_block: boolean;
};

const PLACEMENTS: SponsoredOfferPlacement[] = [
  "post_login",
  "wallet_dashboard",
  "offers_page",
  "deploy_page",
  "issue_page",
  "redeem_page",
  "energy_page",
  "settings_page",
  "renewal_reminder",
  "post_action"
];

function userIdFromResponse(res: express.Response): string {
  const userId = String((res.locals as any).td_user_id || "").trim();
  if (!userId) throw new Error("auth_required");
  return userId;
}

function normalizePlacement(value: unknown): SponsoredOfferPlacement | null {
  const s = typeof value === "string" ? value.trim() : "";
  return PLACEMENTS.includes(s as SponsoredOfferPlacement) ? (s as SponsoredOfferPlacement) : null;
}

function isCampaignActiveNow(campaign: SponsoredOfferRecordV1, nowMs: number): boolean {
  if (campaign.status !== "active") return false;

  if (campaign.active_from) {
    const fromMs = Date.parse(campaign.active_from);
    if (Number.isFinite(fromMs) && nowMs < fromMs) return false;
  }

  if (campaign.active_until) {
    const untilMs = Date.parse(campaign.active_until);
    if (Number.isFinite(untilMs) && nowMs >= untilMs) return false;
  }

  return true;
}

function campaignAudienceMatches(campaign: SponsoredOfferRecordV1, walletPlus: EntitlementWalletPlusStatusV1): boolean {
  if (campaign.audience === "all") return true;
  if (campaign.audience === "basic") return walletPlus.ads_enabled === true;
  if (campaign.audience === "wallet_plus") return walletPlus.wallet_plus_active === true && walletPlus.wallet_plus_grace !== true;
  if (campaign.audience === "wallet_plus_grace") return walletPlus.wallet_plus_grace === true;
  return false;
}

function campaignTenantMatches(campaign: SponsoredOfferRecordV1, tenantId: string | null): boolean {
  if (!campaign.tenant_id) return true;
  return !!tenantId && campaign.tenant_id === tenantId;
}

function campaignBrandMatches(campaign: SponsoredOfferRecordV1): boolean {
  return !campaign.brand_id;
}

function campaignPlacementRulesMatch(campaign: SponsoredOfferRecordV1, placement: SponsoredOfferPlacement, walletPlus: EntitlementWalletPlusStatusV1): boolean {
  if (placement === "renewal_reminder") {
    return campaign.audience === "wallet_plus_grace" && walletPlus.renewal_reminder_required === true;
  }
  return true;
}

function toPublicSponsoredOffer(campaign: SponsoredOfferRecordV1): PublicSponsoredOffer {
  return {
    id: campaign.id,
    title: campaign.title,
    body: campaign.body,
    cta_label: campaign.cta_label,
    destination_url: campaign.destination_url,
    placement: campaign.placement,
    audience: campaign.audience,
    priority: campaign.priority,
    max_impressions_per_day: campaign.max_impressions_per_day,
    cooldown_minutes: campaign.cooldown_minutes,
    allow_user_block: campaign.allow_user_block === true
  };
}

export function buildSponsoredOffersRouter(ctx: SponsoredOffersCtx): express.Router {
  const r = express.Router();

  r.get("/eligible", (req, res) => {
    try {
      const userId = userIdFromResponse(res);
      const placement = normalizePlacement(req.query.placement);
      if (!placement) {
        return res.status(400).json({ ok: false, reason: "placement_required" });
      }

      const profile = readUserProfile(ctx.repoRoot, userId);
      const user = getUser(ctx.repoRoot, userId);
      const tenantId = user ? user.tenant_id || null : null;
      const walletPlus = calculateWalletPlusEntitlementForUserIds(ctx.repoRoot, [userId], profile.skin_id);
      const nowMs = Date.now();

      const campaigns = listSponsoredOffers(ctx.repoRoot)
        .filter((campaign) => campaign.placement === placement)
        .filter((campaign) => isCampaignActiveNow(campaign, nowMs))
        .filter((campaign) => campaignPlacementRulesMatch(campaign, placement, walletPlus))
        .filter((campaign) => campaignAudienceMatches(campaign, walletPlus))
        .filter((campaign) => campaignTenantMatches(campaign, tenantId))
        .filter((campaign) => campaignBrandMatches(campaign))
        .map(toPublicSponsoredOffer)
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

      return res.json({
        ok: true,
        placement,
        wallet_plus: walletPlus,
        campaigns
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      const status = msg === "auth_required" ? 401 : 500;
      return res.status(status).json({ ok: false, reason: msg });
    }
  });

  return r;
}
