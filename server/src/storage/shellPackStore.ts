import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SHELL_PACK_ID = "BRD_td_default";

export type PublicShellPageName = "index" | "login";
export type AppShellPageName = "wallet" | "offers" | "manage" | "deploy" | "issue" | "redeem" | "energy";

export type ShellPackManifest = {
  version: number;
  branding_id: string;
  brand_name: string;
  public_title_suffix: string;
  footer_legal_name: string;
  support: {
    label: string;
    url: string;
  };
  links: {
    request_access_url: string | null;
    privacy_url: string | null;
    terms_url: string | null;
  };
  assets: {
    logo_src: string;
    favicon_src: string;
  };
  styles: {
    public_css: string;
    app_css?: string | null;
  };
  contracts: {
    public_shell_contract: string;
    app_shell_contract?: string | null;
  };
  pages: {
    public: PublicShellPageName[];
    app?: AppShellPageName[];
  };
};

export type ResolvedShellPack = {
  requestedBrandingId: string | null;
  brandingId: string;
  packRoot: string;
  manifestPath: string;
  manifest: ShellPackManifest;
  isDefault: boolean;
  usedFallback: boolean;
};

export type ResolvedShellPage = ResolvedShellPack & {
  pageName: PublicShellPageName | AppShellPageName;
  filePath: string;
};

export type ResolvedShellAsset = ResolvedShellPack & {
  relativeAssetPath: string;
  filePath: string;
};

export type EnsureShellPackMode = "create_if_missing";

export type EnsureShellPackResult = {
  sourceBrandingId: string;
  brandingId: string;
  packRoot: string;
  manifestPath: string;
  bootstrapStatus: "created" | "exists";
};

const PUBLIC_PAGE_NAMES: readonly PublicShellPageName[] = ["index", "login"];
const APP_PAGE_NAMES: readonly AppShellPageName[] = ["wallet", "offers", "manage", "deploy", "issue", "redeem", "energy"];
const GENERATED_BRANDING_ID_RE = /^BRD_[1-9][0-9]*$/;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBrandingId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) return null;
  return raw;
}

function normalizeBootstrapSourceBrandingId(value: unknown): string {
  const brandingId = normalizeBrandingId(value);
  if (brandingId !== DEFAULT_SHELL_PACK_ID) {
    throw new Error("shell_pack_bootstrap_source_invalid");
  }
  return brandingId;
}

function normalizeBootstrapDestinationBrandingId(value: unknown): string {
  const brandingId = normalizeBrandingId(value);
  if (!brandingId || !GENERATED_BRANDING_ID_RE.test(brandingId)) {
    throw new Error("shell_pack_bootstrap_destination_invalid");
  }
  return brandingId;
}

function normalizeEnsureShellPackMode(value: unknown): EnsureShellPackMode {
  if (value !== "create_if_missing") {
    throw new Error("shell_pack_bootstrap_mode_invalid");
  }
  return value;
}

function normalizePublicPageName(value: unknown): PublicShellPageName | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  return PUBLIC_PAGE_NAMES.includes(raw as PublicShellPageName) ? (raw as PublicShellPageName) : null;
}

function normalizeAppPageName(value: unknown): AppShellPageName | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  return APP_PAGE_NAMES.includes(raw as AppShellPageName) ? (raw as AppShellPageName) : null;
}

function normalizeUrlOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  return raw ? raw : null;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") throw new Error(`shell_pack_manifest_invalid:${fieldName}`);
  const raw = value.trim();
  if (!raw) throw new Error(`shell_pack_manifest_invalid:${fieldName}`);
  return raw;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isObjectRecord(parsed)) throw new Error("shell_pack_manifest_invalid:root");
  return parsed;
}

function writeJsonObject(filePath: string, value: Record<string, unknown>): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function rewriteBrandingAssetPath(value: unknown, sourceBrandingId: string, destinationBrandingId: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error("shell_pack_bootstrap_manifest_path_invalid");
  }
  return value.split(`/brands/${sourceBrandingId}/`).join(`/brands/${destinationBrandingId}/`);
}

function brandsRoot(repoRoot: string): string {
  return path.join(repoRoot, "brands");
}

function shellPackRoot(repoRoot: string, brandingId: string): string {
  return path.join(brandsRoot(repoRoot), brandingId);
}

function shellPackManifestPath(repoRoot: string, brandingId: string): string {
  return path.join(shellPackRoot(repoRoot, brandingId), "manifest.json");
}

