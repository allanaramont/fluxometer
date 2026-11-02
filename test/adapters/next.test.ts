import { describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import * as writer from "../../src/core/writer.js";
import { fluxometer } from "../../src/adapters/next.js";

function buildMockNextRequest(overrides: {
  nextUrl: { pathname: string };
}): NextRequest {
  return {
    nextUrl: { pathname: overrides.nextUrl.pathname },
    method: "GET",
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

  it("buckets a path with an opaque/oversized segment under a fixed sentinel instead of recording it raw", async () => {
    const trackSpy = vi
      .spyOn(writer, "trackRequest")
      .mockImplementation(() => {});
    const wrapped = fluxometer((_req) => NextResponse.next());
    const opaqueToken = "a".repeat(80);

    await wrapped(
      buildMockNextRequest({ nextUrl: { pathname: `/users/${opaqueToken}` } }),
      {} as any,
    );

    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: "<unmatched>" }),
    );
  });

  it("allows dots and accented letters in a static segment instead of bucketing common real routes as unmatched", async () => {
    const trackSpy = vi
      .spyOn(writer, "trackRequest")
      .mockImplementation(() => {});
    const wrapped = fluxometer((_req) => NextResponse.next());

    await wrapped(
      buildMockNextRequest({ nextUrl: { pathname: "/favicon.ico" } }),
      {} as any,
    );
    await wrapped(
      buildMockNextRequest({ nextUrl: { pathname: "/produtos/ação" } }),
      {} as any,
    );

    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/favicon.ico" }),
    );
    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/produtos/ação" }),
    );
  });

  it("records the real status when the wrapped middleware returns a plain Response instead of a NextResponse", async () => {
    const trackSpy = vi
      .spyOn(writer, "trackRequest")
      .mockImplementation(() => {});
    const wrapped = fluxometer((_req) => new Response("no", { status: 401 }));

    await wrapped(
      buildMockNextRequest({ nextUrl: { pathname: "/admin" } }),
      {} as any,
    );

    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 }),
    );
  });
});
