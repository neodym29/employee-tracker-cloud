import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {unzipSync} from 'fflate';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 20_000;
export const OCR_INSTALL_COMMAND = 'sudo apt-get install -y poppler-utils tesseract-ocr';

export type ExtractedDocument = {format: 'pdf' | 'pptx'; pageOrSlideCount: number; text: string; warnings: string[]};
export type PdfOcrOptions = {pdftoppmCommand?: string; tesseractCommand?: string; maxPages?: number};

const clean = (value: string) => value.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
const bounded = (value: string) => value.length > MAX_EXTRACTED_CHARACTERS
  ? {text: value.slice(0, MAX_EXTRACTED_CHARACTERS), warnings: [`Content truncated at ${MAX_EXTRACTED_CHARACTERS} characters.`]}
  : {text: value, warnings: [] as string[]};

function ensurePdfTextExtractionGlobals() {
  // pdfjs' Node build optionally imports a native canvas package to install
  // these browser globals. TraceMini only extracts text, so small 2D stubs are
  // sufficient and keep the installed CLI dependency-free/native-free.
  if (!(globalThis as any).DOMMatrix) (globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(value?: number[]) { if (value && value.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = value; }
    multiplySelf(other: any) {
      const {a, b, c, d, e, f} = this;
      this.a = a * other.a + c * other.b; this.b = b * other.a + d * other.b;
      this.c = a * other.c + c * other.d; this.d = b * other.c + d * other.d;
      this.e = a * other.e + c * other.f + e; this.f = b * other.e + d * other.f + f;
      return this;
    }
    preMultiplySelf(other: any) { const copy = new (globalThis as any).DOMMatrix([other.a, other.b, other.c, other.d, other.e, other.f]); return Object.assign(this, copy.multiplySelf(this)); }
    translate(x = 0, y = 0) { return new (globalThis as any).DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(new (globalThis as any).DOMMatrix([1, 0, 0, 1, x, y])); }
    scale(x = 1, y = x) { return new (globalThis as any).DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(new (globalThis as any).DOMMatrix([x, 0, 0, y, 0, 0])); }
    invertSelf() { const determinant = this.a * this.d - this.b * this.c; if (!determinant) return this; const {a, b, c, d, e, f} = this; this.a = d / determinant; this.b = -b / determinant; this.c = -c / determinant; this.d = a / determinant; this.e = (c * f - d * e) / determinant; this.f = (b * e - a * f) / determinant; return this; }
  };
  if (!(globalThis as any).Path2D) (globalThis as any).Path2D = class Path2D { addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} rect() {} closePath() {} };
}

function assertFileSize(file: string) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 1) throw new Error('Document is empty or unavailable.');
  if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds the 25 MiB limit.');
  return stat.size;
}

