import "react-native-url-polyfill/auto";
import { StatusBar } from "expo-status-bar";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import type { Session, User } from "@supabase/supabase-js";
import { getMobileSupabaseEnv } from "./lib/env";
import { getSupabaseMobileClient } from "./lib/supabase";

WebBrowser.maybeCompleteAuthSession();

const REDIRECT_PATH = "auth/callback";

type AppTab = "search" | "summary" | "watchlist";

type PrimarySecurity = {
  id: string;
  isin: string;
  security_type: string | null;
  nse_symbol: string | null;
  bse_code: string | null;
  is_primary: boolean;
};

type Company = {
  id: string;
  legal_name: string;
  display_name: string;
  sector: string | null;
  listing_status: string | null;
  primary_security: PrimarySecurity | null;
};

type Citation = {
  claimId: string;
  sourceDocumentId: string;
  quote: string;
  locator: unknown;
  sourceUrl: string | null;
};

type WatchlistItem = {
  id: string;
  company_id: string;
  created_at: string;
  companies:
    | {
        id: string;
        display_name: string;
        legal_name: string;
        securities:
          | {
              nse_symbol: string | null;
              bse_code: string | null;
              is_primary: boolean;
            }[]
          | null;
      }
    | {
        id: string;
        display_name: string;
        legal_name: string;
        securities:
          | {
              nse_symbol: string | null;
              bse_code: string | null;
              is_primary: boolean;
            }[]
          | null;
      }[]
    | null;
};

