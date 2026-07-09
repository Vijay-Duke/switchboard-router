// Dashboard session/JWT auth removed — single-user local mode.
// Kept as thin stubs so any residual imports do not break builds.

export function shouldUseSecureCookie() {
  return false;
}

export async function createDashboardAuthToken() {
  return "";
}

export async function verifyDashboardAuthToken() {
  return true;
}

export async function getDashboardAuthSession() {
  return { authenticated: true, local: true };
}

export async function setDashboardAuthCookie() {
  /* no-op */
}

export function clearDashboardAuthCookie() {
  /* no-op */
}

export async function verifyDashboardPassword() {
  // No dashboard password in single-user mode.
  return true;
}
