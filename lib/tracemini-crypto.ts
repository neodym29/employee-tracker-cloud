import 'server-only';
import crypto from 'node:crypto';

export type TraceMiniCredentialEnvelope = { version: 1; ciphertext: Buffer; iv: Buffer; tag: Buffer };
const AAD_VERSION = 'employee-tracker-cloud:tracemini:v1';

function encryptionKey(): Buffer {
  const encoded = process.env.TRACEMINI_ENCRYPTION_KEY;
  if (!encoded) throw new Error('TRACEMINI_ENCRYPTION_KEY is required');
  const key = Buffer.from(encoded, 'base64');
  // Buffer's base64 decoder is permissive, so require canonical base64 as well as length.
  const canonical = encoded.replace(/\s/g, '').replace(/=+$/, '');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== canonical) {
    throw new Error('TRACEMINI_ENCRYPTION_KEY must be exactly 32 decoded bytes of base64');
  }
  return key;
}

function aad(projectId: string) {
  return Buffer.from(`${AAD_VERSION}:project:${projectId}`, 'utf8');
}

export function encryptTraceMiniCredential(projectId: string, credential: string): TraceMiniCredentialEnvelope {
  if (!credential || credential.length > 16_384) throw new Error('A TraceMini credential is required');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv, { authTagLength: 16 });
  cipher.setAAD(aad(projectId));
  const ciphertext = Buffer.concat([cipher.update(credential, 'utf8'), cipher.final()]);
  return { version: 1, ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptTraceMiniCredential(projectId: string, envelope: TraceMiniCredentialEnvelope): string {
  if (Number(envelope.version) !== 1 || Buffer.from(envelope.iv).length !== 12 || Buffer.from(envelope.tag).length !== 16) {
    throw new Error('Unsupported TraceMini credential envelope');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(envelope.iv), { authTagLength: 16 });
  decipher.setAAD(aad(projectId));
  decipher.setAuthTag(Buffer.from(envelope.tag));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext)), decipher.final()]).toString('utf8');
}
