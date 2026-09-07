import {describe, expect, it, vi} from 'vitest';
import {localAgentFetch, OCR_INSTALL_COMMAND, requiresOcrInstall} from '../apps/web/document-context.js';

describe('local document agent availability', () => {
  it('recognizes only the missing local OCR dependency guidance', () => {
    expect(OCR_INSTALL_COMMAND).toBe('sudo apt-get install -y poppler-utils tesseract-ocr');
    expect(requiresOcrInstall(new Error(`Local OCR is unavailable. Run: ${OCR_INSTALL_COMMAND}`))).toBe(true);
    expect(requiresOcrInstall(new Error('This scanned PDF needs local OCR, but pdftoppm is not installed.'))).toBe(true);
    expect(requiresOcrInstall(new Error('Install the tesseract-ocr package, then try again.'))).toBe(true);
    expect(requiresOcrInstall(new Error('No readable text was found in the scanned PDF.'))).toBe(false);
  });

  it('waits for a restarting service before reporting success', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValue(new Response(JSON.stringify({ok: true}), {status: 200}));
    const wait = vi.fn(async () => undefined);

    await expect(localAgentFetch('/v1/status', {}, request, wait)).resolves.toEqual({ok: true});
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[250], [500]]);
  });

  it('gives recovery instructions after the local service remains unreachable', async () => {
    const request = vi.fn().mockRejectedValue(new TypeError('connection refused'));

    await expect(localAgentFetch('/v1/status', {}, request, async () => undefined))
      .rejects.toThrow(/systemctl --user restart tracemini\.service/);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not retry a response from a running agent', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({error: 'local document request rejected'}), {status: 403}));

    await expect(localAgentFetch('/v1/status', {}, request)).rejects.toThrow('local document request rejected');
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not replay document uploads after an ambiguous network failure', async () => {
    const request = vi.fn().mockRejectedValue(new TypeError('connection reset'));

    await expect(localAgentFetch('/v1/documents/derive-metadata', {method: 'POST'}, request, async () => undefined))
      .rejects.toThrow(/not reachable/);
    expect(request).toHaveBeenCalledOnce();
  });
});
