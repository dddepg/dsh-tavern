import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { helperClient } from './fixtures/helper-host-harness.mjs'
function harness() {
 const html=helperClient.buildTavernFrameDocument({content:'',token:'touch'});
 const script=html.match(/<script data-dsh-tavern-touch>([\s\S]*?)<\/script>/)?.[1];
 assert.ok(script, 'message iframe must install touch relay');
 const handlers={},sent=[],frames=new Map();let time=0,id=0;
 const parent={postMessage:m=>sent.push(m)};
 const ctx={document:{scrollingElement:null,hidden:false},parent,performance:{now:()=>time},getComputedStyle:e=>e.css,requestAnimationFrame:f=>{frames.set(++id,f);return id},cancelAnimationFrame:i=>frames.delete(i),addEventListener:(n,f)=>handlers[n]=f};
 ctx.window={getSelection:()=>''};vm.runInNewContext(script,ctx);
 const target={nodeType:1,parentElement:null,isConnected:true,closest:()=>null,css:{touchAction:'none',overflowY:'auto',overscrollBehaviorY:'auto'},scrollHeight:200,clientHeight:100,scrollTop:90,scrollTo({top}){this.scrollTop=Math.max(0,Math.min(100,top))}};
 const event=(y,x=0,count=1)=>({target,touches:Array.from({length:count},(_,identifier)=>({screenY:y,screenX:x,identifier})),defaultPrevented:false});
 return {ctx,target,sent,frames,start(y=200){handlers.touchstart(event(y))},move(y,x=0){time+=16;handlers.touchmove(event(y,x))},end(){handlers.touchend({touches:[]})},cancel(){handlers.touchcancel({})},multi(){handlers.touchstart(event(180,0,2))},tick(ms=16){time+=ms;const tasks=[...frames.values()];frames.clear();tasks.forEach(f=>f(time))},wait(ms){time+=ms},deltas(){return sent.filter(m=>m.type==='dsh-tavern-frame-scroll').reduce((n,m)=>n+m.dy,0)}};
}
test('blocked native pan consumes inner 10px and relays only remaining 90px',()=>{const h=harness();h.start();h.move(100);assert.equal(h.target.scrollTop,100);assert.equal(h.deltas(),90)});
