/**
 * Tests for the Next.js image loader.
 */
import { describe, it, expect } from "vitest";
import edgesharpLoader, { createLoader } from "../src/loader.js";

describe("default loader", () => {
  it("generates correct URL with all params", () => {
    const url = edgesharpLoader({ src: "/photo.jpg", width: 640, quality: 75 });
    expect(url).toBe("/_next/image?url=%2Fphoto.jpg&w=640&q=75");
  });

  it("defaults quality to 75 when not specified", () => {
    const url = edgesharpLoader({ src: "/photo.jpg", width: 640 });
    expect(url).toContain("q=75");
  });

  it("encodes special characters in src", () => {
    const url = edgesharpLoader({ src: "/images/my photo (1).jpg", width: 640 });
    expect(url).toContain("url=%2Fimages%2Fmy+photo+%281%29.jpg");
  });

  it("generates relative URL when no NEXT_PUBLIC_IMAGEMODE_URL", () => {
    const url = edgesharpLoader({ src: "/photo.jpg", width: 640, quality: 80 });
    expect(url.startsWith("/_next/image")).toBe(true);
  });
});

describe("createLoader", () => {
  it("prepends configured URL", () => {
    const loader = createLoader({ url: "https://images.example.com" });
    const url = loader({ src: "/photo.jpg", width: 640, quality: 80 });
    expect(url).toBe("https://images.example.com/_next/image?url=%2Fphoto.jpg&w=640&q=80");
  });

  it("strips trailing slash from URL", () => {
    const loader = createLoader({ url: "https://images.example.com/" });
    const url = loader({ src: "/photo.jpg", width: 640 });
    expect(url.startsWith("https://images.example.com/_next/image")).toBe(true);
  });

  it("uses custom default quality", () => {
    const loader = createLoader({ url: "https://img.example.com", defaultQuality: 90 });
    const url = loader({ src: "/photo.jpg", width: 640 });
    expect(url).toContain("q=90");
  });

  it("component quality overrides default", () => {
    const loader = createLoader({ url: "https://img.example.com", defaultQuality: 90 });
    const url = loader({ src: "/photo.jpg", width: 640, quality: 50 });
    expect(url).toContain("q=50");
  });

  it("generates all Next.js default widths correctly", () => {
    const loader = createLoader({ url: "https://img.example.com" });
    const widths = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];

    for (const w of widths) {
      const url = loader({ src: "/hero.jpg", width: w });
      expect(url).toContain(`w=${w}`);
    }
  });
});
