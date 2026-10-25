/**
 * GET /docs — the route list, rendered from the registry the OpenAPI document is built
 * from.
 *
 * There is no second copy of the API surface here. `registeredRoutes()` is the same
 * array `GET /api/openapi.json` walks, so a route that is added, renamed or given a new
 * error can only ever be missing from this page by being missing from the contract too.
 * Routes not yet built are listed and marked `planned`, because the document is what the
 * rest of the build works against.
 *
 * Since 2026-08-30 each route's registry `description` renders under its summary — it
 * carries the usage that matters (idempotency keys, payment headers, caps) and it was
 * reaching only the OpenAPI document. Each row also has a stable anchor, because "see
 * `/docs#get-api-r-owner-slug`" is how a route is pointed at from an issue or a reply.
 *
 * Later the same day the inline "On this page" strip became the contents column
 * (`DocsNav`), shared with /docs/errors — the section titles moved there with it.
 */

import type { Metadata } from "next";
import { appUrl } from "@/lib/env";
import { MCP_TOOL_DOCS } from "@/lib/mcp/tool-docs";
import "@/lib/openapi/routes";
import { registeredRoutes } from "@/lib/openapi/registry";
import { optionalSession } from "@/lib/web/current";
import { SiteFooter, SiteHeader } from "../_components/chrome";
import { DocsNav, TAG_ORDER, TAG_TITLE } from "../_components/docs-nav";
import { Ticks } from "../_components/prose";

export const metadata: Metadata = {
  title: "API routes",
  alternates: { canonical: "/docs" },
  description: "Every endpoint on the platform, its authentication, and the errors it can return.",
};

/** The one line an operator pastes into a terminal. Production host, not `appUrl()`:
 *  it is copied to be run somewhere else, and a `localhost` MCP endpoint helps nobody. */
const MCP_COMMAND = "claude mcp add --transport http x402git https://x402git.com/api/mcp";


const TAG_BLURB: Record<string, string> = {
  public: "Free and unauthenticated, except where a wallet signature buys a more specific answer. These are the routes a buying agent uses.",
  creator:
    "Authenticated with `Authorization: Bearer x4c_live_…`, your agent key. This website calls exactly these routes with a key of its own, minted for your browser session; there is no private admin API.",
  auth: "Identity. A challenge is single-use and expires in five minutes.",
  internal: "Called by GitHub and by the scheduler, never by you.",
};

/** The OpenAPI scheme names, said in English. `+` in the joined form means both. */
const AUTH_LABEL: Record<string, string> = {
  apiKey: "API key",
  walletSignature: "wallet signature",
};

/** `get /api/v/{owner}/{slug}` → `get-api-v-owner-slug`: a stable per-route anchor,
 *  so a route can be pointed at from a reply or an issue the way an error code is. */
function routeAnchor(method: string, path: string): string {
  return [method, ...path.replaceAll(/[{}]/g, "").split("/").filter(Boolean)].join("-");
}

/** A path that wraps at its slashes and nowhere else. `overflow-wrap: anywhere`
 *  turned `/api/v/{owner}/{slug}` into `/api/v/{ow ner}/{slug}` the moment the
 *  column was squeezed; a `<wbr>` before each segment breaks it the way a path
 *  actually divides. */
function BreakablePath({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);
  return (
    <>
      {segments.map((segment, i) => (
        <span key={segment + i}>
          {i > 0 ? <wbr /> : null}/{segment}
        </span>
      ))}
    </>
  );
}

export const dynamic = "force-dynamic";

