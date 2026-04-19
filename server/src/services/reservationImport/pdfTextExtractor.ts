export interface PdfTextResult {
  text: string;
  pageCount: number;
  hadText: boolean;
}

const MAX_TEXT_BYTES = 200 * 1024; // 200KB cap

export async function extractPdfText(buffer: Buffer): Promise<PdfTextResult> {
  // pdf-parse's default export is a callable; its shipped types don't describe the call signature well.
  const mod = await import('pdf-parse');
  const pdfParse = (mod.default ?? mod) as unknown as (b: Buffer) => Promise<{ text: string; numpages: number }>;
  const result = await pdfParse(buffer);
  const text = (result.text || '').trim();
  const truncated = Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES
    ? text.slice(0, MAX_TEXT_BYTES)
    : text;
  return {
    text: truncated,
    pageCount: result.numpages ?? 0,
    hadText: truncated.length > 0,
  };
}
