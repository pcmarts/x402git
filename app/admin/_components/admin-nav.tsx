"use client";

/**
 * The admin sub-nav, with the current section marked.
 *
 * A client component only for `usePathname`, which also renders on the server, so the
 * `aria-current` is in the HTML before hydration. Two groups, because they are two
 * kinds of visit: *looking* (Overview through Activity) and *acting or answering for an
 * act* (Ops, Audit, Admins). "Your dashboard" is gone from this row — the site header
 * above already carries Dashboard, and two links to one place is one too many.
 *
 * On a phone the row scrolls sideways rather than wrapping to three lines (globals.css).
 */

import { usePathname } from "next/navigation";

const ITEMS: { href: string; label: string; groupStart?: boolean; also?: string }[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/listings", label: "Listings" },
  // A creator's own page still lives under /admin/creators/:handle.
  { href: "/admin/users", label: "Users", also: "/admin/creators" },
  { href: "/admin/money", label: "Money" },
  { href: "/admin/activity", label: "Activity" },
  { href: "/admin/ops", label: "Ops", groupStart: true },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/people", label: "Admins" },
];

/** Exact for the overview, prefix for the rest, so a listing's page lights Listings. */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNav({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Admin" className="subnav" data-admin="">
      {ITEMS.map((item) => (
        <a
          key={item.href}
          href={item.href}
          aria-current={isCurrent(pathname, item.href) || (item.also && isCurrent(pathname, item.also)) ? "page" : undefined}
          data-group-start={item.groupStart ? "" : undefined}
        >
          {item.label}
        </a>
      ))}
      {children}
    </nav>
  );
}
