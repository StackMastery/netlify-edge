// netlify/edge-functions/freepik-proxy.ts
const UPSTREAM = "https://www.freepik.com";

/**
 * NOTE:
 * - Strips/rewrites headers that commonly break proxies (Host, Accept-Encoding, CSP).
 * - Rewrites Location headers to keep users on /fp/*.
 * - Tries to make Set-Cookie work by stripping Domain attr, but session features may still fail.
 */
export default async (req: Request) => {
  // Build upstream URL by removing the /fp prefix
  const url = new URL(req.url);
  const upstreamPath = url.pathname.replace(/^\/fp/, "") + url.search;
  const target = new URL(upstreamPath || "/", UPSTREAM);

  // Clone incoming headers, remove problematic ones
  const incoming = new Headers(req.headers);
  incoming.delete("host");
  incoming.delete("accept-encoding"); // let Netlify handle compression
  // Optional: spoof a UA if needed
  if (!incoming.get("user-agent")) {
    incoming.set("user-agent", "Mozilla/5.0");
  }

  // Forward the request
  const upstreamResp = await fetch(target.toString(), {
    method: req.method,
    headers: incoming,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    redirect: "manual", // we’ll rewrite Location manually
  });

  // Copy/adjust response headers
  const outHeaders = new Headers(upstreamResp.headers);

  // 1) Rewrite redirects pointing back to freepik → our /fp/*
  const loc = outHeaders.get("location");
  if (loc) {
    try {
      const locURL = new URL(loc, UPSTREAM);
      if (locURL.origin === new URL(UPSTREAM).origin) {
        // Keep users on our proxy prefix
        outHeaders.set(
          "location",
          "/fp" + locURL.pathname + (locURL.search || "")
        );
      }
    } catch {
      // ignore invalid Location values
    }
  }

  // 2) Relax CSP / X-Frame to reduce breakage (use with caution)
  outHeaders.delete("content-security-policy");
  outHeaders.delete("x-frame-options");

  // 3) Cookies: strip Domain so browser accepts cookies on your domain
  const setCookie = upstreamResp.headers.get("set-cookie");
  if (setCookie) {
    // Multiple Set-Cookie may come as a combined string; split conservatively
    const parts = setCookie.split(/,(?=[^;]+?=)/g).map((c) => {
      // remove Domain=*.freepik.com and SameSite=strict defaults that may block
      return c
        .replace(/;\s*domain=[^;]+/gi, "")
        .replace(/;\s*samesite=lax/gi, "; SameSite=None; Secure");
    });
    outHeaders.delete("set-cookie");
    parts.forEach((p) => outHeaders.append("set-cookie", p));
  }

  // 4) HTML rewrite (very basic): fix absolute links back to our /fp/*
  const ct = upstreamResp.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    const text = await upstreamResp.text();
    const replaced = text
      // absolute links to freepik → /fp/*
      .replaceAll(/https?:\/\/(www\.)?freepik\.com/gi, "")
      // root-relative links: href="/xxx" → href="/fp/xxx"
      .replaceAll(/(href|src)=["']\/(?!fp\/)/gi, `$1="/fp/`);
    outHeaders.set(
      "content-length",
      String(new TextEncoder().encode(replaced).length)
    );
    return new Response(replaced, {
      status: upstreamResp.status,
      headers: outHeaders,
    });
  }

  // For non-HTML, stream through
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: outHeaders,
  });
};

// Match /fp/* routes
export const config = { pattern: "^/fp(/.*)?$" };
