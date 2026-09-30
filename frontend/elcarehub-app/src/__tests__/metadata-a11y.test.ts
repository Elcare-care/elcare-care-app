/**
 * Tests for artwork metadata validation and alt-text requirements (Issue #68)
 *
 * Covers:
 *  - Required fields (title, artist, image)
 *  - Alt text required for non-decorative images
 *  - Decorative image exempts alt text requirement
 *  - Alt text length limit
 *  - Long title does not break validation (only altText has a length cap)
 *  - Multilingual alt text accepted
 *  - License and creator fields are optional
 *  - All errors reported together (no early return)
 */

import { validateArtworkMetadata, ArtworkMetadata } from "@/lib/ipfs";

const VALID_BASE: ArtworkMetadata = {
  title: "Ndebele Patterns",
  description: "A study of traditional Ndebele geometric patterns.",
  artist: "GABC1234STELLAR",
  image: "ipfs://QmXyz",
  year: "2024",
  category: "Traditional",
  altText: "Geometric diamond shapes in red, yellow, and green arranged in horizontal bands.",
};

describe("validateArtworkMetadata", () => {
  it("passes for a fully valid metadata object", () => {
    const result = validateArtworkMetadata(VALID_BASE);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.messages).toHaveLength(0);
  });

  it("fails when title is missing", () => {
    const result = validateArtworkMetadata({ ...VALID_BASE, title: "" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("MISSING_TITLE");
  });

  it("fails when title is whitespace-only", () => {
    const result = validateArtworkMetadata({ ...VALID_BASE, title: "   " });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("MISSING_TITLE");
  });

  it("fails when artist is missing", () => {
    const result = validateArtworkMetadata({ ...VALID_BASE, artist: "" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("MISSING_ARTIST");
  });

  it("fails when image is missing", () => {
    const result = validateArtworkMetadata({ ...VALID_BASE, image: "" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("MISSING_IMAGE");
  });

  it("fails when altText is missing for a non-decorative image", () => {
    const result = validateArtworkMetadata({ ...VALID_BASE, altText: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("MISSING_ALT_TEXT");
    expect(result.messages.some((m) => m.includes("Alt text is required"))).toBe(true);
  });

  it("fails when altText is empty string for a non-decorative image", () => {
    const result = validateArtworkMetadata({ ...VALID_BASE, altText: "" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("MISSING_ALT_TEXT");
  });

  it("passes when isDecorativeImage=true and altText is absent", () => {
    const result = validateArtworkMetadata({
      ...VALID_BASE,
      altText: undefined,
      isDecorativeImage: true,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).not.toContain("MISSING_ALT_TEXT");
  });

  it("fails when altText exceeds 300 characters", () => {
    const longAlt = "A".repeat(301);
    const result = validateArtworkMetadata({ ...VALID_BASE, altText: longAlt });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("ALT_TEXT_TOO_LONG");
    expect(result.messages.some((m) => m.includes("301"))).toBe(true);
  });

  it("passes for altText exactly at the 300-character limit", () => {
    const maxAlt = "B".repeat(300);
    const result = validateArtworkMetadata({ ...VALID_BASE, altText: maxAlt });
    expect(result.valid).toBe(true);
    expect(result.errors).not.toContain("ALT_TEXT_TOO_LONG");
  });

  it("accepts multilingual alt text (Swahili)", () => {
    const result = validateArtworkMetadata({
      ...VALID_BASE,
      altText: "Mchoro wa kijiometri na mstari wa rangi ya bluu na nyekundu.",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts multilingual alt text (Arabic)", () => {
    const result = validateArtworkMetadata({
      ...VALID_BASE,
      altText: "لوحة تجريدية تصوّر الأنماط الهندسية التقليدية.",
    });
    expect(result.valid).toBe(true);
  });

  it("reports multiple errors together", () => {
    const result = validateArtworkMetadata({
      title: "",
      artist: "",
      image: "",
      description: "",
      year: "",
      category: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.errors).toContain("MISSING_TITLE");
    expect(result.errors).toContain("MISSING_ARTIST");
    expect(result.errors).toContain("MISSING_IMAGE");
    expect(result.errors).toContain("MISSING_ALT_TEXT");
  });

  it("optional fields (creator, medium, license) do not affect validity", () => {
    const withExtras = {
      ...VALID_BASE,
      creator: "Amara Diallo",
      medium: "Digital illustration",
      dimensions: "4096×4096 px",
      culturalContext: "Inspired by West African Kente weaving traditions.",
      attribution: "Pattern reference: Kente cloth, Ashanti people, Ghana.",
      license: "CC BY-SA 4.0",
      contentAdvisory: undefined,
    };
    const result = validateArtworkMetadata(withExtras);
    expect(result.valid).toBe(true);
  });

  it("long title does not trigger a validation error", () => {
    const result = validateArtworkMetadata({
      ...VALID_BASE,
      title: "A".repeat(500),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).not.toContain("MISSING_TITLE");
  });
});
