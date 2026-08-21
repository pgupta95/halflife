import { GoogleGenAI } from '@google/genai';
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
  private client: GoogleGenAI;
  private model: string;
  private inputCostPerMtok: number;
  private outputCostPerMtok: number;

  constructor(options: ModelGatewayOptions) {
    this.client = new GoogleGenAI({
      project: options.projectId,
      location: options.region
    });
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

    const config: any = {
      temperature: params.temperature ?? 1.0
    };

    if (params.schema) {
      config.responseMimeType = 'application/json';
      config.responseSchema = this.zodToGeminiSchema(params.schema);
    }

    const generativeModel = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: config,
      systemInstruction: params.systemPrompt
    });

    const result = await generativeModel.generateContent(params.userPrompt);
    const latencyMs = Date.now() - startTime;

    const content = result.response.text();

    // Extract token usage
    const promptTokens = result.response.usageMetadata?.promptTokenCount || 0;
    const completionTokens = result.response.usageMetadata?.candidatesTokenCount || 0;

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
      rawResponse: result.response
    };
  }

  private zodToGeminiSchema(schema: z.ZodType): any {
    // Convert Zod schema to Gemini's OpenAPI subset
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
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined
      };
    }

    throw new Error('Only ZodObject schemas are currently supported');
  }

  private zodTypeToGeminiType(zodType: z.ZodType): any {
    if (zodType instanceof z.ZodString) {
      return { type: 'string' };
    } else if (zodType instanceof z.ZodNumber) {
      return { type: 'number' };
    } else if (zodType instanceof z.ZodBoolean) {
      return { type: 'boolean' };
    } else if (zodType instanceof z.ZodArray) {
      return {
        type: 'array',
        items: this.zodTypeToGeminiType(zodType._def.type)
      };
    } else if (zodType instanceof z.ZodObject) {
      return this.zodToGeminiSchema(zodType);
    } else if (zodType instanceof z.ZodEnum) {
      return {
        type: 'string',
        enum: zodType._def.values
      };
    } else if (zodType instanceof z.ZodOptional) {
      return this.zodTypeToGeminiType(zodType._def.innerType);
    }

    return { type: 'string' }; // fallback
  }
}

// Factory function to create gateway from environment
export function createGateway(modelKey: string = 'gemini-2.0-flash-exp'): ModelGateway {
  const projectId = process.env.GCP_PROJECT_ID!;
  const region = process.env.GCP_REGION || 'us-central1';

  if (!projectId) {
    throw new Error('GCP_PROJECT_ID environment variable is required');
  }

  // Model costs for latest models
  const costs: Record<string, { input: number; output: number }> = {
    'gemini-3.0-flash': { input: 0.10, output: 0.40 }, // Gemini 3.x - latest generation
    'gemini-2.0-flash-exp': { input: 0, output: 0 }, // Free during preview
    'gemini-1.5-flash-002': { input: 0.075, output: 0.30 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
    'gemini-1.5-pro-002': { input: 1.25, output: 5.00 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 }
  };

  const modelCost = costs[modelKey] || costs['gemini-3.0-flash'];

  return new ModelGateway({
    projectId,
    region,
    model: modelKey,
    inputCostPerMtok: modelCost.input,
    outputCostPerMtok: modelCost.output
  });
}
