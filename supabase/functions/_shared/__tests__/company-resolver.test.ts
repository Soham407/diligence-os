import { describe, expect, it } from "vitest";
import { CompanyResolver } from "../company-resolver.ts";
import { resolverFixtureCompanies } from "../__fixtures__/company-resolver.fixture.ts";

describe("CompanyResolver", () => {
  const resolver = new CompanyResolver(resolverFixtureCompanies);

  it("resolves exact NSE symbol", () => {
    const resolved = resolver.resolve("ALPHA");
    expect(resolved?.id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("resolves exact BSE code", () => {
    const resolved = resolver.resolve("532100");
    expect(resolved?.id).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("resolves exact ISIN", () => {
    const resolved = resolver.resolve("INELOTUS00029");
    expect(resolved?.id).toBe("55555555-5555-5555-5555-555555555555");
  });

  it("resolves CIN for a private company", () => {
    const resolved = resolver.resolve("u40101ka2014ptc000321");
    expect(resolved?.id).toBe("44444444-4444-4444-4444-444444444444");
    expect(resolved?.listing_status).toBe("private");
  });

  it("resolves fuzzy name", () => {
    const resolved = resolver.resolve("beta manufa");
    expect(resolved?.id).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("returns null for ambiguous brand name", () => {
    const resolved = resolver.resolve("sunrise");
    expect(resolved).toBeNull();
  });

  it("returns null for garbage input", () => {
    const resolved = resolver.resolve("%%% ???");
    expect(resolved).toBeNull();
  });

  it("returns primary security when company has dual class listings", () => {
    const resolved = resolver.resolve("Lotus Brands");
    expect(resolved?.id).toBe("55555555-5555-5555-5555-555555555555");
    expect(resolved?.primary_security?.isin).toBe("INELOTUS00011");
    expect(resolved?.primary_security?.is_primary).toBe(true);
  });
});
