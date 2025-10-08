export async function GET(req: Request) {
  const reqUrl = new URL(req.url);
  const product = reqUrl.searchParams.get("product");
  if (!product) {
    return new Response(
      JSON.stringify({ error: "Missing required query param: product" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const upstreamBase =
    process.env.UPDATE_BASE_URL ||
    process.env.NEXT_PUBLIC_UPDATE_BASE_URL ||
    "https://hl-essentials-update-24423.azurewebsites.net"; // fallback for local dev

  // Forward all query parameters to upstream
  const upstreamParams = new URLSearchParams();
  reqUrl.searchParams.forEach((value, key) => {
    upstreamParams.set(key, value);
  });
  const upstreamUrl = `${upstreamBase}/api/releases?${upstreamParams.toString()}`;

  const upstream = await fetch(upstreamUrl, {
    headers: { accept: "application/json" },
    // Cache at the edge for 60s; adjust as needed
    next: { revalidate: 60 },
  });

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") || "application/json",
      "cache-control": "public, s-maxage=60",
    },
  });
}