function parseShellPackManifest(raw: Record<string, unknown>, expectedBrandingId: string): ShellPackManifest {
  const version = Number(raw.version);
  if (!Number.isFinite(version)) throw new Error("shell_pack_manifest_invalid:version");

  const brandingId = normalizeRequiredString(raw.branding_id, "branding_id");
  if (brandingId !== expectedBrandingId) {
    throw new Error("shell_pack_manifest_invalid:branding_id_mismatch");
  }

  const brandName = normalizeRequiredString(raw.brand_name, "brand_name");
  const publicTitleSuffix = normalizeRequiredString(raw.public_title_suffix, "public_title_suffix");
  const footerLegalName = normalizeRequiredString(raw.footer_legal_name, "footer_legal_name");

  if (!isObjectRecord(raw.support)) throw new Error("shell_pack_manifest_invalid:support");
  const support = {
    label: normalizeRequiredString(raw.support.label, "support.label"),
    url: normalizeRequiredString(raw.support.url, "support.url")
  };

  if (!isObjectRecord(raw.links)) throw new Error("shell_pack_manifest_invalid:links");
  const links = {
    request_access_url: normalizeUrlOrNull(raw.links.request_access_url),
    privacy_url: normalizeUrlOrNull(raw.links.privacy_url),
    terms_url: normalizeUrlOrNull(raw.links.terms_url)
  };

  if (!isObjectRecord(raw.assets)) throw new Error("shell_pack_manifest_invalid:assets");
  const assets = {
    logo_src: normalizeRequiredString(raw.assets.logo_src, "assets.logo_src"),
    favicon_src: normalizeRequiredString(raw.assets.favicon_src, "assets.favicon_src")
  };

  if (!isObjectRecord(raw.styles)) throw new Error("shell_pack_manifest_invalid:styles");
  const styles = {
    public_css: normalizeRequiredString(raw.styles.public_css, "styles.public_css"),
    app_css: normalizeUrlOrNull(raw.styles.app_css)
  };

  if (!isObjectRecord(raw.contracts)) throw new Error("shell_pack_manifest_invalid:contracts");
  const contracts = {
    public_shell_contract: normalizeRequiredString(raw.contracts.public_shell_contract, "contracts.public_shell_contract"),
    app_shell_contract: normalizeUrlOrNull(raw.contracts.app_shell_contract)
  };

  if (!isObjectRecord(raw.pages)) throw new Error("shell_pack_manifest_invalid:pages");
  const rawPublicPages = Array.isArray(raw.pages.public) ? raw.pages.public : [];
  const publicPages = rawPublicPages
    .map((value) => normalizePublicPageName(value))
    .filter((value): value is PublicShellPageName => value !== null);

  if (publicPages.length < 1) {
    throw new Error("shell_pack_manifest_invalid:pages.public");
  }

  const rawAppPages = Array.isArray(raw.pages.app) ? raw.pages.app : [];
  const appPages = rawAppPages
    .map((value) => normalizeAppPageName(value))
    .filter((value): value is AppShellPageName => value !== null);

  return {
    version,
    branding_id: brandingId,
    brand_name: brandName,
    public_title_suffix: publicTitleSuffix,
    footer_legal_name: footerLegalName,
    support,
    links,
    assets,
    styles,
    contracts,
    pages: {
      public: publicPages,
      app: appPages
    }
  };
}

function tryLoadShellPack(repoRoot: string, brandingId: string, requestedBrandingId: string | null, usedFallback: boolean): ResolvedShellPack | null {
  const normalizedId = normalizeBrandingId(brandingId);
  if (!normalizedId) return null;

  const manifestPath = shellPackManifestPath(repoRoot, normalizedId);
  if (!fileExists(manifestPath)) return null;

  const manifest = parseShellPackManifest(readJsonObject(manifestPath), normalizedId);

  return {
    requestedBrandingId,
    brandingId: normalizedId,
    packRoot: shellPackRoot(repoRoot, normalizedId),
    manifestPath,
    manifest,
    isDefault: normalizedId === DEFAULT_SHELL_PACK_ID,
    usedFallback
  };
}

function requireDefaultShellPack(repoRoot: string, requestedBrandingId: string | null): ResolvedShellPack {
  const fallback = tryLoadShellPack(repoRoot, DEFAULT_SHELL_PACK_ID, requestedBrandingId, requestedBrandingId !== DEFAULT_SHELL_PACK_ID);
  if (fallback) return fallback;
  throw new Error("default_shell_pack_missing");
}

function resolvePublicShellPageFromPack(candidatePack: ResolvedShellPack, normalizedPage: PublicShellPageName): ResolvedShellPage | null {
  if (!candidatePack.manifest.pages.public.includes(normalizedPage)) return null;

  const filePath = path.join(candidatePack.packRoot, "public", `${normalizedPage}.html`);
  if (!fileExists(filePath)) return null;

  return {
    ...candidatePack,
    pageName: normalizedPage,
    filePath
  };
}

