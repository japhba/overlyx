// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (count: number, from: number) => Array.from({length:count},(_,i)=>`w${String(from+i).padStart(3,'0')}`).join(' ');
const content = {type:'doc',content:[
  par(text(words(6,1)+' '),math('a+b'),text(' '+words(8,7)+' '),math('c'),text(' '+words(5,15)+' ')),
  par(text(words(10,20)+' ')),
  par(text(words(4,30)+' '),math('x^2'),text(' '+words(4,34)+' ')),
]};
const clean = (paragraphs:string[]) => paragraphs.map(value=>value.replace(/\s+/g,' ').trim());

for (const pendingMoves of [false,true]) it(`concurrent cuts keep every character of their retained word in order (captured1023, pending=${pendingMoves})`,()=>{
  const net=new Net(content,{pendingMoves}), a=net.peer('a',100), b=net.peer('b',200), c=net.peer('c',300);
  const act=(run:()=>void)=>{
    run();
    for(const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
  };
  try {
    // The literal three-action minimum; both authors split the same original
    // paragraph before receiving the other author's cut.
    act(()=>c.enterBefore('w033'));
    expect(clean(c.pars()).slice(2)).toEqual([words(3,30),`w033 $x^2$ ${words(4,34)}`]);
    act(()=>net.offline(c));
    act(()=>b.enterBefore('w031'));
    expect(clean(b.pars()).slice(2)).toEqual(['w030',`${words(3,31)} $x^2$ ${words(4,34)}`]);
    net.online(c);
    const final=net.converged(), all=final.join(' '), tokens=all.split(/[\s$]+/);
    expect(tokens.filter(value=>/^w\d{3}$/.test(value))).toEqual(Array.from({length:37},(_,i)=>`w${String(i+1).padStart(3,'0')}`));
    expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$','$c$','$x^2$']);
    for(const [left,formula,right] of [['w006','a+b','w007'],['w014','c','w015'],['w033','x^2','w034']]){
      expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
      expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
    }
    expect(clean(final)).toEqual([
      `${words(6,1)} $a+b$ ${words(8,7)} $c$ ${words(5,15)}`,
      words(10,20),'w030',words(2,31),`w033 $x^2$ ${words(4,34)}`,
    ]);
    for(const peer of net.peers){ expect(clean(peer.pars())).toEqual(clean(final)); expect(peer.pendingMoves?.waiting??false).toBe(false); }
  } finally {
    for(const peer of net.peers){peer.remoteUpdates?.destroy();peer.pendingMoves?.destroy();peer.view.destroy();peer.ydoc.destroy();}
    net.server.destroy();
  }
});
