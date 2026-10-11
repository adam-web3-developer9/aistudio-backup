import path from 'node:path';
import { systemOptionsFromEnv } from './index.js';
import { buildSystemWebApp } from './web-app.js';
const options=systemOptionsFromEnv();
const {app}=await buildSystemWebApp({...options,
  mediaDirectory:process.env.SYSTEM_MEDIA_DIRECTORY??path.join(path.dirname(options.databasePath),'private-media'),
  adminDirectory:process.env.SYSTEM_ADMIN_DIRECTORY??'apps/admin/dist',
  credentialKey:process.env.CHANNEL_CREDENTIAL_KEY,
  channelsEnabled:process.env.SYSTEM_CHANNELS_ENABLED==='true',
  trustProxy:process.env.SYSTEM_TRUST_PROXY?.split(',').map(value=>value.trim()).filter(Boolean),
  mediaPolicy:{uploadTimeoutMs:process.env.SYSTEM_MEDIA_UPLOAD_TIMEOUT_MS?Number(process.env.SYSTEM_MEDIA_UPLOAD_TIMEOUT_MS):undefined,maxFileBytes:process.env.SYSTEM_MEDIA_MAX_FILE_BYTES?Number(process.env.SYSTEM_MEDIA_MAX_FILE_BYTES):undefined,projectBytes:process.env.SYSTEM_MEDIA_PROJECT_BYTES?Number(process.env.SYSTEM_MEDIA_PROJECT_BYTES):undefined,ownerBytes:process.env.SYSTEM_MEDIA_OWNER_BYTES?Number(process.env.SYSTEM_MEDIA_OWNER_BYTES):undefined},
});
const shutdown=async()=>{await app.close();process.exit(0);};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
try{await app.listen({host:process.env.SYSTEM_HOST??'127.0.0.1',port:Number(process.env.SYSTEM_PORT??'3001')});}
catch(error){app.log.error(error);await app.close();process.exit(1);}
