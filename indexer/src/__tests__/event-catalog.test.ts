import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Import parser so we can extract its topic map, but unfortunately TOPIC_MAP is not exported.
// We'll read parser.ts as string and extract it, or we can just parse the file.
// Since it's a test, let's extract the TOPIC_MAP statically or mock it.
// Actually, reading parser.ts directly is robust enough.

describe('Event Catalog Completeness', () => {
  it('should have all contract events handled in the indexer parser', () => {
    // 1. Read EVENTS.md from contracts
    const eventsMdPath = path.resolve(__dirname, '../../../contracts/soroban-marketplace/EVENTS.md');
    const mdContent = fs.readFileSync(eventsMdPath, 'utf8');

    // Extract the JSON block
    const jsonMatch = mdContent.match(/```json\n([\s\S]+?)\n```/);
    expect(jsonMatch).toBeTruthy();
    const eventCatalog = JSON.parse(jsonMatch![1]);
    const catalogTopics = Object.values(eventCatalog).map((e: any) => e.topic);

    // 2. Read parser.ts to extract handled topics
    const parserTsPath = path.resolve(__dirname, '../parser.ts');
    const parserContent = fs.readFileSync(parserTsPath, 'utf8');

    // Extract TOPIC_MAP keys
    const topicMapMatch = parserContent.match(/const TOPIC_MAP: Record<string, string> = {([\s\S]+?)};/);
    expect(topicMapMatch).toBeTruthy();
    const topicMapContent = topicMapMatch![1];
    
    // Find all keys, e.g. 'listing_created': ...
    const parserTopics = Array.from(topicMapContent.matchAll(/'([a-z_]+)'\s*:/g)).map(m => m[1]);

    // 3. Assert all catalog topics are in the parser
    const missingTopics = catalogTopics.filter(topic => !parserTopics.includes(topic));
    expect(missingTopics).toEqual([]);
  });
});
