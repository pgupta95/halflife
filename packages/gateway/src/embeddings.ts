import { GoogleAuth } from 'google-auth-library';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../../../.env') });

export async function generateEmbedding(text: string): Promise<number[]> {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });

  const token = await auth.getAccessToken();
  const projectId = process.env.GCP_PROJECT_ID || 'halflife-506215';
  const region = process.env.GCP_REGION || 'us-central1';

  // Use text-embedding-004 with 768 dimensions (max supported)
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/text-embedding-004:predict`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      instances: [{ content: text }],
      parameters: {
        outputDimensionality: 768
      }
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`Embedding API Error: ${data.error.message}`);
  }

  return data.predictions[0].embeddings.values;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// §3.4: drift = 1 - cosine_similarity
export function calculateDrift(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}
