export interface PdfTextResult {
  text: string;
  pageCount: number;
  hadText: boolean;
}

const MAX_TEXT_BYTES = 200 * 1024; // 200KB cap

export async function extractPdfText(buffer: Buffer): Promise<PdfTextResult> {
  // pdf-parse v2 exports a class, not a function. The constructor converts Node
  // Buffer to Uint8Array for the worker; we destroy() to free pdfjs workers.
  const { PDFParse } = (await import('pdf-parse')) as typeof import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text || '').trim();
    const truncated = Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES
      ? text.slice(0, MAX_TEXT_BYTES)
      : text;
    return {
      text: truncated,
      pageCount: Array.isArray(result.pages) ? result.pages.length : 0,
      hadText: truncated.length > 0,
    };
  } finally {
    try { await parser.destroy(); } catch { /* swallow */ }
  }
}
