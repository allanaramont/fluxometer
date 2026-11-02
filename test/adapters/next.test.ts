import { describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import * as writer from "../../src/core/writer.js";
import { fluxometer } from "../../src/adapters/next.js";

function buildMockNextRequest(overrides: {
  nextUrl: { pathname: string };
}): NextRequest {
  return {
    nextUrl: { pathname: overrides.nextUrl.pathname },
  } as unknown as NextRequest;
}

describe("fluxometer (Next.js adapter)", () => {
  it("wraps an existing Next.js middleware and still calls trackRequest, forwarding the original response", async () => {
    const trackSpy = vi
      .spyOn(writer, "trackRequest")
      .mockImplementation(() => {});
    const wrapped = fluxometer((_req) => NextResponse.next());

    const res = await wrapped(
      buildMockNextRequest({ nextUrl: { pathname: "/tasks/42" } }),
      {} as any,
    );

    expect(res).toBeInstanceOf(NextResponse);
    // Next.js middleware has no access to a matched route pattern (that
    // only exists once routing resolves inside a Route Handler), so the
    // adapter normalizes numeric/UUID-shaped segments itself to avoid
    // recording a raw id in the route label.
    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/tasks/:id" }),
    );
  });
});
