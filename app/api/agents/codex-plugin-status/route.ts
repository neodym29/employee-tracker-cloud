import {NextResponse} from 'next/server';
import {ApiError,requireApiSession} from '@/lib/api';
import {NodeInstallError} from '@/lib/tracemini-install';
import {codexPluginBrowserStatus} from '@/lib/tracemini-node-git';

const headers={'cache-control':'no-store, private'};

export async function GET(){
  try {
    return NextResponse.json(await codexPluginBrowserStatus(await requireApiSession('engineer')),{headers});
  } catch(error) {
    const known=error instanceof ApiError||error instanceof NodeInstallError;
    return NextResponse.json({ok:false,error:'Plugin connection status could not be checked.'},{status:known?error.status:500,headers});
  }
}
