import { NextRequest, NextResponse } from 'next/server';
import { ApiError, apiErrorResponse, assertSameOrigin, requireApiSession } from '@/lib/api';
import { removeOwnPhoto, saveOwnPhoto } from '@/lib/profiles';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireApiSession();
    if (Number(req.headers.get('content-length') || 0) > 2.5 * 1024 * 1024) throw new ApiError('Photo is too large', 413, 'photo_too_large');
    const form = await req.formData();
    const file = form.get('photo');
    if (!(file instanceof File)) throw new ApiError('Choose a photo', 400, 'photo_missing');
    const profile = await saveOwnPhoto(session, Buffer.from(await file.arrayBuffer()), file.type);
    return NextResponse.json({ ok: true, profile }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function DELETE(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const profile = await removeOwnPhoto(await requireApiSession());
    return NextResponse.json({ ok: true, profile }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}
