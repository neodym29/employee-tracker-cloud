import { NextRequest, NextResponse } from 'next/server';
import { ApiError, assertSameOrigin, requireApiSession } from './api';
import { bearerSecret, boundedAgentJson, FilesAgentError } from './files-agent';
import { NodeInstallError, exactBody, trustedNodeOrigin, mintNodeInstallation, listNodeInstallations, exchangeNodeInstallation, nodeDeviceStatus, validateNodeInstallation } from './tracemini-install';
import { linuxInstallCommand, linuxInstaller } from '../build/tracemini/installer.mjs';
import path from 'node:path';
import { agentSetupPrompt } from './tracemini-setup-prompt';
const headers={'cache-control':'no-store, private','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
// Do not call generic apiErrorResponse: its catch-all logs error objects/SQL parameters.
export function nodeInstallError(error:unknown){
  const known=error instanceof NodeInstallError || error instanceof ApiError || error instanceof FilesAgentError;
  const status=known?error.status:500;
  const code=error instanceof NodeInstallError ? error.code : error instanceof ApiError ? error.code : error instanceof FilesAgentError ? 'invalid_request' : 'installation_request_failed';
  return NextResponse.json({ok:false,code,error:code},{status,headers});
}
export async function installationsGet(){try{return NextResponse.json(await listNodeInstallations(await requireApiSession()),{headers});}catch(e){return nodeInstallError(e);}}
export async function installationsPost(req:NextRequest){try{
  const user=await requireApiSession();assertSameOrigin(req);exactBody(await boundedAgentJson(req),[]);
  const origin=trustedNodeOrigin();const minted=await mintNodeInstallation(user);
  const installCommand=linuxInstallCommand(origin,minted.token);
  return NextResponse.json({installCommand,setupPrompt:agentSetupPrompt(installCommand),expiresAt:minted.expiresAt,state:'pending_sync',syncEnabled:false},{headers});
}catch(e){return nodeInstallError(e);}}
// Legacy URL credentials are deliberately never accepted, even when valid.
export async function installerGet(){return NextResponse.json({ok:false,code:'installer_url_disabled'},{status:410,headers});}
export async function installerPost(req:NextRequest){try{
  if(new URL(req.url).search)throw new NodeInstallError(400,'invalid_request');
  const input=await boundedAgentJson(req);exactBody(input,['installToken']);
  const token=input.installToken;
  if(typeof token!=='string')throw new NodeInstallError(403,'invalid_or_expired_credential');
  await validateNodeInstallation(token);
  const body=linuxInstaller(path.join(process.cwd(),'build/tracemini/cli'),trustedNodeOrigin(),token);
  return new NextResponse(body,{headers:{...headers,'content-type':'text/x-shellscript; charset=utf-8','content-disposition':'attachment; filename="employee-trace-install.sh"'}});
}catch(e){return nodeInstallError(e);}}
export async function exchangePost(req:NextRequest){try{return NextResponse.json(await exchangeNodeInstallation(await boundedAgentJson(req),bearerSecret(req)),{headers});}catch(e){return nodeInstallError(e);}}
export async function abortPost(req:NextRequest){try{
  if(req.headers.get('content-length')!=='0' && req.body)exactBody(await boundedAgentJson(req),[]);
  return NextResponse.json(await nodeDeviceStatus(bearerSecret(req),true),{headers});
}catch(e){return nodeInstallError(e);}}
export async function statusGet(req:NextRequest){try{return NextResponse.json(await nodeDeviceStatus(bearerSecret(req)),{headers});}catch(e){return nodeInstallError(e);}}
