export type DeliveryHealth = {state:'paused'|'disconnected'|'awaiting'|'received';label:string;detail:string;lastReceivedAt:string|null};
export function deliveryHealth(input:{paused?:boolean;enabled?:boolean;online?:boolean;received?:unknown}):DeliveryHealth {
 const time=input.received?new Date(input.received as string):null;
 const lastReceivedAt=time&&Number.isFinite(time.getTime())?time.toISOString():null;
 const receipt=lastReceivedAt?` Last received ${lastReceivedAt}. Receipt time is not change time; Git history does not capture current uncommitted work.`:'';
 if(input.paused || input.enabled!==true)return {state:'paused',label:'Uploads paused',detail:'Repository selection and registration do not enable uploads.'+receipt,lastReceivedAt};
 if(input.online===false)return {state:'disconnected',label:'Device disconnected',detail:'No recent device contact. Delivery is not confirmed as active.'+receipt,lastReceivedAt};
 if(!lastReceivedAt)return {state:'awaiting',label:'Awaiting first activity',detail:'Registered or selected does not mean activity has been delivered.',lastReceivedAt:null};
 return {state:'received',label:'Activity received',detail:receipt.trim(),lastReceivedAt};
}
export function emptyRecentActivity(health:DeliveryHealth):string {
 const status=health.state==='paused'?' Neo-Nexus uploads are paused.':health.state==='disconnected'?' The Neo-Nexus device is offline.':'';
 return `No changes were recorded in this period.${status} This does not rule out work that Neo-Nexus did not capture.`;
}
