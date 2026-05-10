import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { CompanyResolver, type ResolverCompany } from "../_shared/company-resolver.ts";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase.ts";

type ResolveBody = {
  query?: string;
};

type CompanyRow = {
  id: string;
  cin: string | null;
  legal_name: string;
  display_name: string;
  sector: string | null;
  listing_status: string | null;
  securities:
    | {
        id: string;
        company_id: string;
        isin: string;
        security_type: string | null;
        nse_symbol: string | null;
        bse_code: string | null;
        is_primary: boolean;
      }[]
    | null;
};

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "");
}

function toResolverCompanies(rows: CompanyRow[]): ResolverCompany[] {
  return rows.map((row) => ({
    id: row.id,
    cin: row.cin,
    legal_name: row.legal_name,
    display_name: row.display_name,
    sector: row.sector,
    listing_status: row.listing_status,
    securities: row.securities ?? []
  }));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const pathname = normalizePath(new URL(request.url).pathname);
  if (!pathname.endsWith("/resolve")) {
    return jsonResponse(404, { error: "Route not found." });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return jsonResponse(401, { error: "Missing Authorization header." });
  }

  const userClient = createUserClient(authorization);

  const {
    data: { user },
    error: userError
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return jsonResponse(401, { error: "Invalid user session." });
  }

  let body: ResolveBody;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body." });
  }

  const query = body.query?.trim();
  if (!query) {
    return jsonResponse(400, { error: "query is required." });
  }

  const serviceClient = createServiceClient();
  const { data: companyRows, error: companyError } = await serviceClient
    .from("companies")
    .select(
      "id, cin, legal_name, display_name, sector, listing_status, securities(id, company_id, isin, security_type, nse_symbol, bse_code, is_primary)"
    )
    .limit(5000)
    .returns<CompanyRow[]>();

  if (companyError) {
    return jsonResponse(500, { error: companyError.message });
  }

  const resolver = new CompanyResolver(toResolverCompanies(companyRows ?? []));
  const company = resolver.resolve(query);

  return jsonResponse(200, {
    company
  });
});
