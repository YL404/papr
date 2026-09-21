import { describe, expect, it } from "vitest";
import { imageBytes, imageDataUrl, imageMime, needsImageProxy } from "./imageBytes";

describe("needsImageProxy", () => {
  it("matches the hosts that reject a bare no-Referer request", () => {
    expect(needsImageProxy("https://cdnfile.sspai.com/2025/a.png")).toBe(true);
    expect(needsImageProxy("https://rssfile.sspai.com/b.jpg?x=1")).toBe(true);
  });

  it("passes ordinary hosts and unparseable sources through", () => {
    expect(needsImageProxy("https://i.example.com/cover.png")).toBe(false);
    // A subdomain the host check doesn't cover — the onError retry path
    // handles those, so they must not be double-fetched up front.
    expect(needsImageProxy("https://mirror.cdnfile.sspai.com/a.png")).toBe(false);
    expect(needsImageProxy("not a url")).toBe(false);
  });
});

describe("imageBytes", () => {
  it("keeps Uint8Array responses as bytes", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    expect(imageBytes(bytes)).toBe(bytes);
  });

  it("wraps ArrayBuffer responses", () => {
    const input = new Uint8Array([1, 2, 3]).buffer;
    expect(Array.from(imageBytes(input))).toEqual([1, 2, 3]);
  });

  it("converts number-array IPC responses without stringifying", () => {
    expect(Array.from(imageBytes([0xff, 0xd8, 0xff]))).toEqual([
      0xff, 0xd8, 0xff,
    ]);
  });
});

describe("imageMime", () => {
  it("detects PNG from its magic bytes regardless of URL", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(imageMime("https://cdn.example/x", png)).toBe("image/png");
  });

  it("detects JPEG, GIF and WebP signatures", () => {
    expect(imageMime("x", new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(imageMime("x", new Uint8Array([0x47, 0x49, 0x46]))).toBe("image/gif");
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(imageMime("x", webp)).toBe("image/webp");
  });

  it("trusts magic bytes over a misleading extension", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(imageMime("https://cdn.example/photo.jpg", png)).toBe("image/png");
  });

  it("falls back to the extension when bytes are unrecognised", () => {
    const junk = new Uint8Array([0, 1, 2, 3]);
    expect(imageMime("https://cdn.example/a.png?v=2", junk)).toBe("image/png");
    expect(imageMime("https://cdn.example/a.svg", junk)).toBe("image/svg+xml");
    expect(imageMime("https://cdn.example/a.webp#frag", junk)).toBe("image/webp");
  });

  it("defaults to image/jpeg when nothing identifies the type", () => {
    expect(imageMime("https://cdn.example/no-ext", new Uint8Array([0, 1, 2]))).toBe(
      "image/jpeg",
    );
  });
});

describe("imageDataUrl", () => {
  it("builds a base64 data: URL with the detected MIME", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(imageDataUrl("https://cdn.example/x", png)).toBe(
      `data:image/png;base64,${btoa("\x89PNG")}`,
    );
  });

  it("encodes large inputs without overflowing the call stack", () => {
    const big = new Uint8Array(200_000).fill(0x41); // 'A'
    const url = imageDataUrl("https://cdn.example/big.jpg", big);
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    // Round-trips back to the same bytes.
    const decoded = atob(url.slice("data:image/jpeg;base64,".length));
    expect(decoded.length).toBe(big.length);
  });
});
