/* Small dependency-free WebGL renderer. Geometry represents file facts, never an execution graph. */
'use strict';
window.AtlasScene = class AtlasScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas; this.options = options; this.nodes = []; this.selected = null; this.pending = false;this.extraLines=[];this.showGrid=true;this.offsetY=0;
    this.yaw = .61; this.pitch = .62; this.distance = 23; this.target = [0, 1, 0];
    this.gl = canvas.getContext('webgl', {alpha: false, antialias: true});
    if (!this.gl) { options.onUnavailable?.(); return; }
    const gl = this.gl;
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    this.program = gl.createProgram();
    gl.attachShader(this.program, shader(gl.VERTEX_SHADER, 'attribute vec3 p;attribute vec3 c;uniform mat4 m;uniform float offsetY;varying vec3 v;void main(){gl_Position=m*vec4(p+vec3(0.0,offsetY,0.0),1.0);v=c;}'));
    gl.attachShader(this.program, shader(gl.FRAGMENT_SHADER, 'precision mediump float;varying vec3 v;void main(){gl_FragColor=vec4(v,1.0);}'));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('3D shader link failed');
    this.buffer = gl.createBuffer(); this.lines = gl.createBuffer();
    this.mloc = gl.getUniformLocation(this.program, 'm');
    this.offsetLoc=gl.getUniformLocation(this.program,'offsetY');
    this.ploc = gl.getAttribLocation(this.program, 'p'); this.cloc = gl.getAttribLocation(this.program, 'c');
    gl.enable(gl.DEPTH_TEST); gl.clearColor(...window.AtlasTheme.rgb(window.AtlasTheme.current.scene),1);
    canvas.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; this.drag = {x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY}; canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging'); });
    canvas.addEventListener('pointermove', (e) => {
      if (this.drag) { this.orbit(-(e.clientX-this.drag.x)*.006,(e.clientY-this.drag.y)*.006); this.drag.x=e.clientX;this.drag.y=e.clientY; }
      else this.options.onHover?.(this.pick(e.clientX,e.clientY),e);
    });
    canvas.addEventListener('pointerup', (e) => { if (!this.drag) return; const click = Math.hypot(e.clientX-this.drag.startX,e.clientY-this.drag.startY)<5; this.drag=null;canvas.classList.remove('dragging');if(click)this.options.onSelect?.(this.pick(e.clientX,e.clientY)); });
    canvas.addEventListener('pointercancel', () => {this.drag=null;canvas.classList.remove('dragging');});
    canvas.addEventListener('pointerleave', () => this.options.onHover?.(null));
    canvas.addEventListener('wheel', (e) => {e.preventDefault();if(this.options.onWheel?.(e))return;this.distance=Math.max(7,Math.min(55,this.distance*Math.exp(e.deltaY*.001)));this.draw();},{passive:false});
    canvas.addEventListener('keydown', (e) => {let handled=true;switch(e.key){case'ArrowLeft':this.orbit(.12,0);break;case'ArrowRight':this.orbit(-.12,0);break;case'ArrowUp':this.orbit(0,.1);break;case'ArrowDown':this.orbit(0,-.1);break;case'+':case'=':this.distance=Math.max(7,this.distance-1);break;case'-':this.distance=Math.min(55,this.distance+1);break;case'Home':this.reset();break;default:handled=false;}if(handled){e.preventDefault();this.draw();}});
    canvas.addEventListener('webglcontextlost', (e) => {e.preventDefault();this.lost=true;options.onUnavailable?.();});
    this.observer = new ResizeObserver(()=>this.draw()); this.observer.observe(canvas);
  }
  reset(){this.yaw=.61;this.pitch=.62;this.distance=23;this.draw();}
  orbit(yaw,pitch){const turn=2*Math.PI;this.yaw=(this.yaw+yaw)%turn;this.pitch=(this.pitch+pitch)%turn;this.draw();}
  setNodes(nodes){this.nodes=nodes;this.build();this.draw();}
  setGeometry(nodes,lines=[],showGrid=true){this.nodes=nodes;this.extraLines=lines;this.showGrid=showGrid;this.build();this.draw();}
  select(layer){if(this.selected===layer)return;this.selected=layer;this.build();this.draw();}
  build(){
    if(!this.gl||this.lost)return;
    const data=[];
    const faces=[[[0,0,0],[1,0,0],[1,1,0],[0,1,0],.72],[[1,0,1],[0,0,1],[0,1,1],[1,1,1],.86],[[0,0,1],[0,0,0],[0,1,0],[0,1,1],.65],[[1,0,0],[1,0,1],[1,1,1],[1,1,0],.9],[[0,1,0],[1,1,0],[1,1,1],[0,1,1],1],[[0,0,1],[1,0,1],[1,0,0],[0,0,0],.5]];
    for(const n of this.nodes){
      const highlight=this.selected!==null&&String(n.layer)===String(this.selected);
      const dim=this.selected!==null&&!highlight ? .33 : 1;
      for(const face of faces)for(const i of [0,1,2,0,2,3]){const v=face[i];data.push(n.x+(v[0]-.5)*n.w,n.y+(v[1]-.5)*n.h,n.z+(v[2]-.5)*n.d,...n.color.map(c=>Math.min(1,c*face[4]*dim+(highlight ? .13 : 0))));}
    }
    const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);this.count=data.length/6;
    const grid=[];const add=(a,b,c)=>{grid.push(...a,...c,...b,...c);};
    const theme=window.AtlasTheme.current,rgb=window.AtlasTheme.rgb;
    if(this.showGrid){for(let x=-7;x<=7;x++)add([x,0,-9],[x,0,9],rgb(theme.grid));
    for(let z=-9;z<=9;z++)add([-7,0,z],[7,0,z],rgb(theme.grid));
    add([-7,0,-9],[7,0,-9],rgb(theme.accent));add([-7,0,-9],[-7,0,9],rgb(theme.secondary));add([-7,0,-9],[-7,5,-9],rgb(theme.warning));}
    for(const line of this.extraLines)add(line.a,line.b,line.color);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.lines);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(grid),gl.STATIC_DRAW);this.lineCount=grid.length/6;
  }
  matrix(aspect){
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
    // An explicit orbit basis stays continuous at both poles. A world-up
    // look-at cross product degenerates there and flips after crossing them.
    const sy=Math.sin(this.yaw),cy=Math.cos(this.yaw),sp=Math.sin(this.pitch),cp=Math.cos(this.pitch);
    const z=[sy*cp,sp,cy*cp],x=[cy,0,-sy],y=cross(z,x);
    const eye=this.target.map((value,i)=>value+z[i]*this.distance);
    const view=[x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1];
    const f=1/Math.tan(Math.PI/7),near=.1,far=150;
    const projection=[f/aspect,0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,0,0,2*far*near/(near-far),0];
    const out=Array(16).fill(0);for(let col=0;col<4;col++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)out[col*4+row]+=projection[k*4+row]*view[col*4+k];return out;
  }
  draw(){if(this.pending||!this.gl||this.lost)return;this.pending=true;requestAnimationFrame(()=>{this.pending=false;this.render();});}
  render(){
    if(!this.gl||this.lost)return;const rect=this.canvas.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
    const dpr=Math.min(2,window.devicePixelRatio||1),w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
    const gl=this.gl;this.transform=this.matrix(w/h);gl.viewport(0,0,w,h);gl.clearColor(...window.AtlasTheme.rgb(window.AtlasTheme.current.scene),1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(this.program);gl.uniformMatrix4fv(this.mloc,false,new Float32Array(this.transform));gl.uniform1f(this.offsetLoc,this.offsetY||0);
    const bind=buffer=>{gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(this.ploc);gl.vertexAttribPointer(this.ploc,3,gl.FLOAT,false,24,0);gl.enableVertexAttribArray(this.cloc);gl.vertexAttribPointer(this.cloc,3,gl.FLOAT,false,24,12);};
    bind(this.lines);gl.drawArrays(gl.LINES,0,this.lineCount||0);bind(this.buffer);gl.drawArrays(gl.TRIANGLES,0,this.count||0);
    this.options.onRender?.(this);
  }
  project(p){const m=this.transform;if(!m)return null;const v=[p[0],p[1]+(this.offsetY||0),p[2],1],o=[0,0,0,0];for(let r=0;r<4;r++)for(let c=0;c<4;c++)o[r]+=m[c*4+r]*v[c];return o[3]>0?o.slice(0,3).map(x=>x/o[3]):null;}
  pick(clientX,clientY){
    const rect=this.canvas.getBoundingClientRect(),px=(clientX-rect.left)/rect.width*2-1,py=1-(clientY-rect.top)/rect.height*2;let best=null,depth=Infinity;
    for(const n of this.nodes){const corners=[];for(const x of [-.5,.5])for(const y of [-.5,.5])for(const z of [-.5,.5]){const p=this.project([n.x+x*n.w,n.y+y*n.h,n.z+z*n.d]);if(p)corners.push(p);}if(!corners.length)continue;
      const minX=Math.min(...corners.map(p=>p[0])),maxX=Math.max(...corners.map(p=>p[0])),minY=Math.min(...corners.map(p=>p[1])),maxY=Math.max(...corners.map(p=>p[1])),d=Math.min(...corners.map(p=>p[2]));
      if(px>=minX&&px<=maxX&&py>=minY&&py<=maxY&&d<depth){best=n;depth=d;}}
    return best;
  }
};