export default async function DocsPage() {
  const signedIn = Boolean(await optionalSession());
  const routes = registeredRoutes();
  const base = appUrl();
  const tags = TAG_ORDER.filter((tag) => routes.some((r) => r.tags.includes(tag)));

  return (
    <>
      <SiteHeader signedIn={signedIn} />
      <main className="docs">
        <DocsNav current="/docs" />
        <article>
          <h1>API routes</h1>
          <p className="written measure">
            Everything the platform can do, and the exact shape of every request and response, is{" "}
            <a href="/api/openapi.json">generated from the zod schemas the handlers validate against</a>. This page is the same registry in
            reading order. Every error body on every route is <code>{`{ code, message, docs_url, details? }`}</code> from{" "}
            <a href="/docs/errors">the catalogue</a>.
          </p>
          <p className="written measure">
            The base URL is <code>{base}</code>.
          </p>

          {tags.map((tag) => (
            <section key={tag}>
              <h2 id={tag}>{TAG_TITLE[tag]}</h2>
              <p className="written">
                <Ticks text={TAG_BLURB[tag]} />
              </p>
              <table>
                <caption>{`${routes.filter((r) => r.tags.includes(tag)).length} routes`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Method</th>
                    <th scope="col">Path</th>
                    {/* Optional on a phone, like Errors: the section blurb above the
                        table already says how its routes authenticate. */}
                    <th scope="col" data-col="optional">
                      Auth
                    </th>
                    <th scope="col">What it does</th>
                    <th scope="col" data-col="optional">
                      Errors
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {routes
                    .filter((r) => r.tags.includes(tag))
                    .map((route) => (
                      <tr key={`${route.method} ${route.path}`} id={routeAnchor(route.method, route.path)}>
                        <td>{route.method.toUpperCase()}</td>
                        <td>
                          <BreakablePath path={route.path} />
                        </td>
                        <td data-col="optional">
                          {route.security.length === 0 ? "public" : route.security.map((s) => AUTH_LABEL[s] ?? s).join(" + ")}
                        </td>
                        <td className="written">
                          {route.summary}
                          {route.status === "planned" ? (
                            <>
                              {" "}
                              <span className="badge">planned</span>
                            </>
                          ) : null}
                          {route.description ? (
                            <p className="route-note">
                              <Ticks text={route.description} />
                            </p>
                          ) : null}
                        </td>
                        <td className="wrap" data-col="optional">
                          {(route.errors ?? []).map((code, i) => (
                            <span key={code}>
                              {i > 0 ? " " : ""}
                              <a href={`/docs/errors#${code}`}>{code}</a>
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          ))}

          {/* Moved here 2026-08-30 from the home page, on the founder's direction that the
              website is for people. An operator wiring an agent up is already on this page;
              a person deciding whether to sell a repository was not helped by it. */}
          <section>
            <h2 id="mcp">MCP</h2>
            <p className="written measure">
              The same routes are an MCP server, so an agent gets them as tools in one line.
            </p>
            <pre>
              <code>{MCP_COMMAND}</code>
            </pre>
            <p className="written measure">
              Any client that takes a remote MCP server can add it by URL — in claude.ai and ChatGPT that is a custom connector at{" "}
              <code>https://x402git.com/api/mcp</code>; there is no login step, because every tool that moves money is authenticated
              by the payment itself.
            </p>
            <table>
              <caption>6 tools, in the order an agent uses them</caption>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">What it does</th>
                  <th scope="col" data-col="optional">
                    Wraps
                  </th>
                </tr>
              </thead>
              <tbody>
                {MCP_TOOL_DOCS.map((tool) => (
                  <tr key={tool.name} id={`mcp-${tool.name}`}>
                    <td>
                      <code>{tool.name}</code>
                    </td>
                    <td className="written">{tool.does}</td>
                    <td data-col="optional">
                      {tool.wraps ? (
                        <>
                          GET <BreakablePath path={tool.wraps} />
                        </>
                      ) : (
                        "nothing"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="written measure">
              <code>search_listings</code> is where an agent starts when it does not know a listing&apos;s name. It takes the job in
              plain words — <code>{`{ "query": "turn git history into a changelog" }`}</code> — and searches every live listing&apos;s
              name, description, computed tags and README. Each result carries the <code>owner</code> and <code>slug</code> the other
              five tools take, the price, and which of your words it matched. Results are ordered by how well they match, then by
              name, and never by sales or popularity. <code>max_price_micro</code> caps the price and <code>limit</code> caps the
              count.
            </p>
            <p className="written measure">
              <code>how_to_buy</code> is for the client that cannot sign. A chat model has no wallet and this server never holds
              one for it, so it cannot buy; what it can do is read the listing, quote the price, and hand the person the page to buy
              on or the skill to give an agent that has a wallet. That tool returns all of it in one call.
            </p>
            <p className="written measure">
              The four tools that wrap a route are the same code path as that route — an agent without MCP loses nothing by calling
              the routes directly. <code>purchase</code> follows the x402 MCP transport: an unpaid call returns the 402 as a
              structured result, and a client that signs locally retries with the payment in{" "}
              <code>_meta[&quot;x402/payment&quot;]</code>.
            </p>
          </section>

          <section>
            <h2 id="limits">Rate limits</h2>
            <table>
              <caption>Fixed window, counted server-side</caption>
              <thead>
                <tr>
                  <th scope="col">Route</th>
                  <th scope="col" className="num">
                    Limit
                  </th>
                  <th scope="col">Per</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>POST <BreakablePath path="/api/creators" /></td>
                  <td className="num">5 / hour</td>
                  <td>IP</td>
                </tr>
                <tr>
                  <td>GET <BreakablePath path="/api/auth/challenge" /></td>
                  <td className="num">30 / min</td>
                  <td>address</td>
                </tr>
                <tr>
                  <td>GET <BreakablePath path="/api/r/…" /></td>
                  <td className="num">60 / min</td>
                  <td>address</td>
                </tr>
                <tr>
                  <td>GET <BreakablePath path="/api/v/…" /></td>
                  <td className="num">600 / min</td>
                  <td>IP</td>
                </tr>
                <tr>
                  <td>GET <BreakablePath path="/api/label/…" /></td>
                  <td className="num">600 / min</td>
                  <td>IP</td>
                </tr>
                <tr>
                  <td>Pushes</td>
                  <td className="num">20 / hour</td>
                  <td>repository</td>
                </tr>
              </tbody>
            </table>
            <p className="written">
              Over the limit is <a href="/docs/errors#rate_limited">429 rate_limited</a> with <code>retry_after_seconds</code> in the body
              and a <code>Retry-After</code> header. Unpublished listings are capped at three per creator.
            </p>
          </section>
        </article>
      </main>
      <SiteFooter signedIn={signedIn} />
    </>
  );
}
