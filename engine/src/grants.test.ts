import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { describeArgs, GRANT_TTL_MS, issueGrant, parseSlash, redeemGrant } from './grants.ts';

process.env.GENIE_HOME = mkdtempSync(join(tmpdir(), 'genie-grants-home-'));

const T0 = Date.parse('2026-10-23T10:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe('grants', () => {
  it('parses only the namespaced human-only commands', () => {
    assert.deepEqual(parseSlash('/genie:approve spec.approved --note "ok"'), { command: 'approve', args: 'spec.approved --note "ok"' });
    assert.deepEqual(parseSlash('  /genie:abort'), { command: 'abort', args: '' });
    assert.equal(parseSlash('/genie:approved x'), undefined);
    assert.equal(parseSlash('/approve x'), undefined);
    assert.equal(parseSlash('please /genie:approve x'), undefined);
  });

  it('reads the decision out of the typed arguments', () => {
    assert.deepEqual(describeArgs('slice.reviewed --slice S2 --reject --note "no"'), { target: 'slice.reviewed', reject: true, slice: 'S2' });
    assert.deepEqual(describeArgs('--note "why"'), { reject: false });
    assert.deepEqual(describeArgs('budget --slice=S1'), { target: 'budget', reject: false, slice: 'S1' });
  });

  it('expires', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-grants-'));
    issueGrant(root, 'r1', 'approve', 'spec.approved', at(0));
    assert.throws(() => redeemGrant(root, 'r1', 'approve', { target: 'spec.approved', reject: false }, at(GRANT_TTL_MS + 1)), /typed/);
    issueGrant(root, 'r1', 'approve', 'spec.approved', at(0));
    assert.throws(() => redeemGrant(root, 'r1', 'approve', { target: 'spec.approved', reject: false }, at(-1)), /typed/, 'not from the future');
    issueGrant(root, 'r1', 'approve', 'spec.approved', at(0));
    assert.equal(redeemGrant(root, 'r1', 'approve', { target: 'spec.approved', reject: false }, at(GRANT_TTL_MS)).args, 'spec.approved');
  });

  it("matches the command, and for approvals the gate, rejection and slice", () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-grants-'));
    issueGrant(root, 'r1', 'abort', '--note "done with it"', at(0));
    assert.throws(() => redeemGrant(root, 'r1', 'approve', { reject: false }, at(1)));
    assert.equal(redeemGrant(root, 'r1', 'abort', { reject: false }, at(1)).command, 'abort');
    issueGrant(root, 'r1', 'approve', 'slice.reviewed --slice S1', at(0));
    assert.throws(() => redeemGrant(root, 'r1', 'approve', { target: 'slice.reviewed', reject: false, slice: 'S2' }, at(1)));
    assert.throws(() => redeemGrant(root, 'r1', 'approve', { target: 'slice.reviewed', reject: false }, at(1)));
    redeemGrant(root, 'r1', 'approve', { target: 'slice.reviewed', reject: false, slice: 'S1' }, at(1));
  });
});
