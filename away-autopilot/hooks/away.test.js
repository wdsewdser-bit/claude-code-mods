import { test, expect, mock } from 'claude-code/testing';
const MIN = 60 * 1000;
const done = (answer) => ({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' });
function setup(on) {
    const clock = mock.clock(on);
    const nudges = [];
    on('prompt.submit', ($, e, next) => {
        if (e.origin.kind === 'plugin')
            nudges.push(e.text);
        return { text: e.text };
    });
    on('turn.complete', () => ({ text: '' }));
    on('session.start', (_$, e) => e);
    on('ui.status', () => ({ value: undefined }));
    on('tool.register', (_$, e) => ({ value: { tool: e.name } }));
    on('prompt.compose', () => ({ sections: [] }));
    return { clock, nudges };
}
test('5 分钟无回复后插入提示', async ($, on) => {
    const { clock, nudges } = setup(on);
    await $.turn.complete(done('选 A 还是 B？\n[待确认]'));
    await clock.advance(4 * MIN);
    expect(nudges).toHaveLength(0);
    await clock.advance(1 * MIN + 1);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain('[away-autopilot]');
});
test('wrap_up 带 ask 时也触发', async ($, on) => {
    const { clock, nudges } = setup(on);
    on('tool.call', () => ({ result: 'ok' }));
    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'r', ask: '选哪个？' } });
    await $.turn.complete(done(''));
    await clock.advance(5 * MIN + 1);
    expect(nudges).toHaveLength(1);
});
test('wrap_up 不带 ask 不触发', async ($, on) => {
    const { clock, nudges } = setup(on);
    on('tool.call', () => ({ result: 'ok' }));
    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'r' } });
    await $.turn.complete(done('做完了'));
    await clock.advance(10 * MIN);
    expect(nudges).toHaveLength(0);
});
test('没有标记不触发', async ($, on) => {
    const { clock, nudges } = setup(on);
    await $.turn.complete(done('做完了。'));
    await clock.advance(10 * MIN);
    expect(nudges).toHaveLength(0);
});
test('用户回复取消计时', async ($, on) => {
    const { clock, nudges } = setup(on);
    await $.turn.complete(done('要继续吗？[待确认]'));
    await clock.advance(2 * MIN);
    await $.prompt.submit({ text: '继续', origin: { kind: 'composer' } });
    await clock.advance(10 * MIN);
    expect(nudges).toHaveLength(0);
});
test('调用 pause 后不再推进，用户回来后恢复', async ($, on) => {
    const { clock, nudges } = setup(on);
    await $.session.start({ source: 'startup', cwd: '.' });
    const r = await $.tool.call({ tool: 'mcp__away-autopilot__pause', input: { reason: '剩下的都要确认' } });
    expect(JSON.stringify(r)).toContain('paused');
    await $.turn.complete(done('[待确认]'));
    await clock.advance(10 * MIN);
    expect(nudges).toHaveLength(0);
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } });
    await $.turn.complete(done('[待确认]'));
    await clock.advance(5 * MIN + 1);
    expect(nudges).toHaveLength(1);
});
test('兜底上限 8 次', async ($, on) => {
    const { clock, nudges } = setup(on);
    for (let i = 0; i < 12; i++) {
        await $.turn.complete(done('[待确认]'));
        await clock.advance(5 * MIN + 1);
    }
    expect(nudges).toHaveLength(8);
});
test('system prompt 加入约定', async ($, on) => {
    setup(on);
    const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] });
    expect(r.sections.some(s => s.id === 'away-autopilot')).toBe(true);
});
