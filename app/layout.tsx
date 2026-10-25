import type { Metadata, Viewport } from "next";
import { Azeret_Mono, Public_Sans } from "next/font/google";
import { SiteAnalytics } from "@/app/_components/analytics";
import { HeaderScript } from "@/app/_components/chrome";
import { appUrl } from "@/lib/env";
import "./globals.css";

const azeretMono = Azeret_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-azeret-mono",
});

const publicSans = Public_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-public-sans",
});

export const SITE_NAME = "X402 Git";
export const SITE_TAGLINE = "Get paid by agents for your code";

/*
  Site-wide metadata. `metadataBase` makes every relative `canonical`, `og:url` and
  `og:image` below absolute; pages set `title` and it lands in the template.
*/
export const metadata: Metadata = {
  metadataBase: new URL(appUrl()),
  applicationName: SITE_NAME,
  title: {
    default: `${SITE_NAME} — ${SITE_TAGLINE}`,
    template: `%s — ${SITE_NAME}`,
  },
  description: `${SITE_TAGLINE}. Buyers pay in USDC and receive the repo at a version; the manifest is public, the contents are private.`,
  keywords: ["x402", "sell private GitHub repo", "paid git access", "USDC", "Base", "agent payments", "private repository marketplace"],
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
  },
  robots: {
    index: true,
    follow: true,
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#f7f7f5",
  colorScheme: "light",
  /* minimum-scale pins the layout viewport to the device width. Without it, mobile
     Chrome sizes the layout viewport to the page's preferred minimum width instead,
     and the home page's card rail (three cards of rigid track width, wider than any
     phone) blew it out to ~900px on a 390px screen — the page rendered zoomed-out
     and taps missed their targets. `overflow`/`contain` on the rail do not enter
     that calculation; this does. Zooming in is still allowed (no maximum-scale). */
  initialScale: 1,
  minimumScale: 1,
};

/*
  Direction contract. Emitted as a real HTML comment (React cannot render one
  directly) so it survives the production build and can be grepped from the
  served markup. DESIGN.md is the expanded form; do not edit one without the other.
*/
const DIRECTION_CONTRACT = `<!--
THESIS: the manifest is literally the listing — mode, size, date, path in fixed
columns, and the price is the last line. It refuses the package-registry product
page: no title-plus-sidebar-stats, no blue primary button, no card grid. Amended
2026-08-30 on the founder's direction: a listing has two readings at two URLs
(?view=human / ?view=agent), each complete in the server HTML and neither behind
script, and the home page carries one row of three example cards. See DESIGN.md,
"Overview", for what those two exceptions cost and what still holds.
OWN-WORLD: one sheet of paper (#F7F7F5) under one ink (#1A1A1A), a single muted
grey (#6B6B6B), one accent green (#0B6E4F) spent only on the order line. Hairline
rules at 1px, zero radius, no shadows; Azeret Mono for everything the platform
computed, Public Sans for everything a human wrote.
STORY: a buyer reads what is inside before paying, and pays on the last line.
FIRST VIEWPORT: owner/slug@version as the first line, the computed facts beneath
it, then the long listing running the full width of the sheet.
FORM: The Long Listing — impeccable's pick, pinned by the brief over the roll's
assignment (The Datasheet). Hand: .impeccable/decision/direction-listing.json.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish
review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
-->`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
      `suppressHydrationWarning` is for exactly one attribute: `data-js`, which the
      product page's own inline scripts (the README clip, the buy bar) write onto
      `<html>` before the controls below them are parsed, so a control and its
      no-script fallback swap without a flash. React sees an attribute on the root that
      the server did not send and calls it a mismatch; it is not one, it is the point.
      The flag suppresses the warning on this element only — children still get the
      full check.
    */
    <html lang="en" className={`${azeretMono.variable} ${publicSans.variable}`} suppressHydrationWarning>
      <body>
        {/*
          The agent-discovery pointers, in the markup, for a reader that has the HTML
          and not the response headers (which carry the same two relations — see
          next.config.ts). React hoists these into <head>. `ai-catalog` is the ARD
          spec's HTML pointer; robots.txt carries the same URL as `Agentmap:`.
        */}
        <link rel="ai-catalog" href="/.well-known/ai-catalog.json" type="application/json" />
        <link rel="api-catalog" href="/.well-known/api-catalog" type="application/linkset+json" />
        <template hidden dangerouslySetInnerHTML={{ __html: DIRECTION_CONTRACT }} />
        {children}
        <HeaderScript />
        <SiteAnalytics />
      </body>
    </html>
  );
}
