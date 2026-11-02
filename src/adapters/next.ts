import type { NextMiddleware, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { trackRequest } from "../core/writer.js";

const NUMERIC_SEGMENT = /^\d+$/;
const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Conservative allowlist for a static path segment: Unicode letters and
 * digits, dot/underscore/hyphen, bounded length. Anything else — opaque
 * tokens, oversized segments, unexpected characters — buckets the whole
 * route under `<unmatched>` rather than being recorded verbatim. Letters
 * and digits are Unicode-aware (not just ASCII) and `.` is included so
 * ordinary static assets (`favicon.ico`) and non-English slugs
 * (`/produtos/ação`) aren't swept into `<unmatched>` along with actually
 * opaque content. */
const SAFE_STATIC_SEGMENT = /^[\p{L}\p{N}_.-]{0,40}$/u;
const UNMATCHED_ROUTE = "<unmatched>";

/** Next.js middleware runs before route params are resolved, so there is
 * no matched pattern to read (unlike Express/Fastify). Numeric and UUID
 * segments are replaced with `:id`; any remaining segment that doesn't
 * look like a normal static path piece buckets the whole route under a
 * fixed sentinel instead of leaking unbounded-cardinality content. */
function normalizeRoute(pathname: string): string {
  const segments = pathname.split("/").map((segment) => {
    if (NUMERIC_SEGMENT.test(segment) || UUID_SEGMENT.test(segment))
      return ":id";
    return segment;
  });
  const hasUnsafeSegment = segments.some(
    (segment) => segment !== ":id" && !SAFE_STATIC_SEGMENT.test(segment),
  );
  if (hasUnsafeSegment) return UNMATCHED_ROUTE;
  return segments.join("/");
}

/** Wraps an existing Next.js middleware (or a pass-through) to also record
 * request metrics. Requires `export const runtime = 'nodejs'` in the
 * consumer's middleware.ts — the `pg` driver does not run on Edge. */
export function fluxometer(middleware?: NextMiddleware): NextMiddleware {
  return async function fluxometerMiddleware(req: NextRequest, event) {
    const startedAt = process.hrtime.bigint();
    const response = middleware
      ? await middleware(req, event)
      : NextResponse.next();
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    trackRequest({
      route: normalizeRoute(req.nextUrl.pathname),
      method: req.method,
      // NextResponse extends the standard Response — middleware may
      // legitimately return a plain Response (e.g. `new Response(null,
      // { status: 401 })`), which would otherwise be read as status 200.
      status: response instanceof Response ? response.status : 200,
      durationMs,
    });
    return response ?? NextResponse.next();
  };
}
