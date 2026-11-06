import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inlineSchemaRefs, sanitizeToolsReply } from '../lib/proxy.mjs';

const sectionDef = {
  $defs: {
    Section: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        sets: { type: 'array', items: { $ref: '#/$defs/Section' } },
      },
      required: ['name'],
    },
  },
};

test('inlineSchemaRefs removes $ref/$defs and inlines the first levels', () => {
  const schema = {
    ...sectionDef,
    type: 'object',
    properties: {
      section: { $ref: '#/$defs/Section' },
      sections: { type: 'array', items: { $ref: '#/$defs/Section' } },
    },
  };
  const out = inlineSchemaRefs(schema);
  const text = JSON.stringify(out);
  assert.equal(text.includes('$ref'), false);
  assert.equal(text.includes('$defs'), false);
  assert.equal(out.properties.section.properties.name.type, 'string');
  assert.equal(out.properties.sections.items.required[0], 'name');
});

test('inlineSchemaRefs caps recursion depth with a permissive object', () => {
  const out = inlineSchemaRefs({ ...sectionDef, type: 'object', properties: { section: { $ref: '#/$defs/Section' } } });
  // level 1: section, level 2: section.sets.items, level 3 hits the cap.
  const level2 = out.properties.section.properties.sets.items;
  assert.equal(level2.properties.name.type, 'string');
  const capped = level2.properties.sets.items;
  assert.equal(capped.type, 'object');
  assert.equal(capped.properties, undefined);
});

test('inlineSchemaRefs keeps sibling descriptions and tolerates junk', () => {
  const out = inlineSchemaRefs({
    $defs: { S: { type: 'string' } },
    type: 'object',
    properties: { a: { $ref: '#/$defs/S', description: 'the a' } },
  });
  assert.equal(out.properties.a.type, 'string');
  assert.equal(out.properties.a.description, 'the a');
  assert.equal(inlineSchemaRefs(null), null);
  assert.deepEqual(inlineSchemaRefs({ type: 'object' }), { type: 'object' });
});

test('sanitizeToolsReply rewrites only tools/list payloads', () => {
  const reply = {
    jsonrpc: '2.0',
    id: 2,
    result: {
      tools: [{ name: 'createScheduledWorkout', inputSchema: { ...sectionDef, type: 'object', properties: { s: { $ref: '#/$defs/Section' } } } }],
    },
  };
  sanitizeToolsReply(reply);
  assert.equal(JSON.stringify(reply).includes('$ref'), false);
  assert.equal(reply.result.tools[0].name, 'createScheduledWorkout');

  const untouched = { jsonrpc: '2.0', id: 3, result: { content: [] } };
  assert.deepEqual(sanitizeToolsReply(untouched), untouched);
  assert.equal(sanitizeToolsReply(undefined), undefined);
});

test('sanitizeToolsReply walks batched replies', () => {
  const batch = [
    { id: 1, result: { tools: [{ name: 'x', inputSchema: { $ref: '#/$defs/Missing' } }] } },
    { id: 2, result: {} },
  ];
  sanitizeToolsReply(batch);
  assert.equal(JSON.stringify(batch).includes('$ref'), false);
});