function extractPdfWithLocalOcr(file: string, pageCount: number, options: PdfOcrOptions = {}) {
  const maximum = Math.max(1, Math.min(options.maxPages ?? 10, pageCount));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-ocr-'));
  const prefix = path.join(directory, 'page');
  try {
    const rendered = spawnSync(options.pdftoppmCommand ?? 'pdftoppm', ['-f', '1', '-l', String(maximum), '-r', '150', '-gray', '-png', file, prefix], {timeout: 30_000, stdio: ['ignore', 'ignore', 'pipe']});
    if (rendered.error && (rendered.error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`This scanned PDF needs local OCR, but Poppler is not installed. Copy and paste this command into a terminal: ${OCR_INSTALL_COMMAND}`);
    if (rendered.error || rendered.status !== 0) throw new Error('The scanned PDF could not be rendered for local OCR.');
    const images = fs.readdirSync(directory).map(name => ({
      name,
      page: Number(/-(\d+)\.png$/i.exec(name)?.[1]),
    })).filter(item => Number.isInteger(item.page)).sort((a, b) => a.page - b.page);
    const pages: string[] = [];
    for (const image of images) {
      const recognized = spawnSync(options.tesseractCommand ?? 'tesseract', [path.join(directory, image.name), 'stdout', '-l', 'eng', '--psm', '6'], {encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
      if (recognized.error && (recognized.error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`This scanned PDF needs local OCR, but Tesseract is not installed. Copy and paste this command into a terminal: ${OCR_INSTALL_COMMAND}`);
      if (recognized.error || recognized.status !== 0) continue;
      const pageText = clean(recognized.stdout || '');
      if (pageText) pages.push(`### Page ${image.page}\n${pageText}`);
    }
    const output = bounded(pages.join('\n\n'));
    if (!output.text) throw new Error('No readable text was found in the scanned PDF.');
    return {
      ...output,
      warnings: [`Text was read with local OCR from ${maximum < pageCount ? `the first ${maximum} of ${pageCount} pages` : `${pageCount} page${pageCount === 1 ? '' : 's'}`}.`, ...output.warnings],
    };
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}

export async function extractPdf(file: string, ocrOptions: PdfOcrOptions = {}): Promise<ExtractedDocument> {
  assertFileSize(file);
  const data = new Uint8Array(fs.readFileSync(file));
  if (Buffer.from(data.subarray(0, 5)).toString() !== '%PDF-') throw new Error('The selected file is not a valid PDF.');
  let pdf: any;
  try {
    ensurePdfTextExtractionGlobals();
    const {getDocument, GlobalWorkerOptions} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bundledWorker = new URL('./pdf.worker.js', import.meta.url);
    GlobalWorkerOptions.workerSrc = fs.existsSync(fileURLToPath(bundledWorker)) ? bundledWorker.href : pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    pdf = await getDocument({data, useSystemFonts: true}).promise;
  }
  catch (error: any) {
    const message = String(error?.message || error);
    if (/password/i.test(message)) throw new Error('Encrypted PDFs are not supported.');
    throw new Error('The PDF could not be read safely.');
  }
  if (pdf.numPages > 100) throw new Error('PDFs are limited to 100 pages.');
  const pages: string[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const pageText = clean(content.items.map((item: any) => typeof item.str === 'string' ? item.str : '').join(' '));
    if (pageText) pages.push(`### Page ${number}\n${pageText}`);
  }
  const output = pages.length ? bounded(pages.join('\n\n')) : extractPdfWithLocalOcr(file, pdf.numPages, ocrOptions);
  return {format: 'pdf', pageOrSlideCount: pdf.numPages, ...output};
}

function zipEntries(buffer: Buffer) {
  let end = -1;
  for (let offset = Math.max(0, buffer.length - 65_557); offset <= buffer.length - 22; offset += 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) end = offset;
  }
  if (end < 0) throw new Error('The PPTX ZIP directory is invalid.');
  const total = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  let expanded = 0;
  if (total > 1000) throw new Error('The PPTX contains too many archive entries.');
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The PPTX ZIP directory is invalid.');
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error('The PPTX contains an unsafe archive path.');
    if (uncompressed > 10 * 1024 * 1024 || (compressed > 0 && uncompressed / compressed > 100)) throw new Error('The PPTX exceeds safe archive expansion limits.');
    expanded += uncompressed;
    if (expanded > 40 * 1024 * 1024) throw new Error('The PPTX exceeds safe archive expansion limits.');
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

const xmlText = (xml: string) => clean([...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match => match[1]
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')).join(' '));
const numbered = (prefix: string, suffix: string) => (name: string) => {
  const match = new RegExp(`^${prefix}(\\d+)${suffix.replace('.', '\\.')}$`).exec(name);
  return match ? Number(match[1]) : undefined;
};

export function extractPptx(file: string): ExtractedDocument {
  assertFileSize(file);
  const buffer = fs.readFileSync(file);
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('The selected file is not a valid PPTX.');
  zipEntries(buffer);
  let archive: Record<string, Uint8Array>;
  try { archive = unzipSync(new Uint8Array(buffer)); }
  catch { throw new Error('The PPTX could not be decompressed safely.'); }
  if (!archive['[Content_Types].xml'] || !archive['ppt/presentation.xml']) throw new Error('The selected file is not a valid PPTX presentation.');
  const names = Object.keys(archive);
  if (names.some(name => /vbaProject\.bin/i.test(name) || /^ppt\/(?:embeddings|activeX)\/.+/i.test(name))) throw new Error('PPTX macros and embedded objects are not supported.');
  for (const name of names.filter(name => name.endsWith('.rels'))) {
    if (/TargetMode\s*=\s*["']External["']/i.test(Buffer.from(archive[name]).toString('utf8'))) throw new Error('PPTX external relationships are not supported.');
  }
  const slideNumber = numbered('ppt/slides/slide', '.xml');
  const slides = names.map(name => ({name, number: slideNumber(name)})).filter(item => item.number !== undefined).sort((a, b) => a.number! - b.number!);
  if (!slides.length) throw new Error('The PPTX contains no slides.');
  if (slides.length > 200) throw new Error('PPTX files are limited to 200 slides.');
  const parts: string[] = [];
  for (const slide of slides) {
    const body = xmlText(Buffer.from(archive[slide.name]).toString('utf8'));
    const notesName = `ppt/notesSlides/notesSlide${slide.number}.xml`;
    const notes = archive[notesName] ? xmlText(Buffer.from(archive[notesName]).toString('utf8')) : '';
    if (body || notes) parts.push(`### Slide ${slide.number}\n${body}${notes ? `\nSpeaker notes: ${notes}` : ''}`.trim());
  }
  const output = bounded(parts.join('\n\n'));
  if (!output.text) throw new Error('The PPTX has no extractable text.');
  return {format: 'pptx', pageOrSlideCount: slides.length, ...output};
}

export async function extractDocument(file: string, displayName = path.basename(file)) {
  const extension = path.extname(displayName).toLowerCase();
  if (extension === '.pdf') return extractPdf(file);
  if (extension === '.pptx') return extractPptx(file);
  throw new Error('Only PDF and PPTX files are supported.');
}
