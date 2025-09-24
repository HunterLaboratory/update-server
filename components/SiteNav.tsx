"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/desktop", label: "Desktop" },
  { href: "/instrument", label: "Instrument" },
  { href: "/recovery", label: "Recovery" },
];

export default function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-4">
      {items.map((i) => {
        const active = pathname === i.href;
        return (
          <Link
            key={i.href}
            href={i.href}
            className={
              "text-sm transition-colors " +
              (active
                ? "text-foreground"
                : "text-foreground/70 hover:text-foreground")
            }
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
