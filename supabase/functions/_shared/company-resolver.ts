export type ResolverSecurity = {
  id: string;
  company_id: string;
  isin: string;
  security_type: string | null;
  nse_symbol: string | null;
  bse_code: string | null;
  is_primary: boolean;
};

export type ResolverCompany = {
  id: string;
  cin: string | null;
  legal_name: string;
  display_name: string;
  sector: string | null;
  listing_status: string | null;
  securities: ResolverSecurity[];
};

export type CanonicalCompany = {
  id: string;
  cin: string | null;
  legal_name: string;
  display_name: string;
  sector: string | null;
  listing_status: string | null;
  primary_security: ResolverSecurity | null;
};

type InternalCompany = ResolverCompany & {
  nameKeys: string[];
  tokenSet: Set<string>;
};

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeKey(value: string): string {
  return normalizeWhitespace(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function normalizeBseCode(value: string): string {
  return value.trim().replace(/^0+/, "");
}

function uniqueCompanyForKey(key: string, index: Map<string, Set<string>>): string | null {
  const ids = index.get(key);
  if (!ids || ids.size !== 1) {
    return null;
  }

  const [companyId] = ids;
  return companyId ?? null;
}

function choosePrimarySecurity(securities: ResolverSecurity[]): ResolverSecurity | null {
  if (securities.length === 0) {
    return null;
  }

  const primaryCandidates = securities.filter((security) => security.is_primary);
  const source = primaryCandidates.length > 0 ? primaryCandidates : securities;

  return source
    .slice()
    .sort((a, b) => {
      const aRank = a.nse_symbol ? 0 : a.bse_code ? 1 : 2;
      const bRank = b.nse_symbol ? 0 : b.bse_code ? 1 : 2;
      if (aRank !== bRank) {
        return aRank - bRank;
      }

      return a.isin.localeCompare(b.isin);
    })[0];
}

function withCanonicalShape(company: ResolverCompany): CanonicalCompany {
  return {
    id: company.id,
    cin: company.cin,
    legal_name: company.legal_name,
    display_name: company.display_name,
    sector: company.sector,
    listing_status: company.listing_status,
    primary_security: choosePrimarySecurity(company.securities)
  };
}

export class CompanyResolver {
  private readonly companiesById = new Map<string, InternalCompany>();
  private readonly cinIndex = new Map<string, Set<string>>();
  private readonly isinIndex = new Map<string, Set<string>>();
  private readonly nseIndex = new Map<string, Set<string>>();
  private readonly bseIndex = new Map<string, Set<string>>();
  private readonly nameIndex = new Map<string, Set<string>>();

  constructor(companies: readonly ResolverCompany[]) {
    for (const company of companies) {
      const nameKeys = [normalizeKey(company.display_name), normalizeKey(company.legal_name)].filter(
        (key, index, values) => key.length > 0 && values.indexOf(key) === index
      );

      const tokenSet = new Set<string>([
        ...tokenize(company.display_name),
        ...tokenize(company.legal_name)
      ]);

      const internal: InternalCompany = {
        ...company,
        securities: company.securities.slice(),
        nameKeys,
        tokenSet
      };

      this.companiesById.set(company.id, internal);

      if (company.cin) {
        this.addIndex(this.cinIndex, normalizeKey(company.cin), company.id);
      }

      for (const nameKey of nameKeys) {
        this.addIndex(this.nameIndex, nameKey, company.id);
      }

      for (const security of company.securities) {
        this.addIndex(this.isinIndex, normalizeKey(security.isin), company.id);

        if (security.nse_symbol) {
          this.addIndex(this.nseIndex, normalizeKey(security.nse_symbol), company.id);
        }

        if (security.bse_code) {
          this.addIndex(this.bseIndex, normalizeBseCode(security.bse_code), company.id);
        }
      }
    }
  }

  resolve(query: string): CanonicalCompany | null {
    const trimmed = normalizeWhitespace(query);
    if (!trimmed) {
      return null;
    }

    const key = normalizeKey(trimmed);
    const bseKey = normalizeBseCode(trimmed);

    const exactCompanyId =
      uniqueCompanyForKey(key, this.cinIndex) ??
      uniqueCompanyForKey(key, this.isinIndex) ??
      uniqueCompanyForKey(key, this.nseIndex) ??
      uniqueCompanyForKey(bseKey, this.bseIndex) ??
      uniqueCompanyForKey(key, this.nameIndex);

    if (exactCompanyId) {
      const company = this.companiesById.get(exactCompanyId);
      return company ? withCanonicalShape(company) : null;
    }

    return this.resolveByFuzzyName(trimmed);
  }

  private addIndex(index: Map<string, Set<string>>, key: string, companyId: string): void {
    if (!key) {
      return;
    }

    const existing = index.get(key);
    if (existing) {
      existing.add(companyId);
      return;
    }

    index.set(key, new Set([companyId]));
  }

  private resolveByFuzzyName(query: string): CanonicalCompany | null {
    const queryKey = normalizeKey(query);
    const queryTokens = tokenize(query);

    if (!queryKey || queryTokens.length === 0) {
      return null;
    }

    const scored = Array.from(this.companiesById.values())
      .map((company) => ({
        company,
        score: this.scoreCompany(queryKey, queryTokens, company)
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return null;
    }

    const [top, second] = scored;

    if (top.score < 0.45) {
      return null;
    }

    if (second && Math.abs(top.score - second.score) < 0.05) {
      return null;
    }

    return withCanonicalShape(top.company);
  }

  private scoreCompany(queryKey: string, queryTokens: string[], company: InternalCompany): number {
    let best = 0;

    for (const nameKey of company.nameKeys) {
      if (nameKey === queryKey) {
        return 1;
      }

      if (nameKey.startsWith(queryKey) || queryKey.startsWith(nameKey)) {
        best = Math.max(best, 0.9);
      } else if (nameKey.includes(queryKey)) {
        best = Math.max(best, 0.8);
      }
    }

    let overlap = 0;
    for (const token of queryTokens) {
      if (company.tokenSet.has(token)) {
        overlap += 1;
      }
    }

    const coverageScore = overlap / queryTokens.length;
    if (coverageScore > 0) {
      best = Math.max(best, coverageScore * 0.75);
    }

    return best;
  }
}
