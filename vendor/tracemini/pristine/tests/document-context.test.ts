import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {afterEach, describe, expect, it} from 'vitest';
import {zipSync, strToU8} from 'fflate';
import {decodeReportContext, decodeScheduleDays, encodeReportContext, encodeScheduleDays, validateDocumentContext} from '../apps/server/src/document-context.js';
import {extractPdf, extractPptx, OCR_INSTALL_COMMAND as CLI_OCR_INSTALL_COMMAND} from '../packages/cli/src/document-inspection.js';
import {createDocumentLoopbackHandler} from '../packages/cli/src/document-loopback.js';
import {generateDocumentMetadata} from '../packages/cli/src/document-metadata.js';
import {loadConfig, saveConfig} from '../packages/cli/src/config.js';
import {contextPrompt, ensureDocumentContextSection} from '../packages/cli/src/agent.js';

const originalHome = process.env.TRACEMINI_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.TRACEMINI_HOME;
  else process.env.TRACEMINI_HOME = originalHome;
});

const document = {
  displayName: 'Roadmap.pptx', format: 'pptx' as const,
  mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  byteSize: 2048, pageOrSlideCount: 2, consentedAt: '2026-09-02T10:00:00.000Z',
  metadata: {
    title: 'Roadmap', shortSummary: 'Plans the reporting release.',
    keyPoints: [{text: 'Ship document context', references: ['Slide 1']}], decisions: [], actionItems: [],
    projects: ['TraceMini'], people: [], relevantDates: [], warnings: [],
  },
};

