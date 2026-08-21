import { GoogleAuth } from 'google-auth-library';

async function testDirectAPI() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });

  const token = await auth.getAccessToken();
  console.log('Got access token:', token?.substring(0, 20) + '...');

  // Try the correct endpoint format with project and location
  const projectId = process.env.GCP_PROJECT_ID || 'halflife-506215';
  const location = 'us-central1';

  // Try multiple model names
  const modelsToTry = [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro'
  ];

  for (const model of modelsToTry) {
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
    console.log(`\nTrying ${model}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: 'Say hello in 3 words' }]
        }],
        generationConfig: {
          maxOutputTokens: 10
        }
      })
    });

    const data = await response.json();

    if (!data.error) {
      console.log(`✅ ${model} WORKS!`);
      console.log('Response:', JSON.stringify(data, null, 2));
      process.exit(0);
    } else {
      console.log(`❌ ${model}: ${data.error.message.substring(0, 100)}`);
    }
  }

  console.log('\nNo working model found!');
  process.exit(1);
}

testDirectAPI().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
