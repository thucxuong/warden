// Site-wide settings. The site URL is only used where a full address is
// required (sitemap, canonical and Open Graph tags, the 404 page base).
// Every link between pages stays relative.

export const REPO = "thucxuong/warden";
export const REPO_URL = `https://github.com/${REPO}`;
/** Branch that "Edit this page" and source links point at. */
export const SOURCE_BRANCH = "main";
export const DEFAULT_SITE_URL = "https://thucxuong.github.io/warden/";

export function siteUrlFrom(env: Record<string, string | undefined>): string {
  const raw = env.SITE_URL?.trim() || DEFAULT_SITE_URL;
  return raw.endsWith("/") ? raw : raw + "/";
}

export const blobUrl = (repoPath: string): string => `${REPO_URL}/blob/${SOURCE_BRANCH}/${repoPath}`;
export const editUrl = (repoPath: string): string => `${REPO_URL}/edit/${SOURCE_BRANCH}/${repoPath}`;
