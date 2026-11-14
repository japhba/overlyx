import { describe, expect, it } from 'vitest';
import { connectOps, connectorOps, connectorsFor } from '../packages/client/src/deliverable/connectors';
import { applyOp } from '../packages/core/src/html/source';

const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body><section class="slide">${body}</section></body></html>`;
const apply = (text: string, ops: Parameters<typeof applyOp>[1][]) => ops.reduce((t, op) => applyOp(t, op), text);

describe('connectors between objects (connectors.ts)', () => {
  const two = page('<div style="position: absolute; left: 10px; top: 10px; width: 100px; height: 60px"></div><div id="box-1" style="position: absolute; left: 300px; top: 10px; width: 100px; height: 60px"></div><aside class="notes">n</aside>');
  it('names the objects that have no id and puts the connector before the notes', () => {
    const r = connectOps(two, [1, 0, 0], [1, 0, 1], ['right', 'auto'], true)!;
    expect(r.path).toEqual([1, 0, 2]);
    const text = apply(two, r.ops);
    expect(text).toContain('<div style="position: absolute; left: 10px; top: 10px; width: 100px; height: 60px" id="box-2"></div>');
    expect(text).toContain(`<svg data-ol-connector='{"from":{"id":"box-2","side":"right"},"to":{"id":"box-1"}}' stroke="#1d2433" stroke-width="2"></svg><aside class="notes">`);
    // a line (no arrow): no arrowhead
    expect(apply(two, connectOps(two, [1, 0, 0], [1, 0, 1], ['auto', 'left'], false)!.ops)).toContain(`"to":{"id":"box-1","side":"left"},"head":0}'`);
    // not between an object and itself, nor across slides
    expect(connectOps(two, [1, 0, 0], [1, 0, 0], ['auto', 'auto'], true)).toBeNull();
  });
  it('switches the route and the arrowhead in the settings alone', () => {
    let text = apply(two, connectOps(two, [1, 0, 0], [1, 0, 1], ['right', 'left'], true)!.ops);
    text = apply(text, connectorOps(text, [1, 0, 2], { route: 'elbow' })!);
    expect(text).toMatch(/data-ol-connector="\{&quot;from&quot;:\{&quot;id&quot;:&quot;box-2&quot;,&quot;side&quot;:&quot;right&quot;\},&quot;to&quot;:\{&quot;id&quot;:&quot;box-1&quot;,&quot;side&quot;:&quot;left&quot;\},&quot;route&quot;:&quot;elbow&quot;\}"|data-ol-connector='\{"from":\{"id":"box-2","side":"right"\},"to":\{"id":"box-1","side":"left"\},"route":"elbow"\}'/);
    text = apply(text, connectorOps(text, [1, 0, 2], { route: 'straight', head: false })!);
    expect(text).not.toContain('route');
    expect(text).toMatch(/head(&quot;|"):0/);
    expect(text).toContain('stroke="#1d2433"');
  });
  it('finds the connectors that go when an object (or a group with it inside) is deleted', () => {
    const text = page('<div id="a"></div><div><p id="b">x</p></div><div id="c"></div>'
      + `<svg data-ol-connector='{"from":{"id":"a"},"to":"c"}'></svg><svg data-ol-connector='{"from":{"id":"b"},"to":{"id":"c"}}'></svg><svg data-ol-connector='broken'></svg>`);
    expect(connectorsFor(text, [[1, 0, 0]])).toEqual([[1, 0, 3]]);
    expect(connectorsFor(text, [[1, 0, 1]])).toEqual([[1, 0, 4]]);
    expect(connectorsFor(text, [[1, 0, 2]])).toEqual([[1, 0, 3], [1, 0, 4]]);
    // a connector deleted with its object is not named twice
    expect(connectorsFor(text, [[1, 0, 2], [1, 0, 3]])).toEqual([[1, 0, 4]]);
  });
});
