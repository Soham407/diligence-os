export type ReportType = "earnings_summary" | "due_diligence" | "lead_intel";

const TOOL_BY_REPORT_TYPE: Record<ReportType, string> = {
  earnings_summary: "submit_earnings_summary",
  due_diligence: "submit_due_diligence_report",
  lead_intel: "submit_lead_intel_report"
};

const AGENT_ENV_BY_REPORT_TYPE: Record<ReportType, string> = {
  earnings_summary: "ANTHROPIC_AGENT_ID_EARNINGS_REVIEWER",
  due_diligence: "ANTHROPIC_AGENT_ID_DUE_DILIGENCE_ANALYST",
  lead_intel: "ANTHROPIC_AGENT_ID_LEAD_INTEL_GENERATOR"
};

export type AgentRunInput = {
  reportType: ReportType;
  companyId: string;
  sourceDocumentIds: string[];
  customSources: string[];
  projectId: string | null;
};

export type AgentRunResult = {
  payload: Record<string, unknown>;
  toolName: string;
  agentId: string;
  agentVersion: string;
};

async function callAnthropicManagedAgent(
  input: AgentRunInput,
  toolName: string,
  agentId: string,
  anthropicApiKey: string
): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01"
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 1200,
      tools: [
        {
          name: toolName,
          description: `Submit final ${input.reportType} report payload`,
          input_schema: {
            type: "object",
            properties: {
              executive_summary: { type: "string" },
              key_takeaways: { type: "array", items: { type: "string" } },
              source_documents_used: { type: "array", items: { type: "string" } }
            },
            required: ["executive_summary", "key_takeaways", "source_documents_used"],
            additionalProperties: true
          }
        }
      ],
      tool_choice: { type: "tool", name: toolName },
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            agent_id: agentId,
            report_type: input.reportType,
            company_id: input.companyId,
            source_document_ids: input.sourceDocumentIds,
            custom_sources: input.customSources,
            project_id: input.projectId
          })
        }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${details}`);
  }

  const body = (await response.json()) as {
    content?: Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };

  const toolUse = body.content?.find((item) => item.type === "tool_use" && item.name === toolName);
  if (!toolUse?.input) {
    throw new Error(`Anthropic response missing required tool_use: ${toolName}`);
  }

  return toolUse.input;
}

export async function runReportAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const toolName = TOOL_BY_REPORT_TYPE[input.reportType];
  const agentId = Deno.env.get(AGENT_ENV_BY_REPORT_TYPE[input.reportType]) ?? "local-agent";
  const agentVersion = Deno.env.get("AGENT_VERSION") ?? "dev";
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");

  let payload: Record<string, unknown>;

  if (!anthropicApiKey) {
    payload = {
      executive_summary: "Mock report payload because ANTHROPIC_API_KEY is not configured.",
      key_takeaways: [
        `Generated for ${input.reportType}`,
        `project_id=${input.projectId ?? "none"}`,
        `sources=${input.sourceDocumentIds.length}`
      ],
      source_documents_used: input.sourceDocumentIds.slice().sort()
    };
  } else {
    payload = await callAnthropicManagedAgent(input, toolName, agentId, anthropicApiKey);
  }

  return {
    payload,
    toolName,
    agentId,
    agentVersion
  };
}
