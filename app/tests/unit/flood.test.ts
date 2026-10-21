import { describe, expect, it } from "vitest";
import { bandFor } from "../../src/lib/flood";

/**
 * The band boundaries, which are the whole of the layer's correctness outside MapLibre.
 *
 * These are the artifact's real bands (data/derived/flood_extent.json meta.bands_ft). The
 * tests are written against the numbers rather than against a fixture so that a change in
 * the pipeline is caught here as a failing boundary, not discovered on the map.
 */
const BANDS = [45, 48, 50, 54.74];

describe("bandFor", () => {
  it("draws nothing below flood stage", () => {
    expect(bandFor(0, BANDS)).toBeNull();
    expect(bandFor(44.9, BANDS)).toBeNull();
    expect(bandFor(29.4, BANDS)).toBeNull();
  });

  it("is inclusive at each category boundary, like the NWS threshold", () => {
    expect(bandFor(45, BANDS)).toBe(45);
    expect(bandFor(48, BANDS)).toBe(48);
    expect(bandFor(50, BANDS)).toBe(50);
    expect(bandFor(54.74, BANDS)).toBe(54.74);
  });

  it("never draws a band the stage has not reached", () => {
    expect(bandFor(45.1, BANDS)).toBe(45);
    expect(bandFor(47.99, BANDS)).toBe(45);
    expect(bandFor(49.9, BANDS)).toBe(48);
    expect(bandFor(50.01, BANDS)).toBe(50);
    expect(bandFor(54.73, BANDS)).toBe(50);
  });

  it("keeps the top band at the crest rather than vanishing", () => {
    // Harvey's crest at Richmond: 55.01 ft, above the top band.
    expect(bandFor(55.01, BANDS)).toBe(54.74);
    expect(bandFor(56, BANDS)).toBe(54.74);
  });

  it("does not depend on the payload's ordering", () => {
    expect(bandFor(49, [54.74, 45, 50, 48])).toBe(48);
    expect(bandFor(49, [])).toBeNull();
  });
});
