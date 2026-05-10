import type { ResolverCompany } from "../company-resolver.ts";

export const resolverFixtureCompanies: ResolverCompany[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    cin: "L12345MH2000PLC000001",
    legal_name: "Alpha Holdings Limited",
    display_name: "Alpha",
    sector: "Financial Services",
    listing_status: "listed",
    securities: [
      {
        id: "s-alpha",
        company_id: "11111111-1111-1111-1111-111111111111",
        isin: "INEALPHA00011",
        security_type: "equity",
        nse_symbol: "ALPHA",
        bse_code: "500001",
        is_primary: true
      }
    ]
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    cin: "L98765MH2002PLC000222",
    legal_name: "Beta Manufacturing Limited",
    display_name: "Beta Manufacturing",
    sector: "Industrials",
    listing_status: "listed",
    securities: [
      {
        id: "s-beta",
        company_id: "22222222-2222-2222-2222-222222222222",
        isin: "INEBETA00021",
        security_type: "equity",
        nse_symbol: "BETAMFG",
        bse_code: "532100",
        is_primary: true
      }
    ]
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    cin: "L45454MH2004PLC000333",
    legal_name: "Sunrise Foods Limited",
    display_name: "Sunrise Foods",
    sector: "Consumer",
    listing_status: "listed",
    securities: [
      {
        id: "s-sunrise-foods",
        company_id: "33333333-3333-3333-3333-333333333333",
        isin: "INESUNRISE001",
        security_type: "equity",
        nse_symbol: "SUNFOOD",
        bse_code: "532333",
        is_primary: true
      }
    ]
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    cin: "U40101KA2014PTC000321",
    legal_name: "Sunrise Energy Private Limited",
    display_name: "Sunrise Energy",
    sector: "Energy",
    listing_status: "private",
    securities: []
  },
  {
    id: "55555555-5555-5555-5555-555555555555",
    cin: "L11111GJ2007PLC000555",
    legal_name: "Lotus Brands Limited",
    display_name: "Lotus Brands",
    sector: "Consumer",
    listing_status: "listed",
    securities: [
      {
        id: "s-lotus-equity",
        company_id: "55555555-5555-5555-5555-555555555555",
        isin: "INELOTUS00011",
        security_type: "equity",
        nse_symbol: "LOTUS",
        bse_code: "540555",
        is_primary: true
      },
      {
        id: "s-lotus-preference",
        company_id: "55555555-5555-5555-5555-555555555555",
        isin: "INELOTUS00029",
        security_type: "preference",
        nse_symbol: "LOTUSP",
        bse_code: "940555",
        is_primary: false
      }
    ]
  }
];
