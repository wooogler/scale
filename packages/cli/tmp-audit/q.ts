import { loadScaleDir, paperById } from '@scale/core';
import { deterministicQuizItems } from '../src/quest.js';
const cwd='/Users/sangwooklee/dev/koa-scale';
const loaded=loadScaleDir(cwd);
for(const id of loaded.papers.map(p=>p.id).sort()){
  const paper=paperById(loaded,id)!;
  const items=deterministicQuizItems(paper,loaded,'en');
  console.log('\n======== '+id);
  for(const it of items){
    console.log(`[${it.dim}] ${it.prompt}`);
    it.options!.forEach((o,i)=>console.log(`   ${i===it.correctIndex?'*':' '} ${o}`));
  }
}
