import { VertexAI } from '@google-cloud/vertexai';

async function findGemini3Models() {
  const projectId = 'halflife-506215';
  const region = 'us-central1';

  console.log('Testing potential Gemini 3.x model names...\n');

  const potentialNames = [
    'gemini-3.0-flash',
    'gemini-3-flash',
    'gemini-3.0-flash-exp',
    'gemini-3-flash-exp',
    'gemini-3.0-flash-preview',
    'gemini-3-pro',
    'gemini-3.0-pro',
    // Also test 2.0 variants
    'gemini-2.0-flash',
    'gemini-2.0-flash-exp',
    'gemini-2-flash'
  ];

  for (const modelName of potentialNames) {
    try {
      const vertex = new VertexAI({ project: projectId, location: region });
      const model = vertex.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.5, maxOutputTokens: 10 }
      });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }]
      });

      const response = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log(`✅ ${modelName} - WORKS! Response: "${response.substring(0, 50)}"`);

      // Found a working model, stop
      console.log(`\n🎯 Use this model: ${modelName}`);
      break;
    } catch (err: any) {
      if (err.message?.includes('404')) {
        console.log(`❌ ${modelName} - NOT FOUND`);
      } else {
        console.log(`⚠️  ${modelName} - Error: ${err.message?.substring(0, 80)}`);
      }
    }
  }

  process.exit(0);
}

findGemini3Models();
