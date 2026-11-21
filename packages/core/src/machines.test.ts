import { describe, expect, it } from 'vitest';
import { jsonSchemas, loadWorkspace, parseMachines, validateMachines } from './index.js';

const F = '.flowbook/machines.jsonl';
const M1 = `{"kind":"machine","id":"cmsm","title":"CM state machine","states":"PF_CMSM_STATE_.*","events":"PNET_EVENT_.*","set":[{"call":"pf_cmsm_set_state","key":2}],"files":["src/src/device/pf_cmsm.c"],"context":"p-net main thread"}`;
const M2 = `{"kind":"machine","id":"cm","title":"Configuration manager","states":"CM_STATE_.*","tables":[{"rows":"cm_trans_s[0-9]+","event":1,"to":2,"action":3,"from":{"cm_trans_s0":"CM_STATE_CheckPortMode","cm_trans_s1":"CM_STATE_SM_Startup"}}]}`;
const S1 = `{"kind":"scope","id":"cmdev-init","machine":"cmdev","state":"PF_CMDEV_STATE_POWER_ON","in":[{"file":"src/src/device/pf_cmdev.c","symbol":"pf_cmdev_init"}]}`;

function all(text: string) {
  const diagnostics: import('./index.js').Diagnostic[] = [];
  const m = parseMachines(text, F, diagnostics);
  return [...diagnostics, ...validateMachines(m, F)].map((d) => d.message);
}
const machine = (extra: string, id = 'm') =>
  `{"kind":"machine","id":"${id}","title":"T","states":"S_.*",${extra}}`;
const SET = '"set":[{"call":"f","key":1}]';

describe('machines', () => {
  it('parses the three spec lines', () => {
    const d: import('./index.js').Diagnostic[] = [];
    const m = parseMachines([M1, M2, S1].join('\n'), F, d);
    expect(d).toEqual([]);
    expect(m.machines.map((x) => x.id)).toEqual(['cmsm', 'cm']);
    expect(m.scopes[0]!.line).toBe(3);
    // the scope's machine is not in this file: the only complaint
    expect(all([M1, M2, S1].join('\n'))).toEqual(['unknown machine "cmdev"']);
    expect(all([M1, M2].join('\n'))).toEqual([]);
  });

  it('reports each validation error', () => {
    expect(all(machine(`${SET},"events":"("`))[0]).toMatch(/invalid regular expression "\("/);
    expect(all(machine('"states2":1')).join()).toMatch(/states2/);
    expect(all(machine(`"set":[{"call":"f"}]`))).toEqual(['"set" matcher "f" needs "key"']);
    expect(all(machine(`"set":[{"assign":"st","as":"handler"}]`))).toEqual([
      '"set" matcher "st" needs "as": "key"',
    ]);
    expect(all(machine('"notes":"x"'))).toEqual(['a machine needs "set" or "tables"']);
    expect(all(machine(`"tables":[{"rows":"t","event":1,"to":2,"from":{"t":"OTHER"}}]`))).toEqual([
      '"from" state "OTHER" (for t) does not match "states"',
    ]);
    expect(all(machine(`"tables":[{"rows":"[","event":1,"to":2,"from":{}}]`))[0]).toMatch(
      /invalid regular expression/,
    );
    const scope = (state: string, machineId = 'm') =>
      `{"kind":"scope","id":"s","machine":"${machineId}","state":"${state}","in":[{"file":"a.c","symbol":"f"}]}`;
    expect(all([machine(SET), scope('S_A')].join('\n'))).toEqual([]);
    expect(all([machine(SET), scope('X')].join('\n'))).toEqual([
      'scope state "X" does not match "states" of machine "m"',
    ]);
    expect(all([machine(SET), scope('S_A', 'zz')].join('\n'))).toEqual(['unknown machine "zz"']);
    expect(all([machine(SET), machine(SET)].join('\n'))[0]).toMatch(/duplicate id "m"/);
  });

  it('rejects unknown fields and empty scope anchors', () => {
    expect(all(machine(`${SET},"bogus":1`)).length).toBeGreaterThan(0);
    expect(
      all(`{"kind":"scope","id":"s","machine":"m","state":"S","in":[]}`).length,
    ).toBeGreaterThan(0);
  });

  it('loadWorkspace fills connections.machines and scopes', () => {
    const ws = loadWorkspace(undefined, [], undefined, { path: F, text: [M1, M2].join('\n') });
    expect(ws.diagnostics).toEqual([]);
    expect(ws.connections.machines).toHaveLength(2);
    expect(ws.connections.scopes).toEqual([]);
    expect(loadWorkspace(undefined, []).connections.machines).toBeUndefined();
  });

  it('emits a JSON Schema for machines lines', () => {
    expect(JSON.stringify(jsonSchemas().$defs.machinesLine)).toContain('scope');
  });
});
