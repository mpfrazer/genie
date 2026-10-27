import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { simpleCommands, stripWrappers } from './shell.ts';

describe('simpleCommands', () => {
  it('splits on control operators', () => {
    assert.deepEqual(simpleCommands('cd app && git push origin feat || echo "push failed"; ls | wc -l'), [
      ['cd', 'app'],
      ['git', 'push', 'origin', 'feat'],
      ['echo', 'push failed'],
      ['ls'],
      ['wc', '-l'],
    ]);
  });

  it('handles quotes and escapes', () => {
    assert.deepEqual(simpleCommands(`git commit -m 'a && b' -m "say \\"hi\\"" x\\ y`), [
      ['git', 'commit', '-m', 'a && b', '-m', 'say "hi"', 'x y'],
    ]);
  });

  it('descends into sh -c and eval', () => {
    assert.deepEqual(simpleCommands(`bash -lc 'git push origin main'`), [['git', 'push', 'origin', 'main']]);
    assert.deepEqual(simpleCommands(`eval git push`), [['git', 'push']]);
  });

  it('surfaces command substitutions', () => {
    assert.deepEqual(simpleCommands('echo $(git push) "x $(gh pr merge 3)"'), [
      ['git', 'push'],
      ['gh', 'pr', 'merge', '3'],
      ['echo', '$(…)', 'x $(…)'],
    ]);
    assert.deepEqual(simpleCommands('echo `git push`'), [['git', 'push'], ['echo', '$(…)']]);
  });

  it('keeps the outer command whole around a substitution', () => {
    assert.deepEqual(simpleCommands('git push $(git remote | head -1) main'), [
      ['git', 'remote'],
      ['head', '-1'],
      ['git', 'push', '$(…)', 'main'],
    ]);
  });

  it('keeps redirections that use & in their words', () => {
    assert.deepEqual(simpleCommands('git push origin b 2>&1; echo done'), [['git', 'push', 'origin', 'b', '2>&1'], ['echo', 'done']]);
    assert.deepEqual(simpleCommands('make &>log && make >&2 & wait'), [['make', '&>log'], ['make', '>&2'], ['wait']]);
  });

  it('ignores comments', () => {
    assert.deepEqual(simpleCommands('ls # git push\necho ok'), [['ls'], ['echo', 'ok']]);
  });
});

describe('stripWrappers', () => {
  it('drops assignments and wrappers with their flags', () => {
    assert.deepEqual(stripWrappers(['FOO=1', 'env', '-i', 'BAR=2', 'sudo', '-u', 'me', 'git', 'push']), ['git', 'push']);
    assert.deepEqual(stripWrappers(['command', 'git', 'push']), ['git', 'push']);
  });
});
