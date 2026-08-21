import { VertexAI } from '@google-cloud/vertexai';

async function listModels() {
  const projectId = process.env.GCP_PROJECT_ID || 'halflife-506215';
  const region = process.env.GCP_REGION || 'us-central1';

  console.log(`Checking available models in ${projectId}/${region}...\n`);

  // Try to call a simple model to see what's available
  const testModels = [
    'gemini-2.0-flash-exp',
    'gemini-1.5-flash',
    'gemini-1.5-flash-002',
    'gemini-1.5-pro',
    'gemini-1.5-pro-002',
    'gemini-pro'
  ];

  for (const modelName of testModels) {
    try {
      const vertex = new VertexAI({ project: projectId, location: region });
      const model = vertex.getGenerativeModel({ model: modelName });

      console.log(`✅ ${modelName} - AVAILABLE`);
    } catch (err: any) {
      if (err.message?.includes('404') || err.message?.includes('not found')) {
        console.log(`❌ ${modelName} - NOT FOUND`);
      } else {
        console.log(`⚠️  ${modelName} - ${err.message?.substring(0, 100)}`);
      }
    }
  }

  console.log('\nTrying to make a test call to gemini-1.5-flash-002...');

  try {
    const vertex = new VertexAI({ project: projectId, location: region });
    const model = vertex.getGenerativeModel({
      model: 'gemini-1.5-flash-002',
      generationConfig: { temperature: 0.9, maxOutputTokens: 50 }
    });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'Say "Hello World" and nothing else.' }] }]
    });

    const response = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`\n✅ SUCCESS! Model response: "${response}"`);
    console.log(`\nUse model: gemini-1.5-flash-002`);
  } catch (err: any) {
    console.error(`\n❌ Failed:`, err.message);
  }

  process.exit(0);
}

listModels();
