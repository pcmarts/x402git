/**
 * lib/github/app.ts — the GitHub App client (D10, FR-1, FR-7, §14.3).
 *
 * This module does exactly two things: build the `App` from the environment, and hand
 * back an Octokit authenticated as an installation. Everything else — provisioning a
 * hosted repo, reading a tree, fetching a tarball, verifying a webhook — belongs to the
 * slice that needs it, not here.
 *
 *   const octokit = await installationOctokit(listing.installation_id);
 *   const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{sha}", …);
 *
 * §14.3: an installation token expires in one hour. Mint it, use it, discard it. Never
 * store one; store `installation_id`. The App private key is a crown jewel (§14.8) and
 * belongs in the signing service — the env var here is the V0 stand-in.
 */

import { App } from "@octokit/app";
import { githubAppConfig, hostedOrgs } from "@/lib/env";

/** Octokit's exact instance type, without importing @octokit/rest for it. */
export type InstallationOctokit = Awaited<ReturnType<App["getInstallationOctokit"]>>;

let app: App | null = null;

/** The App, memoised. `githubAppConfig()` un-escapes the `\n`s in a single-line PEM. */
export function githubApp(): App {
  if (app) return app;
  const { appId, privateKey } = githubAppConfig();
  app = new App({ appId, privateKey });
  return app;
}

/** Tests, and any code that mutates process.env. */
export function resetGithubApp(): void {
  app = null;
}

/**
 * An Octokit authenticated as the installation. The token it mints lives one hour;
 * treat the client as request-scoped and let it go.
 */
export async function installationOctokit(installationId: number | string): Promise<InstallationOctokit> {
  return await githubApp().getInstallationOctokit(Number(installationId));
}

/**
 * D10: hosted repos are sharded across platform-owned orgs by cohort, and the App is
 * owned by a different account from the orgs. The first entry is the current cohort.
 */
export function currentHostedOrg(): string {
  const orgs = hostedOrgs();
  if (orgs.length === 0) throw new Error("missing required environment variable: GITHUB_HOSTED_ORGS");
  return orgs[0];
}
