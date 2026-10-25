---
name: X402 Git
description: A private repo sold the way a listing prints — mode, size, date, path, and the price on the last line.
colors:
  paper: "#F7F7F5"
  paper-sunk: "#EFEFEC"
  rule: "#DEDEDA"
  rule-strong: "#BDBDB6"
  rule-control: "#8A8A83"
  ink: "#1A1A1A"
  ink-muted: "#6B6B6B"
  accent: "#0B6E4F"
  accent-deep: "#085239"
  status-fail: "#A61B1B"
  status-warn: "#8A5A00"
  github: "#24292F"
typography:
  display:
    fontFamily: "Azeret Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "clamp(1.75rem, 1.25rem + 2.2vw, 2.5rem)"
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Azeret Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "1.25rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  title:
    fontFamily: "Azeret Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Public Sans, system-ui, -apple-system, Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  body-small:
    fontFamily: "Public Sans, system-ui, -apple-system, Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  listing:
    fontFamily: "Azeret Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.571
    letterSpacing: "normal"
    fontFeature: "tabular-nums"
  label:
    fontFamily: "Azeret Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0.07em"
rounded:
  none: "0"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "32px"
  7: "48px"
  8: "64px"
  9: "96px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.paper}"
    typography: "{typography.listing}"
    rounded: "{rounded.none}"
    padding: "8px 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.accent-deep}"
    textColor: "{colors.paper}"
  button-primary-disabled:
    backgroundColor: "{colors.paper-sunk}"
    textColor: "{colors.ink-muted}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.listing}"
    rounded: "{rounded.none}"
    padding: "8px 16px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.paper-sunk}"
    textColor: "{colors.ink}"
  button-github:
    backgroundColor: "{colors.github}"
    textColor: "{colors.paper}"
    typography: "{typography.listing}"
    rounded: "{rounded.none}"
    padding: "8px 16px"
    height: "44px"
  button-github-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  button-quiet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.listing}"
    rounded: "{rounded.none}"
    padding: "8px 0"
  input-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.listing}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
    height: "44px"
    width: "384px"
  input-field-disabled:
    backgroundColor: "{colors.paper-sunk}"
    textColor: "{colors.ink-muted}"
  table-header-cell:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
  table-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.listing}"
    rounded: "{rounded.none}"
    padding: "4px 12px"
    height: "30px"
  table-row-hover:
    backgroundColor: "{colors.paper-sunk}"
    textColor: "{colors.ink}"
  status-verdict:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.accent}"
    typography: "{typography.listing}"
    rounded: "{rounded.none}"
    padding: "0"
  status-verdict-fail:
    textColor: "{colors.status-fail}"
  status-verdict-warn:
    textColor: "{colors.status-warn}"
  status-verdict-pending:
    textColor: "{colors.ink-muted}"
  link:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
  link-hover:
    textColor: "{colors.accent}"
---

# Design System: X402 Git

