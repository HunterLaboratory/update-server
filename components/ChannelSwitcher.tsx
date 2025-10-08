"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";

export default function ChannelSwitcher() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const currentChannel = searchParams?.get("channel") || "production";

  const handleChannelChange = (channel: string) => {
    const qp = new URLSearchParams(searchParams?.toString() ?? "");
    if (channel === "production") {
      qp.delete("channel");
    } else {
      qp.set("channel", channel);
    }
    const newUrl = qp.toString() ? `${pathname}?${qp.toString()}` : pathname;
    router.push(newUrl);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Channel:</span>
      <div className="inline-flex rounded-lg border border-border/60 bg-background/50 p-0.5">
        <button
          onClick={() => handleChannelChange("production")}
          className={`px-3 py-1 text-xs rounded-md transition-colors ${
            currentChannel === "production"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Production
        </button>
        <button
          onClick={() => handleChannelChange("preview")}
          className={`px-3 py-1 text-xs rounded-md transition-colors ${
            currentChannel === "preview"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Preview
        </button>
      </div>
    </div>
  );
}

