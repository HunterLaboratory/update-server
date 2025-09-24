import ReleaseList from "@/components/ReleaseList";
import { Suspense } from "react";

export default function Page() {
  return (
    <main className="mx-auto p-6 pt-8 max-w-[82rem]">
      <h1 className="text-3xl md:text-4xl font-bold mb-8">
        Recovery Changelog
      </h1>
      <Suspense
        fallback={<div className="text-sm text-muted-foreground">Loading…</div>}
      >
        <ReleaseList product="recovery" />
      </Suspense>
    </main>
  );
}
