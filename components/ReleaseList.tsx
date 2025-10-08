"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import ChannelSwitcher from "./ChannelSwitcher";

type Release = {
  version: string;
  date: string; // ISO
  title: string;
  required?: boolean;
  notesUrl: string;
  model?: string;
  channel?: string;
};

type ReleasesIndex = {
  product: string;
  model?: string;
  channel?: string;
  releases: Release[];
};

export default function ReleaseList({
  product,
  model,
}: {
  product: "desktop" | "instrument" | "recovery";
  model?: string;
}) {
  const searchParams = useSearchParams();
  const channel = searchParams?.get("channel") || "production";
  const [index, setIndex] = useState<ReleasesIndex | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_UPDATE_BASE_URL || "";
    const params = new URLSearchParams({ product });
    if (model) params.set("model", model);
    if (channel) params.set("channel", channel);
    const url = `${base}/api/releases?${params.toString()}`;

    console.log("ReleaseList fetching:", { product, model, channel, url });

    // Clear cached notes when product/model/channel changes
    setNotes({});
    setIndex(null);

    fetch(url)
      .then(async (r) => {
        const data = await r.json();
        console.log("ReleaseList received:", data);
        setIndex(data);
      })
      .catch(() =>
        setIndex({ product, model, channel, releases: [] } as ReleasesIndex)
      );
  }, [product, model, channel]);

  const releases = useMemo(() => {
    const list = index?.releases ?? [];
    return list.slice().sort((a, b) => b.date.localeCompare(a.date));
  }, [index]);

  // Pagination (5 per page via ?page=)
  const router = useRouter();
  const pathname = usePathname();
  const pageParam = parseInt(searchParams?.get("page") ?? "1", 10);
  const currentPage =
    Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(releases.length / pageSize));
  const page = Math.min(currentPage, totalPages);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const pagedReleases = releases.slice(start, end);

  // Prefetch notes for visible items (current page)
  useEffect(() => {
    pagedReleases.forEach((r) => {
      if (!notes[r.version]) {
        fetch(r.notesUrl)
          .then(async (res) => res.json())
          .then((j) => {
            const content = j?.content as string | undefined;
            const url = j?.url as string | undefined;
            if (content) {
              setNotes((m) => ({ ...m, [r.version]: content }));
            } else if (url) {
              return fetch(url)
                .then((res2) => res2.text())
                .then((txt) => setNotes((m) => ({ ...m, [r.version]: txt })))
                .catch(() => {});
            }
          })
          .catch(() => {});
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, releases]);

  // Simple CSS alignment only (strip disabled)

  const isLoading = !index;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <ChannelSwitcher />
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground text-center py-8">
          Loading releases...
        </div>
      )}

      {!isLoading && releases.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-8">
          No releases found for this {model ? "model" : "product"} and channel.
        </div>
      )}

      {/* Releases wrapper with background-drawn rail (no absolute) */}
      {!isLoading && releases.length > 0 && (
        <div className="relative flex flex-col gap-10 md:bg-[linear-gradient(theme(colors.border),theme(colors.border))] md:bg-no-repeat md:bg-[length:1px_100%] md:bg-[position:25%_13px]">
          {pagedReleases.map((r) => {
            const date = new Date(r.date);
            const id = `v-${r.version}`;
            return (
              <div
                key={r.version}
                id={id}
                className="grid grid-cols-12 gap-6 relative scroll-mt-28"
              >
                {/* Left column: date + version */}
                <div className="col-span-3 md:col-span-3 flex flex-col items-start text-sm text-muted-foreground md:sticky md:top-20 md:self-start md:min-h-0">
                  <span>
                    {date.toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                  </span>
                  <span className="mt-2 inline-flex items-center gap-2">
                    <span className="px-2 py-1 rounded-md border bg-card text-card-foreground shadow-sm text-xs font-medium">
                      v{r.version}
                    </span>
                    {r.required ? (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400">
                        required
                      </span>
                    ) : null}
                  </span>
                </div>

                {/* Timeline dot for this release aligned to the rail */}
                <div className="col-span-1 hidden md:block" aria-hidden />
                <div className="hidden md:block absolute left-[25%] -translate-x-1/2 top-[13px] h-2 w-2 rounded-full bg-primary" />

                {/* Content */}
                <div className="col-span-12 md:col-span-8">
                  <div className="flex items-start justify-between gap-4">
                    <div className="relative group">
                      <a
                        className="absolute -left-6 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-foreground transition"
                        href={`#${id}`}
                        aria-label="Anchor link"
                      >
                        <svg
                          className="h-4 w-4"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M10 13a5 5 0 0 1 0-7l1.5-1.5a5 5 0 1 1 7 7L17 12" />
                          <path d="M14 11a5 5 0 0 1 0 7L12.5 20.5a5 5 0 1 1-7-7L7 12" />
                        </svg>
                      </a>
                    </div>
                  </div>
                  <div className=" prose dark:prose-invert max-w-[110ch] break-words prose-pre:overflow-visible prose-pre:whitespace-pre-wrap prose-img:max-w-full">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeRaw]}
                    >
                      {notes[r.version] || "Loading release notes..."}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination controls */}
      {!isLoading && totalPages > 1 && (
        <div className="mt-10 grid grid-cols-12 gap-6 items-center">
          {/* Left spacer to avoid crossing the rail (matches date+dot columns) */}
          <div className="col-span-3 md:col-span-3" />
          <div className="col-span-1 hidden md:block" aria-hidden />
          {/* Right content where divider lives */}
          <div className="col-span-12 md:col-span-8">
            <div className="pt-6 relative border-t border-border">
              <div className="text-base text-foreground text-center">
                Page {page} of {totalPages}
              </div>
              {page > 1 && (
                <button
                  onClick={() => {
                    const qp = new URLSearchParams(
                      searchParams?.toString() ?? ""
                    );
                    qp.set("page", String(page - 1));
                    router.push(`${pathname}?${qp.toString()}`);
                  }}
                  className="absolute left-0 top-1/2 -translate-y-1/2 mt-2 px-4 py-2 rounded-xl border border-border bg-background text-foreground hover:bg-accent/10"
                  aria-label="Previous page"
                >
                  Prev
                </button>
              )}
              {page < totalPages && (
                <button
                  onClick={() => {
                    const qp = new URLSearchParams(
                      searchParams?.toString() ?? ""
                    );
                    qp.set("page", String(page + 1));
                    router.push(`${pathname}?${qp.toString()}`);
                  }}
                  className="absolute right-0 top-1/2 -translate-y-1/2 mt-2 px-5 py-2 rounded-xl border border-border bg-background text-foreground hover:bg-accent/10"
                  aria-label="Next page"
                >
                  Next
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
