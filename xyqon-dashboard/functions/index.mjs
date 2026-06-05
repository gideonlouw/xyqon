import { onRequest } from 'firebase-functions/v2/https';
import { handleRequest } from './xyqon-api.mjs';

export const xyqonApi = onRequest(
  {
    cors: true,
    timeoutSeconds: 30,
    memory: '256MiB',
    region: 'us-central1'
  },
  handleRequest
);
