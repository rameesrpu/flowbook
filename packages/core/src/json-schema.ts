import { z } from 'zod';
import { ConfigFileRecord, FlowFileRecord } from './schema.js';

/** JSON Schemas for one line of a flow file and one line of the config file. */
export function jsonSchemas() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Flowbook records (one JSON object per JSONL line)',
    $defs: {
      flowLine: z.toJSONSchema(FlowFileRecord, { io: 'input' }),
      configLine: z.toJSONSchema(ConfigFileRecord, { io: 'input' }),
    },
  };
}
