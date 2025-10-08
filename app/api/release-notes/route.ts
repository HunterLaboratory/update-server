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
    "https://hl-essentials-update-24423.azurewebsites.net";

  // Forward all query parameters to upstream
  const upstreamParams = new URLSearchParams();
  reqUrl.searchParams.forEach((value, key) => {
    upstreamParams.set(key, value);
  });
  const upstreamUrl = `${upstreamBase}/api/release-notes?${upstreamParams.toString()}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Upstream fetch failed" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  // Prefer returning inline content to avoid client-side SAS/CORS issues
  let json: any = null;
  try {
    json = await upstream.json();
  } catch {
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") || "application/json",
      },
    });
  }

  if (!json?.content && json?.url) {
    try {
      const blobRes = await fetch(json.url, {
        headers: { accept: "text/plain" },
      });
      if (blobRes.ok) {
        json.content = await blobRes.text();
      }
    } catch {}
  }

  return new Response(JSON.stringify(json), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
