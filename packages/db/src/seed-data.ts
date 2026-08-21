#!/usr/bin/env node
import { db } from './client.js';
import { seeds, knownQuantities, models, promptTemplates } from './schema.js';

export async function seedDatabase() {
  console.log('Seeding database...');

  // Insert seeds
  await db.insert(seeds).values([
    {
      slug: 'taycan-macbook',
      domain: 'energy',
      questionText: 'How many MacBook Airs could you fully charge with the battery in a Porsche Taycan?'
    },
    {
      slug: 'gas-tank-laptop',
      domain: 'energy_to_time',
      questionText: 'How long could you run a laptop on the energy in one full tank of gasoline?'
    },
    {
      slug: 'cyclists-house',
      domain: 'power',
      questionText: 'How many cyclists pedaling flat out would it take to power a typical suburban home?'
    },
    {
      slug: 'wikipedia-aloud',
      domain: 'time',
      questionText: 'How long would it take to read every English Wikipedia article aloud at normal speaking pace?'
    },
    {
      slug: 'breath-flight',
      domain: 'mass',
      questionText: "How many years of a person's exhaled carbon dioxide equals the carbon dioxide from one transatlantic flight?"
    }
  ]).onConflictDoNothing();

  // Insert known quantities (reference constants)
  await db.insert(knownQuantities).values([
    {
      entityLabel: 'Porsche Taycan Performance Battery Plus capacity',
      normalizedKey: 'porsche taycan battery capacity',
      value: '93.4',
      unit: 'kWh',
      dimension: 'energy',
      sourceUrl: 'https://www.porsche.com/usa/models/taycan/taycan-models/',
      verifiedByHuman: true
    },
    {
      entityLabel: 'MacBook Air M3 battery capacity',
      normalizedKey: 'macbook air m3 battery capacity',
      value: '52.6',
      unit: 'Wh',
      dimension: 'energy',
      sourceUrl: 'https://support.apple.com/kb/SP918',
      verifiedByHuman: true
    },
    {
      entityLabel: 'Gasoline energy density',
      normalizedKey: 'gasoline energy density',
      value: '34.2',
      unit: 'MJ/L',
      dimension: 'energy_density',
      sourceUrl: 'https://en.wikipedia.org/wiki/Energy_density',
      verifiedByHuman: true
    },
    {
      entityLabel: 'Typical car fuel tank capacity',
      normalizedKey: 'car fuel tank capacity',
      value: '55',
      unit: 'L',
      dimension: 'volume',
      sourceUrl: 'https://www.caranddriver.com',
      verifiedByHuman: true
    },
    {
      entityLabel: 'Laptop average power draw',
      normalizedKey: 'laptop power draw',
      value: '50',
      unit: 'W',
      dimension: 'power',
      sourceUrl: 'https://energyusecalculator.com',
      verifiedByHuman: true
    },
    {
      entityLabel: 'Trained cyclist sustained power output',
      normalizedKey: 'cyclist power output',
      value: '200',
      unit: 'W',
      dimension: 'power',
      sourceUrl: 'https://www.cyclinganalytics.com',
      verifiedByHuman: true
    },
    {
      entityLabel: 'US household average power draw',
      normalizedKey: 'household power draw',
      value: '1200',
      unit: 'W',
      dimension: 'power',
      sourceUrl: 'https://www.eia.gov',
      verifiedByHuman: true
    },
    {
      entityLabel: 'English Wikipedia article count',
      normalizedKey: 'wikipedia article count',
      value: '7000000',
      unit: 'articles',
      dimension: 'count',
      sourceUrl: 'https://en.wikipedia.org/wiki/Wikipedia:Size_of_Wikipedia',
      verifiedByHuman: true
    },
    {
      entityLabel: 'Average Wikipedia article length',
      normalizedKey: 'wikipedia article length',
      value: '650',
      unit: 'words',
      dimension: 'count',
      sourceUrl: 'https://en.wikipedia.org/wiki/Wikipedia:Statistics',
      verifiedByHuman: true
    },
    {
      entityLabel: 'Normal speaking pace',
      normalizedKey: 'speaking pace',
      value: '150',
      unit: 'words/min',
      dimension: 'rate',
      sourceUrl: 'https://virtualspeech.com/blog/average-speaking-rate-words-per-minute',
      verifiedByHuman: true
    },
    {
      entityLabel: 'Human exhaled CO2 per day',
      normalizedKey: 'human co2 exhaled',
      value: '1.0',
      unit: 'kg/day',
      dimension: 'mass_rate',
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3632990/',
      verifiedByHuman: true
    },
    {
      entityLabel: 'Transatlantic flight CO2 per passenger',
      normalizedKey: 'transatlantic flight co2',
      value: '1000',
      unit: 'kg',
      dimension: 'mass',
      sourceUrl: 'https://www.carbonindependent.org',
      verifiedByHuman: true
    }
  ]).onConflictDoNothing();

  // Insert Gemini Flash 2.0 model
  await db.insert(models).values({
    provider: 'google',
    modelKey: 'gemini-2.0-flash-exp',
    pinnedVersion: null,
    displayName: 'Gemini 2.0 Flash (Experimental)',
    inputCostPerMtok: '0.30',
    outputCostPerMtok: '2.50',
    metadata: {
      maxConcurrency: 10,
      vertexModel: 'gemini-2.0-flash-exp',
      supportsStructuredOutput: true
    }
  }).onConflictDoNothing();

  // Insert prompt templates
  await db.insert(promptTemplates).values([
    {
      name: 'system_mutate',
      version: 1,
      body: `You write short quantitative comparison questions of the kind used in physics
and engineering estimation problems.

A good question of this kind:
- asks for a single number as its answer
- compares two real, measurable things
- can be worked out from published figures and arithmetic alone
- is one sentence, and names no units itself

Respond with JSON only. No preamble, no explanation, no markdown fences.`,
      outputSchema: {}
    },
    {
      name: 'mutate_question',
      version: 1,
      body: `Here are the most recent questions in this set, oldest first:

{{questions}}

Write the next question in this set.`,
      outputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'One sentence. Ends with a question mark.'
          }
        },
        required: ['question'],
        additionalProperties: false
      }
    },
    {
      name: 'extract_structure',
      version: 1,
      body: `Extract the quantitative structure of this comparison question:

{{question}}

Identify:
- the two quantities being compared
- the physical dimension of each (energy, mass, time, distance, power, volume, count, rate, or unknown)
- every named entity whose real-world measured value is needed to answer it

List an entity even if you are unsure it exists. Do not correct, improve, or comment on the question. Do not answer it.`,
      outputSchema: {
        type: 'object',
        properties: {
          quantity_a: { type: 'string' },
          dimension_a: { type: 'string', enum: ['energy','mass','time','distance','power','volume','count','rate','unknown'] },
          relation: { type: 'string' },
          quantity_b: { type: 'string' },
          dimension_b: { type: 'string', enum: ['energy','mass','time','distance','power','volume','count','rate','unknown'] },
          referents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                needed_dimension: { type: 'string' }
              },
              required: ['label', 'needed_dimension'],
              additionalProperties: false
            }
          },
          parse_failed: { type: 'boolean' }
        },
        required: ['quantity_a','dimension_a','relation','quantity_b','dimension_b','referents','parse_failed'],
        additionalProperties: false
      }
    }
  ]).onConflictDoNothing();

  console.log('Database seeded successfully!');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
