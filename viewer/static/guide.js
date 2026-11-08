'use strict';
const guide = {available:false,history:[],busy:false,generation:0,layer:'',scene:null,weightScene:null,view:'landscape',viewRequest:0,primarySample:null,primaryTensor:null,layerNodes:[],modelId:null,layerLayout:'floors',floorOrder:[],floorTensors:new Map(),floorIndex:-1,floorLabels:[],floorAnimation:0,landscapeCache:new Map(),landscapeFlights:new Map(),wheelAmount:0,wheelAt:0,wheelStepAt:0,explicitTensor:false};
const roleInfo = [
  {key:'attention',label:'Attention',color:AtlasTheme.rgb(AtlasTheme.current.roles[0]),description:'Attention-related tensors help mix information between token positions. The file shows their shapes and precision; it does not show which words they attend to in a real prompt.'},
  {key:'feedforward',label:'Feed-forward',color:AtlasTheme.rgb(AtlasTheme.current.roles[1]),description:'Feed-forward tensors apply learned transformations to token features. In expert models, some of these transformations may belong to routed experts.'},
  {key:'normalization',label:'Normalization',color:AtlasTheme.rgb(AtlasTheme.current.roles[2]),description:'Normalization weights adjust feature scales around other transformations. Small storage does not mean low importance: changing them can affect many downstream computations.'},
  {key:'state',label:'State / recurrent',color:AtlasTheme.rgb(AtlasTheme.current.roles[3]),description:'These names suggest state-space or recurrent components, which can carry information through a sequence. Their exact operation depends on the model architecture and runtime.'},
  {key:'other',label:'Other / global',color:AtlasTheme.rgb(AtlasTheme.current.roles[4]),description:'This group contains tensors not classified into the other functions, including embeddings, output projections, and architecture-specific components. Inspect a tensor name for more context.'},
];
function sceneColor(token,scale=1){return AtlasTheme.rgb(AtlasTheme.current[token]).map(value=>Math.min(1,value*scale));}
function refreshThemeVisuals(){
  roleInfo.forEach((role,i)=>{role.color=AtlasTheme.rgb(AtlasTheme.current.roles[i]);});
  for(const item of guide.layerNodes)item.color=item.role.color;
  if(!state.model)return;
  renderPrimaryLegend();
  if(guide.view==='layers'){if(guide.layerLayout==='floors')renderFloors(false);else{guide.scene?.setGeometry(guide.layerNodes);guide.scene?.select(guide.layer||null);}}
  else renderPrimarySample();
  if(guide.lastInspectorSample?.name===state.selected?.name)renderSample(guide.lastInspectorSample);
  guide.scene?.draw();guide.weightScene?.draw();
}
function tensorRole(t){const n=t.name.toLowerCase();if(/norm/.test(n))return'normalization';if(/ssm|recurrent|conv1d|time_mix/.test(n))return'state';if(/attn|attention/.test(n))return'attention';if(/ffn|feed_forward|expert|mlp/.test(n))return'feedforward';return'other';}
function message(role,text){const article=node('article',null,`chat-message ${role}`);article.append(node('span',role==='user'?'YOU':role==='error'?'CONNECTION':'ATLAS GUIDE','message-author'),node('p',text));$('chat-messages').append(article);$('chat-messages').scrollTop=$('chat-messages').scrollHeight;return article;}
function formatReply(article,text){
  const paragraph=article.querySelector('p');paragraph.replaceChildren();
  // Only inline code and bold are recognized. Every source fragment stays a text node.
  for(const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)){
    if(part.startsWith('`')&&part.endsWith('`'))paragraph.append(node('code',part.slice(1,-1)));
    else if(part.startsWith('**')&&part.endsWith('**'))paragraph.append(node('strong',part.slice(2,-2)));
    else paragraph.append(document.createTextNode(part));
  }
}
async function post(route,payload){const response=await fetch(`/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)});let data;try{data=await response.json();}catch{throw new Error(`HTTP ${response.status}: the server did not return JSON.`);}if(!response.ok)throw new Error(typeof data.error==='string'?data.error:data.error?.message||`HTTP ${response.status}`);return data;}
function scrollGuide(){setSceneFocus(false);setWeightFocus(false);setGuideVisible(true);document.querySelector('.guide-panel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});$('chat-input').focus();}

function setGuideVisible(visible){document.querySelector('.guided-grid').classList.toggle('guide-hidden',!visible);$('toggle-guide').textContent=visible?'Hide guide ›':'Show guide ‹';$('toggle-guide').setAttribute('aria-expanded',String(visible));guide.scene?.draw();}
function setSceneFocus(active){
  const panel=document.querySelector('.topology-panel');if(panel.classList.contains('scene-focused')===active)return;
  if(active){setWeightFocus(false);guide.focusReturn=document.activeElement;}
  panel.classList.toggle('scene-focused',active);$('focus-scene').textContent=active?'Exit focus ✕':'Focus view ⛶';$('focus-scene').setAttribute('aria-pressed',String(active));
  if(active){panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','Model structure focus view');document.body.classList.add('visual-focus');$('focus-scene').focus();}
  else{panel.removeAttribute('role');panel.removeAttribute('aria-modal');panel.removeAttribute('aria-label');document.body.classList.remove('visual-focus');guide.focusReturn?.focus?.();}
  guide.scene?.draw();
}
function setWeightFocus(active){
  const panel=$('sample-view');if(panel.classList.contains('sample-focused')===active)return;
  if(active){setSceneFocus(false);guide.focusReturn=document.activeElement;}
  panel.classList.toggle('sample-focused',active);$('weight-expand').textContent=active?'Close focus ✕':'Expand sample ⛶';$('weight-expand').setAttribute('aria-pressed',String(active));
  if(active){panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','Weight sample focus view');document.body.classList.add('visual-focus');$('weight-expand').focus();}
  else{panel.removeAttribute('role');panel.removeAttribute('aria-modal');panel.removeAttribute('aria-label');document.body.classList.remove('visual-focus');guide.focusReturn?.focus?.();}
  guide.weightScene?.draw();
}
document.addEventListener('keydown',(event)=>{
  const panel=document.querySelector('.sample-focused')||document.querySelector('.scene-focused');if(!panel)return;
  if(event.key==='Escape'){event.preventDefault();setSceneFocus(false);setWeightFocus(false);return;}
  if(event.key==='Tab'){const focusable=[...panel.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"],summary')].filter(el=>el.getClientRects().length);if(!focusable.length)return;const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&(document.activeElement===first||!panel.contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!panel.contains(document.activeElement))){event.preventDefault();first.focus();}}
});

function initializeScene(){
  try{guide.scene=new AtlasScene($('topology-canvas'),{onUnavailable:()=>{$('scene-unavailable').hidden=false;},onRender:positionFloorLabels,onWheel:floorWheel,onSelect:(hit)=>{if(hit&&guide.view==='landscape'&&hit.layer!==null){selectFloor(hit.layer);return;}if(hit&&guide.view==='layers'){if(guide.layerLayout==='floors')selectFloor(hit.layer);else{chooseLayer(hit.layer);describeLayer(hit.layer,hit.role);}}},onHover:(hit)=>{const tooltip=$('scene-tooltip');tooltip.hidden=!hit;if(hit)tooltip.textContent=guide.view==='layers'?`${hit.layer==='global'?'Global tensors':`Layer ${hit.layer}`} · ${hit.tensorName||hit.role.label} · ${bytes(hit.bytes)}${hit.tensorName?' · '+hit.type:' · '+number(hit.tensorCount)+' tensors'}`:`${hit.layer==='global'?'Global':`Layer ${hit.layer}`} · ${hit.tensorName||''} · sample ${number(hit.sampleIndex)} · value ${precise(hit.value)}`;}});}catch(error){$('scene-unavailable').hidden=false;}
}
function createTopology(model){
  if(!guide.scene)initializeScene();
  const groupMap=new Map();
  for(const tensor of model.tensors){const layer=tensor.layer===null||tensor.layer===undefined?'global':String(tensor.layer);const role=tensorRole(tensor),key=`${layer}:${role}`;if(!groupMap.has(key))groupMap.set(key,{layer,role:roleInfo.find(r=>r.key===role),bytes:0,parameters:0,tensorCount:0,unknown:false});const group=groupMap.get(key);group.bytes+=tensor.bytes||0;group.parameters+=tensor.parameter_count;group.tensorCount++;group.unknown ||= tensor.bytes===null;}
  const layers=[...new Set(model.tensors.map(t=>t.layer).filter(x=>x!==null&&x!==undefined))].sort((a,b)=>a-b);
  const hasGlobal=model.tensors.some(t=>t.layer===null||t.layer===undefined);guide.floorOrder=[...(hasGlobal?['global']:[]),...layers.map(String)];guide.floorTensors=new Map(guide.floorOrder.map(id=>[id,[]]));guide.floorIndex=-1;guide.layerLayout='floors';
  for(const tensor of model.tensors)guide.floorTensors.get(tensor.layer===null||tensor.layer===undefined?'global':String(tensor.layer))?.push(tensor);
  const displayed=layers.length>384?layers.filter((_,i)=>i%Math.ceil(layers.length/384)===0):layers;
  const ordered=['global',...displayed.map(String)];
  const maxBytes=[...groupMap.values()].reduce((m,g)=>Math.max(m,g.bytes),1),denom=Math.log10(maxBytes+1);
  const nodes=[];
  for(const group of groupMap.values()){const row=ordered.indexOf(group.layer);if(row<0)continue;const h=Math.max(.09,Math.log10(group.bytes+1)/denom*4.3);nodes.push({...group,x:(roleInfo.indexOf(group.role)-2)*2.1,y:h/2,z:-7.5+row/Math.max(1,ordered.length-1)*15,w:1.5,h,d:Math.min(.85,12/ordered.length),color:group.role.color});}
  guide.layerNodes=nodes;if(guide.view==='layers'){guide.scene?.setGeometry(nodes);guide.scene?.select(null);}
  $('scene-layer').replaceChildren(new Option('Whole model',''));if(hasGlobal)$('scene-layer').append(new Option('Global tensors','global'));
  for(const layer of layers)$('scene-layer').append(new Option(`Layer ${layer}`,String(layer)));
  const a=model.architecture,s=model.summary;
  $('model-story').textContent=`This ${a.name||'model'} file stores ${compact(s.parameter_count)} learned values across ${number(s.tensor_count)} tensors. ${number(layers.length)} numbered blocks repeat transformations; the colored groups separate their likely jobs.${displayed.length<layers.length?` Showing ${displayed.length} evenly spaced layers in 3D; all layers remain in the directory.`:''}`;
}
function chooseLayer(value){$('layer-filter').value=value;state.page=0;renderTensors();}
function describeLayer(layer,role){
  if(guide.layer!==(layer||'')&&state.selected){state.selected=null;$('tensor-details').hidden=true;$('inspector-empty').hidden=false;document.querySelectorAll('#tensor-body tr.selected').forEach(row=>{row.classList.remove('selected');row.setAttribute('aria-selected','false');});}
  guide.layer=layer||'';$('scene-layer').value=guide.layer;if(guide.view==='layers'){if(guide.layerLayout==='floors')renderFloors(true);else guide.scene?.select(guide.layer||null);}
  const tensors=state.model?.tensors.filter(t=>!layer||(layer==='global'?t.layer===null||t.layer===undefined:String(t.layer)===String(layer)))||[];
  const title=layer?layer==='global'?'Global tensors: the model’s inputs, outputs, and shared pieces.':`Layer ${layer}: one stage of learned transformations.`:'The whole model: many transformations working together.';
  const total=tensors.reduce((sum,t)=>sum+(t.bytes||0),0),params=tensors.reduce((sum,t)=>sum+t.parameter_count,0);
  const explanation=role?role.description:'Each colored group collects tensors with similar names. Attention often mixes context; feed-forward tensors transform features; normalization adjusts scale. Architecture-specific and recurrent components may work differently.';
  $('layer-story').replaceChildren(node('h4',title),node('p',explanation),node('span',`${number(tensors.length)} tensors · ${compact(params)} stored parameters · ${bytes(total)} known storage`,'selection-summary'));
  updateContext();
}
function updateContext(){$('chat-selection').textContent=`Context: ${state.selected?state.selected.name:guide.layer?guide.layer==='global'?'global tensors':`layer ${guide.layer}`:'whole model'}${state.selected&&guide.layer?` · layer filter ${guide.layer}`:''}`;}

function selectFloor(id){
  if(!guide.floorOrder.includes(String(id)))return;
  state.selected=null;$('tensor-details').hidden=true;$('inspector-empty').hidden=false;
  guide.explicitTensor=true;chooseLayer(String(id));guide.explicitTensor=false;
  if(guide.view==='landscape')activateLandscapeFloor(String(id));
}
function moveFloor(delta){const index=guide.floorOrder.indexOf(guide.layer),next=Math.max(0,Math.min(guide.floorOrder.length-1,(index<0?0:index)+delta));if(guide.floorOrder[next]!==undefined)selectFloor(guide.floorOrder[next]);}
function floorWheel(event){
  if(event.ctrlKey||!(guide.view==='landscape'||guide.view==='layers'&&guide.layerLayout==='floors'))return false;
  const now=performance.now(),multiplier=event.deltaMode===1?16:event.deltaMode===2?Math.max(100,event.currentTarget.clientHeight):1,delta=event.deltaY*multiplier;
  if(!delta)return true;if(now-guide.wheelAt>180||Math.sign(delta)!==Math.sign(guide.wheelAmount))guide.wheelAmount=0;guide.wheelAt=now;
  if(now-guide.wheelStepAt<240){guide.wheelAmount=0;return true;}guide.wheelAmount+=delta;
  if(Math.abs(guide.wheelAmount)>=38){const direction=guide.wheelAmount<0?1:-1;guide.wheelAmount=0;guide.wheelStepAt=now;moveFloor(direction);}return true;
}
function cacheLandscape(key,data){guide.landscapeCache.delete(key);guide.landscapeCache.set(key,data);while(guide.landscapeCache.size>5)guide.landscapeCache.delete(guide.landscapeCache.keys().next().value);}
function representativeFloor(id){if(state.selected&&(state.selected.layer===null||state.selected.layer===undefined?'global':String(state.selected.layer))===id)return state.selected;const tensors=guide.floorTensors.get(id)||[],override=guide.landscapeOverrides?.get(id);return tensors.find(t=>t.name===override)||preferredTensor(tensors);}
function activateLandscapeFloor(id){
  if(guide.view!=='landscape')return;const tensor=representativeFloor(id);
  if(tensor){selectTensor(tensor);renderLandscapeCarousel();}
  else{clearPrimary('This floor has no supported value decoder. Scroll to another floor or inspect its tensors in Layer map.');renderLandscapeCarousel();}
}
function requestNeighborSample(tensor){
  if(!tensor?.sample_supported)return;const modelId=state.id,generation=guide.generation,key=`${modelId}:${tensor.name}`,flights=guide.landscapeFlights;
  if(guide.landscapeCache.has(key)||flights.has(key)||guide.pendingKey===key||flights.size>=2)return;
  flights.set(key,true);
  request(`/api/sample?${new URLSearchParams({id:modelId,tensor:tensor.name})}`).then(data=>{
    if(modelId!==state.id||generation!==guide.generation)return;
    cacheLandscape(key,data.supported&&data.values?.length?data:{supported:false,reason:data.reason||'No decoded values returned.'});
  }).catch(error=>{if(modelId===state.id&&generation===guide.generation)cacheLandscape(key,{supported:false,reason:error.message});}).finally(()=>{
    flights.delete(key);if(modelId===state.id&&generation===guide.generation&&guide.view==='landscape')renderLandscapeCarousel();
  });
}
function renderLandscapeCarousel(){
  if(guide.view!=='landscape'||!guide.scene)return;
  const index=guide.floorOrder.indexOf(guide.layer);if(index<0){guide.scene.setGeometry([]);hideFloorLabels();return;}
  const centerTensor=representativeFloor(guide.layer);$('primary-view-label').textContent=`${guide.layer==='global'?'Global':`Layer ${guide.layer}`} · ${centerTensor?.name||'No supported decoder'}`;
  const start=Math.max(0,index-1),end=Math.min(guide.floorOrder.length-1,index+1),spacing=9.5,nodes=[],lines=[],neighbors=[];hideFloorLabels();
  $('floor-position').textContent=guide.layer==='global'?'Global':`Layer ${guide.layer}`;$('floor-down').disabled=index===0;$('floor-up').disabled=index===guide.floorOrder.length-1;$('floor-slider').value=String(index);$('floor-slider').max=String(Math.max(0,guide.floorOrder.length-1));$('floor-slider').disabled=guide.floorOrder.length<2;
  for(let fi=start;fi<=end;fi++){
    const id=guide.floorOrder[fi],selected=fi===index,tensor=representativeFloor(id),key=tensor?`${state.id}:${tensor.name}`:null,data=selected?guide.primarySample:guide.landscapeCache.get(key),y=(fi-index)*spacing;
    const color=sceneColor(selected?'accent':'grid',selected ? .85 : 1.2);for(const z of [-6.3,6.3])lines.push({a:[-6.3,y,z],b:[6.3,y,z],color});for(const x of [-6.3,6.3])lines.push({a:[x,y,-6.3],b:[x,y,6.3],color});
    let detail='No supported decoder';
    if(tensor){detail=`${tensor.name} · ${data?.values?.length?number(data.values.length)+' values':!tensor.sample_supported?'decoder unsupported':data?.supported===false?'sample unavailable':'loading…'}`;
      if(data?.supported&&data.values?.length)for(const weight of weightNodes(data))nodes.push({...weight,y:weight.y+y,layer:id,tensorName:tensor.name});
      else if(!selected&&!data&&tensor.sample_supported)neighbors.push(tensor);
    }
    const title=`${id==='global'?'Global':`Layer ${id}`} · ${detail}`,button=node('button',title,'floor-label landscape-floor-label'+(selected?' selected':''));button.type='button';button.title=title+(data?.reason?` · ${data.reason}`:'');button.setAttribute('aria-pressed',String(selected));button.addEventListener('click',()=>selectFloor(id));$('floor-labels').append(button);guide.floorLabels.push({button,point:[-6.3,y,6.3]});
  }
  guide.scene.setGeometry(nodes,lines,false);guide.scene.select(guide.layer);guide.scene.offsetY=0;
  $('primary-axis-note').textContent='Each floor shows a real, bounded decoded prefix from a tensor in that layer. Height is signed value, normalized independently per floor; heights across floors are not directly comparable. X/Z pack sample rows/columns, not neuron positions. Empty floors have no supported sample.';
  $('primary-instructions').textContent='Wheel: change layer · Ctrl+wheel: zoom · Drag / arrows: orbit 360° · PageUp / PageDown: change layer';
  $('topology-canvas').setAttribute('aria-label','Weight landscape layer carousel. Scroll up for the next higher layer, down for the previous layer. Control plus wheel zooms. PageUp and PageDown change layer. Drag or arrow keys orbit 360 degrees.');
  for(const tensor of neighbors)requestNeighborSample(tensor);
}
function setLayerLayout(layout){
  guide.layerLayout=layout;$('layout-floors').classList.toggle('active',layout==='floors');$('layout-overview').classList.toggle('active',layout==='overview');$('layout-floors').setAttribute('aria-pressed',String(layout==='floors'));$('layout-overview').setAttribute('aria-pressed',String(layout==='overview'));$('floor-navigation').hidden=layout!=='floors';
  const whole=$('scene-layer').querySelector('option[value=""]');if(whole)whole.disabled=layout==='floors';
  if(guide.view!=='layers')return;
  ++guide.floorAnimation;if(guide.scene)guide.scene.offsetY=0;
  if(layout==='floors'){const id=guide.floorOrder.includes(guide.layer)?guide.layer:guide.floorOrder[0];if(id!==undefined)selectFloor(id);else renderFloors(false);}
  else{hideFloorLabels();guide.scene?.setGeometry(guide.layerNodes);guide.scene?.select(guide.layer||null);$('primary-view-label').textContent='LAYER OVERVIEW';$('primary-axis-note').textContent='Across: inferred tensor function · Depth: numbered layer order · Height: log-scaled group storage bytes. This structural index is not a live execution graph.';$('primary-instructions').textContent='Drag to orbit 360° · Scroll to zoom · Click a group to explore';}
}
function hideFloorLabels(){guide.floorLabels=[];$('floor-labels')?.replaceChildren();}
function renderFloors(animate){
  if(guide.view!=='layers'||guide.layerLayout!=='floors')return;
  const index=guide.floorOrder.indexOf(guide.layer),previous=guide.floorIndex;guide.floorIndex=index;
  $('floor-down').disabled=index<=0;$('floor-up').disabled=index<0||index>=guide.floorOrder.length-1;$('floor-slider').max=String(Math.max(0,guide.floorOrder.length-1));$('floor-slider').value=String(Math.max(0,index));$('floor-slider').disabled=guide.floorOrder.length<2;
  const floorName=id=>id==='global'?'Global':`Layer ${id}`;$('floor-position').textContent=index<0?'No layers':floorName(guide.layer);$('floor-slider').setAttribute('aria-valuetext',index<0?'No layers':`${floorName(guide.layer)}, floor ${index+1} of ${guide.floorOrder.length}`);
  if(index<0){hideFloorLabels();guide.scene?.setGeometry([],[],false);$('primary-view-label').textContent='NO TENSOR FLOORS';return;}
  const start=Math.max(0,index-2),end=Math.min(guide.floorOrder.length-1,index+2),spacing=3.4,nodes=[],lines=[];hideFloorLabels();
  const maxBytes=state.model.tensors.reduce((maximum,t)=>Math.max(maximum,t.bytes||0),1),denominator=Math.log10(maxBytes+1);
  const line=(a,b,color)=>lines.push({a,b,color});let shownHere=0;
  for(let fi=start;fi<=end;fi++){
    const id=guide.floorOrder[fi],y=(fi-index)*spacing,all=guide.floorTensors.get(id)||[],shown=all.slice(0,256),selected=fi===index;
    if(selected)shownHere=shown.length;const outline=sceneColor(selected?'accent':'grid',selected ? .9 : 1.2);
    for(const z of [-3.6,3.6])line([-6.1,y,z],[6.1,y,z],outline);for(const x of [-6.1,6.1])line([x,y,-3.6],[x,y,3.6],outline);
    for(let lane=1;lane<5;lane++)line([-6.1+lane*2.44,y,-3.6],[-6.1+lane*2.44,y,3.6],sceneColor('grid',selected?1.2:.7));
    for(const [ri,role]of roleInfo.entries()){
      const group=shown.filter(t=>tensorRole(t)===role.key),columns=Math.min(3,Math.max(1,Math.ceil(Math.sqrt(group.length/2)))),rows=Math.ceil(group.length/columns);
      group.forEach((tensor,j)=>{const height=tensor.bytes===null ? .07 : Math.max(.03,Math.log10((tensor.bytes||0)+1)/denominator*1.65);nodes.push({layer:id,role,tensorName:tensor.name,type:tensor.type,bytes:tensor.bytes,tensorCount:1,x:-4.88+ri*2.44+((j%columns)-(columns-1)/2)*(1.95/columns),z:-2.9+(Math.floor(j/columns)+.5)*(5.8/Math.max(1,rows)),y:y+height/2,w:1.65/columns,d:Math.min(1.2,4.7/Math.max(1,rows)),h:height,color:role.color});});
    }
    const button=node('button',`${floorName(id)} · ${shown.length}${shown.length<all.length?'/'+all.length:''} tensors`,'floor-label'+(selected?' selected':''));button.type='button';button.title=`Select ${floorName(id)}; showing ${shown.length} of ${all.length} tensors`;button.setAttribute('aria-pressed',String(selected));button.addEventListener('click',()=>selectFloor(id));$('floor-labels').append(button);guide.floorLabels.push({button,point:[-6.1,y,3.6]});
  }
  for(const x of [-6.1,6.1])line([x,(start-index)*spacing,-3.6],[x,(end-index)*spacing+1.9,-3.6],sceneColor('grid'));
  guide.scene?.setGeometry(nodes,lines,false);guide.scene?.select(guide.layer);$('primary-view-label').textContent=`${floorName(guide.layer).toUpperCase()} · FLOOR ${index+1} / ${guide.floorOrder.length}`;
  const total=(guide.floorTensors.get(guide.layer)||[]).length;$('primary-axis-note').textContent=`Each block is one tensor; color groups inferred function, block height is log-scaled stored bytes. ${shownHere} of ${total} tensors shown on this floor${total>shownHere?'; the full directory remains below':''}. Neighboring floors are subdued. Floor spacing is a display choice, not an execution graph.`;
  $('primary-instructions').textContent='Wheel: change layer · Ctrl+wheel: zoom · Drag / arrows: orbit 360° · PageUp / PageDown: change layer';$('topology-canvas').setAttribute('aria-label','Layer floor carousel. Scroll up goes to the next higher floor, down the previous floor. Control plus wheel zooms. PageUp and PageDown change floor. Drag or arrow keys orbit 360 degrees; Home resets camera.');
  const animation=++guide.floorAnimation,delta=previous<0?0:index-previous;
  if(animate&&delta&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&guide.scene){const started=performance.now(),offset=Math.sign(delta)*Math.min(Math.abs(delta),1)*spacing;guide.scene.offsetY=offset;const frame=now=>{if(animation!==guide.floorAnimation)return;const progress=Math.min(1,(now-started)/180);guide.scene.offsetY=offset*(1-progress)**3;guide.scene.draw();if(progress<1)requestAnimationFrame(frame);};requestAnimationFrame(frame);}
  else if(guide.scene){guide.scene.offsetY=0;guide.scene.draw();}
}
function positionFloorLabels(scene){if(guide.view!=='landscape'&&(guide.view!=='layers'||guide.layerLayout!=='floors'))return;const rect=scene.canvas.getBoundingClientRect();for(const item of guide.floorLabels){const point=scene.project(item.point);item.button.hidden=!point||point[2]<-1||point[2]>1;if(!point||item.button.hidden)continue;item.button.style.left=`${Math.max(110,Math.min(rect.width-110,(point[0]+1)*rect.width/2))}px`;item.button.style.top=`${Math.max(55,Math.min(rect.height-42,(1-point[1])*rect.height/2))}px`;}}

function weightNodes(data){
  const values=data.values||[],cols=Math.min(64,values.length),rows=Math.ceil(values.length/cols),max=values.reduce((m,v)=>typeof v==='number'&&Number.isFinite(v)?Math.max(m,Math.abs(v)):m,0)||1,nodes=[];
  for(let i=0;i<values.length;i++){const value=values[i];if(typeof value!=='number'||!Number.isFinite(value))continue;const h=Math.abs(value)/max*4;nodes.push({x:(i%cols-(cols-1)/2)*12/Math.max(1,cols),z:(Math.floor(i/cols)-(rows-1)/2)*12/Math.max(1,rows),y:(value>=0?1:-1)*h/2,w:11/Math.max(1,cols),d:11/Math.max(1,rows),h,color:sceneColor(value===0?'zero':value>0?'positive':'negative'),layer:null,sampleIndex:i+(data.start_element||0),value});}
  return nodes;
}
function preferredTensor(tensors){return tensors.find(t=>t.sample_supported&&t.shape.length>=2&&t.parameter_count>=4096&&tensorRole(t)==='attention')||tensors.find(t=>t.sample_supported&&t.shape.length>=2&&t.parameter_count>=4096)||tensors.find(t=>t.sample_supported);}
function initializePrimary(model){
  ++guide.viewRequest;guide.modelId=state.id;guide.primaryTensor=null;guide.primarySample=null;guide.pendingKey=null;guide.sampleError=null;guide.view='landscape';guide.landscapeCache=new Map();guide.landscapeFlights=new Map();guide.landscapeOverrides=new Map();
  const supported=model.tensors.filter(t=>t.sample_supported);$('landscape-tensor').replaceChildren(new Option(supported.length?'Select a decoded tensor':'No supported tensor decoders',''));
  for(const tensor of supported)$('landscape-tensor').append(new Option(`${tensor.name} · ${tensor.type} · ${tensor.shape.join(' × ')}`,tensor.name));
  $('landscape-tensor').disabled=!supported.length;setPrimaryView('landscape',false);
  const initial=preferredTensor(supported);if(initial)selectPrimaryTensor(initial.name);else clearPrimary('This file has no tensors with a supported value decoder. Use Layer map to inspect its structure.');
}
function selectPrimaryTensor(name){
  const tensor=state.model?.tensors.find(t=>t.name===name);if(!tensor)return;
  $('tensor-search').value='';$('type-filter').value='';$('layer-filter').value=tensor.layer===null||tensor.layer===undefined?'global':String(tensor.layer);state.page=0;guide.explicitTensor=true;renderTensors();guide.explicitTensor=false;selectTensor(tensor);
}
function clearPrimary(text){
  ++guide.viewRequest;guide.pendingKey=null;guide.primarySample=null;guide.primaryTensor=null;guide.sampleError=text;$('landscape-tensor').value='';$('landscape-count').textContent='NO SAMPLE';
  $('landscape-status').textContent=text;$('landscape-status').hidden=guide.view==='layers';$('scene-tooltip').hidden=true;
  if(guide.view!=='layers')renderPrimaryLegend();
  if(guide.view!=='layers'){if(guide.view==='landscape')renderLandscapeCarousel();else{guide.scene?.setGeometry([]);drawPrimary2D();}}
}
async function loadPrimarySample(tensor){
  if(guide.view==='layers')return;
  const modelId=state.id,key=`${modelId}:${tensor.name}`;
  if(!tensor.sample_supported){clearPrimary(`Decoded values for ${tensor.type} are not supported. Choose a supported tensor above or switch to Layer map.`);return;}
  $('landscape-tensor').value=tensor.name;
  if(guide.primaryTensor===key&&guide.primarySample){renderPrimarySample();return;}
  const cached=guide.landscapeCache.get(key);
  if(cached?.supported&&cached.values?.length){++guide.viewRequest;guide.pendingKey=null;guide.sampleError=null;guide.primaryTensor=key;guide.primarySample=cached;cacheLandscape(key,cached);renderPrimarySample();renderSample(cached);$('sample-status').hidden=true;$('sample-view').hidden=false;return;}
  if(guide.pendingKey===key)return;
  const token=++guide.viewRequest,inspection=state.loadToken;guide.primaryTensor=key;guide.primarySample=null;guide.pendingKey=key;guide.sampleError=null;
  renderPrimaryLegend();
  $('landscape-status').textContent=`Reading a bounded prefix of ${tensor.name}…`;$('landscape-status').hidden=false;$('landscape-count').textContent='READING…';$('primary-view-label').textContent=tensor.name;$('scene-tooltip').hidden=true;guide.scene?.setGeometry([]);drawPrimary2D();
  try{
    const data=await request(`/api/sample?${new URLSearchParams({id:modelId,tensor:tensor.name})}`);
    if(token!==guide.viewRequest||inspection!==state.loadToken||modelId!==state.id||state.selected?.name!==tensor.name){if(token===guide.viewRequest)guide.pendingKey=null;return;}
    guide.pendingKey=null;
    if(!data.supported||!Array.isArray(data.values)||!data.values.length){clearPrimary(data.reason||'This tensor returned no decoded sample values.');return;}
    guide.primarySample=data;guide.primaryTensor=key;cacheLandscape(key,data);renderPrimarySample();
    // The inspector and primary modes use this same bounded response.
    renderSample(data);$('sample-status').hidden=true;$('sample-view').hidden=false;
  }catch(error){if(token===guide.viewRequest&&inspection===state.loadToken){guide.pendingKey=null;clearPrimary(`Could not read sample: ${error.message}`);}}
}
function setPrimaryView(view,choose=true){
  guide.view=view;const layers=view==='layers',three=layers||view==='landscape';
  document.querySelectorAll('[data-view]').forEach(button=>{const active=button.dataset.view===view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  $('topology-canvas').hidden=!three;$('primary-heatmap').hidden=view!=='heatmap';$('primary-distribution').hidden=view!=='distribution';$('landscape-controls').hidden=layers;$('layer-controls').hidden=!three;$('floor-controls').hidden=!three;$('reset-scene').hidden=!three;document.querySelector('.floor-layout-switch').hidden=!layers;$('floor-navigation').hidden=!(view==='landscape'||layers&&guide.layerLayout==='floors');document.querySelector('.scene-wrap').classList.toggle('landscape-carousel',view==='landscape');
  $('scene-unavailable').hidden=!three||Boolean(guide.scene?.gl&&!guide.scene.lost);$('scene-tooltip').hidden=true;
  $('primary-instructions').textContent=layers?'Drag to orbit 360° · Scroll to zoom · Click a group to explore':view==='landscape'?'Drag to orbit 360° · Scroll to zoom · Hover for index and value':view==='heatmap'?'Hover for sample index and value · Colors share one signed scale':'Hover a bin for its range and count · Counts describe this sample only';
  $('primary-instructions').hidden=!three;
  $('topology-canvas').setAttribute('aria-label',layers?'Interactive 3D layer map. Drag or arrow keys orbit 360 degrees, including underneath. Scroll or plus and minus zoom, Home resets.':'Interactive 3D decoded weight landscape. Drag or arrow keys orbit 360 degrees, including underneath. Scroll or plus and minus zoom, Home resets.');
  if(layers){$('landscape-status').hidden=true;renderPrimaryLegend();setLayerLayout(guide.layerLayout);return;}
  ++guide.floorAnimation;if(guide.scene)guide.scene.offsetY=0;hideFloorLabels();const whole=$('scene-layer').querySelector('option[value=""]');if(whole)whole.disabled=view==='landscape';
  guide.scene?.select(null);renderPrimarySample();
  if(choose){const scoped=guide.layer?(guide.floorTensors.get(guide.layer)||[]):state.model?.tensors||[],tensor=state.selected||preferredTensor(scoped);if(tensor){if(state.selected?.name===tensor.name)loadPrimarySample(tensor);else selectPrimaryTensor(tensor.name);}else if(view==='landscape')activateLandscapeFloor(guide.layer);}
}
function renderPrimaryLegend(){
  $('role-legend').replaceChildren();
  const entries=guide.view==='layers'?roleInfo.map(r=>({label:r.label,color:r.color})):[{label:`Negative · ${AtlasTheme.current.negativeName}`,color:sceneColor('negative')},{label:'Zero baseline',color:sceneColor('zero')},{label:`Positive · ${AtlasTheme.current.positiveName}`,color:sceneColor('positive')}];
  for(const entry of entries){const item=node('span'),swatch=node('i');swatch.style.backgroundColor=`rgb(${entry.color.map(x=>Math.round(x*255)).join(',')})`;item.append(swatch,document.createTextNode(entry.label));$('role-legend').append(item);}
  if(guide.view!=='layers'&&guide.primarySample?.stats){const s=guide.primarySample.stats;$('role-legend').append(node('span',`min ${precise(s.min)} · max ${precise(s.max)} · mean ${precise(s.mean)}`,'sample-range'));}
}
function renderPrimarySample(){
  if(guide.view==='layers')return;const data=guide.primarySample;
  renderPrimaryLegend();$('primary-axis-note').textContent=guide.view==='landscape'?'Height: signed decoded value, scaled to the sample maximum. X/Z: packed sample columns/rows, not neuron positions. This is a contiguous prefix, not full-tensor statistics.':guide.view==='heatmap'?'X/Y: packed sample columns/rows, not original tensor axes. Color separates negative and positive values; use the named legend. Square-root intensity highlights small values. This is a contiguous prefix.':'X: decoded weight value · Y: count of finite sampled values per bin. Bin ranges and counts describe the bounded prefix, not the full tensor.';
  if(!data){$('landscape-status').hidden=false;if(!guide.pendingKey)$('landscape-status').textContent=guide.sampleError||'Choose a supported tensor to visualize its decoded values.';if(guide.view==='landscape')renderLandscapeCarousel();else{guide.scene?.setGeometry([]);drawPrimary2D();}return;}
  $('landscape-status').hidden=true;$('primary-view-label').textContent=data.name||state.selected?.name||'DECODED WEIGHT SAMPLE';$('landscape-count').textContent=`${number(data.values.length)} / ${compact(data.total_count||state.selected?.parameter_count)} VALUES`;
  guide.scene?.select(null);if(guide.view==='landscape')renderLandscapeCarousel();else drawPrimary2D();
}
function drawPrimary2D(){
  const heat=guide.view==='heatmap';if(!heat&&guide.view!=='distribution')return;const canvas=$(heat?'primary-heatmap':'primary-distribution');const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
  const dpr=Math.min(2,devicePixelRatio||1);canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=rect.width,h=rect.height;ctx.fillStyle=AtlasTheme.current.scene;ctx.fillRect(0,0,w,h);const data=guide.primarySample;if(!data)return;
  ctx.font='10px Consolas,monospace';ctx.fillStyle=AtlasTheme.current.muted;ctx.strokeStyle=AtlasTheme.current.grid;
  if(heat){const values=data.values,cols=Math.min(64,values.length),rows=Math.ceil(values.length/cols),size=Math.max(1,Math.min((w-95)/cols,(h-110)/rows)),pw=size*cols,ph=size*rows,left=(w-pw)/2,top=(h-ph)/2;const limit=values.reduce((m,v)=>typeof v==='number'&&Number.isFinite(v)?Math.max(m,Math.abs(v)):m,1e-12);const source=document.createElement('canvas');source.width=cols;source.height=rows;const sourceCtx=source.getContext('2d'),pixels=sourceCtx.createImageData(cols,rows);
    for(let i=0;i<cols*rows;i++){const value=values[i];let color=AtlasTheme.rgb255(AtlasTheme.current.zero);if(typeof value==='number'&&Number.isFinite(value)){const strength=Math.sqrt(Math.min(1,Math.abs(value)/limit)),target=AtlasTheme.rgb255(value>=0?AtlasTheme.current.positive:AtlasTheme.current.negative);color=color.map((base,j)=>Math.round(base+(target[j]-base)*strength));}else if(i<values.length)color=AtlasTheme.rgb255(AtlasTheme.current.nonfinite);pixels.data.set([...color,255],i*4);}sourceCtx.putImageData(pixels,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(source,left,top,pw,ph);ctx.strokeRect(left-.5,top-.5,pw+1,ph+1);ctx.textAlign='center';for(const col of [...new Set([0,Math.floor(cols/4),Math.floor(cols/2),Math.floor(cols*3/4),cols-1])])ctx.fillText(String(col),left+(col+.5)*size,top+ph+18);ctx.fillText('Packed sample column',left+pw/2,top+ph+37);ctx.textAlign='right';for(const row of [...new Set([0,Math.floor(rows/4),Math.floor(rows/2),Math.floor(rows*3/4),rows-1])])ctx.fillText(String(row),left-9,top+(row+.5)*size+3);ctx.save();ctx.translate(left-35,top+ph/2);ctx.rotate(-Math.PI/2);ctx.textAlign='center';ctx.fillText('Packed sample row',0,0);ctx.restore();guide.chartGeometry={kind:'heatmap',left,top,width:pw,height:ph,cols,rows,values};canvas.setAttribute('aria-label',`Heatmap of ${values.length} decoded values in ${cols} packed columns. Negative is ${AtlasTheme.current.negativeName}, positive is ${AtlasTheme.current.positiveName}.`);
  }else{const bins=data.histogram||[],left=65,top=55,pw=Math.max(1,w-left-30),ph=Math.max(1,h-top-65),max=bins.reduce((m,b)=>Math.max(m,b.count),1);for(let tick=0;tick<=4;tick++){const y=top+ph-tick/4*ph;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(left+pw,y);ctx.stroke();ctx.textAlign='right';ctx.fillText(number(Math.round(max*tick/4)),left-10,y+3);}const bw=pw/Math.max(1,bins.length);for(const [i,bin]of bins.entries()){ctx.fillStyle=bin.max<=0?AtlasTheme.current.negative:bin.min>=0?AtlasTheme.current.positive:AtlasTheme.current.secondary;const bh=bin.count/max*ph;ctx.fillRect(left+i*bw+1,top+ph-bh,Math.max(1,bw-2),bh);}ctx.fillStyle=AtlasTheme.current.muted;ctx.textAlign='center';if(bins.length){for(const i of [...new Set([0,Math.floor(bins.length/4),Math.floor(bins.length/2),Math.floor(bins.length*3/4),bins.length])]){const value=i===bins.length?bins[bins.length-1].max:bins[i].min;ctx.fillText(precise(value),left+i*bw,top+ph+20);}}ctx.fillText('Decoded weight value',left+pw/2,top+ph+42);ctx.save();ctx.translate(17,top+ph/2);ctx.rotate(-Math.PI/2);ctx.fillText('Sample count',0,0);ctx.restore();guide.chartGeometry={kind:'distribution',left,top,width:pw,height:ph,bins};canvas.setAttribute('aria-label',`Distribution of ${data.values.length} sampled values in ${bins.length} bins. Horizontal axis decoded value; vertical axis sample count.`);}
}
function chartHover(event){const canvas=event.currentTarget,rect=canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,g=guide.chartGeometry,tip=$('scene-tooltip');if(!g||x<g.left||y<g.top||x>=g.left+g.width||y>=g.top+g.height){tip.hidden=true;return;}tip.hidden=false;if(g.kind==='heatmap'){const col=Math.floor((x-g.left)/g.width*g.cols),row=Math.floor((y-g.top)/g.height*g.rows),i=row*g.cols+col;tip.textContent=i<g.values.length?`Sample element ${number(i)} · value ${precise(g.values[i])} · packed row ${row}, column ${col}`:'Padding outside the sample';}else{const bin=g.bins[Math.min(g.bins.length-1,Math.floor((x-g.left)/g.width*g.bins.length))];if(bin)tip.textContent=`${precise(bin.min)} to ${precise(bin.max)} · ${number(bin.count)} sampled values`;else tip.hidden=true;}}

async function assistantStatus(){
  const requestId=(guide.connectionRequest||0)+1;guide.connectionRequest=requestId;
  $('refresh-assistant').disabled=true;$('assistant-status').textContent='Checking guide connections…';
  try{const [data,config]=await Promise.all([request('/api/assistant/status'),request('/api/config')]);if(requestId!==guide.connectionRequest)return;guide.connectionStatus=data;guide.configuration=config;
    if(!guide.provider)guide.provider=config.settings.default_provider||data.default_provider||'ollama';
    renderProviderControls();
  }catch(error){if(requestId===guide.connectionRequest){guide.available=false;$('chat-send').disabled=true;$('assistant-status').textContent=error.message;}}
  finally{if(requestId===guide.connectionRequest)$('refresh-assistant').disabled=false;}
}
function renderProviderControls(){
  const status=guide.connectionStatus||{},config=guide.configuration||{},provider=guide.provider||'ollama',rows=status.providers||config.providers||[];
  const connection=rows.find(row=>row.id===provider),settings=config.settings?.providers?.[provider]||{},select=$('provider-model'),old=select.value;
  $('assistant-provider').value=provider;$('assistant-provider').disabled=guide.busy;
  const isOllama=provider==='ollama';select.hidden=!isOllama;$('provider-cli-model').hidden=isOllama;
  $('provider-model-label').textContent=isOllama?'OLLAMA CLOUD MODEL':'CLI MODEL (OPTIONAL)';$('provider-model-label').htmlFor=isOllama?'provider-model':'provider-cli-model';
  if(isOllama){select.replaceChildren();for(const model of status.models||[]){const name=typeof model==='string'?model:model.name;select.append(new Option(name,name));}
    const configured=settings.model||status.default_model;if([...select.options].some(option=>option.value===old))select.value=old;else if(configured&&[...select.options].some(option=>option.value===configured))select.value=configured;
    if(!select.options.length)select.append(new Option('No cloud models available',''));
  }else $('provider-cli-model').value=guide.cliModels?.[provider]??settings.model??'';
  guide.available=Boolean(connection?.available)&&(isOllama?Boolean(select.value):true);
  select.disabled=!guide.available||guide.busy;$('provider-cli-model').disabled=guide.busy;$('chat-send').disabled=!guide.available||guide.busy||!state.model;
  if(!$('configuration-fields').disabled)$('save-configuration').disabled=guide.busy;
  const label=connection?.label||(isOllama?'Ollama':provider==='claude'?'Claude Code CLI':'Codex CLI');
  $('assistant-status').textContent=guide.available?`${label} · ${isOllama?'ready':'detected; uses your CLI sign-in'}`:connection?.reason||status.error||`${label} unavailable. Open Configuration to review connection settings.`;
  $('provider-disclosure').textContent=isOllama?'Ollama Cloud receives your questions, recent conversation, compact model facts, and selection. The guide can request sample statistics and up to 16 example values per sample. The full GGUF stays local.':`${label} receives your questions, recent conversation, and bounded model facts through your installed CLI. Replies may use its remote provider. This guide mode has no filesystem or MCP tools and cannot create edit proposals. The full GGUF stays local.`;
}
function changeGuideProvider(){guide.provider=$('assistant-provider').value;guide.history=[];renderProviderControls();message('assistant','Connection changed. Your next question starts with fresh conversation context and the current model selection.');}
function renderConfiguration(data){
  const settings=data.settings,providers=settings.providers;$('config-default-provider').value=settings.default_provider;$('config-timeout').value=settings.timeout_seconds;
  for(const id of ['ollama','claude','codex']){
    $('config-'+id+'-model').value=providers[id]?.model||'';
    if(id!=='ollama')$('config-'+id+'-executable').value=providers[id]?.executable||'';
    const status=data.providers?.find(item=>item.id===id),badge=$('config-'+id+'-status');badge.textContent=status?.available?'Detected':'Unavailable';badge.classList.toggle('connected',Boolean(status?.available));
    $('config-'+id+'-detail').textContent=[status?.reason,status?.version,status?.executable?.split(/[\\/]/).pop()].filter(Boolean).join(' · ');
    $('config-'+id+'-detail').title=status?.executable||'';
  }
  $('config-ollama-url').value=providers.ollama?.base_url||'http://127.0.0.1:11434';
  $('config-claude-snippet').textContent=JSON.stringify(data.mcp?.claude_config||{},null,2);$('config-codex-snippet').textContent=data.mcp?.codex_config||'';
  $('config-mcp-instructions').textContent=Array.isArray(data.mcp?.instructions)?data.mcp.instructions.join(' '):data.mcp?.instructions||'';
  $('config-storage').replaceChildren();for(const [key,value]of Object.entries(data.storage||{})){$('config-storage').append(node('dt',key.replaceAll('_',' ')),node('dd',Array.isArray(value)?value.join('\n'):String(value)));}
  $('configuration-fields').disabled=false;$('save-configuration').disabled=guide.busy;
}
async function loadConfiguration(){
  $('configuration-status').textContent='Checking installed connections…';$('configuration-fields').disabled=true;$('save-configuration').disabled=true;$('reload-configuration').disabled=true;
  try{const data=await request('/api/config');guide.configuration=data;renderConfiguration(data);$('configuration-status').textContent='Connection availability is checked locally. Authentication is verified when you send a question.';}
  catch(error){$('configuration-status').textContent=error.message;}
  finally{$('reload-configuration').disabled=false;}
}
async function saveConfiguration(event){
  event.preventDefault();if(guide.busy){$('configuration-status').textContent='Wait for the current guide reply before saving connection settings.';return;}const providers={ollama:{base_url:$('config-ollama-url').value.trim(),model:$('config-ollama-model').value.trim()}};
  for(const id of ['claude','codex'])providers[id]={executable:$('config-'+id+'-executable').value.trim(),model:$('config-'+id+'-model').value.trim()};
  $('configuration-fields').disabled=true;$('save-configuration').disabled=true;$('reload-configuration').disabled=true;$('configuration-status').textContent='Saving settings and checking connections…';
  try{const data=await post('config',{default_provider:$('config-default-provider').value,timeout_seconds:Number($('config-timeout').value),providers});guide.configuration=data;guide.provider=data.settings.default_provider;guide.cliModels={};guide.history=[];renderConfiguration(data);$('provider-model').value='';await assistantStatus();$('configuration-status').textContent='Saved. The guide now uses your selected default connection. No model prompt was sent.';}
  catch(error){$('configuration-status').textContent=`Could not save: ${error.message}`;}
  finally{$('configuration-fields').disabled=false;$('save-configuration').disabled=guide.busy;$('reload-configuration').disabled=false;}
}
function openConfiguration(){setSceneFocus(false);setWeightFocus(false);$('configuration-dialog').showModal();loadConfiguration();}
async function sendChat(text){
  if(guide.busy||!state.model)return;
  if(!guide.available){$('assistant-status').textContent='This connection is unavailable. Open Configuration to choose or set up a guide connection, then refresh.';scrollGuide();return;}
  const content=(text||$('chat-input').value).trim();if(!content)return;
  const generation=guide.generation,modelId=state.id;guide.busy=true;$('chat-send').disabled=true;$('chat-input').value='';message('user',content);const pending=message('assistant','Reading the model facts and your current selection…');pending.classList.add('pending');
  $('assistant-provider').disabled=true;$('provider-model').disabled=true;$('provider-cli-model').disabled=true;
  $('save-configuration').disabled=true;
  try{const data=await post('chat',{id:modelId,provider:guide.provider||'ollama',provider_model:guide.provider==='ollama'?$('provider-model').value:$('provider-cli-model').value.trim(),message:content,history:guide.history.slice(-12),selected_tensor:state.selected?.name||null,selected_layer:guide.layer==='global'?'global':guide.layer?Number(guide.layer):null,selected_view:guide.view,selected_theme:AtlasTheme.id,...(guide.view==='layers'?{selected_layer_layout:guide.layerLayout}:{})});
    if(generation!==guide.generation)return;pending.remove();const reply=typeof data.reply==='string'?data.reply:JSON.stringify(data.reply);const article=message('assistant',reply||'No reply returned.');formatReply(article,reply||'No reply returned.');
    guide.history.push({role:'user',content},{role:'assistant',content:reply||''});guide.history=guide.history.slice(-12);
    if(data.usage){const usage=data.usage;article.append(node('div',`${precise(usage.duration_seconds)} s · ${number(usage.prompt_tokens)} prompt tokens · ${number(usage.completion_tokens)} output tokens`,'chat-usage'));}
    if(data.warning)article.append(node('div',String(data.warning),'chat-warning'));
    if(data.evidence){const details=node('details',null,'chat-evidence');details.append(node('summary','Facts supplied to the guide'),node('pre',typeof data.evidence==='string'?data.evidence:JSON.stringify(data.evidence,null,2)));article.append(details);}
    for(const proposal of data.proposals||[])renderPlan(proposal,modelId);
  }catch(error){if(generation===guide.generation){pending.remove();message('error',error.message);}}
  finally{if(generation===guide.generation){guide.busy=false;renderProviderControls();}}
}

function buildEditComposer(){
  const section=node('section',null,'edit-composer');section.id='edit-composer';section.hidden=true;
  section.innerHTML='<div class="section-heading"><div><p class="eyebrow">CONTROLLED EXPERIMENT</p><h4>Plan a change to a copy</h4></div></div><p id="edit-eligibility" class="footnote"></p><form id="edit-form"><div class="edit-fields"><label>Operation<select id="edit-operation"><option value="scale">Scale values</option><option value="zero">Set values to zero</option></select></label><label id="factor-field">Factor (−2 to 2)<input id="edit-factor" type="number" step="any" min="-2" max="2" value="0.99" required></label><label>Start element<input id="edit-start" type="number" min="0" step="1" value="0" required></label><label>Element count<input id="edit-count" type="number" min="1" step="1" value="4096" required></label></div><p class="footnote">Indices follow flattened GGUF storage order. The default is a small prefix; increasing the count can include the whole tensor. A candidate copies the whole GGUF and changes only the chosen range.</p><button id="plan-edit" type="submit" class="secondary">Prepare review plan ↗</button><p id="edit-status" class="footnote" role="status"></p></form>';
  $('tensor-details').append(section);
  const ask=node('button','Ask the guide about this tensor ↗','text-button ask-tensor');ask.type='button';ask.addEventListener('click',()=>{scrollGuide();sendChat('Explain the selected tensor in plain language, including what its shape and storage type mean and what cannot be inferred from its values alone.');});$('selected-name').after(ask);
  $('edit-operation').addEventListener('change',()=>{$('factor-field').hidden=$('edit-operation').value==='zero';$('edit-factor').required=$('edit-operation').value==='scale';});
  $('edit-form').addEventListener('submit',async(event)=>{event.preventDefault();if(!state.selected)return;const id=state.id;$('plan-edit').disabled=true;$('edit-status').textContent='Validating the range and hashing the source file. Large models can take a little time…';try{const plan=await post('experiments/plan',{id,tensor:state.selected.name,operation:$('edit-operation').value,factor:Number($('edit-factor').value),element_start:Number($('edit-start').value),element_count:Number($('edit-count').value)});renderPlan(plan.plan||plan,id);$('edit-status').textContent='Plan ready. Review the exact change and storage requirement before creating a candidate.';$('experiment-plans').scrollIntoView({behavior:'smooth',block:'center'});}catch(error){$('edit-status').textContent=error.message;}finally{$('plan-edit').disabled=false;}});
}
function updateEditComposer(tensor){
  updateSampleIdentity(tensor);
  $('edit-composer').hidden=false;const supported=['F32','F16','BF16'].includes(tensor.type);$('edit-form').hidden=!supported;
  $('edit-eligibility').textContent=supported?'Native edits are available for this floating-point tensor. The source stays unchanged. Validate any candidate separately before using it.':`${tensor.type} is inspectable, but candidate editing is limited to F32, F16, and BF16 tensors. Quantized edits require format-aware re-encoding and are not enabled.`;
  $('edit-start').value=0;$('edit-start').max=Math.max(0,tensor.parameter_count-1);$('edit-count').value=Math.min(4096,tensor.parameter_count);$('edit-count').max=tensor.parameter_count;$('edit-status').textContent='';updateContext();
}

function renderPlan(raw,modelId){
  $('plan-review-status').hidden=true;
  const plan=raw.plan||raw,edit=plan.edit||plan;const tensor=typeof plan.tensor==='object'?plan.tensor.name:plan.tensor||plan.tensor_name;
  const card=node('article',null,'plan-card');const title=node('h4',tensor||'Proposed tensor experiment');card.append(node('span',plan.plan_id?'VALIDATED REVIEW PLAN':'SUGGESTED EXPERIMENT','eyebrow'),title);
  if(plan.hypothesis||plan.rationale)card.append(node('p',plan.hypothesis||plan.rationale,'plan-reason'));
  const facts=node('dl',null,'plan-facts');const items=[['Operation',edit.operation==='zero'?'Set values to zero':`Scale × ${edit.factor??'—'}`],['Range',`${number(edit.element_start)} through ${number(Number(edit.element_start)+Number(edit.element_count)-1)} (${number(edit.element_count)} elements)`],['Tensor type',plan.tensor?.type||'Confirmed when plan is prepared'],['Source file',plan.source?.path||state.model?.file.path||''],['Whole-file copy',bytes(plan.source?.size_bytes??state.model?.file.size_bytes)],['Original','Preserved. Candidate created as a separate file.']];
  for(const [label,value]of items){facts.append(node('dt',label),node('dd',value));}card.append(facts);
  if(plan.plan_id||plan.source?.sha256){const identity=node('details',null,'plan-identity');const identityFacts=node('dl',null,'plan-facts');if(plan.plan_id)identityFacts.append(node('dt','Plan ID'),node('dd',plan.plan_id));if(plan.source?.sha256)identityFacts.append(node('dt','Source SHA256'),node('dd',plan.source.sha256));identity.append(node('summary','Plan and source identity'),identityFacts);card.append(identity);}
  if(plan.limitations){const list=node('ul',null,'plan-limitations');for(const text of Array.isArray(plan.limitations)?plan.limitations:[plan.limitations])list.append(node('li',typeof text==='string'?text:JSON.stringify(text)));card.append(list);}
  card.append(node('p','File validation does not test inference behavior or quality. Evaluate the candidate separately before adopting it.','candidate-caveat'));
  const feedback=node('p',plan.plan_id?'No change has been applied. Creating a candidate copies the entire model file.':'Prepare a validated plan to check the tensor range and source identity.','plan-feedback');const action=node('button',plan.plan_id?'Create candidate copy':'Prepare review plan','primary');action.type='button';card.append(feedback,action);$('plan-cards').prepend(card);$('experiment-plans').hidden=false;
  action.addEventListener('click',async()=>{action.disabled=true;
    try{if(!plan.plan_id){feedback.textContent='Validating proposal and hashing the original file…';const prepared=await post('experiments/plan',{id:modelId,tensor,operation:edit.operation,factor:edit.factor,element_start:edit.element_start,element_count:edit.element_count});renderPlan(prepared.plan||prepared,modelId);feedback.textContent='Validated plan is ready above. Review it before creating the candidate.';action.remove();return;}
      feedback.textContent='Starting candidate copy. The original file remains unchanged…';const job=await post('experiments/apply',{plan_id:plan.plan_id,confirm:true});action.textContent='Creating candidate…';await followJob(job.job_id,feedback,action);
    }catch(error){feedback.textContent=error.message;action.disabled=false;action.textContent=plan.plan_id?'Retry candidate creation':'Prepare review plan';}
  });
}
async function followJob(id,feedback,button){
  for(;;){const job=await request(`/api/jobs?${new URLSearchParams({id})}`);if(job.status==='completed'||job.status==='complete'){const result=job.result||{};feedback.textContent=`Candidate created. ${result.output?.path||result.candidate_path||result.output_path||result.path||''} ${result.behavior_tested===false?'Model behavior has not been tested. ':''}${result.validation?'Validation: '+(typeof result.validation==='string'?result.validation:JSON.stringify(result.validation)):''}`;const details=node('details',null,'job-result');details.append(node('summary','Candidate verification details'),node('pre',JSON.stringify(result,null,2)));feedback.after(details);button.textContent='Candidate created ✓';button.disabled=true;return;}if(job.status==='failed')throw new Error(typeof job.error==='string'?job.error:JSON.stringify(job.error)||'Candidate creation failed.');feedback.textContent=`${job.status==='queued'?'Queued':'Creating and verifying candidate'} · ${job.message||'The source is preserved; this can take time for a large GGUF.'}`;await new Promise(resolve=>setTimeout(resolve,2000));}
}

function buildWeight3D(){
  const identity=node('div',null,'sample-identity');identity.id='sample-identity';identity.append(node('strong','','sample-tensor-name'),node('span','','sample-model-name'));
  const bar=node('div',null,'weight-view-toggle');bar.innerHTML='<span class="tiny-label">SAMPLE VIEW</span><button id="weight-2d" type="button" class="active">2D color</button><button id="weight-3d" type="button">3D heights</button><button id="weight-reset" type="button" hidden aria-label="Reset weight 3D view">↺</button><button id="weight-expand" type="button" aria-pressed="false">Expand sample ⛶</button>';
  const wrap=node('div',null,'weight-scene-wrap');wrap.id='weight-scene-wrap';wrap.hidden=true;wrap.innerHTML='<canvas id="weight-canvas" tabindex="0" aria-label="3D signed sample height field. Arrow keys or drag orbit 360 degrees, including underneath. Plus and minus zoom. Home resets."></canvas><p>Height = signed value · X/Z = packed sample column/row. These are display coordinates, not spatial neurons. Drag or use arrow keys to rotate.</p><div id="weight-unavailable" hidden>WebGL unavailable. Use the 2D color view.</div>';
  $('sample-view').prepend(wrap);$('sample-view').prepend(bar);$('sample-view').prepend(identity);
  const toggle=(three)=>{$('weight-scene-wrap').hidden=!three;document.querySelector('#sample-view .canvas-wrap').hidden=three;$('weight-2d').classList.toggle('active',!three);$('weight-3d').classList.toggle('active',three);$('weight-reset').hidden=!three;guide.weightScene?.draw();};
  $('weight-2d').addEventListener('click',()=>toggle(false));$('weight-3d').addEventListener('click',()=>toggle(true));$('weight-reset').addEventListener('click',()=>guide.weightScene?.reset());
  $('weight-expand').addEventListener('click',()=>setWeightFocus(!$('sample-view').classList.contains('sample-focused')));
}
function updateSampleIdentity(tensor=state.selected){
  const identity=$('sample-identity');if(!identity)return;
  identity.querySelector('.sample-tensor-name').textContent=tensor?.name||'Selected tensor';
  identity.querySelector('.sample-model-name').textContent=state.model?.file.name||'';
  identity.title=`${state.model?.file.name||''} · ${tensor?.name||''}`;
}
function updateWeight3D(data){
  guide.lastInspectorSample=data;
  updateSampleIdentity();
  if(!guide.weightScene){try{guide.weightScene=new AtlasScene($('weight-canvas'),{onUnavailable:()=>{$('weight-unavailable').hidden=false;}});}catch{$('weight-unavailable').hidden=false;}}
  guide.weightScene?.setNodes(weightNodes(data));
  if(guide.modelId===state.id&&data.name===state.selected?.name&&guide.primarySample!==data){++guide.viewRequest;guide.pendingKey=null;guide.primaryTensor=`${state.id}:${data.name}`;guide.primarySample=data;guide.sampleError=null;cacheLandscape(guide.primaryTensor,data);renderPrimarySample();}
}

function buildExternalReview(){
  const panel=$('tab-agent');panel.replaceChildren();
  const heading=node('div',null,'section-heading');const title=node('div');title.append(node('p','AN INTERFACE FOR CODEX, CLAUDE CODE, AND YOUR LOCAL GUIDE','eyebrow'),node('h3','Agents can inspect. You decide what changes.'));heading.append(title,node('span','HUMAN REVIEW','small-badge'));panel.append(heading,node('p','Read-only inspection and experiment planning are available to external agents through the local MCP adapter. Agents can identify tensors and prepare a concrete plan; this browser is where you review it and explicitly create a candidate copy.','agent-lede'));
  const form=node('form',null,'external-plan-form');form.innerHTML='<label for="external-plan-id">Review a prepared plan</label><div><input id="external-plan-id" type="text" placeholder="Paste a plan ID from Codex or Claude Code" required><button class="secondary" type="submit">Load review plan ↗</button></div><p id="external-plan-status" class="footnote" role="status"></p>';panel.append(form);
  const api=node('div',null,'api-example');api.append(node('span','LOCAL INSPECTION API','tiny-label'),node('code','GET /api/models\nGET /api/model?id=<model_id>\nGET /api/sample?id=<model_id>&tensor=<name>\nGET /api/experiments/plan?id=<plan_id>'));panel.append(api,node('p','Candidate edits currently support F32, F16, and BF16 ranges. Quantized tensor mutation and architecture changes are not enabled. Creating a file does not establish that it behaves well; run separate inference and quality comparisons.','footnote'));
  // Keep the original renderer’s API target available when another model is inspected.
  const original=node('code');original.id='api-example';original.hidden=true;panel.append(original);
  form.addEventListener('submit',async(e)=>{e.preventDefault();await reviewExternalPlan($('external-plan-id').value.trim());});
}
async function reviewExternalPlan(id){
  if(!id)return;
  // Review is independent of catalog discovery and model inspection. A linked plan
  // must remain visible even while #workspace is hidden or inspection fails.
  const reviewStatus=$('plan-review-status');$('experiment-plans').hidden=false;reviewStatus.hidden=false;reviewStatus.textContent='Loading the stored plan…';$('external-plan-status').textContent=reviewStatus.textContent;
  try{
    const result=await request(`/api/experiments/plan?${new URLSearchParams({id})}`),plan=result.plan||result;
    renderPlan(plan,plan.model_id||state.id);
    $('external-plan-status').textContent='Plan loaded. Review its source path and SHA256, exact range, and whole-file copy requirement above.';
    $('experiment-plans').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
  }catch(error){reviewStatus.hidden=false;reviewStatus.textContent=`Could not load experiment plan: ${error.message}`;$('external-plan-status').textContent=error.message;}
}
buildEditComposer();buildWeight3D();buildExternalReview();
window.addEventListener('atlas:theme',refreshThemeVisuals);
const floorLabels=node('div',null,'floor-labels');floorLabels.id='floor-labels';document.querySelector('.scene-wrap').append(floorLabels);
$('floor-controls').append($('layer-controls'));
$('floor-slider').hidden=true;const wheelHint=node('span','Scroll to change layers','floor-wheel-hint');$('floor-navigation').append(wheelHint);
$('layout-floors').addEventListener('click',()=>setLayerLayout('floors'));$('layout-overview').addEventListener('click',()=>setLayerLayout('overview'));
$('floor-down').addEventListener('click',()=>moveFloor(-1));$('floor-up').addEventListener('click',()=>moveFloor(1));$('floor-slider').addEventListener('input',()=>{const id=guide.floorOrder[Number($('floor-slider').value)];if(id!==undefined)selectFloor(id);});
$('topology-canvas').addEventListener('keydown',(event)=>{if((guide.view==='landscape'||guide.view==='layers'&&guide.layerLayout==='floors')&&(event.key==='PageUp'||event.key==='PageDown')){event.preventDefault();moveFloor(event.key==='PageUp'?1:-1);}});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setPrimaryView(button.dataset.view)));
$('landscape-tensor').addEventListener('change',()=>selectPrimaryTensor($('landscape-tensor').value));
for(const id of ['primary-heatmap','primary-distribution']){$(id).addEventListener('pointermove',chartHover);$(id).addEventListener('pointerleave',()=>{$('scene-tooltip').hidden=true;});}
new ResizeObserver(()=>drawPrimary2D()).observe(document.querySelector('.scene-wrap'));
$('focus-scene').addEventListener('click',()=>setSceneFocus(!document.querySelector('.topology-panel').classList.contains('scene-focused')));
$('toggle-guide').addEventListener('click',()=>setGuideVisible(document.querySelector('.guided-grid').classList.contains('guide-hidden')));
$('reset-scene').addEventListener('click',()=>guide.scene?.reset());$('scene-layer').addEventListener('change',()=>{if(guide.view==='landscape'||guide.layerLayout==='floors')selectFloor($('scene-layer').value);else chooseLayer($('scene-layer').value);});$('explain-layer').addEventListener('click',()=>{scrollGuide();sendChat('Explain the currently selected layer or whole-model view in plain language. What are its main groups doing, and what can we infer from the file?');});
$('refresh-assistant').addEventListener('click',assistantStatus);$('chat-form').addEventListener('submit',(e)=>{e.preventDefault();sendChat();});$('chat-input').addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendChat();}});document.querySelectorAll('[data-prompt]').forEach(button=>button.addEventListener('click',()=>sendChat(button.dataset.prompt)));
$('assistant-provider').addEventListener('change',changeGuideProvider);$('provider-cli-model').addEventListener('input',()=>{guide.cliModels||={};guide.cliModels[guide.provider]=$('provider-cli-model').value;});
$('open-configuration').addEventListener('click',openConfiguration);$('close-configuration').addEventListener('click',()=>$('configuration-dialog').close());$('reload-configuration').addEventListener('click',loadConfiguration);$('configuration-form').addEventListener('submit',saveConfiguration);
document.querySelectorAll('[data-copy-config]').forEach(button=>button.addEventListener('click',async()=>{try{await navigator.clipboard.writeText($(button.dataset.copyConfig).textContent);$('configuration-copy-status').textContent='Copied. Paste into the matching assistant configuration and restart or reconnect its MCP integration.';}catch{$('configuration-copy-status').textContent='Clipboard access is unavailable. Select the snippet text and copy it manually.';}}));
window.addEventListener('atlas:model',(event)=>{setSceneFocus(false);setWeightFocus(false);guide.generation++;guide.busy=false;guide.history=[];guide.layer='';$('chat-messages').replaceChildren();message('assistant','This model is ready to explore. Ask for a plain-language tour, or select a layer or tensor and I’ll focus on that part.');renderProviderControls();createTopology(event.detail);describeLayer('');initializePrimary(event.detail);});
window.addEventListener('atlas:layer',(event)=>{if(state.model){const changed=guide.layer!==event.detail;describeLayer(event.detail);if(changed&&!state.selected&&guide.modelId===state.id&&!guide.explicitTensor){if(guide.view==='landscape'){if(guide.floorOrder.includes(guide.layer))activateLandscapeFloor(guide.layer);else clearPrimary('Choose a specific layer above to view its weight landscape.');}else if(guide.view!=='layers'&&guide.primaryTensor)clearPrimary('Layer selection changed. Choose a tensor above to view its values.');}}});
window.addEventListener('atlas:tensor',(event)=>{const tensor=event.detail,id=tensor.layer===null||tensor.layer===undefined?'global':String(tensor.layer);if(guide.modelId===state.id){guide.landscapeOverrides?.set(id,tensor.name);if(guide.view==='landscape'&&guide.layer!==id){guide.layer=id;$('scene-layer').value=id;$('layer-filter').value=id;state.page=0;renderTensors();}}updateEditComposer(tensor);if(guide.modelId===state.id)loadPrimarySample(tensor);});window.addEventListener('atlas:sample',(event)=>updateWeight3D(event.detail));
assistantStatus();
if(state.model){createTopology(state.model);describeLayer('');initializePrimary(state.model);}
const requestedPlan=new URLSearchParams(location.search).get('plan');if(requestedPlan)reviewExternalPlan(requestedPlan);
