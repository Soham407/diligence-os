import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "npm:pdf-lib@1.17.1";
import type { WhiteLabelResolved } from "./white-label.ts";

export type SourceDocument = {
  id: string;
  source_url: string;
  fetched_at: string;
};

type Citation = {
  source_document_id?: string;
  quote?: string;
  locator?: unknown;
};

type Footnote = {
  number: number;
  sourceDocumentId: string;
  quote: string;
  locatorText: string;
};

const MARGIN = 48;
const FONT_SIZE_NORMAL = 11;
const FONT_SIZE_SMALL = 9;
const LINE_HEIGHT = 15;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asNonEmptyString(entry)).filter((entry): entry is string => entry !== null);
}

function collectCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asRecord(entry));
}

function locatorToText(locator: unknown): string {
  const record = asRecord(locator);
  const type = asNonEmptyString(record.type);
  if (!type) return "locator unavailable";

  if (type === "pdf_page" && typeof record.page === "number") {
    return `pdf page ${record.page}`;
  }

  if (type === "audio_timestamp" && typeof record.start_sec === "number" && typeof record.end_sec === "number") {
    return `audio ${record.start_sec}s-${record.end_sec}s`;
  }

  if (type === "text_span" && typeof record.start_char === "number" && typeof record.end_char === "number") {
    return `text chars ${record.start_char}-${record.end_char}`;
  }

  if (type === "html_anchor") {
    const selector = asNonEmptyString(record.selector);
    return selector ? `html selector ${selector}` : "html anchor";
  }

  return type;
}

function buildReportLines(payload: unknown): { lines: string[]; footnotes: Footnote[]; sourceIds: Set<string> } {
  const record = asRecord(payload);
  const lines: string[] = [];
  const footnotes: Footnote[] = [];
  const sourceIds = new Set<string>();

  const sourceDocumentsUsed = asStringArray(record.source_documents_used);
  for (const sourceId of sourceDocumentsUsed) {
    sourceIds.add(sourceId);
  }

  const nextFootnote = (citation: Citation): number | null => {
    const sourceDocumentId = asNonEmptyString(citation.source_document_id);
    const quote = asNonEmptyString(citation.quote);
    if (!sourceDocumentId || !quote) return null;

    sourceIds.add(sourceDocumentId);
    const number = footnotes.length + 1;
    footnotes.push({
      number,
      sourceDocumentId,
      quote,
      locatorText: locatorToText(citation.locator)
    });
    return number;
  };

  const executiveSummary = asNonEmptyString(record.executive_summary);
  if (executiveSummary) {
    lines.push("Executive Summary");
    lines.push(executiveSummary);
    lines.push("");
  }

  const takeaways = asStringArray(record.key_takeaways);
  if (takeaways.length > 0) {
    lines.push("Key Takeaways");
    for (const takeaway of takeaways) {
      lines.push(`- ${takeaway}`);
    }
    lines.push("");
  }

  const sections = Array.isArray(record.sections) ? record.sections : [];
  for (const sectionEntry of sections) {
    const section = asRecord(sectionEntry);
    const heading = asNonEmptyString(section.heading) ?? "Section";
    lines.push(heading);

    const claims = Array.isArray(section.claims) ? section.claims : [];
    for (const claimEntry of claims) {
      const claim = asRecord(claimEntry);
      const claimText = asNonEmptyString(claim.text);
      if (!claimText) continue;

      const markers = collectCitations(claim.citations)
        .map((citation) => nextFootnote(citation))
        .filter((number): number is number => number !== null)
        .map((number) => `[${number}]`)
        .join("");

      lines.push(markers.length > 0 ? `- ${claimText} ${markers}` : `- ${claimText}`);
    }

    lines.push("");
  }

  const redFlags = Array.isArray(record.red_flags) ? record.red_flags : [];
  if (redFlags.length > 0) {
    lines.push("Red Flags");
    for (const redFlagEntry of redFlags) {
      const redFlag = asRecord(redFlagEntry);
      const redFlagText = asNonEmptyString(redFlag.text);
      if (!redFlagText) continue;

      const markers = collectCitations(redFlag.citations)
        .map((citation) => nextFootnote(citation))
        .filter((number): number is number => number !== null)
        .map((number) => `[${number}]`)
        .join("");

      lines.push(markers.length > 0 ? `- ${redFlagText} ${markers}` : `- ${redFlagText}`);
    }
    lines.push("");
  }

  return { lines, footnotes, sourceIds };
}

