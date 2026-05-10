export const reportComposerFixtureSourceDocuments = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    raw_content: "Revenue increased 12% year over year and margins improved."
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    raw_content: "Management guided for stable demand in the coming quarter."
  }
];

export const reportComposerFixtureWellFormedPayload = {
  executive_summary: "Quarter remained resilient with margin expansion.",
  key_takeaways: ["Revenue growth remained healthy", "Guidance remained stable"],
  sections: [
    {
      heading: "Financial Performance",
      claims: [
        {
          claim_id: "claim-1",
          text: "Revenue expanded in the quarter.",
          citations: [
            {
              source_document_id: "11111111-1111-1111-1111-111111111111",
              locator: { type: "pdf_page", page: 3 },
              quote: "Revenue increased 12% year over year"
            }
          ]
        }
      ]
    }
  ],
  red_flags: [
    {
      text: "Demand visibility remains limited.",
      citations: [
        {
          source_document_id: "22222222-2222-2222-2222-222222222222",
          locator: { type: "text_span", start_char: 0, end_char: 35 },
          quote: "stable demand in the coming quarter"
        }
      ]
    }
  ],
  source_documents_used: [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222"
  ]
};
