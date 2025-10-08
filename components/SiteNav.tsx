"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import { cn } from "@/lib/utils";

const instrumentModels = [
  { href: "/instrument/agera", label: "Agera" },
  { href: "/instrument/colorflex", label: "ColorFlex" },
  { href: "/instrument/vista", label: "Vista" },
];

export default function SiteNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isInstrumentPage = pathname?.startsWith("/instrument");

  // Preserve channel query param when navigating
  const buildHref = (href: string) => {
    const channel = searchParams?.get("channel");
    if (channel && channel !== "production") {
      return `${href}?channel=${channel}`;
    }
    return href;
  };

  return (
    <nav className="flex items-center gap-1">
      <Link
        href={buildHref("/desktop")}
        className={cn(
          "text-sm transition-colors px-4 py-2 rounded-md",
          pathname === "/desktop"
            ? "text-foreground"
            : "text-foreground/70 hover:text-foreground hover:bg-accent/50"
        )}
      >
        Desktop
      </Link>

      <NavigationMenu viewport={false}>
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuTrigger
              className={cn(
                "text-sm h-auto py-2",
                isInstrumentPage
                  ? "text-foreground"
                  : "text-foreground/70 hover:text-foreground"
              )}
            >
              Instrument
            </NavigationMenuTrigger>
            <NavigationMenuContent>
              <div className="w-48">
                {instrumentModels.map((model) => (
                  <NavigationMenuLink
                    key={model.href}
                    asChild
                    className={cn(
                      pathname === model.href &&
                        "bg-accent text-accent-foreground"
                    )}
                  >
                    <Link href={buildHref(model.href)}>
                      <div className="font-medium">{model.label}</div>
                    </Link>
                  </NavigationMenuLink>
                ))}
              </div>
            </NavigationMenuContent>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>

      <Link
        href={buildHref("/recovery")}
        className={cn(
          "text-sm transition-colors px-4 py-2 rounded-md",
          pathname === "/recovery"
            ? "text-foreground"
            : "text-foreground/70 hover:text-foreground hover:bg-accent/50"
        )}
      >
        Recovery
      </Link>
    </nav>
  );
}
