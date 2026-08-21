import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../../../.env') });

export interface ModelResponse {
  content: string;
  parsed?: unknown;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number;
  rawResponse: unknown;
}

export interface ModelGatewayOptions {
  projectId: string;
  region: string;
  model: string;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
}

export class ModelGateway {
  private auth: GoogleAuth;
  private projectId: string;
  private region: string;
  private model: string;
  private inputCostPerMtok: number;
  private outputCostPerMtok: number;

  constructor(options: ModelGatewayOptions) {
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    this.projectId = options.projectId;
    this.region = options.region;
    this.model = options.model;
    this.inputCostPerMtok = options.inputCostPerMtok;
    this.outputCostPerMtok = options.outputCostPerMtok;
  }

  async generate(params: {
    systemPrompt?: string;
    userPrompt: string;
    schema?: z.ZodType;
    temperature?: number;
  }): Promise<ModelResponse> {
    const startTime = Date.now();

    const token = await this.auth.getAccessToken();
    const url = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${this.model}:generateContent`;

    const requestBody: any = {
      contents: [{
        role: 'user',
        parts: [{ text: params.userPrompt }]
      }],
      generationConfig: {
        temperature: params.temperature ?? 1.0,
        maxOutputTokens: 8192
      }
    };

    if (params.systemPrompt) {
      requestBody.systemInstruction = {
        parts: [{ text: params.systemPrompt }]
      };
    }

    if (params.schema) {
      requestBody.generationConfig.responseMimeType = 'application/json';
      requestBody.generationConfig.responseSchema = this.zodToGeminiSchema(params.schema);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(`Vertex AI Error: ${data.error.message}`);
    }

    const latencyMs = Date.now() - startTime;

    // Extract content
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extract token usage
    const promptTokens = data.usageMetadata?.promptTokenCount || 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount || 0;

    // Calculate cost
    const costUsd =
      (promptTokens / 1_000_000) * this.inputCostPerMtok +
      (completionTokens / 1_000_000) * this.outputCostPerMtok;

    // Parse if schema provided
    let parsed: unknown = undefined;
    if (params.schema && content) {
      try {
        const jsonContent = JSON.parse(content);
        parsed = params.schema.parse(jsonContent);
      } catch (err) {
        console.error('Failed to parse response:', err);
        console.error('Content:', content);
        throw new Error(`Response parsing failed: ${err}`);
      }
    }

    return {
      content,
      parsed,
      promptTokens,
      completionTokens,
      latencyMs,
      costUsd,
      rawResponse: data
    };
  }

  private zodToGeminiSchema(schema: z.ZodType): any {
    if (schema instanceof z.ZodObject) {
      const shape = schema._def.shape();
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = this.zodTypeToGeminiType(value as z.ZodType);
        if (!(value as any).isOptional()) {
          required.push(key);
        }
      }

      return {
        type: 'OBJECT',
        properties,
        required: required.length > 0 ? required : undefined
      };
    }

    throw new Error('Only ZodObject schemas are currently supported');
  }

  private zodTypeToGeminiType(zodType: z.ZodType): any {
    if (zodType instanceof z.ZodString) {
      return { type: 'STRING' };
    } else if (zodType instanceof z.ZodNumber) {
      return { type: 'NUMBER' };
    } else if (zodType instanceof z.ZodBoolean) {
      return { type: 'BOOLEAN' };
    } else if (zodType instanceof z.ZodArray) {
      return {
        type: 'ARRAY',
        items: this.zodTypeToGeminiType(zodType._def.type)
      };
    } else if (zodType instanceof z.ZodObject) {
      return this.zodToGeminiSchema(zodType);
    } else if (zodType instanceof z.ZodEnum) {
      return {
        type: 'STRING',
        enum: zodType._def.values
      };
    } else if (zodType instanceof z.ZodOptional) {
      return this.zodTypeToGeminiType(zodType._def.innerType);
    }

    return { type: 'STRING' };
  }
}

export function createGateway(modelKey: string = 'gemini-2.5-flash'): ModelGateway {
  const projectId = process.env.GCP_PROJECT_ID!;
  const region = process.env.GCP_REGION || 'us-central1';

  if (!projectId) {
    throw new Error('GCP_PROJECT_ID environment variable is required');
  }

  const costs: Record<string, { input: number; output: number }> = {
    'gemini-2.5-flash': { input: 0.075, output: 0.30 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 }
  };

  const modelCost = costs[modelKey] || costs['gemini-2.5-flash'];

  return new ModelGateway({
    projectId,
    region,
    model: modelKey,
    inputCostPerMtok: modelCost.input,
    outputCostPerMtok: modelCost.output
  });
}
