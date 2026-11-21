import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connections } from '@flowbook/core';
import {
  buildConnectionIndex,
  buildMachineIndex,
  readWorkspace,
  Resolver,
  scanRoot,
  type FileScan,
  type MachineIndex,
  type MachineView,
  type Pairing,
  type Transition,
} from '@flowbook/resolver';
import { beforeAll, describe, expect, it } from 'vitest';
import { documentMachineIndex, machineLenses, transitionLensTitle } from './machines-model.js';

const fixture = resolve(fileURLToPath(import.meta.url), '../../../../fixtures/cpp-sample');
const read = (rel: string) => readFileSync(join(fixture, rel), 'utf8');

let resolver: Resolver;
let connections: Connections;
let scans: Map<string, FileScan>;
let index: MachineIndex;

beforeAll(async () => {
  resolver = await Resolver.create();
  connections = readWorkspace(fixture).connections;
  scans = scanRoot(fixture, connections, resolver);
  index = buildMachineIndex(connections, scans, buildConnectionIndex(connections, scans));
});

/** `trimmed source line | lens title` for every lens of `rel`. */
function lensesOf(rel: string, mi = index): string[] {
  const lines = read(rel).split('\n');
  return machineLenses(mi, rel).map((l) => `${lines[l.line]!.trim()} | ${l.title}`);
}

const machine: MachineView = {
  id: 'cm',
  title: 'CM state machine',
  states: ['CMSM_IDLE', 'CMSM_RUN'],
  prefix: 'CMSM_',
  transitions: [],
};
const site = { file: 'src/cmsm.c', line: 9, column: 4, symbol: 'cmsm_ind' };
const trigger = (rule: string, symbol?: string): Pairing =>
  ({
    send: { rule, file: 'src/cmsm.c', line: 8, column: 4, role: 'send', matcher: 'call' },
    reactors: symbol ? [{ file: 'src/sched.c', line: 3, column: 0, symbol, via: 'key' }] : [],
  }) as unknown as Pairing;
const transition = (t: Partial<Transition>): Transition => ({
  from: 'CMSM_IDLE',
  to: 'CMSM_RUN',
  via: 'case',
  site,
  triggers: [],
  ...t,
});

describe('transitionLensTitle', () => {
  it('names the states without the prefix and the event', () => {
    expect(transitionLensTitle(machine, transition({ event: 'PNET_EVENT_STARTUP' }))).toBe(
      '↳ CM state machine: IDLE → RUN on PNET_EVENT_STARTUP',
    );
  });

  it('names the enclosing function when there is no event', () => {
    expect(transitionLensTitle(machine, transition({}))).toBe(
      '↳ CM state machine: IDLE → RUN in cmsm_ind',
    );
  });

  it('adds the guard', () => {
    expect(
      transitionLensTitle(machine, transition({ event: 'EV_ERR', guard: 'l->retries>3' })),
    ).toBe('↳ CM state machine: IDLE → RUN on EV_ERR if l->retries>3');
  });

  it('shows an unknown source as any state', () => {
    expect(transitionLensTitle(machine, transition({ from: '*', via: 'none' }))).toBe(
      '↳ CM state machine: any state → RUN in cmsm_ind',
    );
  });

  it('prefixes a table row label', () => {
    expect(
      transitionLensTitle(machine, transition({ label: 'T5', event: 'EV', via: 'table' })),
    ).toBe('↳ CM state machine: T5 IDLE → RUN on EV');
  });

  it('names the first trigger and its first reactor', () => {
    expect(
      transitionLensTitle(
        machine,
        transition({
          event: 'PNET_EVENT_STARTUP',
          triggers: [trigger('sched', 'pf_cmsm_timeout')],
        }),
      ),
    ).toBe(
      '↳ CM state machine: IDLE → RUN on PNET_EVENT_STARTUP · sets off sched → pf_cmsm_timeout',
    );
  });

  it('counts the further triggers', () => {
    expect(
      transitionLensTitle(
        machine,
        transition({
          event: 'EV',
          triggers: [trigger('sched', 'pf_cmsm_timeout'), trigger('mbox'), trigger('evt', 'x')],
        }),
      ),
    ).toBe('↳ CM state machine: IDLE → RUN on EV · sets off sched → pf_cmsm_timeout (+2 more)');
  });

  it('says unpaired when the first trigger has no reactor', () => {
    expect(
      transitionLensTitle(machine, transition({ event: 'EV', triggers: [trigger('mbox')] })),
    ).toBe('↳ CM state machine: IDLE → RUN on EV · sets off mbox → unpaired');
  });
});

describe('machineLenses', () => {
  it('puts a lens on every setter call, peeking the triggered reactors', () => {
    expect(lensesOf('src/rt/sm_link.c')).toEqual([
      'link_set_state(l, LINK_ST_RUN); | ↳ Link state machine: IDLE → RUN on LINK_EV_START · sets off event → rt_main',
      'link_set_state(l, LINK_ST_FAIL); | ↳ Link state machine: RUN → FAIL on LINK_EV_ERROR if l->retries>3',
      'link_set_state(l, LINK_ST_IDLE); | ↳ Link state machine: RUN → IDLE on LINK_EV_STOP',
    ]);
    const [first, second] = machineLenses(index, 'src/rt/sm_link.c');
    expect(first!.targets.map((t) => t.symbol)).toEqual(['rt_main']);
    expect(second!.targets).toEqual([]);
  });

  it('puts a lens on every table row', () => {
    expect(lensesOf('src/rt/sm_cm.c').map((s) => s.slice(s.indexOf('|') + 2))).toEqual([
      '↳ Configuration manager: T1 INIT → RUN on CM_EV_START · sets off event → rt_main',
      '↳ Configuration manager: T2 INIT → DONE on CM_EV_SKIP',
      '↳ Configuration manager: T3 RUN → DONE on CM_EV_STOP',
      '↳ Configuration manager: T4 RUN → INIT on CM_EV_RESET',
    ]);
  });

  it('shows scope and unknown sources', () => {
    expect(lensesOf('src/rt/sm_dev.c').map((s) => s.slice(s.indexOf('|') + 2))).toEqual([
      '↳ Device state machine: POWER_ON → READY in dev_init',
      '↳ Device state machine: any state → POWER_ON in dev_abort',
      '↳ Device state machine: READY → ERROR in dev_ind',
    ]);
  });

  it('has no lenses for a file without transitions', () => {
    expect(machineLenses(index, 'src/rt/jobs.c')).toEqual([]);
  });
});

describe('documentMachineIndex', () => {
  it('indexes the unsaved text of a document', () => {
    const rel = 'src/rt/sm_link.c';
    const text = read(rel).replace('LINK_ST_IDLE);', 'LINK_ST_FAIL);');
    const docScan = resolver.scan(rel, text, connections.rules, connections.machines);
    const mi = documentMachineIndex(connections, scans, rel, docScan);
    const titles = machineLenses(mi, rel).map((l) => l.title);
    expect(titles).toContain('↳ Link state machine: RUN → FAIL on LINK_EV_STOP');
  });
});