describe('schema-free document context', () => {
  it('round-trips report and schedule envelopes while retaining legacy values', () => {
    const docs = validateDocumentContext([document]);
    expect(decodeReportContext(encodeReportContext('Focus on outcomes', docs))).toEqual({guidance: 'Focus on outcomes', documents: docs});
    expect(decodeReportContext('Legacy guidance')).toEqual({guidance: 'Legacy guidance', documents: []});
    expect(decodeScheduleDays(encodeScheduleDays([1, 5], docs))).toEqual({days: [1, 5], documents: docs});
    expect(decodeScheduleDays([2, 4])).toEqual({days: [2, 4], documents: []});
  });

  it('rejects local paths and oversized collections', () => {
    expect(() => validateDocumentContext([{...document, displayName: '/home/alice/private.pdf'}])).toThrow(/display name/);
    expect(() => validateDocumentContext(Array.from({length: 6}, () => document))).toThrow(/five/);
  });

  it('applies the 4 KiB limit to metadata rather than transport wrapper fields', () => {
    const metadata = {
      title: 'T'.repeat(240),
      shortSummary: 'S'.repeat(1000),
      keyPoints: Array.from({length: 9}, (_, index) => ({text: 'K'.repeat(240), references: [`Page ${index + 1}`]})),
      decisions: [], actionItems: [], projects: [], people: [], relevantDates: [], warnings: [],
    };
    const wrapped = {...document, displayName: `${'D'.repeat(156)}.pdf`, format: 'pdf' as const, mediaType: 'application/pdf', metadata};

    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(JSON.stringify(wrapped))).toBeGreaterThan(4 * 1024);
    expect(validateDocumentContext([wrapped])).toEqual([wrapped]);
  });

  it('adds document metadata separately without changing Git evidence', () => {
    const prompt = contextPrompt({job: {start_date: '2026-09-01', end_date: '2026-09-01', custom_prompt: encodeReportContext(null, [document])}, events: []}, []);
    expect(prompt).toContain('Additional document context');
    expect(prompt).toContain('not proof of engineering work');
    expect(prompt).toContain('Plans the reporting release.');
    expect(prompt).not.toContain('application/vnd');
    expect(prompt).toContain('Include a clearly labeled Document context section');
    const completed = ensureDocumentContextSection('# Engineering report', encodeReportContext(null, [document]));
    expect(completed).toContain('## Document context');
    expect(completed).toContain('Plans the reporting release');
    expect(ensureDocumentContextSection('# Git-only report', null)).toBe('# Git-only report');
    expect(ensureDocumentContextSection(`${completed}\n`, encodeReportContext(null, [document])).match(/^## Document context$/gm)).toHaveLength(1);
  });
});

describe('local document processing', () => {
  it('runs Codex through stdin with structured-output flags and removes every private temp file', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-codex-'));
    const command = path.join(temporary, 'fake-codex');
    const log = path.join(temporary, 'invocation');
    fs.writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$@" > "$TRACEMINI_CODEX_TEST_LOG.args"\ncat > "$TRACEMINI_CODEX_TEST_LOG.stdin"\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '--output-last-message' ]; then shift; output="$1"; fi\n  shift\ndone\nprintf '%s' '{"title":"Plan","shortSummary":"Bounded summary.","keyPoints":[],"decisions":[],"actionItems":[],"projects":[],"people":[],"relevantDates":[],"warnings":[]}' > "$output"\n`, {mode: 0o700});
    await expect(generateDocumentMetadata('untrusted document text', 'plan.pdf', 5000, {command, temporaryRoot: temporary, env: {...process.env, TRACEMINI_CODEX_TEST_LOG: log}})).resolves.toMatchObject({title: 'Plan'});
    const args = fs.readFileSync(`${log}.args`, 'utf8');
    expect(args).toContain('--sandbox\nread-only\n');
    expect(args).toContain('--ephemeral\n');
    expect(args).toContain('--ignore-user-config\n');
    expect(args).toContain('--output-schema\n');
    expect(fs.readFileSync(`${log}.stdin`, 'utf8')).toContain('untrusted evidence');
    expect(fs.readdirSync(temporary).sort()).toEqual(['fake-codex', 'invocation.args', 'invocation.stdin']);
    fs.rmSync(temporary, {recursive: true, force: true});
  });

  it('extracts ordered text from a normal PDF', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-pdf-'));
    const file = path.join(temporary, 'context.pdf');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      '<< /Length 48 >>\nstream\nBT /F1 12 Tf 72 720 Td (TraceMini context) Tj ET\nendstream',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    fs.writeFileSync(file, pdf);
    await expect(extractPdf(file)).resolves.toMatchObject({format: 'pdf', pageOrSlideCount: 1, text: expect.stringContaining('TraceMini context')});
    fs.rmSync(temporary, {recursive: true, force: true});
  });

  it('uses bounded local OCR for an image-only PDF', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-scanned-pdf-'));
    const file = path.join(temporary, 'scan.pdf');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    fs.writeFileSync(file, pdf);
    const renderer = path.join(temporary, 'fake-pdftoppm');
    const ocr = path.join(temporary, 'fake-tesseract');
    fs.writeFileSync(renderer, '#!/bin/sh\nfor prefix do :; done\nprintf image > "${prefix}-1.png"\n', {mode: 0o700});
    fs.writeFileSync(ocr, '#!/bin/sh\nprintf "Architecture decision from scan"\n', {mode: 0o700});
    await expect(extractPdf(file, {pdftoppmCommand: renderer, tesseractCommand: ocr})).resolves.toMatchObject({
      format: 'pdf', text: expect.stringContaining('Architecture decision from scan'), warnings: expect.arrayContaining([expect.stringContaining('local OCR')]),
    });
    await expect(extractPdf(file, {pdftoppmCommand: path.join(temporary, 'missing-pdftoppm')})).rejects.toThrow(CLI_OCR_INSTALL_COMMAND);
    await expect(extractPdf(file, {pdftoppmCommand: renderer, tesseractCommand: path.join(temporary, 'missing-tesseract')})).rejects.toThrow(CLI_OCR_INSTALL_COMMAND);
    expect(fs.readdirSync(temporary).sort()).toEqual(['fake-pdftoppm', 'fake-tesseract', 'scan.pdf']);
    fs.rmSync(temporary, {recursive: true, force: true});
  });

  it('extracts PPTX slide text and speaker notes in order', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-pptx-'));
    const file = path.join(temporary, 'roadmap.pptx');
    const archive = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide2.xml': strToU8('<a:t>Second</a:t>'),
      'ppt/slides/slide1.xml': strToU8('<a:t>First</a:t>'),
      'ppt/notesSlides/notesSlide1.xml': strToU8('<a:t>Remember this</a:t>'),
    });
    fs.writeFileSync(file, archive);
    expect(extractPptx(file)).toMatchObject({format: 'pptx', pageOrSlideCount: 2, text: expect.stringMatching(/Slide 1[\s\S]*First[\s\S]*Remember this[\s\S]*Slide 2[\s\S]*Second/)});
    fs.rmSync(temporary, {recursive: true, force: true});
  });

  it('allows empty PowerPoint embedding folders but still rejects embedded object files', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-pptx-'));
    const safe = path.join(temporary, 'safe.pptx');
    const unsafe = path.join(temporary, 'unsafe.pptx');
    const base = {
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml': strToU8('<a:t>Normal presentation</a:t>'),
      'ppt/embeddings/': new Uint8Array(),
    };
    fs.writeFileSync(safe, zipSync(base));
    fs.writeFileSync(unsafe, zipSync({...base, 'ppt/embeddings/workbook.xlsx': strToU8('embedded')}));
    expect(extractPptx(safe).text).toContain('Normal presentation');
    expect(() => extractPptx(unsafe)).toThrow(/embedded objects/);
    fs.rmSync(temporary, {recursive: true, force: true});
  });

  it('accepts an exact-origin streamed upload and deletes the temporary binary', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-loopback-'));
    process.env.TRACEMINI_HOME = home;
    saveConfig({...loadConfig(), serverUrl: 'https://trace.example', workspaceId: 7, agentId: 9});
    let temporaryPath = '';
    let derivations = 0;
    const server = http.createServer(createDocumentLoopbackHandler({derive: async file => {
      derivations += 1;
      temporaryPath = file;
      expect(fs.readFileSync(file).toString()).toBe('fake-pptx');
      return {extracted: {format: 'pptx', pageOrSlideCount: 2, text: 'bounded', warnings: []}, metadata: document.metadata};
    }}));
    const status = (await request(server).get('/v1/status').set('Host', '127.0.0.1:43127').set('Origin', 'https://trace.example').expect(200)).body;
    const result = (await request(server).post('/v1/documents/derive-metadata').set('Host', '127.0.0.1:43127').set('Origin', 'https://trace.example').set('x-tracemini-nonce', status.nonce).set('x-tracemini-consent', 'true').set('x-tracemini-workspace', '7').set('x-tracemini-file-name', encodeURIComponent('roadmap.pptx')).set('content-type', 'application/octet-stream').send(Buffer.from('fake-pptx')).expect(201)).body;
    expect(result).toMatchObject({displayName: 'roadmap.pptx', pageOrSlideCount: 2});
    expect(fs.existsSync(temporaryPath)).toBe(false);
    expect(loadConfig().documents).toHaveLength(1);
    const duplicateStatus = (await request(server).get('/v1/status').set('Host', '127.0.0.1:43127').set('Origin', 'https://trace.example').expect(200)).body;
    const duplicate = (await request(server).post('/v1/documents/derive-metadata').set('Host', '127.0.0.1:43127').set('Origin', 'https://trace.example').set('x-tracemini-nonce', duplicateStatus.nonce).set('x-tracemini-consent', 'true').set('x-tracemini-workspace', '7').set('x-tracemini-file-name', encodeURIComponent('renamed.pptx')).set('content-type', 'application/octet-stream').send(Buffer.from('fake-pptx')).expect(200)).body;
    expect(duplicate.localId).toBe(result.localId);
    expect(derivations).toBe(1);
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('rejects unsupported upload media types before reading bytes', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-loopback-'));
    process.env.TRACEMINI_HOME = home;
    saveConfig({...loadConfig(), serverUrl: 'https://trace.example', workspaceId: 7, agentId: 9});
    const server = http.createServer(createDocumentLoopbackHandler());
    const status = (await request(server).get('/v1/status').set('Host', '127.0.0.1:43127').set('Origin', 'https://trace.example').expect(200)).body;
    await request(server).post('/v1/documents/derive-metadata').set('Host', '127.0.0.1:43127').set('Origin', 'https://trace.example').set('x-tracemini-nonce', status.nonce).set('x-tracemini-consent', 'true').set('x-tracemini-workspace', '7').set('x-tracemini-file-name', encodeURIComponent('roadmap.pptx')).set('content-type', 'text/plain').send('not a presentation').expect(415);
    expect(loadConfig().documents).toHaveLength(0);
    fs.rmSync(home, {recursive: true, force: true});
  });
});