function resolveAppShellPageFromPack(candidatePack: ResolvedShellPack, normalizedPage: AppShellPageName): ResolvedShellPage | null {
  if (!candidatePack.manifest.pages.app?.includes(normalizedPage)) return null;

  const filePath = path.join(candidatePack.packRoot, "app", `${normalizedPage}.html`);
  if (!fileExists(filePath)) return null;

  return {
    ...candidatePack,
    pageName: normalizedPage,
    filePath
  };
}

function normalizeAssetRelativePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("shell_pack_asset_invalid_path");

  let raw = value.trim();
  while (raw.startsWith("/")) raw = raw.slice(1);
  raw = raw.replace(/\\/g, "/");

  if (!raw) throw new Error("shell_pack_asset_invalid_path");

  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 1) throw new Error("shell_pack_asset_invalid_path");
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("shell_pack_asset_invalid_path");
  }

  return parts.join("/");
}

function buildStaticFilePath(packRoot: string, relativeAssetPath: string): string {
  const parts = relativeAssetPath.split("/").filter(Boolean);
  return path.join(packRoot, "static", ...parts);
}

function rewriteBootstrappedManifest(manifestPath: string, sourceBrandingId: string, destinationBrandingId: string): void {
  const raw = readJsonObject(manifestPath);

  if (normalizeRequiredString(raw.branding_id, "branding_id") !== sourceBrandingId) {
    throw new Error("shell_pack_bootstrap_source_manifest_invalid");
  }

  raw.branding_id = destinationBrandingId;

  if (!isObjectRecord(raw.assets)) throw new Error("shell_pack_bootstrap_manifest_assets_invalid");
  raw.assets.logo_src = rewriteBrandingAssetPath(raw.assets.logo_src, sourceBrandingId, destinationBrandingId);
  raw.assets.favicon_src = rewriteBrandingAssetPath(raw.assets.favicon_src, sourceBrandingId, destinationBrandingId);

  if (!isObjectRecord(raw.styles)) throw new Error("shell_pack_bootstrap_manifest_styles_invalid");
  raw.styles.public_css = rewriteBrandingAssetPath(raw.styles.public_css, sourceBrandingId, destinationBrandingId);
  raw.styles.app_css = rewriteBrandingAssetPath(raw.styles.app_css, sourceBrandingId, destinationBrandingId);

  writeJsonObject(manifestPath, raw);
}

function rewriteBootstrappedHtmlBrandingRefs(rootDir: string, sourceBrandingId: string, destinationBrandingId: string): void {
  if (!directoryExists(rootDir)) return;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const childPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      rewriteBootstrappedHtmlBrandingRefs(childPath, sourceBrandingId, destinationBrandingId);
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".html")) continue;

    const raw = fs.readFileSync(childPath, "utf8");
    const next = raw.split(`/brands/${sourceBrandingId}/`).join(`/brands/${destinationBrandingId}/`);
    fs.writeFileSync(childPath, next, "utf8");
  }
}

export function getDefaultShellPackId(): string {
  return DEFAULT_SHELL_PACK_ID;
}

export function loadShellPackManifest(repoRoot: string, brandingId: string | null | undefined): ResolvedShellPack {
  const requestedBrandingId = normalizeBrandingId(brandingId);
  if (requestedBrandingId && requestedBrandingId !== DEFAULT_SHELL_PACK_ID) {
    const requested = tryLoadShellPack(repoRoot, requestedBrandingId, requestedBrandingId, false);
    if (requested) return requested;
  }
  return requireDefaultShellPack(repoRoot, requestedBrandingId);
}

export function ensureShellPack(repoRoot: string, params: {
  sourceBrandingId: string;
  brandingId: string;
  mode: EnsureShellPackMode;
}): EnsureShellPackResult {
  const sourceBrandingId = normalizeBootstrapSourceBrandingId(params.sourceBrandingId);
  const brandingId = normalizeBootstrapDestinationBrandingId(params.brandingId);
  normalizeEnsureShellPackMode(params.mode);

  const sourcePack = tryLoadShellPack(repoRoot, sourceBrandingId, sourceBrandingId, false);
  if (!sourcePack) {
    throw new Error("shell_pack_bootstrap_source_missing");
  }

  const destinationRoot = shellPackRoot(repoRoot, brandingId);
  const destinationManifestPath = shellPackManifestPath(repoRoot, brandingId);

  if (fileExists(destinationManifestPath)) {
    const existing = tryLoadShellPack(repoRoot, brandingId, brandingId, false);
    if (!existing) {
      throw new Error("shell_pack_bootstrap_destination_manifest_invalid");
    }

    return {
      sourceBrandingId,
      brandingId,
      packRoot: existing.packRoot,
      manifestPath: existing.manifestPath,
      bootstrapStatus: "exists"
    };
  }

  if (fs.existsSync(destinationRoot)) {
    throw new Error("shell_pack_bootstrap_destination_partial_exists");
  }

  fs.mkdirSync(brandsRoot(repoRoot), { recursive: true });
  fs.cpSync(sourcePack.packRoot, destinationRoot, { recursive: true, force: false, errorOnExist: true });

  rewriteBootstrappedManifest(destinationManifestPath, sourceBrandingId, brandingId);
  rewriteBootstrappedHtmlBrandingRefs(path.join(destinationRoot, "public"), sourceBrandingId, brandingId);
  rewriteBootstrappedHtmlBrandingRefs(path.join(destinationRoot, "app"), sourceBrandingId, brandingId);

  const created = tryLoadShellPack(repoRoot, brandingId, brandingId, false);
  if (!created) {
    throw new Error("shell_pack_bootstrap_created_pack_invalid");
  }

  return {
    sourceBrandingId,
    brandingId,
    packRoot: created.packRoot,
    manifestPath: created.manifestPath,
    bootstrapStatus: "created"
  };
}

