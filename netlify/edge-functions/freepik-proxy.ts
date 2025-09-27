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
  incoming.set(
    "cookie",
    "GR_REFRESH=AMf-vBzym9CFnZ3lmL3uNkFhk95iGHwf6UeTuLJAwzTUxiNNg6yIaQTP536mVVqeF79P4Bv-DArPgGbg1SbEu6-oTVfISLUoLIISb-rOluDBKmNuFuAU9cKKI1Ca6rZAUmpkEVTPfkLjaTnP66jyrw9Yj_4KXBfWw-ZOnfiG9CeSqnsNfG4o24Id4vTv_PdgRcSi-dPKXKLz;GR_TOKEN=eyJhbGciOiJSUzI1NiIsImtpZCI6IjA1NTc3MjZmYWIxMjMxZmEyZGNjNTcyMWExMDgzZGE2ODBjNGE3M2YiLCJ0eXAiOiJKV1QifQ.eyJuYW1lIjoiamFoaWR1bCBJc2xhbSIsInBpY3R1cmUiOiJodHRwczovL2xoMy5nb29nbGV1c2VyY29udGVudC5jb20vYS9BRWRGVHA1Q2U3MG0zcnJmLWI2QkdrYWVLN1QwMjR0TERTeEx6RjdvRWVtMj1zOTYtYyIsImFjY291bnRzX3VzZXJfaWQiOjg4NzAzNTU2LCJzY29wZXMiOiJmcmVlcGlrL2ltYWdlcyBmcmVlcGlrL3ZpZGVvcyBmbGF0aWNvbi9wbmciLCJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vZmMtcHJvZmlsZS1wcm8tcmV2MSIsImF1ZCI6ImZjLXByb2ZpbGUtcHJvLXJldjEiLCJhdXRoX3RpbWUiOjE3NTgzODgxMTIsInVzZXJfaWQiOiJUUEVZWWZGU3RCV043UWY1cVgyT1BzQWhjM3UxIiwic3ViIjoiVFBFWVlmRlN0QldON1FmNXFYMk9Qc0FoYzN1MSIsImlhdCI6MTc1ODk4NDAzOCwiZXhwIjoxNzU4OTg3NjM4LCJlbWFpbCI6ImphaGlkdWxpc2xhbWphaGlkNDQ3NEBnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiZmlyZWJhc2UiOnsiaWRlbnRpdGllcyI6eyJnb29nbGUuY29tIjpbIjExMTEyMDA3MTEyMzA4NDE3NDk4MSJdLCJlbWFpbCI6WyJqYWhpZHVsaXNsYW1qYWhpZDQ0NzRAZ21haWwuY29tIl19LCJzaWduX2luX3Byb3ZpZGVyIjoiY3VzdG9tIn19.cf6dK6VDKivCeKQ_tafDwGPcihYaZFbuJxgqZX62XlLpR8B8aDjhWjsHdI8f6amaTL6nCmV9hfIpTQpriyGNVrTbUw_i8oV8ALc1tm8iNlo_9EanqyWMx8xKbBXq-AwBKMAU_jmFCxdpsAmCaQa4nwmmg45EPeSgbb6jwN0IWTbHNiEhcdg0EsnPEMe7QC0Ssfr4Fw2_UPF7w28a4iTTscMOFYzeYRy2M_ovspM9Skqwiq5Wi5eK8O6WiEPo9gZSQdJdTp4DuS0Pd0Q51kOMVyrnvDZgfbUtnsuPLmGfhrC8hZdrXT19y7__QoC7V6diIyRg5wg63XdrFxciCdgApA"
  );
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
          "/" + locURL.pathname + (locURL.search || "")
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
export const config = { pattern: "^(/.*)?$" };