export default function App() {
  const supabase = useMemo(() => getSupabaseMobileClient(), []);
  const { supabaseUrl, supabaseAnonKey } = useMemo(() => getMobileSupabaseEnv(), []);

  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<AppTab>("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [resolvedCompany, setResolvedCompany] = useState<Company | null>(null);

  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<string | null>(null);
  const [streamTrail, setStreamTrail] = useState("");
  const [finalPayload, setFinalPayload] = useState<Record<string, unknown> | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null);

  const [personalOrgId, setPersonalOrgId] = useState<string | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchlistError, setWatchlistError] = useState<string | null>(null);
  const [watchlistStatus, setWatchlistStatus] = useState<string | null>(null);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);

  useEffect(() => {
    const initialize = async () => {
      const {
        data: { session: currentSession }
      } = await supabase.auth.getSession();

      setSession(currentSession);
      setUser(currentSession?.user ?? null);
      setActiveOrgId(readActiveOrg(currentSession?.user ?? null));
      setAuthLoading(false);

      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) {
        await applyAuthCallbackUrl(initialUrl);
      }
    };

    void initialize();

    const authSubscription = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setActiveOrgId(readActiveOrg(nextSession?.user ?? null));
    });

    const linkSubscription = Linking.addEventListener("url", ({ url }) => {
      void applyAuthCallbackUrl(url);
    });

    return () => {
      authSubscription.data.subscription.unsubscribe();
      linkSubscription.remove();
    };
  }, [supabase]);

  useEffect(() => {
    if (!user) {
      setPersonalOrgId(null);
      setWatchlistItems([]);
      return;
    }

    void loadOrgContext(user.id);
  }, [user, activeOrgId]);

  useEffect(() => {
    if (!user || !activeOrgId || !personalOrgId || activeOrgId !== personalOrgId) {
      setWatchlistItems([]);
      return;
    }

    void loadWatchlist();
  }, [user, activeOrgId, personalOrgId]);

  async function applyAuthCallbackUrl(url: string) {
    try {
      const parsed = new URL(url.replace("#", "?"));
      const code = parsed.searchParams.get("code");
      const accessToken = parsed.searchParams.get("access_token");
      const refreshToken = parsed.searchParams.get("refresh_token");
      const errorDescription = parsed.searchParams.get("error_description");

      if (errorDescription) {
        setAuthError(errorDescription);
        return;
      }

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          setAuthError(error.message);
          return;
        }

        setAuthStatus("Signed in successfully.");
        setAuthError(null);
        return;
      }

      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        });

        if (error) {
          setAuthError(error.message);
          return;
        }

        setAuthStatus("Signed in successfully.");
        setAuthError(null);
      }
    } catch {
      // ignore non-auth deep links
    }
  }

  async function sendMagicLink() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setAuthError("Enter an email address first.");
      return;
    }

    setAuthBusy(true);
    setAuthError(null);
    setAuthStatus(null);

    const redirectTo = Linking.createURL(REDIRECT_PATH);
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmedEmail,
      options: {
        emailRedirectTo: redirectTo
      }
    });

    setAuthBusy(false);

    if (error) {
      setAuthError(error.message);
      return;
    }

    setAuthStatus("Magic link sent. Open it on this device to complete sign-in.");
  }

  async function continueWithGoogle() {
    setAuthBusy(true);
    setAuthError(null);
    setAuthStatus(null);

    const redirectTo = Linking.createURL(REDIRECT_PATH);
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        skipBrowserRedirect: true
      }
    });

    if (error || !data.url) {
      setAuthBusy(false);
      setAuthError(error?.message ?? "Failed to start Google sign-in.");
      return;
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    setAuthBusy(false);

    if (result.type !== "success" || !result.url) {
      setAuthError("Google sign-in was cancelled before completion.");
      return;
    }

    await applyAuthCallbackUrl(result.url);
  }

  async function signOut() {
    setAuthBusy(true);
    setAuthError(null);
    setAuthStatus(null);

    const { error } = await supabase.auth.signOut();
    setAuthBusy(false);

    if (error) {
      setAuthError(error.message);
      return;
    }

    setResolvedCompany(null);
    setFinalPayload(null);
    setCitations([]);
    setStreamTrail("");
    setSummaryStatus("Signed out.");
  }

  async function loadOrgContext(userId: string) {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("personal_org_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (error || !data) {
      setPersonalOrgId(null);
      return;
    }

    setPersonalOrgId(data.personal_org_id);
  }

  async function switchToPersonalOrg() {
    if (!session?.access_token || !personalOrgId) {
      return;
    }

    setWatchlistBusy(true);
    setWatchlistError(null);
    setWatchlistStatus(null);

    const response = await fetch(`${supabaseUrl}/functions/v1/orgs/switch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabaseAnonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ org_id: personalOrgId })
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setWatchlistBusy(false);
      setWatchlistError(payload.error ?? "Failed to switch to personal org.");
      return;
    }

    const { error } = await supabase.auth.refreshSession();
    setWatchlistBusy(false);

    if (error) {
      setWatchlistError(error.message);
      return;
    }

    setWatchlistStatus("Switched to personal org for retail watchlist actions.");
  }

  async function resolveCompany() {
    const query = searchQuery.trim();
    if (!query) {
      setSearchError("Enter company name, NSE/BSE symbol, CIN, or ISIN.");
      return;
    }

    if (!session?.access_token) {
      setSearchError("Sign in to use company search.");
      return;
    }

    setSearchBusy(true);
    setSearchError(null);

    const response = await fetch(`${supabaseUrl}/functions/v1/companies/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabaseAnonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      company?: Company | null;
    };

    setSearchBusy(false);

    if (!response.ok) {
      setSearchError(payload.error ?? "Company search failed.");
      return;
    }

    if (!payload.company) {
      setResolvedCompany(null);
      setSearchError("No canonical company match found.");
      return;
    }

    setResolvedCompany(payload.company);
    setActiveTab("summary");
  }

  async function runEarningsSummary() {
    if (!resolvedCompany) {
      setSummaryError("Resolve a company first.");
      return;
    }

    if (!session?.access_token) {
      setSummaryError("Sign in to run earnings summaries.");
      return;
    }

    setSummaryBusy(true);
    setSummaryError(null);
    setSummaryStatus("Starting SSE stream...");
    setStreamTrail("");
    setFinalPayload(null);
    setCitations([]);

    const response = await fetch(`${supabaseUrl}/functions/v1/reports`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabaseAnonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        company_id: resolvedCompany.id,
        report_type: "earnings_summary"
      })
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setSummaryBusy(false);
      setSummaryError(payload.error ?? `Report request failed with status ${response.status}.`);
      return;
    }

    if (!response.body?.getReader) {
      setSummaryBusy(false);
      setSummaryError("This runtime does not expose streaming readers for SSE.");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let activeToolIndex: number | null = null;
    let partialToolInput = "";
    let parsedPayload: Record<string, unknown> | null = null;

    const appendTrail = (text: string) => {
      if (!text) return;
      setStreamTrail((current) => `${current}${text}`);
    };

    const handleSseBlock = (rawBlock: string) => {
      const lines = rawBlock.split("\n");
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      const data = dataLines.join("\n");
      if (!data || data === "[DONE]") {
        return;
      }

      try {
        const parsed = JSON.parse(data) as {
          type?: string;
          index?: number;
          delta?: { type?: string; text?: string; partial_json?: string };
          content_block?: { type?: string; name?: string; input?: Record<string, unknown> };
        };

        if (parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
          appendTrail(parsed.delta.text);
        }

        if (
          parsed.type === "content_block_start" &&
          parsed.content_block?.type === "tool_use" &&
          parsed.content_block?.name === "submit_earnings_summary"
        ) {
          activeToolIndex = typeof parsed.index === "number" ? parsed.index : null;
          partialToolInput = "";

          if (parsed.content_block.input && typeof parsed.content_block.input === "object") {
            parsedPayload = parsed.content_block.input;
          }
        }

        if (
          parsed.type === "content_block_delta" &&
          activeToolIndex !== null &&
          parsed.index === activeToolIndex &&
          parsed.delta?.type === "input_json_delta"
        ) {
          partialToolInput += parsed.delta.partial_json ?? "";
        }

        if (
          parsed.type === "content_block_stop" &&
          activeToolIndex !== null &&
          parsed.index === activeToolIndex &&
          partialToolInput.length > 0
        ) {
          const candidate = JSON.parse(partialToolInput);
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            parsedPayload = candidate as Record<string, unknown>;
          }
        }
      } catch {
        appendTrail(data);
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        if (!value) {
          continue;
        }

        buffer += decoder.decode(value, { stream: true }).replaceAll("\r", "");

        while (true) {
          const delimiter = buffer.indexOf("\n\n");
          if (delimiter < 0) {
            break;
          }

          const block = buffer.slice(0, delimiter);
          buffer = buffer.slice(delimiter + 2);
          handleSseBlock(block);
        }
      }

      buffer += decoder.decode().replaceAll("\r", "");
      if (buffer.trim().length > 0) {
        handleSseBlock(buffer);
      }
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : "SSE stream interrupted.");
      setSummaryBusy(false);
      reader.releaseLock();
      return;
    }

    reader.releaseLock();

    if (!parsedPayload) {
      const { data: reportRow } = await supabase
        .from("reports")
        .select("payload")
        .eq("company_id", resolvedCompany.id)
        .eq("report_type", "earnings_summary")
        .eq("status", "succeeded")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (reportRow?.payload && typeof reportRow.payload === "object") {
        parsedPayload = reportRow.payload as Record<string, unknown>;
      }
    }

    if (!parsedPayload) {
      setSummaryBusy(false);
      setSummaryError("Stream ended without a structured summary payload.");
      return;
    }

    setFinalPayload(parsedPayload);
    const extractedCitations = extractCitations(parsedPayload);
    const hydratedCitations = await hydrateCitationSourceLinks(extractedCitations);
    setCitations(hydratedCitations);
    setSummaryBusy(false);
    setSummaryStatus("Earnings summary completed.");
  }

  async function hydrateCitationSourceLinks(items: Citation[]): Promise<Citation[]> {
    const sourceIds = Array.from(new Set(items.map((item) => item.sourceDocumentId).filter(Boolean)));
    if (sourceIds.length === 0) {
      return items;
    }

    const { data } = await supabase.from("source_documents").select("id, source_url").in("id", sourceIds);
    const sourceMap = new Map<string, string>();

    for (const row of data ?? []) {
      if (typeof row.id === "string" && typeof row.source_url === "string") {
        sourceMap.set(row.id, row.source_url);
      }
    }

    return items.map((item) => ({
      ...item,
      sourceUrl: sourceMap.get(item.sourceDocumentId) ?? null
    }));
  }

  async function loadWatchlist() {
    setWatchlistBusy(true);
    setWatchlistError(null);

    const { data, error } = await supabase
      .from("watchlists")
      .select("id, company_id, created_at, companies(id, display_name, legal_name, securities(nse_symbol, bse_code, is_primary))")
      .order("created_at", { ascending: false });

    setWatchlistBusy(false);

    if (error) {
      setWatchlistError(error.message);
      return;
    }

    setWatchlistItems((data ?? []) as WatchlistItem[]);
  }

  async function addToWatchlist() {
    if (!resolvedCompany || !personalOrgId) {
      setWatchlistError("Resolve a company first.");
      return;
    }

    setWatchlistBusy(true);
    setWatchlistError(null);
    setWatchlistStatus(null);

    const { error } = await supabase.from("watchlists").insert({
      org_id: personalOrgId,
      company_id: resolvedCompany.id,
      created_by: user?.id ?? null
    });

    if (error) {
      setWatchlistBusy(false);
      if (error.code === "23505") {
        setWatchlistStatus("Company is already in your watchlist.");
      } else {
        setWatchlistError(error.message);
      }
      return;
    }

    setWatchlistStatus("Added to watchlist.");
    await loadWatchlist();
    setWatchlistBusy(false);
  }

  async function removeFromWatchlist(watchlistId: string) {
    setWatchlistBusy(true);
    setWatchlistError(null);
    setWatchlistStatus(null);

    const { error } = await supabase.from("watchlists").delete().eq("id", watchlistId);

    if (error) {
      setWatchlistBusy(false);
      setWatchlistError(error.message);
      return;
    }

    setWatchlistStatus("Removed from watchlist.");
    await loadWatchlist();
    setWatchlistBusy(false);
  }

  if (authLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#5eead4" />
          <Text style={styles.mutedText}>Loading auth session…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.badge}>Diligence OS Retail</Text>
        <Text style={styles.title}>Search, stream, and watch</Text>

        {!session || !user ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sign in</Text>
            <TextInput
              autoCapitalize="none"
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor="#64748b"
              style={styles.input}
              value={email}
            />
            <Pressable disabled={authBusy} onPress={() => void sendMagicLink()} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Send magic link</Text>
            </Pressable>
            <Pressable disabled={authBusy} onPress={() => void continueWithGoogle()} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Continue with Google</Text>
            </Pressable>
            {authStatus ? <Text style={styles.successText}>{authStatus}</Text> : null}
            {authError ? <Text style={styles.errorText}>{authError}</Text> : null}
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Account</Text>
              <Text style={styles.mutedText}>{user.email}</Text>
              <Text style={styles.mutedText}>Active org: {activeOrgId ?? "-"}</Text>
              <Text style={styles.mutedText}>Personal org: {personalOrgId ?? "-"}</Text>
              <Pressable disabled={authBusy} onPress={() => void signOut()} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Sign out</Text>
              </Pressable>
            </View>

            <View style={styles.tabRow}>
              <TabButton active={activeTab === "search"} label="Search" onPress={() => setActiveTab("search")} />
              <TabButton active={activeTab === "summary"} label="Summary" onPress={() => setActiveTab("summary")} />
              <TabButton active={activeTab === "watchlist"} label="Watchlist" onPress={() => setActiveTab("watchlist")} />
            </View>

            {activeTab === "search" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Company search</Text>
                <TextInput
                  onChangeText={setSearchQuery}
                  placeholder="NSE/BSE symbol, CIN, ISIN, or name"
                  placeholderTextColor="#64748b"
                  style={styles.input}
                  value={searchQuery}
                />
                <Pressable disabled={searchBusy} onPress={() => void resolveCompany()} style={styles.primaryButton}>
                  <Text style={styles.primaryButtonText}>{searchBusy ? "Resolving..." : "Resolve company"}</Text>
                </Pressable>
                {searchError ? <Text style={styles.errorText}>{searchError}</Text> : null}
                {resolvedCompany ? <CompanyCard company={resolvedCompany} /> : null}
              </View>
            ) : null}

            {activeTab === "summary" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Earnings summary stream</Text>
                <Text style={styles.mutedText}>
                  {resolvedCompany ? `${resolvedCompany.display_name} (${resolvedCompany.id})` : "Resolve a company from Search."}
                </Text>
                <Pressable
                  disabled={summaryBusy || !resolvedCompany}
                  onPress={() => void runEarningsSummary()}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>{summaryBusy ? "Streaming..." : "Run earnings summary"}</Text>
                </Pressable>

                {summaryStatus ? <Text style={styles.successText}>{summaryStatus}</Text> : null}
                {summaryError ? <Text style={styles.errorText}>{summaryError}</Text> : null}

                {streamTrail ? (
                  <View style={styles.outputBlock}>
                    <Text style={styles.outputLabel}>Live stream</Text>
                    <Text style={styles.outputText}>{streamTrail}</Text>
                  </View>
                ) : null}

                {finalPayload ? (
                  <View style={styles.outputBlock}>
                    <Text style={styles.outputLabel}>Structured payload</Text>
                    <Text style={styles.outputText}>{JSON.stringify(finalPayload, null, 2)}</Text>
                  </View>
                ) : null}

                {citations.length > 0 ? (
                  <View style={styles.outputBlock}>
                    <Text style={styles.outputLabel}>Citations</Text>
                    {citations.map((citation) => (
                      <Pressable
                        key={`${citation.claimId}:${citation.sourceDocumentId}`}
                        onPress={() => setSelectedCitation(citation)}
                        style={styles.citationButton}
                      >
                        <Text style={styles.citationButtonText} numberOfLines={2}>
                          {citation.quote}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}

            {activeTab === "watchlist" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Watchlist</Text>

                {activeOrgId && personalOrgId && activeOrgId !== personalOrgId ? (
                  <View style={styles.warningBlock}>
                    <Text style={styles.warningText}>
                      Active org is not personal. Switch to your personal org to manage retail watchlist.
                    </Text>
                    <Pressable
                      disabled={watchlistBusy}
                      onPress={() => void switchToPersonalOrg()}
                      style={styles.secondaryButton}
                    >
                      <Text style={styles.secondaryButtonText}>Switch to personal org</Text>
                    </Pressable>
                  </View>
                ) : null}

                <Pressable
                  disabled={watchlistBusy || !resolvedCompany || activeOrgId !== personalOrgId}
                  onPress={() => void addToWatchlist()}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>
                    {resolvedCompany ? `Add ${resolvedCompany.display_name}` : "Resolve company in Search first"}
                  </Text>
                </Pressable>

                {watchlistStatus ? <Text style={styles.successText}>{watchlistStatus}</Text> : null}
                {watchlistError ? <Text style={styles.errorText}>{watchlistError}</Text> : null}

                {watchlistBusy ? <ActivityIndicator color="#5eead4" /> : null}

                {watchlistItems.map((item) => {
                  const company = Array.isArray(item.companies) ? item.companies[0] : item.companies;
                  const primary = (company?.securities ?? []).find((security) => security.is_primary) ?? null;

                  return (
                    <View key={item.id} style={styles.watchlistItem}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.watchlistTitle}>{company?.display_name ?? item.company_id}</Text>
                        <Text style={styles.mutedText}>
                          NSE {primary?.nse_symbol ?? "-"} · BSE {primary?.bse_code ?? "-"}
                        </Text>
                      </View>
                      <Pressable onPress={() => void removeFromWatchlist(item.id)} style={styles.removeButton}>
                        <Text style={styles.removeButtonText}>Remove</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      <Modal
        animationType="slide"
        onRequestClose={() => setSelectedCitation(null)}
        presentationStyle="pageSheet"
        transparent={false}
        visible={selectedCitation !== null}
      >
        <SafeAreaView style={styles.modalSafeArea}>
          <ScrollView contentContainerStyle={styles.modalContent}>
            <Text style={styles.modalTitle}>Citation</Text>
            <Text style={styles.modalLabel}>Verbatim quote</Text>
            <Text style={styles.modalBody}>{selectedCitation?.quote ?? "-"}</Text>
            <Text style={styles.modalLabel}>Source link</Text>
            <Text style={styles.modalBody}>{selectedCitation?.sourceUrl ?? "Unavailable"}</Text>
            {selectedCitation?.sourceUrl ? (
              <Pressable
                onPress={() => {
                  if (selectedCitation?.sourceUrl) {
                    void Linking.openURL(selectedCitation.sourceUrl);
                  }
                }}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Open source link</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setSelectedCitation(null)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Close</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function CompanyCard({ company }: { company: Company }) {
  return (
    <View style={styles.companyCard}>
      <Text style={styles.companyName}>{company.display_name}</Text>
      <Text style={styles.mutedText}>{company.legal_name}</Text>
      <Text style={styles.mutedText}>Company ID: {company.id}</Text>
      <Text style={styles.mutedText}>Sector: {company.sector ?? "-"}</Text>
      <Text style={styles.mutedText}>Listing: {company.listing_status ?? "-"}</Text>
      <Text style={styles.mutedText}>
        Primary security: {company.primary_security?.isin ?? "-"} · NSE {company.primary_security?.nse_symbol ?? "-"} · BSE {company.primary_security?.bse_code ?? "-"}
      </Text>
    </View>
  );
}

function TabButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tabButton, active ? styles.tabButtonActive : null]}>
      <Text style={[styles.tabButtonText, active ? styles.tabButtonTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

function readActiveOrg(user: User | null): string | null {
  const activeOrgId = user?.app_metadata?.active_org_id;
  return typeof activeOrgId === "string" && activeOrgId.length > 0 ? activeOrgId : null;
}

function extractCitations(payload: Record<string, unknown>): Citation[] {
  const next: Citation[] = [];

  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  for (const section of sections) {
    if (!section || typeof section !== "object" || !("claims" in section)) {
      continue;
    }

    const claims = Array.isArray((section as { claims?: unknown[] }).claims)
      ? ((section as { claims?: unknown[] }).claims ?? [])
      : [];

    for (const claim of claims) {
      if (!claim || typeof claim !== "object") {
        continue;
      }

      const claimId =
        typeof (claim as { claim_id?: unknown }).claim_id === "string"
          ? (claim as { claim_id: string }).claim_id
          : "unscoped";
      const claimCitations = Array.isArray((claim as { citations?: unknown[] }).citations)
        ? ((claim as { citations?: unknown[] }).citations ?? [])
        : [];

      for (const citation of claimCitations) {
        if (!citation || typeof citation !== "object") {
          continue;
        }

        const sourceDocumentId =
          typeof (citation as { source_document_id?: unknown }).source_document_id === "string"
            ? (citation as { source_document_id: string }).source_document_id
            : "";
        const quote =
          typeof (citation as { quote?: unknown }).quote === "string"
            ? (citation as { quote: string }).quote
            : "";

        if (!sourceDocumentId || !quote) {
          continue;
        }

        next.push({
          claimId,
          sourceDocumentId,
          quote,
          locator: (citation as { locator?: unknown }).locator ?? null,
          sourceUrl: null
        });
      }
    }
  }

  return dedupeCitations(next);
}

function dedupeCitations(items: Citation[]): Citation[] {
  const seen = new Set<string>();
  const unique: Citation[] = [];

  for (const item of items) {
    const key = `${item.claimId}:${item.sourceDocumentId}:${item.quote}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  return unique;
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#020617"
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 10
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    paddingTop: 18,
    gap: 14
  },
  badge: {
    color: "#67e8f9",
    textTransform: "uppercase",
    letterSpacing: 2,
    fontSize: 12,
    fontWeight: "700"
  },
  title: {
    color: "#e2e8f0",
    fontSize: 30,
    fontWeight: "700"
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1e293b",
    backgroundColor: "#0f172a",
    padding: 14,
    gap: 12
  },
  cardTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "700"
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#020617",
    color: "#e2e8f0",
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  primaryButton: {
    backgroundColor: "#5eead4",
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14
  },
  primaryButtonText: {
    color: "#042f2e",
    fontWeight: "700",
    textAlign: "center"
  },
  secondaryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    paddingVertical: 11,
    paddingHorizontal: 14
  },
  secondaryButtonText: {
    color: "#cbd5e1",
    fontWeight: "600",
    textAlign: "center"
  },
  mutedText: {
    color: "#94a3b8",
    fontSize: 13
  },
  errorText: {
    color: "#fda4af",
    fontSize: 13
  },
  successText: {
    color: "#86efac",
    fontSize: 13
  },
  tabRow: {
    flexDirection: "row",
    gap: 8
  },
  tabButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#0b1220",
    paddingVertical: 10
  },
  tabButtonActive: {
    backgroundColor: "#164e63",
    borderColor: "#22d3ee"
  },
  tabButtonText: {
    color: "#94a3b8",
    textAlign: "center",
    fontWeight: "600"
  },
  tabButtonTextActive: {
    color: "#ecfeff"
  },
  companyCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    padding: 10,
    gap: 4,
    backgroundColor: "#0b1220"
  },
  companyName: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "700"
  },
  outputBlock: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    padding: 10,
    gap: 8,
    backgroundColor: "#020617"
  },
  outputLabel: {
    color: "#67e8f9",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    fontWeight: "700"
  },
  outputText: {
    color: "#cbd5e1",
    fontSize: 12
  },
  citationButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#155e75",
    backgroundColor: "#083344",
    padding: 9
  },
  citationButtonText: {
    color: "#cffafe",
    fontSize: 12
  },
  warningBlock: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#f59e0b",
    backgroundColor: "#7c2d12",
    padding: 10,
    gap: 8
  },
  warningText: {
    color: "#fde68a",
    fontSize: 13
  },
  watchlistItem: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#0b1220",
    padding: 10,
    flexDirection: "row",
    gap: 10,
    alignItems: "center"
  },
  watchlistTitle: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "700"
  },
  removeButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#f43f5e",
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  removeButtonText: {
    color: "#fecdd3",
    fontSize: 12,
    fontWeight: "700"
  },
  modalSafeArea: {
    flex: 1,
    backgroundColor: "#020617"
  },
  modalContent: {
    padding: 20,
    gap: 12
  },
  modalTitle: {
    color: "#f8fafc",
    fontSize: 24,
    fontWeight: "700"
  },
  modalLabel: {
    color: "#67e8f9",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1
  },
  modalBody: {
    color: "#cbd5e1",
    fontSize: 14,
    lineHeight: 22
  }
});
