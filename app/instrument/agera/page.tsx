"use client";

import ReleaseList from "@/components/ReleaseList";

export default function Page() {
  return (
    <main className="mx-auto p-6 pt-8 max-w-[82rem]">
      <h1 className="text-3xl md:text-4xl font-bold mb-8">Agera Changelog</h1>
      <ReleaseList product="instrument" model="agera" />
    </main>
  );
}