<!--
  Decided autonomously in an unattended session on 2026-08-29. The founder's brief
  pinned two things — "clean and simple", and the direction "The Long Listing" from
  the hand already rolled in .impeccable/decision/direction-listing.json (impeccable's
  pick, over the roll's assigned "The Datasheet"). Every remaining choice in this file
  was made by the agent without a confirmation round, because the session had no human
  present and the skill's interview step had no answer channel. Nothing here is a
  question waiting for an answer; it is all decided. Change it by editing it.
  Normative tokens live in app/globals.css and in this file's frontmatter.
-->

## Overview

**Creative North Star: "The Long Listing"**

`tar -tvf` and `ls -l` produce the most trusted document in a developer's life: a
complete enumeration of what is inside something, in fixed columns, with nothing
withheld. That is exactly what this product sells. The manifest is public and the
contents are private, so the manifest has to look like an inventory that could not
be hiding anything — not like a store page with a picture of a box. The listing page
*is* the listing: repo and version on the first line, computed facts under it, every
path with its mode, size and date, the README set inline, the release log below, and
the price on the last line where a total belongs.

The rendition is printed, not terminal. A green-on-black shell would be a costume;
this world is the same output laid down in ink on a warm off-white sheet
(`paper #F7F7F5` / `ink #1A1A1A`), which is what a listing looks like when someone
means to keep it. There is exactly one accent — a deep, unlit green (`accent #0B6E4F`)
— and it is spent on the order line and on a passing scan. Nothing is rounded, nothing
casts a shadow, and every rule on every page is one pixel. Density is the point: the
page should feel like a document a careful engineer produced, where more information
made it better rather than busier.

The system's one product-specific invariant is typographic. PRODUCT.md requires that
computed fields be visually distinct from creator-supplied ones, so the two faces
carry that distinction and nothing else: **Azeret Mono** sets everything the platform
computed or measured — paths, sizes, hashes, versions, prices, dates, column headers,
form fields, buttons — and **Public Sans** sets everything a human wrote — README
prose, changelog bodies, marketing copy, help text. A reader can tell provenance from
the shape of the letters before reading a word. Monospace here is measurement, not
decoration.

The confirmed anti-references are the package-registry product page (title, sidebar
stats, one blue primary button — indistinguishable from GitHub and npm by design) and
the marketplace storefront (ratings, badges, hero). Both were on the table as the
standing exit; neither was taken.

*Amended 2026-08-30, on the founder's direction.* Three shapes that were listed among
those anti-references are now in the system, each in exactly one place and each narrowed
to the job that earned it:

- **A sidebar with the price in it, on the listing page.** The founder's words were
  "GitHub meets Gumroad meets x402", and the direction is explicit that the product page
  is "formatted for humans, not for agents". The Long Listing put the total on the last
  line because that is where a total belongs on a *listing*; it is not where a price
  belongs on a *product page*, and a reader who has to scroll a two-thousand-word README
  to find out what something costs has been billed blind in the other direction. So on
  `/[owner]/[slug]` and nowhere else, the price, the updates line, one buy control, what
  you get and the trust line sit in a hairline rectangle in a right column that sticks.
  The rule that survives is the one that mattered: the facts a buyer checks — version,
  date, licence, scan verdict, artifact class — are in the header above the price on
  every viewport, and the price is never the first thing on the page.
- **One row of three example cards on the home page**, because three listings shown to
  be compared side by side is what a card row is actually for, and a ruled list of
  three made the reader scan down for a comparison that runs across. The rule that
  remains: no cards anywhere else except the buy box and, since later the same day on
  the founder's direction, the product page's README and `What's inside` (GitHub's
  README frame), never a card inside a card,
  no shadow, no radius, no ground — a hairline rectangle and nothing more. The moment
  those three acquire a filter, a sort, a rating or a "see all", they have become the
  storefront and the rule was lost anyway.
- **A language bar**, in the `What's inside` disclosure. GitHub's own bar is the
  reference and its colour key is the part that does not translate: this system has one
  accent and it is spent on the paid action. The segments are the ink ramp instead —
  ink, ash, hairline-strong, hairline, largest share first — and the legend names every
  segment with its percentage, so the bar is `aria-hidden` decoration over an accessible
  reading rather than the only place the fact appears.

*What went, the same day.* The listing page used to carry a two-link view strip
(Overview / For agents). `?view=agent` is unchanged and still server-renders the whole
manifest for `curl`, but nothing on the website links to it: the founder's direction is
to "flag the whole agent-first approach for now and focus purely on humans — keep it all
built, just hide it on the website". So the strip is gone, `OpenAPI` and `Errors` left
the header and the footer (both are linked from `/docs`, which is now one footer link),
the home page's **For agents** block moved to `/docs`, and `/how-it-works` carries no
`curl` and no JSON. *Reworked later the same day, on the founder's direction:* it now reads
in the order a person's questions arrive — the whole product as one ruled sequence
(`.flow`, actor in the margin, event in the title face), a **What is x402?** explainer whose
wire exchange is four English lines in the computed face (`.exchange`, the server's turns
on Sunk Sheet), Sell · Buy · Fees as ruled name-beside-explanation rows (`.how`), the
comparison, and a grouped FAQ in the product page's `<details>` with the question in the
text face (`.faq`) and matching `FAQPage` structured data. One grounded action, at the end.
*Reordered again the same day, with the contents column (founder: "use the same side menu
that the docs page has … think through the order of the whole page").* The practical story
now runs unbroken — the sequence, then Sell, then Buy — and the x402 explainer follows Buy,
because Buy's last row (an agent buying with no person) is the row that raises the
protocol's question; then Fees, the comparison, the FAQ. The page wears the docs surface's
`.docs-nav` beside the reading above `64rem`, its rows this page's headings verbatim with
the row or question count at the tab stop, read from the same arrays the sections render.

**Key Characteristics:**

- One sheet of warm off-white paper, one ink, one accent, hairline rules.
- Zero corner radius, zero shadows, zero gradients anywhere in the system.
- Monospace marks machine-computed truth; the text face marks human authorship.
- Tables are the primary component, not a fallback for one.
- No motion beyond 100ms state changes; the cursor line snaps.
- Semantic HTML with no classes must already look like the design.

## Colors

An ink set, not a palette: paper, sunk paper, four greys, one accent with its pressed
state, and two status inks reserved for verdicts. Eleven values, plus one borrowed
ground that is not ours to design.

### Primary

- **Ledger Green** (`#0B6E4F`): the only accent in the system. It grounds the single
  order line on a listing page, colours a passing scan verdict, marks the caret and
  the text selection, and is the hover colour for links. 5.76:1 on paper, 6.17:1
  under paper-coloured text, so it carries body-sized type in either direction.
- **Ledger Green Deep** (`#085239`): pressed and hovered states of the accent ground
  only. Never used as a text colour.

### Neutral

- **Sheet** (`#F7F7F5`): the page. Warm off-white, the colour of paper that was not
  bleached. The only background in the system that covers area.
- **Sunk Sheet** (`#EFEFEC`): the cursor line under a hovered table row, the ground of
  `<pre>` and inline `<code>`, and the ground of every disabled control. One step
  down, never two.
- **Ink** (`#1A1A1A`): all body and heading text, the focus ring's outer band. 16.2:1
  on paper. Never pure black, because pure black on paper is a screenshot of a
  terminal, not a printed sheet.
- **Ash** (`#6B6B6B`): secondary text — column headers, labels, timestamps, byte
  counts that are context rather than the point, and the ghosted side of an update
  diff. 4.97:1 on paper and 4.63:1 on sunk sheet, so it is still AA body text at every
  size. This is the lightest text colour that exists.
- **Hairline** (`#DEDEDA`): the rule between table rows and around inert containers.
  Non-text only.
- **Hairline Strong** (`#BDBDB6`): the rule under a table head and under a section
  heading, the blockquote rule, the scrollbar thumb. Structural dividers only.
- **Control Edge** (`#8A8A83`): the outline of every input, select, textarea and
  secondary button, and the underline of every link. 3.24:1 on paper, which is the
  WCAG 1.4.11 floor for a non-text control boundary — the reason it exists as a
  separate grey from Hairline Strong, which does not clear that bar.

### Tertiary

- **Fail Red** (`#A61B1B`): a failed scan, an invalid field, a declined payment.
  6.94:1 on paper.
- **Caution Ochre** (`#8A5A00`): a scan that found something non-blocking. 5.53:1 on
  paper.

### Borrowed

- **GitHub Ink** (`#24292F`): the ground of GitHub's own sign-in button, and the ground
  of exactly one control in this system — the home page's **Connect my repo**. Added
  2026-08-30 on the founder's direction that the CTA look like the official GitHub OAuth
  button. Paper on it is 13.7:1. It has no pressed state of its own: it darkens to Ink
  (`#1A1A1A`), so the borrowed value stays a single hex rather than growing a ramp.

### Named Rules

**The Closed Ink Set Rule.** The system has eleven colours of its own and no ramps.
There is no `--accent-light`, no tint, no alpha wash over the accent, and no new hex in
any component file. If a state needs to read differently, it changes weight, ground, or
rule colour — not hue.

**The Borrowed Ground Rule.** `--github` is the one exception and it is not a system
colour; it is another company's button, used because the button starts an OAuth round
trip to that company and a control that looks like the destination is telling the truth
about where the click goes. It grounds `button[data-variant="github"]` and nothing else
— not a link, not a border, not a heading, not a second GitHub-flavoured control — and
it never acquires a lighter or darker sibling. If a second borrowed ground is ever
proposed, the answer is no: one is a citation, two is a palette.

**The Two Rule Greys Rule.** `--rule` and `--rule-strong` divide content; they are
decoration and carry no contrast obligation. `--rule-control` outlines things a person
operates — inputs, selects, textareas, secondary buttons — and things they click —
link underlines. Never swap them: a control edge in `--rule-strong` fails WCAG 1.4.11
at 1.76:1, and a table row rule in `--rule-control` turns a listing into a spreadsheet.

**The One Order Line Rule.** Accent as a *ground* appears once per page, on that page's
single committing action. Everything else that is clickable is ink on paper inside a
hairline rectangle. A page with two green buttons has lost the rule that makes the green
mean something.

*Amended 2026-08-30, on the founder's direction that the home page lead with **Connect
my repo**, and again the same day on the direction that it wear GitHub's own button.* On
every page that sells something the committing action is the paid action, and the green
still means "this is the thing you pay for". The home page is the one page with nothing
to buy: its committing action is Connect my repo, and it wears `--github` rather than
the green — see The Borrowed Ground Rule. So the home page carries **no** green ground
at all, and the green stays what it always meant: the thing you pay for. What did not
change is the count. One grounded action per page, never two, whichever ground it is.

**The Verdict Ink Rule.** Fail Red and Caution Ochre belong to scan verdicts, invalid
fields, and payment failure. They never appear as chrome, decoration, category
colour, or emphasis. Price and the order line never borrow them.

**The AA Floor Rule.** Ash (`#6B6B6B`) is the lightest text in the system. "Ghosted"
states in an update diff — unchanged files against changed ones — are rendered by
dropping to Ash and by removing weight, never by fading below it. Contrast is never
spent on hierarchy.

## Typography

**Display / Data Font:** Azeret Mono (variable 100–900, loaded via `next/font/google`;
fallback `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`)
**Body Font:** Public Sans (variable 100–900, loaded via `next/font/google`; fallback
`system-ui, -apple-system, Segoe UI, Helvetica Neue, Arial, sans-serif`)

**Character:** Azeret Mono is a mechanical, squared-off monospace with a large x-height
and unusually even colour in a dense column — it reads as instrumentation rather than
as a terminal emulator, which is exactly the distance this world needs from shell
cosplay. Public Sans is the American civic grotesque from the US Web Design System:
plain, direct, specific, with no editorial personality to argue with the data. Both
are self-hosted through `next/font`, so there is no third-party request, no flash, and
no layout shift on a page an agent may fetch a hundred times a day. **Inter is not in
this system, in any role, including as a fallback.**

### Hierarchy

- **Display** (Azeret Mono 500, `clamp(1.75rem, 1.25rem + 2.2vw, 2.5rem)`, 1.12,
  −0.02em): one per page. On a listing page it is `owner/slug` with the version; on the
  dashboard it is the creator's handle. Sets `text-wrap: balance`.
- **Headline** (Azeret Mono 500, 1.25rem, 1.3): section heads — CONTENTS, README,
  RELEASES, DEPENDENCIES. Carries a 1px `hairline-strong` underline as part of the
  heading, so sections are separated by the type, not by a container.
- **Title** (Azeret Mono 500, 1rem, 1.3): sub-heads inside a section and the label on a
  pricing preset.
- **Body** (Public Sans 400, 1.0625rem/17px, 1.6, max 68ch): rendered README, changelog
  bodies, the home page's sentences, help text under a form field.
- **Body Small** (Public Sans 400, 0.9375rem/15px, 1.55): captions, footnotes, the
  earnings sentence under a price field.
- **Listing** (Azeret Mono 400, 0.875rem/14px, 22px line, tabular numerals): the file
  tree, dependency list, release log, addresses, hashes, prices, form input text and
  button labels. This is the workhorse and most of the page is set in it.
- **Label** (Azeret Mono 500, 0.75rem/12px, +0.07em, uppercase): table column headers,
  form labels, `<legend>`. Nowhere else.

### Named Rules

**The Computed / Written Rule.** Every value the platform derived — path, mode, byte
count, SHA, version, price, date, wallet address, scan verdict — is set in Azeret Mono.
Every string a person authored — README, changelog, listing description, page copy —
is set in Public Sans. The two faces are the disclosure boundary made visible, so
neither may be used for the other's content "for consistency". The `.computed` and
`.written` utilities exist to force this at the edges (a creator's blurb inside a table
cell is still `.written`).

*Stated in full, 2026-08-31 (layout v2), because the boundary cases were being decided
per element:* the mono face also sets everything that is **machine-output or interface
machinery** — headings, nav and footer links, buttons and their labels, prices and
price terms ("new releases included" is a term of sale, not prose), install counts,
form inputs, table heads. The text face sets **only prose a person wrote for another
person to read** — blurbs, READMEs, sub-lines, help text, FAQ answers. A card whose
mono title sits over a sans blurb is not an inconsistency; it is the rule working. No
element changes under this paragraph — it exists so the next one is placed by rule, not
by taste.

**The No Kicker Rule.** The uppercase tracked Label style is for a table column header,
a form label, and a `<legend>`. It is never a word placed above a heading. There are no
eyebrows, no kickers, and no section numbers in this system.

*Clarified 2026-08-31, on the founder's direction that the home page's section heads
read as eyebrow-size text.* `h2.section-label` sets the home page's `How to earn` and
`Featured` at the Label size, in Ash, over the heading's usual rule. The rule above
stands untouched: these are the sections' own `<h2>`s worn small — the heading *is* the
small text, and nothing sits above a heading anywhere. The moment a Headline-size head
appears under one of these, it has become an eyebrow and this clarification is void.

**The Tabular Rule.** Anything a reader might compare down a column — sizes, prices,
counts, dates, percentages — is right-aligned with `font-variant-numeric: tabular-nums`.
The `.num` utility does both. A number that is not comparable (a version in prose) does
not get it.

## Layout

One column, full width of the sheet, scrolling — on every page but two.

*Amended 2026-08-30, on the founder's direction that the product page be "GitHub meets
Gumroad meets x402".* `/[owner]/[slug]` is two columns above `60rem`: a `1fr` body and a
`22rem` right column holding the buy box, which is `position: sticky` so the price and
the action stay in view down a long page. Document order is head → box → body, which
is also the phone's stacking order, so nobody scrolls a README to find a price and the
grid never reorders anything a screen reader or `curl` reads. Below `44rem` of viewport
*height* the box stops sticking, because a sticky element taller than the space it is
stuck in has an unreachable bottom. Every other page in the product is still one column,
and the Datasheet's rail is still refused everywhere else.

*Amended again 2026-08-30, on the founder's direction that the dense docs get "a side
menu like a regular docs page".* `/docs` and `/docs/errors` share a **contents column**
above `64rem`: a `12rem` left column holding one nav for the whole docs surface — each
docs page a head row ruled like a table head, its sections as hairline rows with the
route or code count at the tab stop, sourced from the same registry and catalogue the
pages render so the menu can never disagree with the headings. It is sticky under the
site header at the same clearance every anchor target keeps. Below `64rem` the same
element flattens into the ruled line of anchors the page carried before — this page's
sections and the other page's title. It is anchors and ink only, because `/docs/**`
must work with script off; there is no scrollspy and no toggle. The docs column and
the buy box are the two columns in the product, and each earned it differently: the
box holds an offer beside a reading, the contents hold a map beside a reference. A
third two-column page still needs the founder's direction, not this precedent.

*Amended once more 2026-08-30: the third page arrived, by that direction.* `/how-it-works`
wears the same contents column, on the founder's words "use the same side menu that the
docs page has". It is the docs pattern exactly — the same `.docs-nav` markup, grid,
breakpoint and phone strip, one head row for the page and its sections as hairline rows,
counts read from the arrays the sections render — because the page makes the docs' claim:
it is a long reference a reader arrives at with one question. A *fourth* two-column page
still needs the founder's direction; this amendment extends the contents column to the
long-read surfaces, not to the product.

**The Standalone Rule.** *Added 2026-08-30, on the founder's direction that the product
pages "feel standalone — just like on Gumroad".* A listing page and an author page wear
no site navigation. The header is the wordmark alone — small, muted, no rule under it,
the way home without a menu — and the footer is one line, *Sold on X402 Git · Terms*.
Neither reads the session. These are storefront pages: creator-owned, shared by link,
landed on cold, and every link out of them is a way not to buy. Every other page keeps
the full header and footer; the rule is the kind of page, not the route. Because the
public page now looks nothing like the dashboard around it, the dashboard's *Public
page* link opens it in a new tab, so a creator sees it exactly as a buyer will.

**The Above the Fold Rule.** *Added 2026-08-30, on the founder's direction that "the buy
box should be way further up".* On the product page the price and the buy control are in
the first viewport at every width, and the header is what is trimmed to keep them there —
never the buyer's checks.

- **Desktop.** The box is at **row 1** of the grid, level with the `h1`, and spans both
  rows. The header therefore occupies column 1 only, so its closing rule is the width of
  the reading column rather than of the sheet. It used to sit under a full-width header,
  which put the price a header's height down the page for no reason but markup order.
- **Phone.** The header carries the title, the creator line and the one-line blurb —
  and nothing else. The meta row left it on 2026-08-30: version sits on the Download
  cost line, installs on the owners line, and licence, class, updated and the scan
  verdict in the specification list under the box, so the checks share a column with
  the price instead of repeating above it. The trigger hint left the page with the
  About block; the provenance sentence and the holdback/terms line left the body on 2026-08-30 (founder), leaving no small print on the human page. The price
  lands inside the first viewport of a 390×844 screen with the button under it.
- **What pays for it.** Padding, one step at a time, below `44rem`: the page's top gutter
  drops to `--space-5`, the header's closing gap to `--space-5`, the box's padding to
  `--space-4`, and the specification `<dl>` under the box keeps its two columns where
  every other `<dl>` in the system stacks. Nothing is removed and no type is shrunk.

The rule the trim may never break is the one above it: the version, the date, the licence,
the scan verdict and the artifact class come **before** the price in the document, on
every viewport. Never bill blind.

- **Container:** `--container: 76rem` (1216px), centred, with `--gutter:
  clamp(1rem, 4vw, 2rem)` either side. Tables run the full container width; prose is
  capped at `--measure: 68ch` regardless of container width.
- **Spacing scale:** 4px base — 4, 8, 12, 16, 24, 32, 48, 64, 96 (`--space-1`…`--space-9`).
  Nothing between steps, ever. Section separation is `--space-7` (48px) above a heading
  and `--space-3` (12px) below it: more space above than below, always.
- **Row rhythm:** `--row-height: 1.875rem` (30px) — a 22px line in 4px of padding,
  giving a 31px pitch once the 1px row rule is counted. A three-thousand-row file tree
  has to stay scannable, so rows are tight and sections are generous.
- **Rules do the containing.** Regions are separated by a 1px rule and by space. There
  are no bordered boxes wrapping content sections and there is never a box inside a box.
- **Responsive:** the file tree keeps size and path at every width. Below `40rem` any
  cell marked `[data-col="optional"]` (mode, blob date) is hidden and horizontal cell
  padding drops from 12px to 8px. Nothing horizontally scrolls except `<pre>`.
- **Touch:** every interactive control is at least `--tap: 2.75rem` (44px) tall.

### Named Rules

**The Last Line Rule.** The paid action sits at the end of the listing, after the
reader has seen what they are buying, as a full-width bar carrying price and version.
It is not sticky, not floated, and not duplicated at the top. "Never bill blind" is a
layout decision before it is a copy decision.

*Amended 2026-08-30, on the founder's direction that the product page be a page a
person buys from.* The rule holds unchanged on `?view=agent`, which is the reading that
contains the manifest: tree, dependencies, release log, stamps, and then the order line
last. On the product page the rule is replaced rather than restated, because the founder
asked for the opposite shape and was right to: a buy box you have to hunt for is worse
UX than a buy box you can see, and a total at the bottom of a document is a *listing*
convention, not a *product page* one.

What "never bill blind" requires is met three ways on the product page, and all three
are load-bearing:

1. The buyer's checks — version, date, licence, scan verdict and its date, artifact
   class — are in the page header, **above** the box in document order, so they are read
   before the price on a phone and sit beside it on a desktop.
2. The box itself carries what is being bought before the button: the price, what an
   update costs, what arrives (`.zip` at a named version and its size, the LICENSE, re-download),
   and the scan line. The button's label names the amount.
3. The manifest is on the page — files, size, dependency count in the summary; the
   language mix, the top-level folders, the full tree and the dependency table one
   disclosure deeper — and complete at `?view=agent`.

The count is unchanged: **one grounded action per page.** On the product page it is the
buy button; after a purchase it is the download link, which is the same slot.

**The Bare HTML Rule.** `app/globals.css` styles elements, not classes. A page built
from `<h1>`, `<table>`, `<p>`, `<a>`, `<button>` and `<input>` with no `class`
attribute at all must already render as this design system. The styling floor lives on
the tags themselves and utilities are the exception, not the mechanism.

*Amended 2026-08-30, on the founder's direction.* The second half of this rule used to
read "every page must work with JavaScript disabled". That constraint is now lifted for
the product page, the home page, `/purchases` and the buy flow, and holds only for
`/docs/**`. Two things did not change and are not negotiable:

- **The content is still in the server HTML.** `npm run check:ssr` must find the slug and
  the README text on a product page, because the whole product claim is a manifest an
  agent can read cold. What is allowed to require script is *behaviour* — a wallet, a
  disclosure, a bar — never a fact.
- **A control that cannot work does not render.** The buy button's pre-hydration frame is
  a sentence saying how to pay without one, not a dead button. That is the same rule the
  copy control has always followed, and it is what makes the lift safe.

## Elevation & Depth

There is no elevation. No `box-shadow` is used for depth anywhere in this system, and
there are no gradients, no glass, no blur, and no overlays. A sheet of paper has one
plane.

Depth is expressed two ways and only two: a one-step change of ground (Sheet →
Sunk Sheet) and a 1px rule. The hovered table row and the code block are sunk; the
disabled control is sunk. That is the whole vocabulary.

The single `box-shadow` in the system is not depth — it is the focus ring:
`0 0 0 2px var(--paper), 0 0 0 4px var(--ink)`. A paper-coloured gap then an ink band,
so it reads at 3:1 or better against the sheet (16.2:1) and against the accent ground
of the order line (5.76:1 for the inner band). It is applied on `:focus-visible` with
`outline: none`, and it is the same ring on every focusable element — link, button,
input, select, table row action.

### Named Rules

**The Hidden Means Hidden Rule.** *Added 2026-09-14.* `[hidden] { display: none
!important }` is in the base rules, and it is the only `!important` in the system that is
about a thing's existence rather than its state. It is there because it was missing:
`fit()` in `readme-more.tsx` had been correctly setting `hidden` on the clip control's
wrapper since the day it shipped, and `[data-js="on"] .readme-more { display: block }` —
one attribute and one class — outranked the user agent's `[hidden] { display: none }`, so
a **Show more** sat under a README that was already entirely visible. Anything this
product hides with the attribute goes through that one line; no component may set
`display` on a hidden element with an `!important` of its own.

**The Flat Sheet Rule.** If a change of ground and a hairline rule cannot express a
relationship, the relationship is wrong — reach for space or a heading, never for a
shadow.

*Amended 2026-08-30, on the founder's direction that the README preview be "clipped with
a soft fade".* There is exactly one gradient in the system and it is never painted: the
README preview's bottom edge is a `mask-image: linear-gradient(to bottom, currentColor
…, transparent)`, so only the alpha channel of that gradient is used and the colour —
`currentColor`, which is Ink — is never drawn. It is the text dissolving into the paper
at the clip, which is what a clipped page does, not a wash of colour over a card. No new
value enters the ink set to draw it, it is the only mask in the product, and a second one
proposed anywhere else is a gradient wearing a mask's name.

## Shapes

`--radius: 0`. Every corner in the system is square: buttons, inputs, code blocks,
fieldsets, status chips, the order bar. The token exists so that nobody reintroduces
`8px` in a component; reference `var(--radius)` rather than writing `0`.

Every border in the system is `1px` (`--rule-width`). Weight never varies — only
colour does, between `--rule` (row separators, inert containers), `--rule-strong`
(table head underline, section heading underline) and `--rule-control` (input and
button outlines, link underlines). There are no 2px, 3px, or coloured left-borders on
anything.

The recurring silhouette is the full-width horizontal band: a heading with a rule
under it, a table that runs edge to edge of the container, and the order bar. Vertical
divisions come from column alignment inside a table, never from a vertical rule.

### Named Rules

**The Hairline Rule.** One pixel, one of two greys. A thicker or coloured rule is how
this world stops looking printed and starts looking like a component library.

## Components

### Buttons

- **Shape:** square (`0` radius), 1px outline, 44px minimum height, 8px/16px padding,
  Azeret Mono 500 at the Listing size. Labels name the action and its consequence:
  "Get 4.1.2 — $9.00", "Update to 4.1.2 — $3.00", "Publish release", "Withdraw $18.90".
- **Primary** (`button[data-variant="primary"]`): Ledger Green ground, paper text,
  green border. One per page, on the paid action — or, on the home page, on **Connect my
  repo** (see The One Order Line Rule). Hover drops to Ledger Green Deep. Disabled falls
  to Sunk Sheet ground with Ash text and a Hairline border.
- **Secondary** (bare `<button>`): paper ground, ink text, `rule-control` border. The
  default appearance for every non-paying action. Hover sinks the ground to Sunk Sheet
  and darkens the border to Ash.
- **GitHub** (`button[data-variant="github"]`): GitHub Ink ground, paper text, the
  Octocat mark inline at 1.25em in `currentColor`, then the label. Hover darkens to Ink.
  One control in the whole product — the home page's Connect my repo — and it is a
  `<form method="get">` submit, so it works with scripting off. See The Borrowed Ground
  Rule.
- **Quiet** (`button[data-variant="quiet"]`): no border, no ground, Ash text with a
  `rule-control` underline — a form-submitting action that has to sit inline in a
  sentence or a table cell without becoming a button. Hover goes accent. The footer's
  Sign out is one of these: a real `<form method="post">`, because a GET would let a
  prefetching browser or a link in a README end somebody's session.
- **Link-as-action** (`a[data-button]`): the secondary rectangle worn by an anchor that
  is genuinely a navigation — "View" on an example card — so it keeps the middle click,
  the context menu and the status bar while sitting in a row beside real buttons. Never
  used to make a `<button>` out of something that does not navigate, and never the
  reverse.
- **Focus:** the system focus ring on `:focus-visible`; the primary button's ring reads
  because its inner band is paper.
- **Transition:** 100ms ease-out on background, border and colour. Nothing else.

### Inputs / Fields

- **Style:** paper ground, 1px `rule-control` border, square, 8px/12px padding, 44px
  minimum height, `max-width: 24rem`. Text is Azeret Mono at the Listing size, because
  a repo URL, a wallet address and a price are all data. `<textarea>` is the exception
  and takes Public Sans at Body size, capped at 68ch, because a person is writing prose
  into it.
- **Label:** the uppercase tracked Label style, Ash, above the field, 8px below.
- **Placeholder:** Ash at full opacity — never a lightened ink.
- **Hover:** border darkens to Ash. **Focus:** the system ring.
- **Error:** `aria-invalid="true"` turns the border Fail Red; the message sits below
  the field in Body Small, Fail Red, and names both the problem and the recovery.
- **Disabled:** Sunk Sheet ground, Ash text, Hairline border, `not-allowed`.
- **Pricing presets** are radio inputs in a `<fieldset>` with a `<legend>`, never a
  slider and never a select. The price field is pre-filled and cannot be blank.

### Tables — the signature component

The file tree, the dependency list, the release log, the purchase history and the
earnings ledger are all one component.

- **Head:** Label style, Ash, uppercase, left-aligned, `nowrap`, with a 1px
  `rule-strong` bottom rule.
- **Body:** Listing style at 4px/12px padding on a 30px row, each row closed by a 1px
  `rule` bottom border. First and last cells lose their outer padding so the columns
  align flush with the container edge — the tab stops are real.
- **Numeric columns** carry `.num`: right-aligned, tabular, `nowrap`.
- **Cursor line:** `tbody tr:hover` takes the Sunk Sheet ground with **no transition**.
- **Caption:** `<caption>` in Label style above the table, left-aligned, carrying the
  count and provenance ("3,537 files · 87.5 MB · computed 2026-08-29").
- No zebra striping. Rules already separate the rows; doing both is doing it twice.
- No nested tables and no cards wrapping tables.

### Views

The listing has two readings and they are two URLs: the product page at
`/[owner]/[slug]`, and the machine reading at `?view=agent`. Since 2026-08-30 there is
**no view strip**: nothing on the website links to the agent reading, on the founder's
direction that the site is for people. The agent reading is unchanged, still
server-renders complete, still fetchable with `curl`, and carries a link back to the
product page; `/docs` is where a reader who wants it is told it exists.

The strip's removal also removes the last thing this system had in common with a
registry's tab widget, which was the anti-reference the strip was argued against in the
first place.

*Added 2026-08-30:* a third page, `/[owner]` — the **author page**. It is not a third
reading of a listing; it is one creator's shelf, and it exists because until now a
creator had exactly one kind of URL to hand somebody and no way to say *here is
everything I sell*. See **Author page** below.

### Steps

The home page's `Connect repo → Set price → Add wallet → Done`. A real `<ol>` — with CSS
off it is still four numbered steps in order — laid out as four equal columns above
`48rem` and a ruled stack below it. Each step is a name in the Title face over one
sub-line of Body Small in Ash. The arrows are `::after` generated content with an empty
alt (`content: "→" / ""`), so they are drawn between columns and never announced, and
they disappear entirely when the steps stack. Four steps, never five, and no numbers
drawn on the page — the sequence is carried by the arrows, not by an `01 / 02 / 03`
label.

*Amended 2026-08-30, on the founder's direction: "one flow, not two CTAs".* **Step one is
the button.** The GitHub control used to sit on its own above this row, which then opened
with a step called `Connect repo` — the same instruction twice within four inches, once as
a thing you can press and once as a word. So the first cell now holds the
`<form method="get">` and its `button[data-variant="github"]`, with the same Body Small
sub-line under it that the other three carry, and the row reads
`[Connect my repo] → Set price → Add wallet → Done`. Two consequences are load-bearing:

- **The first row of every cell is `--tap` tall**, handed to all four columns by
  `grid-template-rows: subgrid`, so the three names sit on the button's centre line and
  the four sub-lines sit on one line under it. Without the subgrid the names start at the
  top of a 44px row and the button reads as a different kind of object dropped into a
  list.
- **The arrow is centred on that row** (`height: var(--tap); display: flex; align-items:
  center`), not hung from the cell's top padding, so it points at the button rather than
  above it.

The count is unchanged and so is The One Order Line Rule: one grounded action on the home
page, and it is now inside the sequence it starts rather than beside it.

*Amended 2026-08-31 (layout v2, on the founder's direction).* **The button left the row
again — upward.** Inline with three text labels, the one filled block on the page shared
a baseline with words and read as step zero of four, and its column sat bottom-light
against the others. It now sits centred in the hero, directly under the subhead; what
"one flow, not two CTAs" forbids is a *step whose words repeat the button's*, and the
row does not have one: on the same day's direction it regained a first step with
different words, `Connect repo`, over "Every release syncs automatically".
The row reads `Connect repo → Set price → Add wallet → Done`. Three
consequences:

- **The ruled stack holds until `64rem`**, not 48 — at 48rem four columns were ~157px
  and the sub-lines shredded. 64rem is also the card row's breakpoint, so the landing
  page has one desktop moment.
- **The name and sub-line rows are still subgrid**, no longer for a button's sake but so
  a name long enough to wrap holds every column's sub-line on one shared line.
- **The arrow sits on the name's own line** (`height: calc(var(--size-title) *
  var(--leading-heading))`), pointing between the words it sequences, not centred on a
  44px row that no longer exists.

The row wears a heading now (founder, 2026-08-31): `How to earn`, an `h2.section-label`
at Label size whose rule replaces the list's own top border (see The No Kicker Rule's
clarification); `Featured` wears the same dress, so the page's two content sections are
headed alike.

The hero above it is centred — headline, the one line "Sell it once, and get paid again
every time you ship.", the button — with viewport-relative room
(`padding-block: clamp(var(--space-7), 12vh, 7rem)`) chosen so the steps row's rule
still lands inside the first viewport on a short laptop. That is this page's fold rule:
**the hero breathes, and the row beneath it is always above the fold.**

### Cards

One row of three, on the home page. A `1px --rule` rectangle with `--space-4` of padding
and no ground, no shadow, no radius, holding: the slug in the computed face, the
creator's blurb cut to twelve words in the text face, the price line, and the card's
floor — the byline on the left and one control on the right — so three cards of unequal
blurb length still line their buttons up. Three columns at `64rem` and up (layout v2,
2026-08-31 — 48rem broke slugs mid-word and un-aligned the card tops, and 64rem is
where the widest current slug plus its install count first fits a third of the row),
one column below. Nothing inside a card is itself boxed. Three rules keep the head row
honest: **a slug never breaks at its hyphens** (`white-space: nowrap` — it is one name,
not prose), the install count may drop below the slug when the two stop sharing a line,
and a slug wider than the whole card ellipsizes as the last resort. On the card's
floor the byline link carries the View control's `--tap` height, so the row's two
occupants sit as equals rather than one centred against the other.

*Amended 2026-08-30.* The same card now carries the author page's shelf and the home
page's three examples, over the same loader type, because they make the same claim about
the same rows — "this is a real listing, here is what is in it, open it". A second card
component would be a second promise about what a card means. The card also carries the
install count when there is one (`$9 · updates included · 12 installs`) and nothing when
there is not; a card that says "0 installs" is telling every reader the same
discouraging thing about a listing published this morning.

*Amended again the same day, on the founder's direction.* The card has **one** control
everywhere, and a byline where the second one was.

- **Copy link is gone.** Two rectangles of equal weight on a card's floor made the reader
  choose between them before they knew what was behind either, and the one they want
  first is always "show me". Copying a link you have not opened is a creator's action on
  a row of cards written for a buyer.
- **View opens in a new window** (`target="_blank" rel="noopener"`, with "(opens in a new
  tab)" in the accessible name). The home page is where the reader is deciding; sending
  them away from it to look at an example loses the decision.
- **The byline is the avatar and the handle, as one link to the author page.** 24px, the
  same hairline the 40px avatar wears on a product page, the handle in the mono face in
  Ash. It is the only new fact on the card and it is the one a stranger weighing three
  unfamiliar listings actually wants: somebody real published these. **No avatar, no
  byline** — a Rail B listing has no GitHub person and a revoked installation means we do
  not know today, and a grey circle standing in for a face is a placeholder for a fact
  (`lib/web/featured.ts`).
- **The author page passes no avatar**, because the creator is already at the top of that
  page in full and the same face sixty pixels lower is one fact printed twice.

The buy box (below) is the other bordered rectangle in the system, joined on 2026-08-30 by
the product page's two body sections — README and `What's inside` — on the founder's
direction to take GitHub's README frame. That is the whole list: the moment a bordered
box is the default container for a section, this is the component library the world was
built to refuse.

### Buy box

The product page's order block, in the right column above `60rem` and stacked under the
header below it. A `1px --rule` rectangle with `--space-5` of padding — no ground, no
shadow, no radius, nothing inside it boxed again — holding, in this order:

- the two costs itemised like an invoice (`.cost-lines`, amended 2026-08-30 — it was a
  lone display price over an updates sentence): "Download v1.2.0" against the price at
  Display size in the computed face, tabular, then "Future updates" against "Free" or
  "$5 each" in the same mono. Labels in the text face, Ash, on the left; amounts on the
  right, sharing a baseline. No number is printed twice;
- one muted sentence under the lines: "Every later release is yours." when updates are
  free, "You're only charged when you choose to update." when they are not;
- **one** control at full box width, wearing the accent ground. Its label names the
  deal and the amount, never the mechanism (amended 2026-08-30 — it opened with
  "Connect wallet", which told nobody they were starting a purchase): "Buy — $9" or
  "Get it free" before a wallet is connected; then "Pay $9", "Pay $5 — update to
  v1.1.0", "Get it — free", or "Download v1.0.0" for a version already owned. Before
  hydration it is a sentence rather than a button;
- once a wallet is connected, a **payment-method row** above the button (`.pay-from`,
  2026-08-30): "Paying from 0x2CAC…2a03 on Base" on the left, a quiet "Change" on the
  right, ruled above and below, in the Label face — the shape of every checkout's card
  row, so a reader who has never held a wallet still knows where they are. "Change",
  not "Disconnect": it only resets the box; there is no buyer session to end;
- a `role="status"` line under the button, because PRODUCT.md requires wallet and
  payment state to be announced — one short muted sentence, never two: what the button
  will ask for before connecting ("You'll be asked to connect a wallet. Nothing is
  charged until you approve it."), "Your wallet will ask you to approve the payment."
  after, or "You own v1.0.0.";
- **"Buy with your agent"** (added 2026-08-30): the x402 endpoint on the sunken paper
  every code value gets, with a compact bordered copy button beside it. One muted
  sentence between the heading and the URL (added 2026-08-31) names the mechanism —
  "Hand this URL to any agent with a wallet — it's an x402 endpoint, so the agent can
  read the price, pay in USDC, and download the code itself." — in the same
  `.written .updates` voice as the sentence under the cost lines, because the block is
  the page's one chance to say the agent rail is a first-class way to buy, not a
  wallet-holder's shortcut. The URL is server HTML; only the button hydrates. Hidden
  on a retired listing;
- "What you get" moved out of the box (2026-08-30) to sit with the specification list
  beneath it: the box holds the deal, the column's tail holds the facts. Still a
  Title-size heading with no rule, over the archive line and the re-download line;
- **how many wallets own it**, in Ash, mono: `12 people own this` — absent before the
  first sale, because printing a zero as a statistic is a defect and a sentence
  standing in for the zero is the same defect in prose (FR-40, amended 2026-08-30:
  exact from the first purchase, hidden at nought, never a buyer address);
- the scan sentence moved out of the box (2026-08-30): it now sits under the
  specification list (Size · Files · Licence · Class · Updated · Languages, the bar and legend as the value of the last row since 2026-08-30; it was in What’s inside), above its own hairline, in Ash — a
  footnote to the facts rather than a line item in the offer.

*Amended 2026-09-14, on the founder's direction — "I want it to actually be part of the
right-hand panel … a lot more compact … signal these various scans it's had, maybe just a
tick next to each scan and the name of it, e.g. whether it was scanned with Socket or
not."* The scan sentence is gone and **Trust** is a block of its own in that column,
between What you get and Languages: a hairline, the Label-size heading, and seven rows at
the listing's 30px pitch — the mark, the scan's short name, and, where the column has room
for one, a short phrase in the ash (`· Vulnerabilities … 1 moderate`). Under them the
stamp and one link, *Full report*, to the section in the body. Four rules hold it:

- **Seven rows, always seven.** A check with no report row behind it keeps its name and
  takes the `–`, because *which scans has this had* has an answer on a listing cut in
  August and the answer is none of them. Its name drops to Ash and no further — see
  The AA Floor Rule.
- **The mark is decorative.** `aria-hidden`, with the check's full phrase beside it in
  `.sr-only`, so the verdict is a word for a screen reader and for `curl` exactly as it is
  in the report. A short phrase appears where the column has room for one and is hidden
  from assistive technology, being an abbreviation of the sentence already given.
- **The page's one scan stamp lives here.** Set as a log — the date at the left margin on
  a 10ch column and the event beside it, one line each, newest first (`2026-09-14
  advisories refreshed` / `2026-09-01 scanned · scanner 2026.09.1`), on the founder's
  direction that it "start with the date so it looks more unified, like a log". The Trust
  section in the body no longer repeats it (2026-09-14: "we only need to show this once");
  the scanner version rides on the *scanned* line, the event it describes.
- **It is a section beside the box, not a row inside it.** Same grammar as What you get
  above and Languages below. The buy box is one of the two rectangles in this system and
  nothing nests inside it.

*Amended 2026-09-14, on the founder's direction.* The headings read **Security scan** in
the column and **Security scan report** in the body — *Trust* is the reader's conclusion
and this is our work; naming a section after the conclusion is the same claim a shield
icon makes. A shield was proposed with the rename and declined: the marks are the only
symbols in the section, and the word is the verdict. Class names and the `#trust` anchor
are unchanged — they are addresses, not copy.

The section in the body kept everything else and moved **after the README**, with the
release log: it is reference now, not the last computed thing before the pitch, and its
heading reads *Trust report* so the page has one **Trust** and one thing it links to. It
stays a `<section>` rather than becoming a `<details>` — `:target` can style a disclosure
but cannot open one, so a reader following the link with script off would land on a closed
fold.

*Amended the same day, on the founder's second reading — "on the right side we can just
keep the simplified view; we don't need to know what scanned it … in the report, in the
details, exactly what scanner scanned this".* **The vendor moved out of the column and
into the report.** Two changes and no third:

- The column's rows are a mark, a name and the short phrase. A tick and a name is what a
  price needs beside it; who ran the check is the next question, and the next question
  belongs on the next page down.
- The report's check rows gained a third column, 8rem at the right margin in the Label
  size: **the source that produced the row** — `X402 Git`, `OSV`, `Socket` — so the
  vendors read down as a column of their own beside the phrases. Below `40rem` it stacks
  with the rest of the row and aligns left, because a right margin it was hung from no
  longer exists.

*Amended the same day again, on the founder's third reading — "can the trust report have
a Read more just like the README does? When a user clicks Show report on the right panel,
can this also expand the trust report on the main page as well?"* **The report is clipped
the way the README is**, with the same attribute, the same control and the same inline
script (`app/_components/readme-more.tsx`) — one clip in this product, not two that drift.
Its preview height is **`min(11rem, 40vh)`, the one deliberate exception to the README's
own `min(26rem, 55vh)`** (14 Sep 2026, founder: the report "shows quite a lot"). 176px is
measured, not picked: the check rows on the longest report we hold close at 39, 78, 117 and
178px, so the clip ends two pixels short of the fourth row's rule rather than through the
middle of a line, and the fade dissolves the fourth row into the paper — three rows crisp,
the fourth fading, everything else folded. The verdict sentence and the stamp sit outside
the clipped block, because the section's answer is never the thing you have to open the
section to read.

Two more things the report does that the README does not:

- **The vendors are links on first mention**, in the verdict sentence only —
  `OSV` to osv.dev, `Socket` to socket.dev, in a new window with "(opens in a new tab)" in
  the accessible name, the same convention the home page's *View* follows. X402 Git is
  never a link: it is us, and a link from our page to our page sends a reader in a circle.
  The source column on the rows stays plain text; the same two names as links seven times
  would read as navigation rather than as a column of facts.
- **"What this can do" puts one item per line** (founder, the same day: "so it's cleaner
  on the eye"). Nine hostnames joined by ` · ` is a paragraph a reader has to read all of
  to find one domain. It is a real `<ul class="capability-values">` with no marker and no
  indent — the `dt` beside it is the only marker the row needs — and a line whose value is
  single (`At install — nothing runs`) stays one value rather than becoming a list of one.

The column's link is **Show report** and it does both jobs: `data-readme-open` names the
clipped block, the delegated listener opens it, and the anchor then lands on `#trust` as
it always did. Three rules on that link, and they are the ones that keep the fold honest:
it only ever **opens** (a reader who has just asked to see something does not want the
second press to have hidden it), it does **nothing** when the report already fits, since
the script has by then taken the clip and the control off it, and **with scripting off it
is a plain anchor** to a report that was never clipped in the first place.

And the report opens with **its own verdict in one sentence**, in the text face above the
stamp: *"Scanned by X402 Git, OSV and Socket — passed on all three. Findings from all
three are listed below."* The founder asked for "that level of confidence, like
pass/pass"; the second sentence is what keeps the first from being the shield §1 of "PRD
Trust Report.md" was written against, and it is why the line is computed from the rows
rather than written. It never says *safe* and it never says *clean*.

Under the box, outside it, a `<dl>` of details on a 7rem key column: size, files,
languages. It is not boxed: the box holds the offer, the list holds the specification,
and putting a rule around both would be a box inside a box.

*Amended 2026-08-30.* The list used to carry licence, last release and creator as well.
Licence and last release are in the header meta row — sixty pixels away on a desktop and
above the price on a phone — and a fact printed twice in one viewport reads as two facts.
Creator became its own block, below.

### Creator

*Added 2026-08-30 on the founder's direction to "pull in more stats around the
author/creator". Rewritten the same day on the direction to take Gumroad's product page
as the shape. Amended again the same day: the product page renders the **compact**
variant — a "CREATOR" kicker in the label face, the avatar and the name, as one link to
the author page — and the full block below lives on the author page alone. The h1 lost
its `owner /` breadcrumb at the same time: the repository's name alone is the title, and
the creator line under it carries the person.*

**One creator block per page, and it is at the top**, directly under the headline on the
product page and under the handle on the author page. It replaced the sidebar version
rather than joining it: two creator blocks on one screen print the same avatar, the same
name and the same handle twice, and no amount of splitting the fields between them fixes
that — an avatar in two places is one fact in two places. On a page where a stranger is
deciding to send $9 to another stranger, the identity belongs beside the headline, not in
a footnote next to the order block.

What it carries, in this order:

- the avatar at 32px in a hairline rectangle, the name in the text face over `@login` in
  the mono face, as one link to GitHub;
- the bio, one line, in Body Small;
- **one fact line**, mono and Ash: `3 repos on X402 Git · 42 public repos · ★ 1,204 ·
  1,240 followers · on GitHub since 2019 · Company · City`;
- the website and the X handle, as links.

The counts are three different kinds of claim and only one of them is ours:

- **`N repos on X402 Git`** is the platform's, and is the only link in the line. It goes
  to the author page, which is the reason that page exists. It is absent when the number
  is one, because "1 repo on X402 Git" on the page of that one repo is a link back to
  itself with a step added, and it is plain text on the author page itself.
- **`N public repos`** is GitHub's own `public_repos`, which is authoritative and
  uncapped, so it wins over the number this platform counted while summing stars.
- **`★ N`** is the sum of `stargazers_count` across up to 300 of the creator's public
  repositories. Past that ceiling the total is a floor and says so with a `+`. **The star
  is drawn, from the icon set, never the `★` character** — a glyph is somebody else's
  drawing at somebody else's weight, and a screen reader announces it as "black star". The
  word "stars" is in the markup beside it, visually hidden.
- Nothing else. No followers-to-stars ratio, no "top 1%", no derived score. A star total
  is somebody else's measurement of somebody else's work, so it never sets in the accent
  and never becomes a badge.

**It is not a bordered card**, though it is called one. The buy box is one of exactly two
rectangles in this system and a second one under a headline would be the component library
this world exists to refuse; the avatar's own hairline is the only rule in the block.

A zero is never printed: a creator with no stars has no star line. With no GitHub person
at all — a Rail B listing, an uninstalled App, a failed call — the block is the platform
handle and the platform count, and it invents nothing.

### Author page

*Added 2026-08-30.* `/[owner]`: the handle at Display size, the Creator block, the total
install count, a hairline, and the shelf — every live listing as a card, most recently
shipped first.

**It is a shelf, not a profile, and the difference is the whole design.** There is no
follow button, no sort, no filter, no search and no "see all", because there is nothing
to see beyond what is on the page. The moment it acquires one of those it has become a
catalogue and this product has grown a second side of the market it does not have.

Three rules:

- **Live listings only, with no exception for the owner.** A draft is invisible to
  everybody but its owner on `/[owner]/[slug]`, and showing the owner their own drafts
  *here* would be a second dashboard wearing a public page's clothes — the sort of surface
  where somebody screenshots their drafts believing they are published. The dashboard is
  the page with the drafts on it.
- **An empty shelf is a real page**, not a 404: "Nothing published yet." A creator may
  already have sent the link. It is `noindex` while it is empty.
- **A reserved handle and an unknown handle are both 404.** `docs`, `dashboard`,
  `purchases`, `how-it-works`, `signin` and `api` are pages; the loader refuses those
  words a second time so a route added tomorrow cannot be shadowed by a row written
  yesterday.

### The cover

*Added 2026-08-30, from the reference.* The README's opening image, promoted to the top of
the product page — above the headline, which is where the reference puts it and where a
person looks first. Full column width, `max-height: 22rem` on a desktop and `9rem` on a
phone, inside a hairline on sunk paper so a transparent PNG has an edge.

Four rules keep it honest:

- **Only an image the creator put first.** The match is anchored: an optional opening
  heading, then a paragraph whose entire content is one image. A screenshot four
  paragraphs down stays four paragraphs down, in the sentence it illustrates.
- **It is removed from the README below**, so it is on the page once.
- **Never cropped.** A cover this page invented a crop for would be this page editing
  somebody's README, and the pictures creators write have words in them.
- **No image, no placeholder.** An empty grey rectangle where a cover would have been is
  worse than the page without one.

The dashboard tells a creator the recipe: about 1200×630, under 500 kB, first line of the
README.

### The pinned price bar

*Added 2026-08-30, from the reference.* On a phone, once the buy box has scrolled off the
screen: a fixed bar on the bottom edge carrying the price, the updates line in Ash, and
one accent-grounded control. It sits above the home indicator via
`env(safe-area-inset-bottom)`, and the footer reserves its height so the last line of the
document is never underneath it.

- **It is a link to the box (`#buy`), not a second buy button.** The real control holds
  wallet state, chain state and a `role="status"` region; a second instance would be two
  components disagreeing about which wallet is connected. An anchor works with scripting
  off and keeps the middle click.
- **It never shares a screen with the box**, which is what keeps **The One Order Line
  Rule** true per *viewport* and not only per page.
- **Phones only.** Above `60rem` the box is sticky in the right column and never leaves.
- **Behaviour, so it may need script**, and it is absent without it. Nothing in it is
  content: the price, the update price and the action are all in the server HTML already,
  inside the box.

### Icons

*Added 2026-08-30.* One set, ten marks, in `app/_components/icons.tsx`: folder, file, doc,
code, terminal, check, config, image, spark, star.

- **One grid, one weight.** Every icon is drawn inside `0 0 16 16` on half-pixel
  coordinates, `stroke-width: 1.25`, no fills. It is the same hairline the rules on this
  site are drawn with, at the same weight, which is the whole reason they sit together.
- **Square caps, mitred joins.** `--radius` is `0`; a rounded cap would be the one soft
  edge on a page of printed rules.
- **`currentColor`, always.** No icon carries a colour and no icon touches The Closed Ink
  Set Rule.
- **Never the only carrier of meaning.** Every icon sits beside the word it illustrates
  and is `aria-hidden`. There is no icon-only control anywhere in the product.
- **No emoji and no Unicode glyph standing in for a mark**, including `★`.

The marks are keyed on the analyser's own component buckets, so a reader who learns that a
four-point star means "a thing that acts" has learned it once and it holds for a skill, an
agent, a command and a hook alike. An unknown bucket falls back to the sheet.

### About

*Removed 2026-08-30, on the founder's direction — the repository speaks for itself and
the README is the whole pitch; a block that interleaves GitHub metadata with the
creator's typed-in prose invents context the repo does not carry. The body now leads
with "What's inside" (computed, the buyer's fastest check that the thing is real) and
then the README. The trigger hint still reaches agents via `?view=agent`; the
provenance sentence is gone from the human page (2026-08-30). The section below is kept for
the record of what it was.*

*Added 2026-08-30, same direction.* The first block in the body, under the meta row and
above the README: the repository's own GitHub description when it is not the creator's
blurb again, the trigger hint, the project's official website as a plain link with no
favicon, its topics as pills, and one mono fact line — `last pushed <relative> · created
YYYY · <language> · <counts> · <github link or "private repository">`.

- **Topics are pills, and pills are hairline rectangles.** `--rule` at 1px, no ground, no
  colour, `--radius` of 0, set at the Label size in the mono face. A topic is a word the
  creator typed on GitHub, not a category this product recognises, and a filled chip
  would imply a taxonomy that does not exist.
- **A relative date, here and nowhere else.** "last pushed 3 days ago" answers *has
  anyone touched this*, which is a distance. Every computed date on the page — release,
  scan, computed-at — stays an exact ISO day, because a rounded date is not a fact a
  reader can check.
- **A private repository gets the words, not a link.** `html_url` is dropped when the
  repo is private and the line says `private repository` instead, because a link that
  404s for everyone but the owner is worse than a sentence.
- **None of it is a computed signal.** Nothing here feeds the artifact class, the scan,
  the licence gate or the price, so prose in this block is set in the text face and only
  the measured fact line is mono. Every field of it can be absent and the page is
  unchanged.

After a purchase the box becomes the receipt in the same rectangle: what you own, the
download as an anchor wearing the primary ground (an anchor, because it is a real
navigation to a signed URL and must keep the middle click), how long the link lasts, the
transaction hash as an explorer link, and where to find it again.

### Copy control

"Copy x402 link", as progressive enhancement rather than as a script feature. Both
halves are always in the server HTML: a `button[data-copy]`, hidden by default, and a
`code[data-copy-fallback]` carrying the URL in full, shown by default. An inline script
sets `<html data-js="on">` before the controls are parsed, and that attribute — nothing
else — swaps which one is visible. With scripting off the reader loses the button and
keeps the link, which was always the point. Confirmation is the button's own label
changing to "Copied" and back; there is no toast and no region that only exists after a
click.

### Disclosures

`<details>`, used for the four things on a product page that a reader wants available
rather than present: `What's inside`, and inside it `Full file list` and `Dependencies`,
plus `N earlier releases`. A `<summary>` is a 44px row in the Listing face with a
hairline under it and a `+` / `−` drawn as generated content with an empty alt, so the
affordance is one shape in every browser and is never announced. `list-style: none`, the
WebKit marker hidden, native keyboard behaviour untouched.

The summary carries the answer, not just the label: "What's inside — 7 files · 20.1 kB ·
no dependencies". A disclosure whose closed state teaches nothing is a place to hide
things.

The buy *disclosure* — a `<details>` wearing the primary button, which opened the `curl`
instructions because there was no browser wallet — is gone as of 2026-08-30. There is a
browser wallet now (`app/_components/buy-with-wallet.tsx`, `lib/web/wallet-checkout.ts`),
so the control is a real button that takes real money, and the terminal path is on
`/docs` where it belongs.

The release log joined the set the same day: `Releases`, whose summary carries the newest
version and its date, so a reader who never opens it still knows when this last shipped.
Two disclosures in a row are one region, not two — they take `--space-5` from each other
rather than the section's `--space-7`, because 48px between two 44px rows reads as a gap
where a reader expects a stack.

### The README preview

**The README is not a disclosure.** It was one for about an hour on 2026-08-30 and the
founder was right to reject it: the opening paragraphs of a README are the best writing
on the page, because the creator wrote them for a reader rather than for a buyer, and a
reader who has to click to see what they are buying has been sold a sealed box — which
is the exact thing this product exists to refuse.

So the README is a section with a heading, rendered, clipped at `min(26rem, 55vh)`, its
bottom edge dissolving into the paper (see The Flat Sheet Rule), over one secondary
button that says `Show more`. Three rules hold it:

- **The whole document is always in the server HTML**, unclipped and unhidden.
  `npm run check:ssr` proves it and an agent's `curl` gets the complete README. The clip
  and the control are behaviour, and behaviour is the only thing on this page allowed to
  need script.
- **With scripting off there is no clip and no control.** Both are gated on
  `<html data-js="on">`, which the inline script sets — the same mechanism the copy
  control has always used. The fallback is the README, long, which is what it was before.
- **A control that has nothing to open does not render.** The same script measures the
  block and removes both the clip and the button when the README already fits. A
  "Show more" on a six-line README is a lie about how much is left.

### What's inside

*Rebuilt 2026-08-30, on the founder's direction that this section is the product's case
and should read like it.* It is the answer to *what am I actually buying*, so it is the
one disclosure on the page that is **open by default** — a disclosure is for things a
reader wants available rather than present, and this they want present.

In order, under the summary:

1. **The caption line** (amended 2026-08-30 — it used to be this line *and* a row of
   Headline-size numerals under it, and the file count appeared in both): one line at
   the Label size in the mono face, `2 folders · 6 files · 310 lines of code · 24.4 kB ·
   no dependencies`. Lines of code is omitted rather than printed as a nought when a
   manifest predates `lines_of_code` or a repository has no code in it at all — a prompt
   pack is a real thing to sell. **Exact, with separators, never `20k`:** every other
   number on this page is checkable against the manifest endpoint.
2. **The language bar**, unchanged.
3. **The folder rows.** A list, not a table, because the fourth column is a sentence and a
   sentence in a table cell wraps into a paragraph with rules through it. Each row keeps
   the table's 30px pitch, its hairline and its hover ground, and carries: the folder mark,
   the name in mono, the file count and byte total right-aligned in Ash, and under them a
   line saying **what is in it** in the analyser's own nouns — `8 scripts · 1 test file` —
   behind the mark of its dominant bucket. The nouns are FR-48's, so the closed summary,
   the folder line and the headline inventory can never disagree. Loose top-level files
   collect under `(root)` and always sort last.
4. **`Full file list`** and **`Dependencies`**, still one disclosure deeper, with the
   computed-at stamp travelling with them as FR-52 requires. Each path in the file list
   carries its bucket's mark.

### The README's own markup

*Added 2026-08-30 with FR-49's images, tables and task lists.* A README written for GitHub
has to read here the way it reads there, and until that day it did not: a table came out as
rows of raw pipes and an image came out as its own markup.

- **Images.** Absolute `https:` passes through; `http:` and `data:` are dropped. A relative
  path is resolved against the release snapshot, stored in a public bucket and served from
  `/api/label/:owner/:slug/asset/*`. Each image sits in a hairline on sunk paper, so a
  transparent PNG has an edge and a badge row does not float.
- **Tables** take the site's own table style — Label-size Ash header, hairline rows, mono,
  tabular numerals — because a README's table and a manifest's table are the same object
  and should not be two. Alignment travels as `data-align`, never as `style` or `class`.
- **Task lists** are a drawn box: a hairline square, filled in ink when done. Not an
  `<input type="checkbox">`, which the sanitiser drops whole and which is not worth
  weakening for a tick; and not a Unicode ballot glyph. The state is also a word in the
  markup, visually hidden, so a screen reader and `curl` both get it.
- **A refused *relative* link renders as its label**, and a refused *scheme* renders as its
  markdown source. A private repository's `[the guide](docs/guide.md)` has no address
  anybody can open, but the words are still the creator's sentence — printing the brackets
  and the path turns a sentence into a bug report. A `javascript:` href is somebody trying
  something, and the raw text is the disclosure.

### Language bar

A `--space-2` tall row of segments inside a hairline rectangle, largest share first,
over a legend that names each segment and its percentage. The segments take the ink ramp
— `--ink`, `--ink-muted`, `--rule-strong`, `--rule` — via `[data-rank]`, and the bar is
`aria-hidden`: the legend is the reading, the bar is the shape of it. No new colour
enters the system to draw it, which is the whole reason it is greys and not GitHub's key.

### Status

A verdict is a word and an ink, not a pill: `[data-status="pass"]` in Ledger Green,
`"fail"` in Fail Red, `"warn"` in Caution Ochre, `"pending"` in Ash, all set in the
Listing face. Colour never carries the meaning alone — the word is always present, so
the scan badge reads "pass" or "fail" to a screen reader and to `curl` identically.
Payment and wallet states go in a `role="status"` region so assistive technology is
told what happened.

### Links

Ink, always underlined, `rule-control` underline at 1px with `0.18em` offset. Hover
turns text and underline to Ledger Green; active goes Ledger Green Deep; focus turns
the underline to ink under the ring. Colour alone never marks a link, in either face.

### Browser surfaces

Themed, not left to the browser: `::selection` is paper on Ledger Green; `caret-color`
and `accent-color` are Ledger Green; `scrollbar-color` is `rule-strong` on paper with
`color-scheme: light`; `::marker` is Ash; `text-underline-offset` is set globally.

### Motion

`--transition: 100ms ease-out` is the entire motion budget, and it applies only to
background, border and text colour on interactive elements. There are no entrance
animations, no scroll-triggered reveals, no skeletons, and no spinners — the pages are
server-rendered and must be complete in the HTML. `prefers-reduced-motion: reduce`
collapses all durations to 1ms.

**The Snap Rule.** The hovered table row changes ground instantly, with no transition,
because a cursor line in a listing does not fade in. It is the one authored motion
moment in the system, and it is the absence of motion.

## Do's and Don'ts

### Do:

- **Do** set every platform-computed value in Azeret Mono and every human-written
  string in Public Sans, per The Computed / Written Rule. This is the product's
  disclosure promise rendered as type.
- **Do** style elements over classes, so a class-free semantic page already looks
  right. Every page's *content* must be in the server HTML; only behaviour may need
  script, and `/docs/**` must still work with script off entirely.
- **Do** reference tokens: `var(--ink)`, `var(--space-4)`, `var(--rule-width)`,
  `var(--radius)`. A raw hex, px, or radius in a component file is a defect.
- **Do** put the paid action once. On the product page it is the buy button in the box,
  labelled with the amount; on `?view=agent` it is still the order line at the end.
- **Do** right-align and `tabular-nums` anything a reader compares down a column.
- **Do** keep prose at 68ch (`--measure`) even when the container is 1216px wide.
- **Do** put 48px above a heading and 12px below it.
- **Do** state a scan verdict in words as well as ink, and put payment state in a
  `role="status"` region.
- **Do** label example listings as synthetic when they are invented. The home page's
  featured examples are real published listings under the `examples` handle, read from
  the same table as everybody else's, so they carry no label; a slug with no live
  listing renders nothing at all rather than a placeholder. No fabricated numbers,
  testimonials, or benchmarks may appear in any surface.

### Don't:

- **Don't** introduce a tint, a ramp, or an alpha wash, or a colour of our own beyond
  the eleven. `--github` is a citation, not a twelfth ink, and it grounds one control.
- **Don't** ground more than one action per page. Ledger Green belongs to the paid
  action; the home page has nothing to buy and grounds Connect my repo in `--github`
  instead, so it carries no green ground at all.
- **Don't** use Fail Red or Caution Ochre for anything but a verdict, an invalid field,
  or a payment failure.
- **Don't** add a `box-shadow`, gradient, blur, glass, or overlay. The focus ring is
  the only shadow property in the system and it is a ring, not depth, and the README
  preview's fade is the one gradient — used as a `mask-image`, so its colour is never
  painted. Both are named exceptions; a third is a defect.
- **Don't** round a corner. `--radius` is `0` and there is no second radius token.
- **Don't** vary rule weight. Every border is 1px; only its grey changes.
- **Don't** wrap content sections in bordered boxes, and never nest a box in a box.
  There are exactly two bordered rectangles in the product — the home page's row of three
  example cards and the product page's buy box — and nothing inside either of them is
  boxed again. The Creator block under the buy box is called a card and is deliberately
  not one: a rule above it and a section's air do the work a border would have done.
  Topic pills are hairline rectangles around a word, not containers, and they are the
  only place a 1px rectangle wraps content outside those two.
- **Don't** add a third reading of a listing, and don't link the agent reading back into
  the website's navigation. Two URLs, both complete in the HTML, one of them unlinked.
- **Don't** place a kicker, eyebrow, or section number above a heading.
- **Don't** use Inter, in any role, including as a fallback in a font stack.
- **Don't** ship text lighter than Ash (`#6B6B6B`); render a ghosted diff state by
  dropping to Ash and removing weight, not by fading past AA.
- **Don't** add entrance animation, scroll reveals, spinners, or skeleton states.
- **Don't** put the price or the buy action above the manifest on the agent reading. On
  the product page the box may lead the body, but never the page: the version, the date,
  the licence, the scan verdict and the artifact class come first in the document, on
  every viewport. Never bill blind.
- **Don't** print the same fact twice in one viewport. Licence and last release left the
  buy box's specification list because both are in the header meta row a few pixels away;
  GitHub's repository description is dropped when it is the creator's blurb typed again.
- **Don't** hide the README behind a click. Preview it, clip it, and put the whole
  document in the server HTML. The price goes above it; it does not go away.
- **Don't** print a zero as a statistic. A private repository has zero stars because
  nobody can see it. A count that is zero renders nothing.
- **Don't** print a hash, an analyzer version, a scanner version or a computed-at stamp
  in the product page's default flow. Every one of them still exists and still travels
  with the block it stamps (FR-52) — inside a disclosure, or on `?view=agent`.
  *Amended 2026-09-13:* the Trust section's own stamp — "Scanned 13 Sep 2026 · scanner
  2026.09.1 · advisories refreshed 12 Sep 2026" — is the exception, and it is not one of
  these. Everywhere else the version stamps a fact the reader came for and is noise beside
  it; here the section's subject *is* what checked this and when, and a verdict with no
  ruleset and no date behind it is the badge "PRD Trust Report.md" §1 was written against.
  One line, under the heading, before the rows. *Amended again 2026-09-14:* the stamp is
  printed once, not twice — in the buy column's log, with the version on the *scanned*
  line — and the Trust section in the body carries no stamp of its own.
- **Don't** ship a control that only works after hydration without a pre-hydration frame
  that says so. A dead button is worse than a sentence.
- **Don't** add zebra striping to a table that already has row rules.
- **Don't** build a search box, a category browse or a rating. This is not a marketplace
  and no surface may imply a second side of the market. The home page's three named
  examples are a demonstration of what a listing page looks like — the moment they acquire
  a filter, a sort or a "see all", they have become a catalogue, and the card row that
  carries them stops being earned. *Amended 2026-08-30, on the founder's direction:* the
  **author page** is the one exception and it is deliberately not a profile — no follow,
  no bio the creator writes here, no score, no aggregate rating; it is one creator's live
  listings on the same cards, plus the GitHub context the product page already shows. The
  moment it grows a filter or a sort, this line applies to it too.
- **Don't** print a Unicode glyph or an emoji where a mark belongs, `★` included. The icon
  set is ten drawn marks on one 16px grid at one weight, and every one of them has its word
  beside it.
- **Don't** ground two actions in a viewport. The pinned price bar exists only while the
  buy box is off screen, which is what lets it wear the accent at all.
