import { NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { getVisiblePhoto } from '@/lib/profiles';

type Context = { params: Promise<{ userId: string }> };

export async function GET(_req: Request, context: Context) {
  try {
    const { userId } = await context.params;
    const photo = await getVisiblePhoto(await requireApiSession(), userId);
    return new NextResponse(new Uint8Array(photo), {
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'no-store, private',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) { return apiErrorResponse(error); }
}
