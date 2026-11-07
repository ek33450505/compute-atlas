import { RefreshSiteButton } from "@/app/admin/refresh-site-button";
import { hasAdminSession } from "@/lib/admin-session";

/**
 * The admin layout also wraps /admin/login, so the Refresh site button renders
 * only for a valid session. Display only: the action re-verifies the cookie.
 */
export async function RefreshSiteSlot() {
  if (!(await hasAdminSession())) return null;
  return <RefreshSiteButton />;
}
