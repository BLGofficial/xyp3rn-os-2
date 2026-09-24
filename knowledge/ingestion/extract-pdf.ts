import { extractText, getDocumentProxy } from 'unpdf';

// unpdf (pdf.js wrapper, zero deps) over pdf-parse: pdf-parse pulls a native canvas binding
// for features text extraction never uses.

/**
 * Checks the PDF magic bytes.
 * @param bytes - raw file content
 * @returns true when bytes start with "%PDF-"
 */
export const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';

/**
 * Extracts plain text per page.
 * @param bytes - PDF bytes (copied first: pdf.js detaches the buffer it is given)
 * @returns one string per page, lines separated by \n
 */
export const extractPdfPages = async (bytes: Uint8Array): Promise<string[]> => {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
};