function drawWrappedText(page: PDFPage, text: string, options: {
  x: number;
  y: number;
  maxWidth: number;
  font: PDFFont;
  size: number;
  lineHeight: number;
}) {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return options.y - options.lineHeight;
  }

  let line = "";
  let cursorY = options.y;

  for (const word of words) {
    const nextLine = line.length === 0 ? word : `${line} ${word}`;
    const width = options.font.widthOfTextAtSize(nextLine, options.size);

    if (width > options.maxWidth && line.length > 0) {
      page.drawText(line, {
        x: options.x,
        y: cursorY,
        size: options.size,
        font: options.font
      });
      cursorY -= options.lineHeight;
      line = word;
    } else {
      line = nextLine;
    }
  }

  if (line.length > 0) {
    page.drawText(line, {
      x: options.x,
      y: cursorY,
      size: options.size,
      font: options.font
    });
    cursorY -= options.lineHeight;
  }

  return cursorY;
}

export async function buildReportPdf(params: {
  reportId: string;
  reportType: string;
  createdAt: string;
  companyName: string;
  payload: unknown;
  whiteLabel: WhiteLabelResolved;
  sourceDocuments: SourceDocument[];
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const titleFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const bodyFont = await doc.embedFont(StandardFonts.Helvetica);

  let page = doc.addPage([595.28, 841.89]);
  let cursorY = page.getHeight() - MARGIN;
  const maxWidth = page.getWidth() - MARGIN * 2;

  const ensureSpace = (required: number) => {
    if (cursorY - required >= MARGIN) return;
    page = doc.addPage([595.28, 841.89]);
    cursorY = page.getHeight() - MARGIN;
  };

  const drawHeading = (text: string) => {
    ensureSpace(30);
    page.drawText(text, { x: MARGIN, y: cursorY, size: 18, font: titleFont });
    cursorY -= 24;
  };

  const drawSubHeading = (text: string) => {
    ensureSpace(22);
    page.drawText(text, { x: MARGIN, y: cursorY, size: 13, font: titleFont });
    cursorY -= 18;
  };

  const drawBodyLine = (text: string, small = false) => {
    ensureSpace(20);
    cursorY = drawWrappedText(page, text, {
      x: MARGIN,
      y: cursorY,
      maxWidth,
      font: bodyFont,
      size: small ? FONT_SIZE_SMALL : FONT_SIZE_NORMAL,
      lineHeight: small ? 12 : LINE_HEIGHT
    });
  };

  drawHeading(params.whiteLabel.brandName);
  drawBodyLine(`${params.reportType} report · ${params.companyName}`);
  drawBodyLine(`Report ID: ${params.reportId}`, true);
  drawBodyLine(`Generated at: ${params.createdAt}`, true);

  if (params.whiteLabel.logoUrl) {
    drawBodyLine(`Logo: ${params.whiteLabel.logoUrl}`, true);
  }

  if (params.whiteLabel.showPlatformBranding) {
    drawBodyLine("Powered by Diligence OS", true);
  }

  if (params.whiteLabel.disclaimers.length > 0) {
    cursorY -= 8;
    drawSubHeading("Disclaimers");
    for (const disclaimer of params.whiteLabel.disclaimers) {
      drawBodyLine(`- ${disclaimer}`, true);
    }
  }

  const reportBody = buildReportLines(params.payload);

  cursorY -= 8;
  drawSubHeading("Report Content");
  if (reportBody.lines.length === 0) {
    drawBodyLine("No structured report content was present in payload.");
  } else {
    for (const line of reportBody.lines) {
      if (line.length === 0) {
        cursorY -= 5;
      } else if (line.startsWith("- ")) {
        drawBodyLine(line);
      } else {
        drawSubHeading(line);
      }
    }
  }

  if (reportBody.footnotes.length > 0) {
    cursorY -= 8;
    drawSubHeading("Footnotes");
    for (const footnote of reportBody.footnotes) {
      drawBodyLine(
        `[${footnote.number}] "${footnote.quote}" (source ${footnote.sourceDocumentId}; ${footnote.locatorText})`,
        true
      );
    }
  }

  cursorY -= 8;
  drawSubHeading("Source List");

  const knownSources = new Map(params.sourceDocuments.map((source) => [source.id, source]));
  const orderedSourceIds = Array.from(reportBody.sourceIds.values()).sort();

  if (orderedSourceIds.length === 0) {
    drawBodyLine("No sources captured for this report.", true);
  } else {
    for (const sourceId of orderedSourceIds) {
      const source = knownSources.get(sourceId);
      if (source) {
        drawBodyLine(`${source.source_url} · fetched_at ${source.fetched_at}`, true);
      } else {
        drawBodyLine(`source_id ${sourceId} · fetched_at unavailable`, true);
      }
    }
  }

  return await doc.save();
}