export function resolvePublicShellPage(repoRoot: string, brandingId: string | null | undefined, pageName: PublicShellPageName): ResolvedShellPage {
  const normalizedPage = normalizePublicPageName(pageName);
  if (!normalizedPage) throw new Error("shell_pack_public_page_invalid");

  const requestedBrandingId = normalizeBrandingId(brandingId);
  const pack = loadShellPackManifest(repoRoot, requestedBrandingId);

  const resolved = resolvePublicShellPageFromPack(pack, normalizedPage);
  if (resolved) return resolved;

  if (!pack.isDefault) {
    const fallback = requireDefaultShellPack(repoRoot, requestedBrandingId);
    const fallbackResolved = resolvePublicShellPageFromPack(fallback, normalizedPage);
    if (fallbackResolved) return fallbackResolved;
  }

  throw new Error(`shell_pack_public_page_missing:${normalizedPage}`);
}

export function resolveTenantPublicShellPageStrict(repoRoot: string, brandingId: string | null | undefined, pageName: PublicShellPageName): ResolvedShellPage {
  const normalizedPage = normalizePublicPageName(pageName);
  if (!normalizedPage) throw new Error("shell_pack_public_page_invalid");

  const requestedBrandingId = normalizeBrandingId(brandingId);
  if (!requestedBrandingId || requestedBrandingId === DEFAULT_SHELL_PACK_ID) {
    throw new Error("tenant_shell_pack_branding_invalid");
  }

  const pack = tryLoadShellPack(repoRoot, requestedBrandingId, requestedBrandingId, false);
  if (!pack) {
    throw new Error(`tenant_shell_pack_missing:${requestedBrandingId}`);
  }

  const resolved = resolvePublicShellPageFromPack(pack, normalizedPage);
  if (resolved) return resolved;

  throw new Error(`tenant_shell_pack_public_page_missing:${normalizedPage}`);
}

export function resolveTenantAppShellPageStrict(repoRoot: string, brandingId: string | null | undefined, pageName: AppShellPageName): ResolvedShellPage {
  const normalizedPage = normalizeAppPageName(pageName);
  if (!normalizedPage) throw new Error("shell_pack_app_page_invalid");

  const requestedBrandingId = normalizeBrandingId(brandingId);
  if (!requestedBrandingId || requestedBrandingId === DEFAULT_SHELL_PACK_ID) {
    throw new Error("tenant_shell_pack_branding_invalid");
  }

  const pack = tryLoadShellPack(repoRoot, requestedBrandingId, requestedBrandingId, false);
  if (!pack) {
    throw new Error(`tenant_shell_pack_missing:${requestedBrandingId}`);
  }

  const resolved = resolveAppShellPageFromPack(pack, normalizedPage);
  if (resolved) return resolved;

  throw new Error(`tenant_shell_pack_app_page_missing:${normalizedPage}`);
}

export function resolveShellStaticAsset(repoRoot: string, brandingId: string | null | undefined, relativeAssetPath: string): ResolvedShellAsset {
  const requestedBrandingId = normalizeBrandingId(brandingId);
  const normalizedRelativePath = normalizeAssetRelativePath(relativeAssetPath);
  const pack = loadShellPackManifest(repoRoot, requestedBrandingId);

  const resolveFromPack = (candidatePack: ResolvedShellPack): ResolvedShellAsset | null => {
    const filePath = buildStaticFilePath(candidatePack.packRoot, normalizedRelativePath);
    if (!fileExists(filePath)) return null;

    return {
      ...candidatePack,
      relativeAssetPath: normalizedRelativePath,
      filePath
    };
  };

  const resolved = resolveFromPack(pack);
  if (resolved) return resolved;

  if (!pack.isDefault) {
    const fallback = requireDefaultShellPack(repoRoot, requestedBrandingId);
    const fallbackResolved = resolveFromPack(fallback);
    if (fallbackResolved) return fallbackResolved;
  }

  throw new Error(`shell_pack_asset_missing:${normalizedRelativePath}`);
}
