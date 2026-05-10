import { z } from "zod";

export const CitationLocatorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pdf_page"),
    page: z.number().int().min(1)
  }),
  z.object({
    type: z.literal("text_span"),
    start_char: z.number().int().min(0),
    end_char: z.number().int().min(0)
  }),
  z.object({
    type: z.literal("audio_timestamp"),
    start_sec: z.number().min(0),
    end_sec: z.number().min(0)
  }),
  z.object({
    type: z.literal("html_anchor"),
    selector: z.string().min(1)
  })
]);

export const CitationSchema = z.object({
  source_document_id: z.string().uuid(),
  locator: CitationLocatorSchema,
  quote: z.string().min(1).max(500)
});

export const ReportClaimSchema = z.object({
  claim_id: z.string().min(1),
  text: z.string().min(1),
  citations: z.array(CitationSchema)
});

export const ReportSectionSchema = z.object({
  heading: z.string().min(1),
  claims: z.array(ReportClaimSchema)
});

export const ReportRedFlagSchema = z.object({
  text: z.string().min(1),
  citations: z.array(CitationSchema)
});

const BaseReportSchema = z
  .object({
    executive_summary: z.string().min(1),
    key_takeaways: z.array(z.string().min(1)),
    sections: z.array(ReportSectionSchema),
    red_flags: z.array(ReportRedFlagSchema),
    source_documents_used: z.array(z.string().uuid())
  })
  .strip();

export const EarningsSummarySchema = BaseReportSchema;
export const DueDiligenceReportSchema = BaseReportSchema;
export const LeadIntelReportSchema = BaseReportSchema;

export type EarningsSummary = z.infer<typeof EarningsSummarySchema>;
export type DueDiligenceReport = z.infer<typeof DueDiligenceReportSchema>;
export type LeadIntelReport = z.infer<typeof LeadIntelReportSchema>;
